import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { GenerateContentResponse, GoogleGenAI } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { trust } from "../../src/govern.js";
import type { AuditEvent } from "../../src/shared/types.js";

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

	it("a call that policy or budget DENIES never runs the user's declaration code: tool() is asked only inside an authorized round", async () => {
		const asked = { n: 0 };
		const tool = {
			tool: async () => {
				asked.n++;
				return { functionDeclarations: [{ name: "lookup" }] };
			},
			callTool: async () => [{ functionResponse: { name: "lookup", response: { ok: true } } }],
		};
		const m = scriptedModel(ROUNDS);
		const sdk = new GoogleGenAI({ apiKey: "test" });
		(sdk.models as unknown as Loose)["generateContentInternal"] = m.respond;
		// a budget the first round cannot be held against: denied before any provider call
		const governed = await trust(sdk, { dryRun: true, budget: 1, vaultBase: vault });
		await expect(
			governed.models.generateContent({
				model: "gemini-2.5-flash",
				contents: "go",
				config: { tools: [tool] } as never,
			}),
		).rejects.toThrow();
		expect(asked.n).toBe(0);
		expect(m.sent).toHaveLength(0);
		await governed.destroy();
	});

	it("tools declare CONCURRENTLY, as in the SDK: two declarations that wait for each other both resolve", async () => {
		const makePair = () => {
			let started = 0;
			let release!: () => void;
			const both = new Promise<void>((resolve) => {
				release = resolve;
			});
			const decl = (name: string) => async () => {
				started++;
				if (started === 2) release();
				await both; // never settles unless the SECOND tool() is started while the first is pending
				return { functionDeclarations: [{ name }] };
			};
			const call = async () => [{ functionResponse: { name: "x", response: { ok: true } } }];
			return [
				{ tool: decl("a"), callTool: call },
				{ tool: decl("b"), callTool: call },
			];
		};
		const run = async (governedRun: boolean) => {
			const m = scriptedModel(ROUNDS);
			const sdk = new GoogleGenAI({ apiKey: "test" });
			(sdk.models as unknown as Loose)["generateContentInternal"] = m.respond;
			const tools = makePair();
			const target = governedRun
				? (await trust(sdk, { dryRun: true, budget: 500_000, vaultBase: vault })).models
				: sdk.models;
			const done = await Promise.race([
				(target as typeof sdk.models)
					.generateContent({
						model: "gemini-2.5-flash",
						contents: "go",
						config: { tools } as never,
					})
					.then(() => "resolved"),
				new Promise<string>((r) => setTimeout(() => r("hung"), 3000)),
			]);
			return { done, sentTools: m.sentTools };
		};
		const native = await run(false);
		const governed = await run(true);
		expect(native.done).toBe("resolved");
		expect(governed.done).toBe("resolved");
		expect(governed.sentTools).toEqual(native.sentTools);
	}, 15_000);

	it("a tool() that throws fails the call the way it fails natively, with no model round made", async () => {
		const bad = {
			tool: async () => {
				throw new Error("declaration service down");
			},
			callTool: async () => [],
		};
		const expectedMsg = await (async () => {
			const m = scriptedModel(ROUNDS);
			const sdk = new GoogleGenAI({ apiKey: "test" });
			(sdk.models as unknown as Loose)["generateContentInternal"] = m.respond;
			return sdk.models
				.generateContent({
					model: "gemini-2.5-flash",
					contents: "go",
					config: { tools: [bad] } as never,
				})
				.then(
					() => "no error",
					(e: Error) => e.message,
				);
		})();
		const m = scriptedModel(ROUNDS);
		const sdk = new GoogleGenAI({ apiKey: "test" });
		(sdk.models as unknown as Loose)["generateContentInternal"] = m.respond;
		const governed = await trust(sdk, { dryRun: true, budget: 500_000, vaultBase: vault });
		const actual = await governed.models
			.generateContent({
				model: "gemini-2.5-flash",
				contents: "go",
				config: { tools: [bad] } as never,
			})
			.then(
				() => "no error",
				(e: Error) => e.message,
			);
		expect(expectedMsg).toBe("declaration service down");
		expect(actual).toBe(expectedMsg);
		expect(m.sent).toHaveLength(0);
		await governed.destroy();
	});

	// In pii "redact" mode the governed call forwards a deep CLONE of the request, and the SDK asks the tool on that clone.
	// (The PII detector matches a string that IS the value, so the email stands alone in each field.)
	it('pii "redact": a declaration that answers from its own state reaches the model REDACTED, in every round', async () => {
		const EMAIL = "alice@example.com";
		const makeTool = () => ({
			declaration: { functionDeclarations: [{ name: "lookup", description: EMAIL }] },
			tool(this: { declaration: unknown }) {
				return Promise.resolve(this.declaration);
			},
			callTool: async () => [{ functionResponse: { name: "lookup", response: { ok: true } } }],
		});
		const run = async (pii: "redact" | "warn") => {
			const m = scriptedModel(ROUNDS);
			const sdk = new GoogleGenAI({ apiKey: "test" });
			(sdk.models as unknown as Loose)["generateContentInternal"] = m.respond;
			// Policy knobs such as `pii` are read from the vault's config file, not from trust()'s opts.
			mkdirSync(join(vault, ".usertrust"), { recursive: true });
			writeFileSync(
				join(vault, ".usertrust", "usertrust.config.json"),
				JSON.stringify({ budget: 500_000, pii }),
			);
			const governed = await trust(sdk, { dryRun: true, budget: 500_000, vaultBase: vault });
			await governed.models.generateContent({
				model: "gemini-2.5-flash",
				contents: EMAIL,
				config: { tools: [makeTool()] } as never,
			});
			await governed.destroy();
			return JSON.stringify([m.sent, m.sentTools]);
		};
		const redacted = await run("redact");
		expect(redacted).not.toContain(EMAIL);
		expect(redacted).toContain("REDACTED");
		// CONTROL: without redaction the same value does reach the model, so the row can fail
		expect(await run("warn")).toContain(EMAIL);
	});

	it('pii "redact" + a PII prompt: a STATEFUL callable (tool() sets up what callTool needs) still works, and its declaration is redacted', async () => {
		const EMAIL = "alice@example.com";
		const makeStateful = () => {
			const t = {
				ready: false,
				tool() {
					this.ready = true;
					return Promise.resolve({
						functionDeclarations: [{ name: "lookup", description: EMAIL }],
					});
				},
				callTool() {
					if (!this.ready) throw new Error("tool() has not run on this instance");
					return Promise.resolve([
						{ functionResponse: { name: "lookup", response: { ok: true } } },
					]);
				},
			};
			return t;
		};
		const m = scriptedModel(ROUNDS);
		const sdk = new GoogleGenAI({ apiKey: "test" });
		(sdk.models as unknown as Loose)["generateContentInternal"] = m.respond;
		mkdirSync(join(vault, ".usertrust"), { recursive: true });
		writeFileSync(
			join(vault, ".usertrust", "usertrust.config.json"),
			JSON.stringify({ budget: 500_000, pii: "redact" }),
		);
		const governed = await trust(sdk, { dryRun: true, budget: 500_000, vaultBase: vault });
		const out = (await governed.models.generateContent({
			model: "gemini-2.5-flash",
			contents: EMAIL,
			config: { tools: [makeStateful()] } as never,
		})) as unknown as { receipts?: unknown[] };
		expect(out.receipts).toHaveLength(3);
		const wire = JSON.stringify([m.sent, m.sentTools]);
		expect(wire).not.toContain(EMAIL);
		expect(wire).toContain("REDACTED");
		await governed.destroy();
	});

	it("a `get tool()` accessor on a call the governor DENIES is never invoked (it is read at use, not at wrap time)", async () => {
		let reads = 0;
		const tool = {
			get tool() {
				reads++;
				return async () => ({ functionDeclarations: [{ name: "lookup" }] });
			},
			callTool: async () => [],
		};
		const m = scriptedModel(ROUNDS);
		const sdk = new GoogleGenAI({ apiKey: "test" });
		(sdk.models as unknown as Loose)["generateContentInternal"] = m.respond;
		const governed = await trust(sdk, { dryRun: true, budget: 1, vaultBase: vault });
		await expect(
			governed.models.generateContent({
				model: "gemini-2.5-flash",
				contents: "go",
				config: { tools: [tool] } as never,
			}),
		).rejects.toThrow();
		expect(reads).toBe(0);
		expect(m.sent).toHaveLength(0);
		await governed.destroy();
	});

	it('pii "redact": a callTool that later writes PII into the tool\'s own declaration object does not leak into later rounds', async () => {
		const EMAIL = "alice@example.com";
		const declaration = { functionDeclarations: [{ name: "lookup", description: "clean" }] };
		const tool = {
			// the SAME live object every time: a PII-free first answer is what redactPII hands back unchanged
			tool: async () => declaration,
			callTool: async () => {
				declaration.functionDeclarations[0]!.description = EMAIL;
				return [{ functionResponse: { name: "lookup", response: { ok: true } } }];
			},
		};
		const m = scriptedModel(ROUNDS);
		const sdk = new GoogleGenAI({ apiKey: "test" });
		(sdk.models as unknown as Loose)["generateContentInternal"] = m.respond;
		mkdirSync(join(vault, ".usertrust"), { recursive: true });
		writeFileSync(
			join(vault, ".usertrust", "usertrust.config.json"),
			JSON.stringify({ budget: 500_000, pii: "redact" }),
		);
		const governed = await trust(sdk, { dryRun: true, budget: 500_000, vaultBase: vault });
		await governed.models.generateContent({
			model: "gemini-2.5-flash",
			// the prompt holds PII, so the request is cloned and the SDK asks the tool through the clone
			contents: EMAIL,
			config: { tools: [tool] } as never,
		});
		expect(m.sentTools).toHaveLength(3);
		// round 1 is clean, and the tool's later write never reaches round 2 or 3
		expect(JSON.stringify(m.sentTools)).not.toContain(EMAIL);
		await governed.destroy();
	});

	it("a class-instance request whose contents and config.tools are PROTOTYPE getters runs its rounds", async () => {
		const tool = {
			tool: async () => ({ functionDeclarations: [{ name: "lookup" }] }),
			callTool: async () => [{ functionResponse: { name: "lookup", response: { ok: true } } }],
		};
		class Config {
			get tools() {
				return [tool];
			}
		}
		class Request {
			model = "gemini-2.5-flash";
			get contents() {
				return "go";
			}
			get config() {
				return new Config();
			}
		}
		const m = scriptedModel(ROUNDS);
		const sdk = new GoogleGenAI({ apiKey: "test" });
		(sdk.models as unknown as Loose)["generateContentInternal"] = m.respond;
		const governed = await trust(sdk, { dryRun: true, budget: 500_000, vaultBase: vault });
		const out = (await governed.models.generateContent(new Request() as never)) as unknown as {
			receipts?: unknown[];
		};
		expect(out.receipts).toHaveLength(3);
		expect(m.sent).toHaveLength(3);
		await governed.destroy();
	});

	it("a FROZEN callable tool is governed like any other (no Proxy invariant to break)", async () => {
		const makeFrozen = () => {
			const seen: unknown[] = [];
			const tool = Object.freeze({
				tool: async () => ({ functionDeclarations: [{ name: "lookup" }] }),
				callTool: async (calls: unknown[]) => {
					seen.push(calls);
					return [{ functionResponse: { name: "lookup", response: { ok: true } } }];
				},
			});
			return { tool, seen };
		};
		const a = scriptedModel(ROUNDS);
		const fa = makeFrozen();
		const sdk = new GoogleGenAI({ apiKey: "test" });
		(sdk.models as unknown as Loose)["generateContentInternal"] = a.respond;
		await sdk.models.generateContent({
			model: "gemini-2.5-flash",
			contents: "go",
			config: { tools: [fa.tool] } as never,
		});
		const b = scriptedModel(ROUNDS);
		const fb = makeFrozen();
		const sdk2 = new GoogleGenAI({ apiKey: "test" });
		(sdk2.models as unknown as Loose)["generateContentInternal"] = b.respond;
		const governed = await trust(sdk2, { dryRun: true, budget: 500_000, vaultBase: vault });
		const out = (await governed.models.generateContent({
			model: "gemini-2.5-flash",
			contents: "go",
			config: { tools: [fb.tool] } as never,
		})) as unknown as { receipts?: unknown[] };
		expect(b.sent).toEqual(a.sent);
		expect(b.sentTools).toEqual(a.sentTools);
		expect(fb.seen).toEqual(fa.seen);
		expect(out.receipts).toHaveLength(a.sent.length);
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

// ── The AFC snapshot keeps every field the SDK reads: the WIRE request is the SDK's own ──

type WireRound = { functionCalls?: Loose[]; text: string };

/**
 * A `fetch` stand-in for the SDK's transport: it records every provider request (URL and parsed JSON body) and answers
 * each with the next scripted model turn, as JSON or, for `:streamGenerateContent`, as one server-sent event. Unlike the
 * rows above, nothing inside the SDK is replaced, so its request converters run and the body is what the provider gets.
 */
function wire(rounds: WireRound[] = [{ text: "done" }]) {
	const requests: Array<{ url: string; body: Loose; apiClientHeader: string | null }> = [];
	const fetchStub = async (
		url: unknown,
		init?: { body?: unknown; headers?: HeadersInit },
	): Promise<Response> => {
		requests.push({
			url: String(url),
			body: JSON.parse(String(init?.body)) as Loose,
			// the SDK's client label, which carries `mcp_used/...` when it sees MCP tool usage
			apiClientHeader: new Headers(init?.headers).get("x-goog-api-client"),
		});
		const r = rounds[Math.min(requests.length - 1, rounds.length - 1)] as WireRound;
		const payload = {
			candidates: [
				{
					content: {
						role: "model",
						parts: [
							...(r.functionCalls ?? []).map((functionCall) => ({ functionCall })),
							{ text: r.text },
						],
					},
				},
			],
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
		};
		return String(url).includes(":streamGenerateContent")
			? new Response(`data: ${JSON.stringify(payload)}\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				})
			: new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
	};
	return { requests, fetchStub };
}

type WireMethod = "generateContent" | "generateContentStream";
type WireModels = Record<WireMethod, (params: never) => Promise<unknown>>;

/** One call, a stream drained to its end; resolves "ok" or the error's message. */
async function runOn(models: unknown, method: WireMethod, params: unknown): Promise<string> {
	try {
		const out = await (models as WireModels)[method](params as never);
		if (method === "generateContentStream") {
			for await (const _ of out as AsyncIterable<unknown>) {
				// drained
			}
		}
		return "ok";
	} catch (err) {
		return (err as Error).message;
	}
}

/** A callable tool (the SDK's CallableTool shape). */
function wireCallable() {
	return {
		tool: async () => ({ functionDeclarations: [{ name: "lookup" }] }),
		callTool: async () => [{ functionResponse: { name: "lookup", response: { ok: true } } }],
	};
}

/** `functionCallingConfig` as a class instance: `mode` and `allowedFunctionNames` are PROTOTYPE getters, each read counted. */
class CallingConfig {
	readonly #reads: Record<string, number>;
	readonly #mode: string;
	constructor(reads: Record<string, number>, mode: string) {
		this.#reads = reads;
		this.#mode = mode;
	}
	get mode(): string {
		this.#reads["mode"] = (this.#reads["mode"] ?? 0) + 1;
		return this.#mode;
	}
	get allowedFunctionNames(): string[] {
		this.#reads["allowedFunctionNames"] = (this.#reads["allowedFunctionNames"] ?? 0) + 1;
		return ["lookup"];
	}
}

/** `toolConfig` as a class instance: `retrievalConfig` and `includeServerSideToolInvocations` are PROTOTYPE getters. */
class ToolConfigInstance {
	readonly #reads: Record<string, number>;
	constructor(reads: Record<string, number>) {
		this.#reads = reads;
	}
	get retrievalConfig(): Loose {
		this.#reads["retrievalConfig"] = (this.#reads["retrievalConfig"] ?? 0) + 1;
		return { languageCode: "en-GB", latLng: { latitude: 51.5, longitude: -0.12 } };
	}
	get includeServerSideToolInvocations(): boolean {
		this.#reads["includeServerSideToolInvocations"] =
			(this.#reads["includeServerSideToolInvocations"] ?? 0) + 1;
		return true;
	}
}

/** A data tool whose `functionDeclarations` structuredClone cannot see: a prototype getter, or a non-enumerable own property. */
const HIDDEN_DECLARATIONS: Array<[string, (reads: Record<string, number>) => object]> = [
	[
		"a PROTOTYPE getter",
		(reads) => {
			class DeclaredTool {
				get functionDeclarations(): Loose[] {
					reads["functionDeclarations"] = (reads["functionDeclarations"] ?? 0) + 1;
					return [{ name: "lookup", description: "look it up" }];
				}
			}
			return new DeclaredTool();
		},
	],
	[
		"a NON-ENUMERABLE own property",
		() =>
			Object.defineProperty({}, "functionDeclarations", {
				value: [{ name: "lookup", description: "look it up" }],
				enumerable: false,
			}),
	],
];

/** An audit writer that records each appended event (a fresh hash per event). */
function recordingAudit(): AuditWriter & { events: AppendEventInput[] } {
	const events: AppendEventInput[] = [];
	return {
		events,
		appendEvent: async (input: AppendEventInput): Promise<AuditEvent> => {
			events.push(input);
			return {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: String(events.length).padStart(64, "0"),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			};
		},
		getWriteFailures: () => 0,
		isDegraded: () => false,
		flush: async () => {},
		release: () => {},
	};
}

/**
 * A data tool whose `inputSchema` (the SDK's MCP-usage test is `'inputSchema' in tool`) structuredClone would not carry:
 * inherited, holding `undefined` or an object, or a non-enumerable own property. Each also declares a function.
 */
const HIDDEN_INPUT_SCHEMA: Array<[string, () => object]> = [
	[
		"an INHERITED inputSchema holding undefined",
		() => Object.assign(Object.create({ inputSchema: undefined }), declaresLookup()),
	],
	[
		"an INHERITED inputSchema holding an object",
		() => Object.assign(Object.create({ inputSchema: { type: "object" } }), declaresLookup()),
	],
	[
		"a NON-ENUMERABLE own inputSchema",
		() =>
			Object.defineProperty(declaresLookup(), "inputSchema", {
				value: { type: "object" },
				enumerable: false,
			}),
	],
];

/** A tool that INHERITS a THROWING `inputSchema` getter (the SDK only tests `in`, never runs it); its calls are counted. */
function throwingInputSchemaTool(calls: { n: number }): object {
	class McpLikeBase {
		get inputSchema(): never {
			calls.n++;
			throw new Error("inputSchema getter ran");
		}
	}
	return Object.assign(new McpLikeBase(), declaresLookup());
}

/** An own enumerable DATA `inputSchema` that structuredClone cannot copy; the SDK only tests `in`, never the value. */
const UNCLONEABLE_INPUT_SCHEMA: Array<[string, () => object]> = [
	["a FUNCTION", () => ({ ...declaresLookup(), inputSchema: () => ({ type: "object" }) })],
	["a SYMBOL", () => ({ ...declaresLookup(), inputSchema: Symbol("schema") })],
];

/** Plain data built in ANOTHER realm (a `vm` context, as a test runner or sandbox makes it). */
const CROSS_REALM_PLAIN: Array<[string, () => object]> = [
	[
		"a whole tool from another realm",
		() =>
			runInNewContext(
				'({ functionDeclarations: [{ name: "lookup", parameters: { type: "OBJECT" } }] })',
			) as object,
	],
	[
		"a declarations array from another realm",
		() => ({
			functionDeclarations: runInNewContext(
				'[{ name: "lookup", parameters: { type: "OBJECT" } }]',
			) as unknown[],
		}),
	],
];

/** A class-instance declaration built in another realm: its `name` is a prototype getter there. */
function crossRealmClassTool(): object {
	return runInNewContext(
		'class Decl { get name() { return "lookup"; } }; ({ functionDeclarations: [new Decl()] })',
	) as object;
}

/**
 * A same-realm declaration whose prototype impersonates `Object.prototype`: null-prototyped, with a `constructor` named
 * "Object" whose `prototype` points back at it, but a user function (not native code), and an inherited getter.
 */
function fakeObjectPrototypeTool(): object {
	function fakeObject(): void {}
	Object.defineProperty(fakeObject, "name", { value: "Object" });
	const proto = Object.create(null, {
		constructor: { value: fakeObject, writable: true, configurable: true },
		description: { get: () => "look it up", configurable: true },
	}) as object;
	fakeObject.prototype = proto;
	const declaration = Object.create(proto, {
		name: { value: "lookup", enumerable: true, writable: true, configurable: true },
	}) as object;
	return { functionDeclarations: [declaration] };
}

function declaresLookup(): Loose {
	return { functionDeclarations: [{ name: "lookup" }] };
}

/** A declaration as a class instance: `name` and `description` are PROTOTYPE getters, which structuredClone drops. */
class DeclarationInstance {
	get name(): string {
		return "lookup";
	}
	get description(): string {
		return "look it up";
	}
}

/** A tool holding a class-instance declaration, in an own enumerable array or behind a getter on the tool. */
const NESTED_INSTANCE: Array<[string, () => object]> = [
	[
		"in an own enumerable functionDeclarations array",
		() => ({ functionDeclarations: [new DeclarationInstance()] }),
	],
	[
		"in a functionDeclarations array a PROTOTYPE getter returns",
		() => {
			class DeclaredTool {
				get functionDeclarations(): unknown[] {
					return [new DeclarationInstance()];
				}
			}
			return new DeclaredTool();
		},
	],
];

describe("the AFC snapshot forwards every field the SDK reads (real @google/genai, fetch stubbed)", () => {
	let vault: string;
	const realFetch = globalThis.fetch;
	beforeEach(() => {
		vault = join(tmpdir(), `trust-afc-wire-${randomUUID()}`);
		mkdirSync(vault, { recursive: true });
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
		rmSync(vault, { recursive: true, force: true });
	});

	/**
	 * The same request on the SDK ungoverned, then governed, each on its own client and wire. `auditKinds` lists the
	 * governed call's audit events, by kind.
	 */
	async function both(method: WireMethod, makeParams: () => unknown, rounds?: WireRound[]) {
		const raw = wire(rounds);
		globalThis.fetch = raw.fetchStub as typeof fetch;
		const rawResult = await runOn(new GoogleGenAI({ apiKey: "test" }).models, method, makeParams());
		const gov = wire(rounds);
		globalThis.fetch = gov.fetchStub as typeof fetch;
		const audit = recordingAudit();
		const governed = await trust(new GoogleGenAI({ apiKey: "test" }), {
			dryRun: true,
			budget: 500_000,
			vaultBase: vault,
			_audit: audit,
		});
		const govParams = makeParams();
		const govResult = await runOn(governed.models, method, govParams);
		await governed.destroy();
		return { raw, rawResult, gov, govResult, auditKinds: audit.events.map((e) => e.kind) };
	}

	for (const method of ["generateContent", "generateContentStream"] as const) {
		it(`${method}: a class-instance functionCallingConfig's PROTOTYPE getters mode and allowedFunctionNames reach the provider, each read once`, async () => {
			let reads: Record<string, number> = {};
			const makeParams = () => {
				reads = {};
				return {
					model: "gemini-2.5-flash",
					contents: "go",
					config: {
						tools: [{ functionDeclarations: [{ name: "lookup" }] }],
						toolConfig: { functionCallingConfig: new CallingConfig(reads, "NONE") },
					},
				};
			};
			const { raw, rawResult, gov, govResult } = await both(method, makeParams);

			expect(rawResult).toBe("ok");
			expect(govResult).toBe("ok");
			// no callable tool: one governed call, one provider request, as natively
			expect(raw.requests).toHaveLength(1);
			expect(gov.requests).toHaveLength(1);
			expect(raw.requests[0]?.body["toolConfig"]).toEqual({
				functionCallingConfig: { mode: "NONE", allowedFunctionNames: ["lookup"] },
			});
			expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
			expect(reads).toEqual({ mode: 1, allowedFunctionNames: 1 });
		});

		it(`${method}: a class-instance toolConfig's PROTOTYPE getters retrievalConfig and includeServerSideToolInvocations reach the provider, each read once`, async () => {
			let reads: Record<string, number> = {};
			const makeParams = () => {
				reads = {};
				return {
					model: "gemini-2.5-flash",
					contents: "go",
					config: {
						tools: [{ functionDeclarations: [{ name: "lookup" }] }],
						toolConfig: new ToolConfigInstance(reads),
					},
				};
			};
			const { raw, rawResult, gov, govResult } = await both(method, makeParams);

			expect(rawResult).toBe("ok");
			expect(govResult).toBe("ok");
			expect(raw.requests).toHaveLength(1);
			expect(gov.requests).toHaveLength(1);
			expect(raw.requests[0]?.body["toolConfig"]).toEqual({
				retrievalConfig: { languageCode: "en-GB", latLng: { latitude: 51.5, longitude: -0.12 } },
				includeServerSideToolInvocations: true,
			});
			expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
			expect(reads).toEqual({ retrievalConfig: 1, includeServerSideToolInvocations: 1 });
		});

		for (const [shape, makeTool] of HIDDEN_DECLARATIONS) {
			it(`${method}: a data tool whose functionDeclarations is ${shape} reaches the provider with its declarations`, async () => {
				let reads: Record<string, number> = {};
				const makeParams = () => {
					reads = {};
					return {
						model: "gemini-2.5-flash",
						contents: "go",
						config: { tools: [makeTool(reads)] },
					};
				};
				const { raw, rawResult, gov, govResult } = await both(method, makeParams);

				expect(rawResult).toBe("ok");
				expect(govResult).toBe("ok");
				expect(raw.requests).toHaveLength(1);
				expect(gov.requests).toHaveLength(1);
				expect(raw.requests[0]?.body["tools"]).toEqual([
					{ functionDeclarations: [{ name: "lookup", description: "look it up" }] },
				]);
				expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
				if (shape === "a PROTOTYPE getter") expect(reads).toEqual({ functionDeclarations: 1 });
			});
		}

		// Below a tool's top-level fields the snapshot cannot capture field by field (a `parameters` Schema is recursive),
		// so a value structuredClone would copy lossily there is refused as "can't tell", never forwarded emptied.
		for (const [shape, makeTool] of NESTED_INSTANCE) {
			it(`${method}: a class-instance declaration ${shape} is refused as "can't tell" (one policy_denied, no provider request)`, async () => {
				const makeParams = () => ({
					model: "gemini-2.5-flash",
					contents: "go",
					config: { tools: [makeTool()] },
				});
				const { raw, rawResult, gov, govResult, auditKinds } = await both(method, makeParams);

				// Natively, what the SDK sends depends on the backend: the Gemini API passes each declaration through as it
				// is, so JSON.stringify drops its getters...
				expect(rawResult).toBe("ok");
				expect(raw.requests).toHaveLength(1);
				expect(raw.requests[0]?.body["tools"]).toEqual([{ functionDeclarations: [{}] }]);
				// ...while Vertex AI reads each field (functionDeclarationToVertex) and sends the declaration.
				const vertex = wire();
				globalThis.fetch = vertex.fetchStub as typeof fetch;
				const vertexResult = await runOn(
					new GoogleGenAI({ vertexai: true, apiKey: "test" }).models,
					method,
					makeParams(),
				);
				expect(vertexResult).toBe("ok");
				expect(vertex.requests).toHaveLength(1);
				expect(vertex.requests[0]?.body["tools"]).toEqual([
					{ functionDeclarations: [{ name: "lookup", description: "look it up" }] },
				]);
				// A structuredClone would empty it for both; the snapshot cannot match both, so the governed call refuses
				expect(govResult).toContain(
					`models.${method} could not be checked for automatic function calling (params.config.tools[0].functionDeclarations[0] cannot be copied as data)`,
				);
				expect(auditKinds).toEqual(["policy_denied"]);
				expect(gov.requests).toHaveLength(0);
			});
		}

		it(`${method}: a SPARSE functionDeclarations array is refused as "can't tell" (one policy_denied, no provider request)`, async () => {
			const makeParams = () => {
				const declarations: Loose[] = [{ name: "lookup" }];
				declarations[2] = { name: "other" }; // index 1 is a hole
				return {
					model: "gemini-2.5-flash",
					contents: "go",
					config: { tools: [{ functionDeclarations: declarations }] },
				};
			};
			const { gov, govResult, auditKinds } = await both(method, makeParams);

			expect(govResult).toContain(
				`models.${method} could not be checked for automatic function calling (params.config.tools[0].functionDeclarations cannot be copied as data)`,
			);
			expect(auditKinds).toEqual(["policy_denied"]);
			expect(gov.requests).toHaveLength(0);
		});

		it(`${method}: a plain array of plain declarations, nested Schema included, is walked and forwarded as the SDK's own (control)`, async () => {
			const makeParams = () => ({
				model: "gemini-2.5-flash",
				contents: "go",
				config: {
					tools: [
						{
							functionDeclarations: [
								{
									name: "lookup",
									parameters: {
										type: "OBJECT",
										properties: { q: { type: "STRING" }, tags: { type: "ARRAY" } },
										required: ["q"],
									},
								},
								{ name: "other" },
							],
						},
						{ googleSearch: {} },
					],
				},
			});
			const { raw, rawResult, gov, govResult, auditKinds } = await both(method, makeParams);

			expect(rawResult).toBe("ok");
			expect(govResult).toBe("ok");
			expect(raw.requests).toHaveLength(1);
			expect(gov.requests).toHaveLength(1);
			expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
			expect(auditKinds).not.toContain("policy_denied");
		});

		for (const [shape, makeTool] of HIDDEN_INPUT_SCHEMA) {
			it(`${method}: a data tool with ${shape} keeps the SDK's MCP usage header, and the same body`, async () => {
				const makeParams = () => ({
					model: "gemini-2.5-flash",
					contents: "go",
					config: { tools: [makeTool()] },
				});
				const { raw, rawResult, gov, govResult, auditKinds } = await both(method, makeParams);

				expect(rawResult).toBe("ok");
				expect(govResult).toBe("ok");
				expect(raw.requests).toHaveLength(1);
				expect(gov.requests).toHaveLength(1);
				// natively `'inputSchema' in tool` is true, so the SDK labels the request as MCP usage
				expect(raw.requests[0]?.apiClientHeader).toContain("mcp_used/");
				expect(gov.requests[0]?.apiClientHeader).toBe(raw.requests[0]?.apiClientHeader);
				expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
				expect(auditKinds).not.toContain("policy_denied");
			});
		}

		it(`${method}: an INHERITED THROWING inputSchema getter is never run; the call succeeds with the SDK's MCP usage header and body`, async () => {
			const rawCalls = { n: 0 };
			const govCalls = { n: 0 };
			let made = 0;
			// the first params go to the raw SDK, the second to the governed client
			const makeParams = () => ({
				model: "gemini-2.5-flash",
				contents: "go",
				config: { tools: [throwingInputSchemaTool(made++ === 0 ? rawCalls : govCalls)] },
			});
			const { raw, rawResult, gov, govResult, auditKinds } = await both(method, makeParams);

			// natively the SDK only tests `'inputSchema' in tool`: the getter never runs, and the call succeeds
			expect(rawResult).toBe("ok");
			expect(rawCalls.n).toBe(0);
			expect(govResult).toBe("ok");
			expect(govCalls.n).toBe(0);
			expect(raw.requests).toHaveLength(1);
			expect(gov.requests).toHaveLength(1);
			expect(raw.requests[0]?.apiClientHeader).toContain("mcp_used/");
			expect(gov.requests[0]?.apiClientHeader).toBe(raw.requests[0]?.apiClientHeader);
			expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
			expect(auditKinds).not.toContain("policy_denied");
		});

		for (const [shape, makeTool] of UNCLONEABLE_INPUT_SCHEMA) {
			it(`${method}: an own inputSchema holding ${shape} (never read by the SDK) is carried by presence only: same MCP header and body`, async () => {
				const makeParams = () => ({
					model: "gemini-2.5-flash",
					contents: "go",
					config: { tools: [makeTool()] },
				});
				const { raw, rawResult, gov, govResult, auditKinds } = await both(method, makeParams);

				expect(rawResult).toBe("ok");
				expect(govResult).toBe("ok");
				expect(raw.requests).toHaveLength(1);
				expect(gov.requests).toHaveLength(1);
				expect(raw.requests[0]?.apiClientHeader).toContain("mcp_used/");
				expect(gov.requests[0]?.apiClientHeader).toBe(raw.requests[0]?.apiClientHeader);
				expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
				expect(auditKinds).not.toContain("policy_denied");
			});
		}

		for (const [shape, makeTool] of CROSS_REALM_PLAIN) {
			it(`${method}: plain declarations in ${shape} are accepted and forwarded as the SDK's own`, async () => {
				const makeParams = () => ({
					model: "gemini-2.5-flash",
					contents: "go",
					config: { tools: [makeTool()] },
				});
				const { raw, rawResult, gov, govResult, auditKinds } = await both(method, makeParams);

				expect(rawResult).toBe("ok");
				expect(govResult).toBe("ok");
				expect(raw.requests).toHaveLength(1);
				expect(gov.requests).toHaveLength(1);
				expect(raw.requests[0]?.body["tools"]).toEqual([
					{ functionDeclarations: [{ name: "lookup", parameters: { type: "OBJECT" } }] },
				]);
				expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
				expect(auditKinds).not.toContain("policy_denied");
			});
		}

		const STILL_REFUSED: Array<[string, () => object]> = [
			["a class-instance declaration from another realm", crossRealmClassTool],
			["a declaration whose prototype is a FAKE Object.prototype", fakeObjectPrototypeTool],
		];
		for (const [shape, makeTool] of STILL_REFUSED) {
			it(`${method}: ${shape} is still refused as "can't tell" (one policy_denied, no provider request)`, async () => {
				const makeParams = () => ({
					model: "gemini-2.5-flash",
					contents: "go",
					config: { tools: [makeTool()] },
				});
				const { gov, govResult, auditKinds } = await both(method, makeParams);

				expect(govResult).toContain(
					`models.${method} could not be checked for automatic function calling (params.config.tools[0].functionDeclarations[0] cannot be copied as data)`,
				);
				expect(auditKinds).toEqual(["policy_denied"]);
				expect(gov.requests).toHaveLength(0);
			});
		}
	}

	it("generateContent with a callable tool: the governed loop's EVERY round carries the class-instance functionCallingConfig, as the SDK's own loop does", async () => {
		let reads: Record<string, number> = {};
		const makeParams = () => {
			reads = {};
			return {
				model: "gemini-2.5-flash",
				contents: "go",
				config: {
					tools: [wireCallable()],
					toolConfig: { functionCallingConfig: new CallingConfig(reads, "ANY") },
				},
			};
		};
		const rounds = [
			{ functionCalls: [{ name: "lookup", args: {} }], text: "calling" },
			{ text: "done" },
		];
		const { raw, rawResult, gov, govResult } = await both("generateContent", makeParams, rounds);

		expect(rawResult).toBe("ok");
		expect(govResult).toBe("ok");
		// the verdict is unchanged: the SDK's loop made two rounds, and so did the governed one
		expect(raw.requests).toHaveLength(2);
		expect(gov.requests).toHaveLength(2);
		for (const r of raw.requests) {
			expect(r.body["toolConfig"]).toEqual({
				functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] },
			});
		}
		expect(gov.requests.map((r) => r.body)).toEqual(raw.requests.map((r) => r.body));
		expect(reads).toEqual({ mode: 1, allowedFunctionNames: 1 });
	});

	for (const [shape, makeTool] of HIDDEN_DECLARATIONS) {
		it(`generateContent: a data tool whose functionDeclarations is ${shape}, beside a callable tool, gets the SDK's own local rejection and no provider request`, async () => {
			const makeParams = () => ({
				model: "gemini-2.5-flash",
				contents: "go",
				config: { tools: [makeTool({}), wireCallable()] },
			});
			const { raw, rawResult, gov, govResult } = await both("generateContent", makeParams);

			expect(rawResult).toContain(
				"Automatic function calling with CallableTools (or MCP objects) and basic FunctionDeclarations is not yet supported. Incompatible tools found at tools[0].",
			);
			expect(govResult).toBe(rawResult);
			expect(raw.requests).toHaveLength(0);
			expect(gov.requests).toHaveLength(0);
		});

		it(`generateContentStream: a data tool whose functionDeclarations is ${shape}, beside a callable tool, makes no provider request (control)`, async () => {
			const makeParams = () => ({
				model: "gemini-2.5-flash",
				contents: "go",
				config: { tools: [makeTool({}), wireCallable()] },
			});
			const { raw, rawResult, gov, govResult } = await both("generateContentStream", makeParams);

			// natively the SDK's own error; governed, the stream's AFC refusal: neither reaches the provider
			expect(rawResult).toContain("Incompatible tools found at tools[0].");
			expect(govResult).toContain("generateContentStream");
			expect(raw.requests).toHaveLength(0);
			expect(gov.requests).toHaveLength(0);
		});
	}
});
