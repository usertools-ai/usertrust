import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GenerateContentResponse, GoogleGenAI } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trust } from "../../src/govern.js";

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

/**
 * CONFORMANCE of `google-afc.ts` to the REAL `@google/genai` automatic-function-calling loop.
 *
 * `google-afc.ts` is a second implementation of that loop, mirrored from `@google/genai` 1.52.0 (`Models.generateContent`).
 * Its drift from the SDK is the risk, and a copy of the SDK's source inside a fake would only test the copy. So these rows run
 * the real SDK's own loop and the governed loop against the same scripted model and the same tools, and compare what the
 * caller can observe: the final response, the call history, which tool calls ran with what, and what each model round was
 * sent. Only the network edge (the SDK's private `generateContentInternal`) is replaced, with the same script for both.
 *
 * `@google/genai` is a transitive dev dependency (via pi-ai), not a declared one: this test imports it directly. If a
 * future SDK changes the loop, these rows fail, and the mirror must be re-diffed against the new source.
 */
const MIRRORED_SDK_VERSION = "1.52.0";

type Loose = Record<string, unknown>;

function scriptedModel(rounds: Array<{ functionCalls?: Loose[]; text: string }>) {
	const sent: unknown[] = [];
	const sentTools: unknown[] = [];
	const respond = async (params: Loose): Promise<GenerateContentResponse> => {
		sent.push(structuredClone(params["contents"]));
		sentTools.push(structuredClone((params["config"] as Loose | undefined)?.["tools"]));
		const r = rounds[Math.min(sent.length - 1, rounds.length - 1)] as {
			functionCalls?: Loose[];
			text: string;
		};
		const res = new GenerateContentResponse();
		res.candidates = [
			{
				content: {
					role: "model",
					parts: [
						...(r.functionCalls ?? []).map((functionCall) => ({ functionCall })),
						{ text: r.text },
					],
				},
			},
		];
		res.usageMetadata = {
			promptTokenCount: 1000,
			candidatesTokenCount: 100,
			totalTokenCount: 1100,
		};
		return res;
	};
	return { respond, sent, sentTools };
}

function makeTool() {
	const seen: unknown[] = [];
	const tool = {
		tool: async () => ({ functionDeclarations: [{ name: "lookup" }] }),
		callTool: async (calls: unknown[]) => {
			seen.push(structuredClone(calls));
			return [{ functionResponse: { name: "lookup", response: { ok: seen.length } } }];
		},
	};
	return { tool, seen };
}

const ROUNDS = [
	{ functionCalls: [{ name: "lookup", args: { q: "a" } }], text: "calling" },
	{ functionCalls: [{ name: "lookup", args: { q: "b" } }], text: "calling again" },
	{ text: "done" },
];

const SHAPES: Array<[string, Loose]> = [
	["default config", {}],
	["ignoreCallHistory", { automaticFunctionCalling: { ignoreCallHistory: true } }],
	["maximumRemoteCalls: 1", { automaticFunctionCalling: { maximumRemoteCalls: 1 } }],
	["maximumRemoteCalls: 2", { automaticFunctionCalling: { maximumRemoteCalls: 2 } }],
];

const CONTENTS: Array<[string, unknown]> = [
	["a list of turns", [{ role: "user", parts: [{ text: "look it up" }] }]],
	["a bare string", "look it up"],
	// the common multimodal prompt: a string and a Part in one array is ONE user turn
	[
		"a multimodal [text, inlineData part]",
		["What is in this image?", { inlineData: { mimeType: "image/png", data: "AAAA" } }],
	],
	["a single Part", { text: "look it up" }],
];

describe("governed AFC conforms to the real @google/genai loop", () => {
	let vault: string;
	beforeEach(() => {
		vault = join(tmpdir(), `trust-afc-conf-${randomUUID()}`);
		mkdirSync(vault, { recursive: true });
	});
	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	const observe = (res: unknown) => {
		const r = res as GenerateContentResponse;
		return {
			text: r.candidates?.[0]?.content?.parts?.map((p) => p.text).join("|"),
			history: JSON.parse(JSON.stringify(r.automaticFunctionCallingHistory ?? null)),
			functionCalls: r.functionCalls ?? null,
		};
	};

	for (const [contentsName, contents] of CONTENTS) {
		for (const [shapeName, extraConfig] of SHAPES) {
			it(`${contentsName}, ${shapeName}: same result, history, tool calls and model inputs as the SDK's own loop`, async () => {
				// the SDK, ungoverned
				const a = scriptedModel(ROUNDS);
				const toolA = makeTool();
				const sdk = new GoogleGenAI({ apiKey: "test" });
				(sdk.models as unknown as Loose)["generateContentInternal"] = a.respond;
				const expected = observe(
					await sdk.models.generateContent({
						model: "gemini-2.5-flash",
						contents: contents as never,
						config: { ...extraConfig, tools: [toolA.tool] } as never,
					}),
				);

				// the same SDK, governed
				const b = scriptedModel(ROUNDS);
				const toolB = makeTool();
				const sdk2 = new GoogleGenAI({ apiKey: "test" });
				(sdk2.models as unknown as Loose)["generateContentInternal"] = b.respond;
				const governed = await trust(sdk2, { dryRun: true, budget: 500_000, vaultBase: vault });
				const out = (await governed.models.generateContent({
					model: "gemini-2.5-flash",
					contents: contents as never,
					config: { ...extraConfig, tools: [toolB.tool] } as never,
				})) as unknown as { response: unknown; receipts: unknown[] };

				const actual = observe(out.response);
				expect(actual.text).toBe(expected.text);
				expect(actual.history).toEqual(expected.history);
				expect(actual.functionCalls).toEqual(expected.functionCalls);
				expect(toolB.seen).toEqual(toolA.seen);
				expect(b.sent).toEqual(a.sent);
				// and the point of it all: every model round the SDK made is one governed receipt
				expect(out.receipts).toHaveLength(a.sent.length);
				await governed.destroy();
			});
		}
	}

	// Malformed requests must fail the same way governed and ungoverned, before any round is made or charged.
	const MALFORMED: Array<[string, unknown]> = [
		["empty contents", []],
		["Content mixed with a Part", [{ role: "user", parts: [{ text: "a" }] }, { text: "b" }]],
		["a Part mixed with Content", [{ text: "b" }, { role: "user", parts: [{ text: "a" }] }]],
		["a bare functionCall part", { functionCall: { name: "lookup" } }],
		[
			"a functionResponse part in a parts array",
			[{ text: "a" }, { functionResponse: { name: "x" } }],
		],
	];
	for (const [name, contents] of MALFORMED) {
		it(`${name}: the same error as the SDK, and no round is charged`, async () => {
			const a = scriptedModel(ROUNDS);
			const sdk = new GoogleGenAI({ apiKey: "test" });
			(sdk.models as unknown as Loose)["generateContentInternal"] = a.respond;
			const expected = await sdk.models
				.generateContent({
					model: "gemini-2.5-flash",
					contents: contents as never,
					config: { tools: [makeTool().tool] } as never,
				})
				.then(
					() => "no error",
					(e: Error) => e.message,
				);
			const b = scriptedModel(ROUNDS);
			const sdk2 = new GoogleGenAI({ apiKey: "test" });
			(sdk2.models as unknown as Loose)["generateContentInternal"] = b.respond;
			const governed = await trust(sdk2, { dryRun: true, budget: 500_000, vaultBase: vault });
			const actual = await governed.models
				.generateContent({
					model: "gemini-2.5-flash",
					contents: contents as never,
					config: { tools: [makeTool().tool] } as never,
				})
				.then(
					() => "no error",
					(e: Error) => e.message,
				);
			expect(actual).toBe(expected);
			expect(expected).not.toBe("no error");
			expect(b.sent).toHaveLength(a.sent.length);
			await governed.destroy();
		});
	}

	// How a callable tool is declared is part of the SDK's loop: it awaits every tool.tool() ONCE, before round 1.
	it("a callable's declaration is resolved ONCE per call, and every round sees that one snapshot (stateful/dynamic tools)", async () => {
		const makeDynamic = () => {
			let n = 0;
			const seen: unknown[] = [];
			const tool = {
				tool: async () => {
					n++;
					return { functionDeclarations: [{ name: `lookup_v${n}` }] };
				},
				callTool: async (calls: unknown[]) => {
					seen.push(calls);
					return [{ functionResponse: { name: "lookup", response: { ok: true } } }];
				},
			};
			return { tool, calls: () => n };
		};
		const a = scriptedModel(ROUNDS);
		const da = makeDynamic();
		const sdk = new GoogleGenAI({ apiKey: "test" });
		(sdk.models as unknown as Loose)["generateContentInternal"] = a.respond;
		await sdk.models.generateContent({
			model: "gemini-2.5-flash",
			contents: "go",
			config: { tools: [da.tool] } as never,
		});

		const b = scriptedModel(ROUNDS);
		const db = makeDynamic();
		const sdk2 = new GoogleGenAI({ apiKey: "test" });
		(sdk2.models as unknown as Loose)["generateContentInternal"] = b.respond;
		const governed = await trust(sdk2, { dryRun: true, budget: 500_000, vaultBase: vault });
		await governed.models.generateContent({
			model: "gemini-2.5-flash",
			contents: "go",
			config: { tools: [db.tool] } as never,
		});
		expect(da.calls()).toBe(1);
		expect(db.calls()).toBe(da.calls());
		// every round was sent the same declarations the SDK's own rounds were sent
		expect(b.sentTools).toEqual(a.sentTools);
		await governed.destroy();
	});

	it("a callable tool implemented as a FUNCTION OBJECT is governed round by round, like the SDK's own loop", async () => {
		const makeFnTool = () => {
			const seen: unknown[] = [];
			const fn = Object.assign(() => undefined, {
				tool: async () => ({ functionDeclarations: [{ name: "lookup" }] }),
				callTool: async (calls: unknown[]) => {
					seen.push(calls);
					return [{ functionResponse: { name: "lookup", response: { ok: true } } }];
				},
			});
			return { fn, seen };
		};
		const a = scriptedModel(ROUNDS);
		const ta = makeFnTool();
		const sdk = new GoogleGenAI({ apiKey: "test" });
		(sdk.models as unknown as Loose)["generateContentInternal"] = a.respond;
		await sdk.models.generateContent({
			model: "gemini-2.5-flash",
			contents: "go",
			config: { tools: [ta.fn] } as never,
		});

		const b = scriptedModel(ROUNDS);
		const tb = makeFnTool();
		const sdk2 = new GoogleGenAI({ apiKey: "test" });
		(sdk2.models as unknown as Loose)["generateContentInternal"] = b.respond;
		const governed = await trust(sdk2, { dryRun: true, budget: 500_000, vaultBase: vault });
		const out = (await governed.models.generateContent({
			model: "gemini-2.5-flash",
			contents: "go",
			config: { tools: [tb.fn] } as never,
		})) as unknown as { receipts?: unknown[] };
		expect(a.sent).toHaveLength(3);
		expect(b.sent).toEqual(a.sent);
		expect(tb.seen).toEqual(ta.seen);
		// the point: one governed receipt per model round, not one hold for the SDK's whole internal loop
		expect(out.receipts).toHaveLength(3);
		await governed.destroy();
	});

	it("a model that never stops calling tools is bounded by the SDK's default of 10 rounds, in both loops", async () => {
		const endless = [{ functionCalls: [{ name: "lookup", args: {} }], text: "again" }];
		const a = scriptedModel(endless);
		const sdk = new GoogleGenAI({ apiKey: "test" });
		(sdk.models as unknown as Loose)["generateContentInternal"] = a.respond;
		await sdk.models.generateContent({
			model: "gemini-2.5-flash",
			contents: "go",
			config: { tools: [makeTool().tool] } as never,
		});

		const b = scriptedModel(endless);
		const sdk2 = new GoogleGenAI({ apiKey: "test" });
		(sdk2.models as unknown as Loose)["generateContentInternal"] = b.respond;
		const governed = await trust(sdk2, { dryRun: true, budget: 500_000, vaultBase: vault });
		const out = (await governed.models.generateContent({
			model: "gemini-2.5-flash",
			contents: "go",
			config: { tools: [makeTool().tool] } as never,
		})) as unknown as { receipts: unknown[] };
		expect(a.sent).toHaveLength(10);
		expect(b.sent).toHaveLength(a.sent.length);
		expect(out.receipts).toHaveLength(10);
		await governed.destroy();
	});

	it("tracks the SDK version it mirrors", () => {
		// The package does not export its own package.json: find it from the resolved entry point.
		const entry = createRequire(import.meta.url).resolve("@google/genai");
		let dir = dirname(entry);
		while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
		const version = (
			JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { version: string }
		).version;
		// Not an assertion of equality on purpose: a bumped SDK should still pass the behavioural rows above. A differing
		// version is the prompt to re-diff `google-afc.ts` against the new loop; it is printed, not failed.
		if (version !== MIRRORED_SDK_VERSION) {
			console.warn(
				`[google-afc] mirror is of @google/genai ${MIRRORED_SDK_VERSION}; installed ${version}: re-diff google-afc.ts`,
			);
		}
		expect(version).toMatch(/^\d+\.\d+\.\d+/);
	});
});
