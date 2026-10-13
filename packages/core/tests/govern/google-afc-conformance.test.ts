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
	const requests: Array<{
		url: string;
		body: Loose;
		apiClientHeader: string | null;
		testHeader: string | null;
	}> = [];
	const fetchStub = async (
		url: unknown,
		init?: { body?: unknown; headers?: HeadersInit },
	): Promise<Response> => {
		requests.push({
			url: String(url),
			body: JSON.parse(String(init?.body)) as Loose,
			// the SDK's client label, which carries `mcp_used/...` when it sees MCP tool usage
			apiClientHeader: new Headers(init?.headers).get("x-goog-api-client"),
			// a caller's own header, sent through `config.httpOptions.headers`
			testHeader: new Headers(init?.headers).get("x-test"),
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

/**
 * Scenario: a data tool whose LATER SDK-read field (`urlContext`, an own enumerable getter) empties its earlier
 * `functionDeclarations` array when read. Each read of the getter is counted.
 */
function clearingTool(reads: { urlContext: number }): object {
	const declarations: Loose[] = [{ name: "lookup" }];
	return {
		functionDeclarations: declarations,
		get urlContext(): undefined {
			reads.urlContext++;
			declarations.length = 0;
			return undefined;
		},
	};
}

/** Scenario: a data tool that holds ITSELF (`self`) and a one-shot `googleSearch` getter (a second read throws). */
function selfReferencingTool(reads: { googleSearch: number }): object {
	const tool: Record<string, unknown> = {};
	Object.defineProperty(tool, "googleSearch", {
		get: () => {
			reads.googleSearch++;
			if (reads.googleSearch > 1) throw new Error("googleSearch read twice");
			return {};
		},
		enumerable: true,
		configurable: true,
	});
	tool["self"] = tool;
	return tool;
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

		it(`${method}: a tool field the SDK never reads (an uncloneable \`hook\`) is not copied: accepted, not forwarded, the body is the SDK's own`, async () => {
			const makeParams = () => ({
				model: "gemini-2.5-flash",
				contents: "go",
				config: { tools: [{ googleSearch: {}, hook: () => 1 }] },
			});
			const { raw, rawResult, gov, govResult, auditKinds } = await both(method, makeParams);

			expect(rawResult).toBe("ok");
			expect(govResult).toBe("ok");
			expect(raw.requests).toHaveLength(1);
			expect(gov.requests).toHaveLength(1);
			// natively the converters build the wire tool from the fields they read, so `hook` is dropped there too
			expect(raw.requests[0]?.body["tools"]).toEqual([{ googleSearch: {} }]);
			expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
			expect(auditKinds).not.toContain("policy_denied");
		});

		it(`${method}: a later field's getter that empties the captured functionDeclarations cannot reach the snapshot: the SDK's own local rejection, no provider request`, async () => {
			const rawReads = { urlContext: 0 };
			const govReads = { urlContext: 0 };
			let made = 0;
			const makeParams = () => ({
				model: "gemini-2.5-flash",
				contents: "go",
				config: { tools: [clearingTool(made++ === 0 ? rawReads : govReads), wireCallable()] },
			});
			const { raw, rawResult, gov, govResult } = await both(method, makeParams);

			// natively the SDK rejects plain declarations beside a callable tool before its converters read urlContext
			expect(rawResult).toContain("Incompatible tools found at tools[0]");
			expect(raw.requests).toHaveLength(0);
			expect(rawReads.urlContext).toBe(0);
			// governed: the snapshot reads every SDK field up front, ONCE, after functionDeclarations was already cloned
			expect(govReads.urlContext).toBe(1);
			expect(gov.requests).toHaveLength(0);
			if (method === "generateContent") {
				// left to the SDK, which rejects the snapshot's (intact) declarations the same way
				expect(govResult).toBe(rawResult);
			} else {
				// a stream with a callable tool is refused by governance either way (control for this method)
				expect(govResult).toContain(`models.${method} with automatic function calling`);
			}
		});

		it(`${method}: a tool that holds itself, with a one-shot googleSearch getter: the getter runs once and the call succeeds, as natively`, async () => {
			const rawReads = { googleSearch: 0 };
			const govReads = { googleSearch: 0 };
			let made = 0;
			const makeParams = () => ({
				model: "gemini-2.5-flash",
				contents: "go",
				config: { tools: [selfReferencingTool(made++ === 0 ? rawReads : govReads)] },
			});
			const { raw, rawResult, gov, govResult, auditKinds } = await both(method, makeParams);

			expect(rawResult).toBe("ok");
			expect(rawReads.googleSearch).toBe(1);
			expect(govResult).toBe("ok");
			expect(govReads.googleSearch).toBe(1);
			expect(raw.requests).toHaveLength(1);
			expect(gov.requests).toHaveLength(1);
			expect(raw.requests[0]?.body["tools"]).toEqual([{ googleSearch: {} }]);
			expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
			expect(auditKinds).not.toContain("policy_denied");
		});
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

// ── The snapshot reads a tool in the SDK's order, and sends on Vertex AI what the SDK sends ──

type Reads = Record<string, number>;

function counted(reads: Reads, key: string): void {
	reads[key] = (reads[key] ?? 0) + 1;
}

/** An own enumerable getter on `obj` that counts its reads and runs `effect` on each. */
function withGetter(obj: Loose, key: string, reads: Reads, effect: () => unknown): Loose {
	Object.defineProperty(obj, key, {
		get: () => {
			counted(reads, key);
			return effect();
		},
		enumerable: true,
		configurable: true,
	});
	return obj;
}

/** (a) A `googleSearch` getter that empties the same tool's `functionDeclarations` when read. */
function searchEmptiesDeclarations(reads: Reads): object {
	const declarations: Loose[] = [{ name: "lookup" }];
	return withGetter({ functionDeclarations: declarations }, "googleSearch", reads, () => {
		declarations.length = 0;
		return undefined;
	});
}

/** (b) A `googleSearch` getter that deletes the same tool's own `inputSchema` when read. */
function searchDeletesInputSchema(reads: Reads): object {
	const tool: Loose = {
		inputSchema: { type: "object" },
		functionDeclarations: [{ name: "lookup" }],
	};
	return withGetter(tool, "googleSearch", reads, () => {
		delete tool["inputSchema"];
		return undefined;
	});
}

/** (b) A `googleSearch` getter that gives the same tool an `inputSchema` when read. */
function searchAddsInputSchema(reads: Reads): object {
	const tool: Loose = { functionDeclarations: [{ name: "lookup" }] };
	return withGetter(tool, "googleSearch", reads, () => {
		tool["inputSchema"] = { type: "object" };
		return undefined;
	});
}

/** A `functionDeclarations` getter that turns on the same tool's `googleSearch` when read. */
function declarationsEnableSearch(reads: Reads): object {
	const tool: Loose = {};
	return withGetter(tool, "functionDeclarations", reads, () => {
		tool["googleSearch"] = {};
		return [{ name: "lookup" }];
	});
}

/** Two tools: the FIRST one's `googleSearch` getter runs `act` on the SECOND one. */
function pairWhere(reads: Reads, second: Loose, act: (second: Loose) => void): [object, Loose] {
	const first = withGetter({}, "googleSearch", reads, () => {
		act(second);
		return undefined;
	});
	return [first, second];
}

/** A `functionCallingConfig` carrying `fields` in a way JSON.stringify does not see. */
const HIDDEN_CALLING_FIELDS: Array<[string, (fields: Loose) => object]> = [
	["INHERITED prototype data", (fields) => Object.create(fields) as object],
	[
		"class PROTOTYPE getters",
		(fields) => {
			class CallingFields {}
			for (const [key, value] of Object.entries(fields)) {
				Object.defineProperty(CallingFields.prototype, key, {
					get: () => value,
					configurable: true,
				});
			}
			return new CallingFields();
		},
	],
	[
		"NON-ENUMERABLE own properties",
		(fields) => {
			const out = {};
			for (const [key, value] of Object.entries(fields)) {
				Object.defineProperty(out, key, { value, enumerable: false });
			}
			return out;
		},
	],
];

const BACKENDS = [
	["the Gemini API", false],
	["Vertex AI", true],
] as const;

const EMAIL = "jane.doe@example.com";

/**
 * A `functionCallingConfig` whose own enumerable data is `own` and whose serialization hook is HIDDEN from an
 * `Object.keys` walk: a non-enumerable own `toJSON`, or one a class instance inherits. JSON.stringify runs either.
 */
const HIDDEN_TO_JSON: Array<[string, (own: Loose, hook: () => unknown) => object]> = [
	[
		"a NON-ENUMERABLE own toJSON",
		(own, hook) =>
			Object.defineProperty({ ...own }, "toJSON", { value: () => hook(), enumerable: false }),
	],
	[
		"an INHERITED toJSON (a class method)",
		(own, hook) => {
			class CallingConfigWithHook {
				toJSON(): unknown {
					return hook();
				}
			}
			return Object.assign(new CallingConfigWithHook(), own);
		},
	],
];

describe("the AFC snapshot reads a tool in the SDK's order, and sends on Vertex AI what the SDK sends (real @google/genai, fetch stubbed)", () => {
	let vault: string;
	const realFetch = globalThis.fetch;
	beforeEach(() => {
		vault = join(tmpdir(), `trust-afc-order-${randomUUID()}`);
		mkdirSync(vault, { recursive: true });
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
		rmSync(vault, { recursive: true, force: true });
	});

	/**
	 * `native` on the SDK ungoverned, then `governed` on a governed client of the same backend, each on its own wire.
	 * `native` defaults to the same params (a fresh object from the same factory).
	 */
	async function nativeThenGoverned(
		method: WireMethod,
		params: { native: () => unknown; governed: () => unknown },
		opts: { vertex?: boolean; pii?: "redact"; rounds?: WireRound[] } = {},
	) {
		const client = () =>
			new GoogleGenAI(opts.vertex ? { vertexai: true, apiKey: "test" } : { apiKey: "test" });
		const raw = wire(opts.rounds);
		globalThis.fetch = raw.fetchStub as typeof fetch;
		const rawResult = await runOn(client().models, method, params.native());
		const gov = wire(opts.rounds);
		globalThis.fetch = gov.fetchStub as typeof fetch;
		const audit = recordingAudit();
		const governed = await trust(client(), {
			dryRun: true,
			budget: 500_000,
			vaultBase: vault,
			_audit: audit,
			...(opts.pii !== undefined ? { pii: opts.pii } : {}),
		});
		const govResult = await runOn(governed.models, method, params.governed());
		await governed.destroy();
		return { raw, rawResult, gov, govResult, auditKinds: audit.events.map((e) => e.kind) };
	}

	/** The same tools for the native and the governed call, each built with its own read counter. */
	function sameTools(makeTools: (reads: Reads) => unknown[]) {
		const rawReads: Reads = {};
		const govReads: Reads = {};
		const params = (reads: Reads) => () => ({
			model: "gemini-2.5-flash",
			contents: "go",
			config: { tools: makeTools(reads) },
		});
		return { rawReads, govReads, params: { native: params(rawReads), governed: params(govReads) } };
	}

	for (const method of ["generateContent", "generateContentStream"] as const) {
		it(`${method}: (a) a googleSearch getter that empties the tool's functionDeclarations runs after they are captured: the SDK's own local rejection, no provider request`, async () => {
			const t = sameTools((reads) => [searchEmptiesDeclarations(reads), wireCallable()]);
			const { raw, rawResult, gov, govResult } = await nativeThenGoverned(method, t.params);

			// natively findAfcIncompatibleToolIndexes reads functionDeclarations before any converter reads googleSearch
			expect(rawResult).toContain("Incompatible tools found at tools[0]");
			expect(raw.requests).toHaveLength(0);
			expect(gov.requests).toHaveLength(0);
			expect(t.rawReads).toEqual({});
			// the snapshot reads every field the SDK reads, ONCE, up front: the getter runs once, after the capture
			expect(t.govReads).toEqual({ googleSearch: 1 });
			if (method === "generateContent") {
				expect(govResult).toBe(rawResult);
			} else {
				// a stream with a callable tool is refused by governance either way (control for this method)
				expect(govResult).toContain(`models.${method} with automatic function calling`);
			}
		});

		it(`${method}: (b) a googleSearch getter that deletes the tool's inputSchema runs after its presence is captured: the same MCP usage header and body`, async () => {
			const t = sameTools((reads) => [searchDeletesInputSchema(reads)]);
			const { raw, rawResult, gov, govResult } = await nativeThenGoverned(method, t.params);

			expect(rawResult).toBe("ok");
			expect(govResult).toBe("ok");
			expect(raw.requests).toHaveLength(1);
			expect(gov.requests).toHaveLength(1);
			// natively hasMcpToolUsage tests `'inputSchema' in tool` before the converters read googleSearch
			expect(raw.requests[0]?.apiClientHeader).toContain("mcp_used/");
			expect(gov.requests[0]?.apiClientHeader).toBe(raw.requests[0]?.apiClientHeader);
			expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
			expect(t.rawReads).toEqual({ googleSearch: 1 });
			expect(t.govReads).toEqual(t.rawReads);
		});

		it(`${method}: (b) a googleSearch getter that ADDS an inputSchema runs after presence is captured: no MCP usage header, as natively`, async () => {
			const t = sameTools((reads) => [searchAddsInputSchema(reads)]);
			const { raw, rawResult, gov, govResult } = await nativeThenGoverned(method, t.params);

			expect(rawResult).toBe("ok");
			expect(govResult).toBe("ok");
			expect(raw.requests).toHaveLength(1);
			expect(gov.requests).toHaveLength(1);
			expect(raw.requests[0]?.apiClientHeader).not.toContain("mcp_used/");
			expect(gov.requests[0]?.apiClientHeader).toBe(raw.requests[0]?.apiClientHeader);
			expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
			expect(t.govReads).toEqual(t.rawReads);
		});

		it(`${method}: every tool's inputSchema presence is captured before any tool's field: a first tool's getter that gives the second one an inputSchema sets no MCP usage header, as natively`, async () => {
			const t = sameTools((reads) =>
				pairWhere(reads, { functionDeclarations: [{ name: "lookup" }] }, (second) => {
					second["inputSchema"] = { type: "object" };
				}),
			);
			const { raw, rawResult, gov, govResult } = await nativeThenGoverned(method, t.params);

			expect(rawResult).toBe("ok");
			expect(govResult).toBe("ok");
			expect(raw.requests).toHaveLength(1);
			expect(gov.requests).toHaveLength(1);
			// natively hasMcpToolUsage tests every tool before any converter runs
			expect(raw.requests[0]?.apiClientHeader).not.toContain("mcp_used/");
			expect(gov.requests[0]?.apiClientHeader).toBe(raw.requests[0]?.apiClientHeader);
			expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
			expect(t.rawReads).toEqual({ googleSearch: 1 });
			expect(t.govReads).toEqual(t.rawReads);
		});

		it(`${method}: with a callable tool, every tool's functionDeclarations is captured before any tool's other fields: a first tool's getter that empties the second one's declarations gets the SDK's own local rejection`, async () => {
			const t = sameTools((reads) => [
				...pairWhere(reads, { functionDeclarations: [{ name: "lookup" }] }, (second) => {
					(second["functionDeclarations"] as Loose[]).length = 0;
				}),
				wireCallable(),
			]);
			const { raw, rawResult, gov, govResult } = await nativeThenGoverned(method, t.params);

			// natively findAfcIncompatibleToolIndexes reads every tool's declarations before the converters run
			expect(rawResult).toContain("Incompatible tools found at tools[1]");
			expect(raw.requests).toHaveLength(0);
			expect(gov.requests).toHaveLength(0);
			expect(t.rawReads).toEqual({});
			expect(t.govReads).toEqual({ googleSearch: 1 });
			if (method === "generateContent") {
				expect(govResult).toBe(rawResult);
			} else {
				expect(govResult).toContain(`models.${method} with automatic function calling`);
			}
		});

		it(`${method}: without a callable tool the SDK reads tool by tool: a first tool's getter that adds a declaration to the second one reaches the provider, as natively`, async () => {
			const t = sameTools((reads) =>
				pairWhere(reads, { functionDeclarations: [{ name: "lookup" }] }, (second) => {
					(second["functionDeclarations"] as Loose[]).push({ name: "other" });
				}),
			);
			const { raw, rawResult, gov, govResult } = await nativeThenGoverned(method, t.params);

			expect(rawResult).toBe("ok");
			expect(govResult).toBe("ok");
			expect(raw.requests).toHaveLength(1);
			expect(gov.requests).toHaveLength(1);
			// natively tTool reads the second tool's declarations after the first tool's converter ran
			expect(raw.requests[0]?.body["tools"]).toEqual([
				{},
				{ functionDeclarations: [{ name: "lookup" }, { name: "other" }] },
			]);
			expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
			expect(t.rawReads).toEqual({ googleSearch: 1 });
			expect(t.govReads).toEqual(t.rawReads);
		});

		it(`${method}: a tool's functionDeclarations is captured before its other fields: a declarations getter that turns on googleSearch reaches the provider with it, as natively`, async () => {
			const t = sameTools((reads) => [declarationsEnableSearch(reads)]);
			const { raw, rawResult, gov, govResult } = await nativeThenGoverned(method, t.params);

			expect(rawResult).toBe("ok");
			expect(govResult).toBe("ok");
			expect(raw.requests).toHaveLength(1);
			expect(gov.requests).toHaveLength(1);
			// natively tTool reads functionDeclarations before the converter reads googleSearch
			expect(raw.requests[0]?.body["tools"]).toEqual([
				{ googleSearch: {}, functionDeclarations: [{ name: "lookup" }] },
			]);
			expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
			// natively tTool reads it twice (its test, then its loop) and the converter once; the snapshot once
			expect(t.rawReads).toEqual({ functionDeclarations: 3 });
			expect(t.govReads).toEqual({ functionDeclarations: 1 });
		});

		for (const [backend, vertex] of BACKENDS) {
			const params = (callingConfig: () => object) => () => ({
				model: "gemini-2.5-flash",
				contents: "go",
				config: {
					tools: [{ functionDeclarations: [{ name: "lookup" }] }],
					toolConfig: { functionCallingConfig: callingConfig() },
				},
			});

			for (const [shape, make] of HIDDEN_CALLING_FIELDS) {
				it(`${method} on ${backend}: a functionCallingConfig whose mode and allowedFunctionNames are ${shape} sends what the SDK sends`, async () => {
					const fields = { mode: "NONE", allowedFunctionNames: ["lookup"] };
					const p = params(() => make(fields));
					const { raw, rawResult, gov, govResult } = await nativeThenGoverned(
						method,
						{ native: p, governed: p },
						{ vertex },
					);

					expect(rawResult).toBe("ok");
					expect(govResult).toBe("ok");
					expect(raw.requests).toHaveLength(1);
					expect(gov.requests).toHaveLength(1);
					// the Gemini API reads each field by name; Vertex AI passes the object to JSON.stringify, which skips them
					expect(raw.requests[0]?.body["toolConfig"]).toEqual({
						functionCallingConfig: vertex ? {} : fields,
					});
					expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
				});
			}

			it(`${method} on ${backend}: an own enumerable mode beside an INHERITED allowedFunctionNames: each sent as the SDK sends it`, async () => {
				const p = params(() =>
					Object.assign(Object.create({ allowedFunctionNames: ["lookup"] }) as object, {
						mode: "ANY",
					}),
				);
				const { raw, rawResult, gov, govResult } = await nativeThenGoverned(
					method,
					{ native: p, governed: p },
					{ vertex },
				);

				expect(rawResult).toBe("ok");
				expect(govResult).toBe("ok");
				expect(raw.requests[0]?.body["toolConfig"]).toEqual({
					functionCallingConfig: vertex
						? { mode: "ANY" }
						: { mode: "ANY", allowedFunctionNames: ["lookup"] },
				});
				expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
			});

			it(`${method} on ${backend}: own enumerable mode and allowedFunctionNames are sent (control)`, async () => {
				const fields = { mode: "NONE", allowedFunctionNames: ["lookup"] };
				const p = params(() => ({ ...fields }));
				const { raw, rawResult, gov, govResult } = await nativeThenGoverned(
					method,
					{ native: p, governed: p },
					{ vertex },
				);

				expect(rawResult).toBe("ok");
				expect(govResult).toBe("ok");
				expect(raw.requests[0]?.body["toolConfig"]).toEqual({ functionCallingConfig: fields });
				expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
			});
		}

		// pii "redact": what is sent from functionCallingConfig is either redacted or not sent at all.
		for (const [shape, make] of HIDDEN_CALLING_FIELDS) {
			const params = (contents: string, names: string[]) => () => ({
				model: "gemini-2.5-flash",
				contents,
				config: {
					tools: [{ functionDeclarations: [{ name: "lookup" }] }],
					toolConfig: {
						functionCallingConfig: make({ mode: "ANY", allowedFunctionNames: names }),
					},
				},
			});

			it(`${method} on Vertex AI, pii "redact", an e-mail address in allowedFunctionNames held as ${shape} and in the prompt: no raw PII is sent, and the body is native Vertex's after redaction`, async () => {
				const { raw, rawResult, gov, govResult, auditKinds } = await nativeThenGoverned(
					method,
					{
						native: params("[REDACTED:email]", [EMAIL]),
						governed: params(`write to ${EMAIL}`, [EMAIL]),
					},
					{ vertex: true, pii: "redact" },
				);

				expect(rawResult).toBe("ok");
				expect(govResult).toBe("ok");
				expect(gov.requests).toHaveLength(1);
				expect(JSON.stringify(gov.requests)).not.toContain(EMAIL);
				expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
				expect(auditKinds).not.toContain("policy_denied");
			});

			it(`${method} on Vertex AI, pii "redact", an e-mail address in allowedFunctionNames held as ${shape} and a clean prompt: no raw PII is sent, and the body is native Vertex's`, async () => {
				const p = params("go", [EMAIL]);
				const { raw, rawResult, gov, govResult, auditKinds } = await nativeThenGoverned(
					method,
					{ native: p, governed: p },
					{ vertex: true, pii: "redact" },
				);

				expect(rawResult).toBe("ok");
				expect(govResult).toBe("ok");
				expect(gov.requests).toHaveLength(1);
				// natively Vertex AI never sends it: JSON.stringify skips an inherited or non-enumerable field
				expect(JSON.stringify(raw.requests)).not.toContain(EMAIL);
				expect(JSON.stringify(gov.requests)).not.toContain(EMAIL);
				expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
				expect(auditKinds).not.toContain("policy_denied");
			});

			it(`${method} on the Gemini API, pii "redact", an e-mail address in allowedFunctionNames held as ${shape} and in the prompt: it is sent REDACTED, as the SDK reads it by name`, async () => {
				const { raw, rawResult, gov, govResult, auditKinds } = await nativeThenGoverned(
					method,
					{
						native: params("[REDACTED:email]", ["[REDACTED:email]"]),
						governed: params(`write to ${EMAIL}`, [EMAIL]),
					},
					{ pii: "redact" },
				);

				expect(rawResult).toBe("ok");
				expect(govResult).toBe("ok");
				expect(gov.requests).toHaveLength(1);
				expect(JSON.stringify(gov.requests)).not.toContain(EMAIL);
				expect(gov.requests[0]?.body["toolConfig"]).toEqual({
					functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["[REDACTED:email]"] },
				});
				expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
				expect(auditKinds).not.toContain("policy_denied");
			});
		}

		// Vertex AI sends functionCallingConfig as JSON.stringify makes it, running its toJSON hook however it is held.
		for (const [shape, make] of HIDDEN_TO_JSON) {
			const hooked = (contents: string, hook: () => unknown, reads: Reads) => () => ({
				model: "gemini-2.5-flash",
				contents,
				config: {
					tools: [{ functionDeclarations: [{ name: "lookup" }] }],
					toolConfig: {
						functionCallingConfig: make({ mode: "ANY", allowedFunctionNames: ["lookup"] }, () => {
							counted(reads, "toJSON");
							return hook();
						}),
					},
				},
			});
			const toNone = () => ({ mode: "NONE" });
			const CASES = [
				['pii "redact" and an e-mail address in the prompt', "redact", `write to ${EMAIL}`],
				['pii "redact" and a clean prompt', "redact", "go"],
				["no redaction", undefined, `write to ${EMAIL}`],
			] as const;

			for (const [backend, vertex] of BACKENDS) {
				for (const [name, pii, prompt] of CASES) {
					it(`${method} on ${backend}, ${name}: ${shape} returning mode NONE is honoured as the SDK honours it, and runs once`, async () => {
						const rawReads: Reads = {};
						const govReads: Reads = {};
						const nativePrompt = pii === "redact" && prompt !== "go" ? "[REDACTED:email]" : prompt;
						const { raw, rawResult, gov, govResult, auditKinds } = await nativeThenGoverned(
							method,
							{
								native: hooked(nativePrompt, toNone, rawReads),
								governed: hooked(prompt, toNone, govReads),
							},
							{ vertex, ...(pii !== undefined ? { pii } : {}) },
						);

						expect(rawResult).toBe("ok");
						expect(govResult).toBe("ok");
						expect(raw.requests).toHaveLength(1);
						expect(gov.requests).toHaveLength(1);
						// Vertex AI passes the object to JSON.stringify, which runs the hook; the Gemini API reads fields by name
						expect(raw.requests[0]?.body["toolConfig"]).toEqual({
							functionCallingConfig: vertex
								? { mode: "NONE" }
								: { mode: "ANY", allowedFunctionNames: ["lookup"] },
						});
						expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
						expect(auditKinds).not.toContain("policy_denied");
						// the hook is caller code: on Vertex AI the SDK runs it once per request, and so does the snapshot
						expect(rawReads).toEqual(vertex ? { toJSON: 1 } : {});
						if (vertex) {
							expect(govReads).toEqual(rawReads);
						} else {
							// the Gemini API never runs it; the governor's own JSON.stringify of a request (serializeRequest, for
							// its 1-hour cache check, not what a Google call sends) runs an own hook the copy carries, once
							expect(govReads.toJSON ?? 0).toBeLessThanOrEqual(1);
						}
					});
				}
			}

			it(`${method} on Vertex AI, pii "redact", ${shape} whose output holds an e-mail address: it is sent REDACTED, never raw`, async () => {
				const withEmail = (name: string) => () => ({ mode: "ANY", allowedFunctionNames: [name] });
				const { raw, rawResult, gov, govResult } = await nativeThenGoverned(
					method,
					{
						native: hooked("[REDACTED:email]", withEmail("[REDACTED:email]"), {}),
						governed: hooked(`write to ${EMAIL}`, withEmail(EMAIL), {}),
					},
					{ vertex: true, pii: "redact" },
				);

				expect(rawResult).toBe("ok");
				expect(govResult).toBe("ok");
				expect(gov.requests).toHaveLength(1);
				expect(JSON.stringify(gov.requests)).not.toContain(EMAIL);
				expect(gov.requests[0]?.body["toolConfig"]).toEqual({
					functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["[REDACTED:email]"] },
				});
				expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
			});

			const NON_OBJECT: Array<[string, () => unknown, unknown]> = [
				["a string", () => "NONE", { functionCallingConfig: "NONE" }],
				["undefined", () => undefined, {}],
			];
			for (const [what, hook, sent] of NON_OBJECT) {
				it(`${method} on Vertex AI: ${shape} returning ${what} sends what the SDK sends`, async () => {
					const p = hooked("go", hook, {});
					const { raw, rawResult, gov, govResult } = await nativeThenGoverned(
						method,
						{ native: p, governed: p },
						{ vertex: true },
					);

					expect(rawResult).toBe("ok");
					expect(govResult).toBe("ok");
					expect(raw.requests[0]?.body["toolConfig"]).toEqual(sent);
					expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
				});
			}

			it(`${method} on Vertex AI: ${shape} returning null (sent as null natively, which the request converter would drop from a copy) is refused as "can't tell", no provider request`, async () => {
				const p = hooked("go", () => null, {});
				const { raw, rawResult, gov, govResult, auditKinds } = await nativeThenGoverned(
					method,
					{ native: p, governed: p },
					{ vertex: true },
				);

				expect(rawResult).toBe("ok");
				expect(raw.requests[0]?.body["toolConfig"]).toEqual({ functionCallingConfig: null });
				expect(govResult).toContain(
					`models.${method} could not be checked for automatic function calling (params.config.toolConfig.functionCallingConfig cannot be copied as data)`,
				);
				expect(auditKinds).toEqual(["policy_denied"]);
				expect(gov.requests).toHaveLength(0);
			});

			it(`${method} on Vertex AI: ${shape} that THROWS fails natively and is refused governed, no provider request either way`, async () => {
				const p = hooked(
					"go",
					() => {
						throw new Error("toJSON hook threw");
					},
					{},
				);
				const { raw, rawResult, gov, govResult, auditKinds } = await nativeThenGoverned(
					method,
					{ native: p, governed: p },
					{ vertex: true },
				);

				expect(rawResult).toContain("toJSON hook threw");
				expect(raw.requests).toHaveLength(0);
				expect(govResult).toContain(
					`models.${method} could not be checked for automatic function calling (params.config.toolConfig.functionCallingConfig cannot be copied as data)`,
				);
				expect(auditKinds).toEqual(["policy_denied"]);
				expect(gov.requests).toHaveLength(0);
			});
		}

		// The SDK reads toolConfig and functionCallingConfig (by name on the Gemini API, by JSON.stringify on Vertex AI)
		// only in its request converters, after findAfcIncompatibleToolIndexes and after every tool's converter.
		const LATE_HOOKS: Array<[string, boolean, (reads: Reads, empty: () => void) => Loose]> = [
			[
				"a functionCallingConfig toJSON hook",
				true,
				(reads, empty) => ({
					functionCallingConfig: Object.defineProperty({ mode: "ANY" }, "toJSON", {
						value: () => {
							counted(reads, "toJSON");
							empty();
							return { mode: "ANY" };
						},
						enumerable: false,
					}),
				}),
			],
			[
				"a functionCallingConfig mode getter",
				false,
				(reads, empty) => ({
					functionCallingConfig: withGetter({}, "mode", reads, () => {
						empty();
						return "ANY";
					}),
				}),
			],
			[
				"a toolConfig retrievalConfig getter",
				false,
				(reads, empty) =>
					withGetter({}, "retrievalConfig", reads, () => {
						empty();
						return undefined;
					}),
			],
		];
		for (const [hook, vertexOnly, makeToolConfig] of LATE_HOOKS) {
			for (const [backend, vertex] of BACKENDS) {
				if (vertexOnly && !vertex) continue;
				it(`${method} on ${backend}: ${hook} that empties a plain tool's declarations runs after the tools are read: the SDK's own local rejection beside a callable tool, no provider request`, async () => {
					const rawReads: Reads = {};
					const govReads: Reads = {};
					const params = (reads: Reads) => () => {
						const declarations: Loose[] = [{ name: "lookup" }];
						return {
							model: "gemini-2.5-flash",
							contents: "go",
							config: {
								tools: [{ functionDeclarations: declarations }, wireCallable()],
								toolConfig: makeToolConfig(reads, () => {
									declarations.length = 0;
								}),
							},
						};
					};
					const { raw, rawResult, gov, govResult } = await nativeThenGoverned(
						method,
						{ native: params(rawReads), governed: params(govReads) },
						{ vertex },
					);

					// natively findAfcIncompatibleToolIndexes rejects before any converter reads toolConfig
					expect(rawResult).toContain("Incompatible tools found at tools[0]");
					expect(raw.requests).toHaveLength(0);
					expect(gov.requests).toHaveLength(0);
					expect(rawReads).toEqual({});
					// the snapshot reads it once, after every tool field was captured
					expect(Object.values(govReads)).toEqual([1]);
					if (method === "generateContent") {
						expect(govResult).toBe(rawResult);
					} else {
						expect(govResult).toContain(`models.${method} with automatic function calling`);
					}
				});
			}
		}

		it(`${method} on Vertex AI, pii "redact": a functionCallingConfig toJSON read after the tools still runs once, and its output is sent redacted`, async () => {
			const rawReads: Reads = {};
			const govReads: Reads = {};
			const params = (reads: Reads, prompt: string, name: string) => () => ({
				model: "gemini-2.5-flash",
				contents: prompt,
				config: {
					tools: [{ functionDeclarations: [{ name: "lookup" }] }, { googleSearch: {} }],
					toolConfig: {
						functionCallingConfig: Object.defineProperty({ mode: "ANY" }, "toJSON", {
							value: () => {
								counted(reads, "toJSON");
								return { mode: "ANY", allowedFunctionNames: [name] };
							},
							enumerable: false,
						}),
					},
				},
			});
			const { raw, rawResult, gov, govResult } = await nativeThenGoverned(
				method,
				{
					native: params(rawReads, "[REDACTED:email]", "[REDACTED:email]"),
					governed: params(govReads, `write to ${EMAIL}`, EMAIL),
				},
				{ vertex: true, pii: "redact" },
			);

			expect(rawResult).toBe("ok");
			expect(govResult).toBe("ok");
			expect(gov.requests).toHaveLength(1);
			expect(JSON.stringify(gov.requests)).not.toContain(EMAIL);
			expect(gov.requests[0]?.body).toEqual(raw.requests[0]?.body);
			expect(rawReads).toEqual({ toJSON: 1 });
			expect(govReads).toEqual(rawReads);
		});

		it(`${method}: a toolConfig getter that clears a callable tool's callTool, and restores it a moment later, is refused as "can't tell": never one governed call over the SDK's own loop`, async () => {
			const params = () => {
				const callable: Loose = wireCallable();
				const callTool = callable["callTool"];
				return {
					model: "gemini-2.5-flash",
					contents: "go",
					config: {
						tools: [callable],
						toolConfig: withGetter({}, "retrievalConfig", {}, () => {
							callable["callTool"] = undefined;
							queueMicrotask(() => {
								callable["callTool"] = callTool;
							});
							return undefined;
						}),
					},
				};
			};
			const { gov, govResult, auditKinds } = await nativeThenGoverned(method, {
				native: params,
				governed: params,
			});

			expect(govResult).toContain(
				`models.${method} could not be checked for automatic function calling`,
			);
			expect(auditKinds).toEqual(["policy_denied"]);
			expect(gov.requests).toHaveLength(0);
		});
	}

	// With `config.tools` set, the SDK sends `Object.assign({}, params.config, { tools })` (processParamsMaybeAddMcpUsage),
	// and its request converters read THAT copy: an inherited or non-enumerable config field is never sent. Without tools it
	// passes `params` through, and the converters read every config field by name.
	describe("with config.tools set, config reaches the provider as the SDK copies it (own enumerable fields only); without, every field by name", () => {
		const SEARCH = () => [{ googleSearch: {} }];
		const SYSTEM_INSTRUCTION = `Reply to ${EMAIL} only`;
		const JSON_SCHEMA = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" };

		/** A config class whose `systemInstruction` is a PROTOTYPE getter. */
		class InstructedConfig {
			get systemInstruction(): string {
				return SYSTEM_INSTRUCTION;
			}
		}

		const request = (config: object) => ({ model: "gemini-2.5-flash", contents: "go", config });

		/** The same config for the native and the governed call, each built with its own read counter. */
		function sameConfig(makeConfig: (reads: Reads) => object) {
			const rawReads: Reads = {};
			const govReads: Reads = {};
			return {
				rawReads,
				govReads,
				params: {
					native: () => request(makeConfig(rawReads)),
					governed: () => request(makeConfig(govReads)),
				},
			};
		}

		type Outcome = Awaited<ReturnType<typeof nativeThenGoverned>>;

		/** Both calls succeed with one provider request each, and the governed body is the native one. */
		function expectSameRequest(r: Outcome): void {
			expect(r.rawResult).toBe("ok");
			expect(r.govResult).toBe("ok");
			expect(r.raw.requests).toHaveLength(1);
			expect(r.gov.requests).toHaveLength(1);
			expect(r.gov.requests[0]?.body).toEqual(r.raw.requests[0]?.body);
		}

		/** Refused like every request that cannot be checked: one policy_denied, nothing charged, no provider request. */
		function expectRefused(r: Outcome, method: WireMethod): void {
			expect(r.govResult).toContain(
				`models.${method} could not be checked for automatic function calling`,
			);
			expect(r.auditKinds).toEqual(["policy_denied"]);
			expect(r.gov.requests).toHaveLength(0);
		}

		for (const method of ["generateContent", "generateContentStream"] as const) {
			for (const [backend, vertex] of BACKENDS) {
				const on = `${method} on ${backend}`;

				it(`${on}, pii "redact": an INHERITED systemInstruction getter beside tools is not sent, as natively (a clean prompt, so no redaction runs)`, async () => {
					const t = sameConfig(() => Object.assign(new InstructedConfig(), { tools: SEARCH() }));
					const r = await nativeThenGoverned(method, t.params, { vertex, pii: "redact" });

					expectSameRequest(r);
					expect(r.raw.requests[0]?.body).not.toHaveProperty("systemInstruction");
					expect(JSON.stringify(r.gov.requests)).not.toContain(EMAIL);
				});

				it(`${on}: the same INHERITED systemInstruction getter WITHOUT tools is sent, as natively (control: read by name)`, async () => {
					const t = sameConfig(() => new InstructedConfig());
					const r = await nativeThenGoverned(method, t.params, { vertex });

					expectSameRequest(r);
					expect(JSON.stringify(r.raw.requests[0]?.body["systemInstruction"])).toContain(EMAIL);
				});

				it(`${on}: tools [] (truthy, empty) still makes the SDK copy config: the INHERITED systemInstruction is not sent`, async () => {
					const t = sameConfig(() => Object.assign(new InstructedConfig(), { tools: [] }));
					const r = await nativeThenGoverned(method, t.params, { vertex });

					expectSameRequest(r);
					expect(r.raw.requests[0]?.body).not.toHaveProperty("systemInstruction");
				});

				it(`${on}: a NON-ENUMERABLE own systemInstruction beside tools is not sent, as natively`, async () => {
					const t = sameConfig(() =>
						Object.defineProperty({ tools: SEARCH() }, "systemInstruction", {
							value: SYSTEM_INSTRUCTION,
							enumerable: false,
						}),
					);
					const r = await nativeThenGoverned(method, t.params, { vertex });

					expectSameRequest(r);
					expect(r.raw.requests[0]?.body).not.toHaveProperty("systemInstruction");
				});

				it(`${on}: an INHERITED toolConfig getter beside tools is never run and not sent, as natively`, async () => {
					const t = sameConfig((reads) => {
						class ToolConfigured {
							get toolConfig(): Loose {
								counted(reads, "toolConfig");
								return { functionCallingConfig: { mode: "NONE" } };
							}
						}
						return Object.assign(new ToolConfigured(), { tools: SEARCH() });
					});
					const r = await nativeThenGoverned(method, t.params, { vertex });

					expectSameRequest(r);
					expect(r.raw.requests[0]?.body).not.toHaveProperty("toolConfig");
					expect(t.rawReads).toEqual({});
					expect(t.govReads).toEqual({});
				});

				it(`${on}: an OWN ENUMERABLE toolConfig getter beside tools is sent, read once`, async () => {
					const t = sameConfig((reads) =>
						withGetter({ tools: SEARCH() }, "toolConfig", reads, () => ({
							functionCallingConfig: { mode: "NONE" },
						})),
					);
					const r = await nativeThenGoverned(method, t.params, { vertex });

					expectSameRequest(r);
					expect(r.raw.requests[0]?.body).toHaveProperty("toolConfig");
					expect(t.govReads).toEqual({ toolConfig: 1 });
				});

				it(`${on}: an OWN ENUMERABLE temperature getter beside tools is sent, read once (control)`, async () => {
					const t = sameConfig((reads) =>
						withGetter({ tools: SEARCH() }, "temperature", reads, () => 0.25),
					);
					const r = await nativeThenGoverned(method, t.params, { vertex });

					expectSameRequest(r);
					expect(r.raw.requests[0]?.body["generationConfig"]).toEqual({ temperature: 0.25 });
					expect(t.govReads).toEqual({ temperature: 1 });
				});

				const HIDDEN_HTTP_OPTIONS: Array<[string, () => object]> = [
					[
						"an INHERITED httpOptions",
						() =>
							Object.assign(Object.create({ httpOptions: { headers: { "x-test": "1" } } }), {
								tools: SEARCH(),
							}),
					],
					[
						"a NON-ENUMERABLE own httpOptions",
						() =>
							Object.defineProperty({ tools: SEARCH() }, "httpOptions", {
								value: { headers: { "x-test": "1" } },
								enumerable: false,
							}),
					],
				];
				for (const [shape, makeConfig] of HIDDEN_HTTP_OPTIONS) {
					it(`${on}: ${shape} beside tools is refused as "can't tell" (the SDK reads it by name only on its MCP path, which a process-global flag also turns on)`, async () => {
						const t = sameConfig(makeConfig);
						const r = await nativeThenGoverned(method, t.params, { vertex });

						expect(r.rawResult).toBe("ok");
						expectRefused(r, method);
					});
				}

				it(`${on}: an OWN ENUMERABLE httpOptions beside tools is sent through the copy, its header included, as natively`, async () => {
					const t = sameConfig(() => ({
						tools: SEARCH(),
						httpOptions: { headers: { "x-test": "1" } },
					}));
					const r = await nativeThenGoverned(method, t.params, { vertex });

					expectSameRequest(r);
					expect(r.raw.requests[0]?.testHeader).toBe("1");
					expect(r.gov.requests[0]?.testHeader).toBe("1");
				});

				it(`${on}: automaticFunctionCalling is read BY NAME: an INHERITED { disable: true } beside a callable tool turns the SDK's loop off, as natively`, async () => {
					const calls = { native: 0, governed: 0 };
					const config = (who: keyof typeof calls) => () =>
						request(
							Object.assign(Object.create({ automaticFunctionCalling: { disable: true } }), {
								tools: [
									{
										tool: async () => ({ functionDeclarations: [{ name: "lookup" }] }),
										callTool: async () => {
											calls[who]++;
											return [{ functionResponse: { name: "lookup", response: { ok: true } } }];
										},
									},
								],
							}),
						);
					const r = await nativeThenGoverned(
						method,
						{ native: config("native"), governed: config("governed") },
						{
							vertex,
							rounds: [{ functionCalls: [{ name: "lookup", args: {} }], text: "calling" }],
						},
					);

					// natively shouldDisableAfc reads it by name: one request, and the model's function call is not run
					expectSameRequest(r);
					expect(calls).toEqual({ native: 0, governed: 0 });
				});

				it(`${on}: tools is read BY NAME: an INHERITED tools getter is sent, as natively`, async () => {
					const t = sameConfig(() => {
						class ToolsConfig {
							get tools(): Loose[] {
								return SEARCH();
							}
						}
						return new ToolsConfig();
					});
					const r = await nativeThenGoverned(method, t.params, { vertex });

					expectSameRequest(r);
					expect(r.raw.requests[0]?.body["tools"]).toEqual([{ googleSearch: {} }]);
				});

				if (method === "generateContentStream") {
					it(`${on}: an INHERITED responseSchema holding $schema beside tools is MOVED before the SDK's copy and sent as responseJsonSchema, as natively (read once)`, async () => {
						const t = sameConfig((reads) => {
							class SchemaConfig {
								get responseSchema(): Loose {
									counted(reads, "responseSchema");
									return JSON_SCHEMA;
								}
							}
							return Object.assign(new SchemaConfig(), { tools: SEARCH() });
						});
						const r = await nativeThenGoverned(method, t.params, { vertex });

						expectSameRequest(r);
						expect(r.raw.requests[0]?.body["generationConfig"]).toEqual({
							responseJsonSchema: JSON_SCHEMA,
						});
						expect(t.govReads).toEqual({ responseSchema: 1 });
					});
				}

				it(`${on}: an own responseSchema holding $schema beside an INHERITED truthy responseJsonSchema and tools: ${
					method === "generateContentStream"
						? `refused as "can't tell" (natively nothing moves, but the SDK would move it on the copy)`
						: "the SDK moves after its copy, so the same body as natively"
				}`, async () => {
					const t = sameConfig(() =>
						Object.assign(Object.create({ responseJsonSchema: { type: "string" } }), {
							tools: SEARCH(),
							responseSchema: JSON_SCHEMA,
						}),
					);
					const r = await nativeThenGoverned(method, t.params, { vertex });

					expect(r.rawResult).toBe("ok");
					expect(r.raw.requests[0]?.body["generationConfig"]).not.toHaveProperty(
						"responseJsonSchema",
					);
					if (method === "generateContentStream") {
						expectRefused(r, method);
					} else {
						expectSameRequest(r);
					}
				});

				it(`${on}: the copy does not keep the caller's prototype: a #private-backed INHERITED responseSchema getter is never re-read through it (the SDK reads responseSchema by name), the same body as natively`, async () => {
					const t = sameConfig(() => {
						class PrivateSchemaConfig {
							readonly #schema = JSON_SCHEMA;
							get responseSchema(): Loose {
								return this.#schema; // throws on any receiver but the instance
							}
						}
						return Object.assign(new PrivateSchemaConfig(), { tools: SEARCH() });
					});
					const r = await nativeThenGoverned(method, t.params, { vertex });

					expectSameRequest(r);
				});

				if (method === "generateContent") {
					it(`${on}: an INHERITED responseSchema holding $schema beside tools is not sent at all, as natively (the move comes after the SDK's copy)`, async () => {
						const t = sameConfig(() =>
							Object.assign(Object.create({ responseSchema: JSON_SCHEMA }), { tools: SEARCH() }),
						);
						const r = await nativeThenGoverned(method, t.params, { vertex });

						expectSameRequest(r);
						expect(r.raw.requests[0]?.body["generationConfig"]).toEqual({});
					});
				}

				// The SDK reads `config` in a different ORDER per method. generateContentStream: maybeMoveToResponseJsonSchem
				// (responseSchema, then responseJsonSchema), then shouldDisableAfc (automaticFunctionCalling, then tools), then
				// processParamsMaybeAddMcpUsage (tools, then the copy). generateContent: processParamsMaybeAddMcpUsage first, then
				// maybeMoveToResponseJsonSchem, whose writes come after the copy but whose READS still happen.
				if (method === "generateContent") {
					const THROWING_SCHEMA: Array<[string, () => object]> = [
						[
							"an INHERITED",
							() => {
								class ThrowingSchemaConfig {
									get responseSchema(): never {
										throw new Error("responseSchema getter threw");
									}
								}
								return Object.assign(new ThrowingSchemaConfig(), { tools: SEARCH() });
							},
						],
						[
							"a NON-ENUMERABLE own",
							() =>
								Object.defineProperty({ tools: SEARCH() }, "responseSchema", {
									get: () => {
										throw new Error("responseSchema getter threw");
									},
									enumerable: false,
								}),
						],
					];
					for (const [shape, makeConfig] of THROWING_SCHEMA) {
						it(`${on}: ${shape} responseSchema getter that throws beside tools fails natively (maybeMoveToResponseJsonSchem reads it after the copy) and is refused governed, no request either way`, async () => {
							const r = await nativeThenGoverned(method, sameConfig(makeConfig).params, { vertex });

							expect(r.rawResult).toContain("responseSchema getter threw");
							expect(r.raw.requests).toHaveLength(0);
							expectRefused(r, method);
						});
					}
				}

				it(`${on}: a tools getter that turns automaticFunctionCalling.disable off before it returns a callable tool: ${
					method === "generateContentStream"
						? "the stream reads automaticFunctionCalling BEFORE tools, so AFC stays off: one stream request, as natively, not refused"
						: "generateContent reads tools BEFORE automaticFunctionCalling, so AFC is on: the same requests and tool calls as natively"
				}`, async () => {
					const calls = { native: 0, governed: 0 };
					const params = (who: keyof typeof calls) => () => {
						const afc: Loose = { disable: true };
						const callable = {
							tool: async () => ({ functionDeclarations: [{ name: "lookup" }] }),
							callTool: async () => {
								calls[who]++;
								return [{ functionResponse: { name: "lookup", response: { ok: true } } }];
							},
						};
						return request(
							withGetter({ automaticFunctionCalling: afc }, "tools", {}, () => {
								afc["disable"] = false;
								return [callable];
							}),
						);
					};
					const r = await nativeThenGoverned(
						method,
						{ native: params("native"), governed: params("governed") },
						{
							vertex,
							rounds: [
								{ functionCalls: [{ name: "lookup", args: {} }], text: "calling" },
								{ text: "done" },
							],
						},
					);

					expect(r.rawResult).toBe("ok");
					expect(r.govResult).toBe("ok");
					expect(r.gov.requests.map((q) => q.body)).toEqual(r.raw.requests.map((q) => q.body));
					expect(calls.governed).toBe(calls.native);
					if (method === "generateContentStream") {
						expect(r.raw.requests).toHaveLength(1);
						expect(calls.native).toBe(0);
					} else {
						expect(r.raw.requests).toHaveLength(2);
						expect(calls.native).toBe(1);
					}
				});

				// maybeMoveToResponseJsonSchem also runs `Object.keys(responseSchema)` when responseSchema is truthy and
				// responseJsonSchema falsy: on a Proxy, that runs its `ownKeys` trap.
				const keysThrow = () =>
					new Proxy(
						{},
						{
							ownKeys() {
								throw new Error("ownKeys trap threw");
							},
						},
					);
				const HIDDEN_SCHEMA: Array<[string, (schema: () => object) => object]> = [
					[
						"an INHERITED",
						(schema) =>
							Object.assign(Object.create({ responseSchema: schema() }), { tools: SEARCH() }),
					],
					[
						"a NON-ENUMERABLE own",
						(schema) =>
							Object.defineProperty({ tools: SEARCH() }, "responseSchema", {
								value: schema(),
								enumerable: false,
							}),
					],
				];
				for (const [shape, withSchema] of HIDDEN_SCHEMA) {
					it(`${on}: ${shape} responseSchema whose Object.keys throws (a Proxy's ownKeys trap) beside tools fails natively and is refused governed, no request either way`, async () => {
						const r = await nativeThenGoverned(
							method,
							sameConfig(() => withSchema(keysThrow)).params,
							{ vertex },
						);

						expect(r.rawResult).toContain("ownKeys trap threw");
						expect(r.raw.requests).toHaveLength(0);
						expectRefused(r, method);
					});

					if (method === "generateContent") {
						it(`${on}: ${shape} PLAIN responseSchema (no $schema) beside tools is read and goes through: the same body as natively, no schema sent (control)`, async () => {
							const r = await nativeThenGoverned(
								method,
								sameConfig(() => withSchema(() => ({ type: "object" }))).params,
								{ vertex },
							);

							expectSameRequest(r);
							expect(r.raw.requests[0]?.body["generationConfig"]).toEqual({});
						});
					}
				}

				for (const withTools of [true, false]) {
					const beside = withTools ? "beside tools" : "WITHOUT tools";
					it(`${on}: an OWN ENUMERABLE responseSchema whose Object.keys throws ${beside} fails as natively: the snapshot forwards it and the SDK inspects it once, itself; no request either way (control)`, async () => {
						const r = await nativeThenGoverned(
							method,
							sameConfig(() => ({
								...(withTools ? { tools: SEARCH() } : {}),
								responseSchema: keysThrow(),
							})).params,
							{ vertex },
						);

						expect(r.rawResult).toContain("ownKeys trap threw");
						expect(r.raw.requests).toHaveLength(0);
						expect(r.govResult).toBe(r.rawResult);
						expect(r.gov.requests).toHaveLength(0);
					});

					if (method === "generateContentStream") {
						it(`${on}: an OWN ENUMERABLE responseSchema whose ownKeys answers differently on each call ${beside}: the snapshot makes no inspection of its own (one more trap call than natively: the governor's cost estimate, as on master)`, async () => {
							const calls = { native: 0, governed: 0 };
							const params = (who: keyof typeof calls) => () => {
								const schema = new Proxy(
									{ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
									{
										ownKeys(target) {
											calls[who]++;
											// the first inspection sees no $schema; any later one does
											return calls[who] === 1 ? ["type"] : Reflect.ownKeys(target);
										},
									},
								);
								return request({
									...(withTools ? { tools: SEARCH() } : {}),
									responseSchema: schema,
								});
							};
							const r = await nativeThenGoverned(
								method,
								{ native: params("native"), governed: params("governed") },
								{ vertex },
							);

							expect(r.rawResult).toBe("ok");
							expect(r.govResult).toBe("ok");
							// interceptCall's cost estimate serializes the request (serializeRequest's JSON.stringify) before
							// the SDK runs: one inspection outside the snapshot, made on master too, which a trap that
							// answers differently each time sees first. The snapshot adds none: the SDK's own inspection of
							// the forwarded schema is the only other one, as natively.
							expect(calls.governed).toBe(calls.native + 1);
						});
					}
				}

				// generateContent's processParamsMaybeAddMcpUsage reads every tools ENTRY (`tools.map`) before it copies the
				// config, and holds its own mapped array from then on; maybeMoveToResponseJsonSchem comes after.
				it(`${on}: tools [] and a hidden responseSchema whose Object.keys APPENDS a tool to the caller's tools array: ${
					method === "generateContent"
						? "the SDK already holds its own mapped array, so the appended tool is not sent"
						: "the stream's Object.keys runs first, so the SDK reads the appended tool"
				}; the same body as natively`, async () => {
					const t = sameConfig(() => {
						const tools: Loose[] = [];
						const appending = new Proxy(
							{},
							{
								ownKeys() {
									tools.push({ googleSearch: {} });
									return [];
								},
							},
						);
						return Object.assign(Object.create({ responseSchema: appending }), { tools });
					});
					const r = await nativeThenGoverned(method, t.params, { vertex });

					expectSameRequest(r);
					expect(r.raw.requests[0]?.body["tools"]).toEqual(
						method === "generateContent" ? [] : [{ googleSearch: {} }],
					);
				});

				it(`${on}, pii "redact": a tools[0] getter that deletes config.systemInstruction runs before the SDK's copy, so it is not sent, as natively`, async () => {
					const t = sameConfig(() => {
						const config: Loose = { systemInstruction: `Reply to ${EMAIL} only` };
						const tools: Loose[] = [];
						Object.defineProperty(tools, "0", {
							get: () => {
								delete config["systemInstruction"];
								return { googleSearch: {} };
							},
							enumerable: true,
							configurable: true,
						});
						config["tools"] = tools;
						return config;
					});
					const r = await nativeThenGoverned(method, t.params, { vertex, pii: "redact" });

					expectSameRequest(r);
					expect(r.raw.requests[0]?.body).not.toHaveProperty("systemInstruction");
					expect(JSON.stringify(r.gov.requests)).not.toContain(EMAIL);
				});

				// The WHOLE first-touch sequence, recorded from the SDK itself: every getter and trap the SDK runs on config,
				// tools, the entries, automaticFunctionCalling and a data tool, first touches only (a repeat is the SDK
				// reading again; the snapshot reads once). `tool()` is not recorded: the snapshot never calls it (the governed
				// call asks it lazily, after authorization; its count is pinned by its own row).
				const SEQUENCES: Array<{
					name: string;
					only: WireMethod;
					callable: boolean;
					/** What is instrumented; each exclusion is a declared difference, named where the shape is chosen. */
					afc: "none" | "disable" | "both";
					declarationsGetter: boolean;
					toolConfigGetter: boolean;
				}> = [
					// Natively generateContent reads automaticFunctionCalling only beside a callable tool; the snapshot reads it
					// either way. So the plain shape has none.
					{
						name: "a plain tool",
						only: "generateContent",
						callable: false,
						afc: "none",
						declarationsGetter: true,
						toolConfigGetter: true,
					},
					{
						name: "a callable tool beside a plain one",
						only: "generateContent",
						callable: true,
						afc: "both",
						declarationsGetter: true,
						toolConfigGetter: true,
					},
					// Without a callable tool, shouldDisableAfc returns before it reads maximumRemoteCalls; the snapshot copies
					// automaticFunctionCalling whole at its read. So maximumRemoteCalls is plain data here.
					{
						name: "a plain tool",
						only: "generateContentStream",
						callable: false,
						afc: "disable",
						declarationsGetter: true,
						toolConfigGetter: true,
					},
					// A refused AFC stream: natively it reads maximumRemoteCalls after tools, then
					// findAfcIncompatibleToolIndexes' functionDeclarations and the streamFunctionCallArguments toolConfig, all
					// before its copy, an order the snapshot does not model. Those three are left uninstrumented.
					{
						name: "a callable tool beside a plain one (a refused AFC stream)",
						only: "generateContentStream",
						callable: true,
						afc: "disable",
						declarationsGetter: false,
						toolConfigGetter: false,
					},
				];
				for (const shape of SEQUENCES) {
					if (shape.only !== method) continue;
					it(`${on}, ${shape.name}: the governed first-touch sequence of the request's getters and traps is the SDK's own`, async () => {
						const logs = { native: [] as string[], governed: [] as string[] };
						const params = (log: string[]) => () => {
							const touch = <T>(key: string, value: T): T => {
								log.push(key);
								return value;
							};
							const getter = (target: object, key: string, label: string, value: () => unknown) =>
								Object.defineProperty(target, key, {
									get: () => touch(label, value()),
									enumerable: true,
									configurable: true,
								});
							// `disable` first, as shouldDisableAfc reads it first
							const afc: Loose = {};
							if (shape.afc !== "none")
								getter(afc, "disable", "automaticFunctionCalling.disable", () => false);
							if (shape.afc === "both") {
								getter(
									afc,
									"maximumRemoteCalls",
									"automaticFunctionCalling.maximumRemoteCalls",
									() => 10,
								);
							} else {
								afc["maximumRemoteCalls"] = 10;
							}
							const schema = new Proxy(
								{},
								{
									ownKeys() {
										touch("responseSchema.ownKeys", undefined);
										return [];
									},
								},
							);
							const inherited: Loose = { responseJsonSchema: undefined };
							getter(inherited, "responseSchema", "responseSchema", () => schema);
							if (shape.afc !== "none") {
								getter(
									inherited,
									"automaticFunctionCalling",
									"automaticFunctionCalling",
									() => afc,
								);
							}
							const plain: Loose = { googleSearch: {} };
							const last = shape.callable ? 1 : 0;
							if (shape.declarationsGetter) {
								getter(
									plain,
									"functionDeclarations",
									`tools[${last}].functionDeclarations`,
									() => undefined,
								);
							}
							const entries = shape.callable ? [wireCallable(), plain] : [plain];
							const tools: unknown[] = [];
							for (const [i, entry] of entries.entries())
								getter(tools, String(i), `tools[${i}]`, () => entry);
							const config: Loose = Object.create(inherited);
							getter(config, "temperature", "temperature", () => 0.25);
							getter(config, "tools", "tools", () => tools);
							if (shape.toolConfigGetter) getter(config, "toolConfig", "toolConfig", () => ({}));
							else config["toolConfig"] = {};
							return request(config);
						};
						const r = await nativeThenGoverned(
							method,
							{ native: params(logs.native), governed: params(logs.governed) },
							{ vertex },
						);
						const firstTouches = (log: string[]) => log.filter((key, i) => log.indexOf(key) === i);

						expect(r.rawResult).toBe("ok");
						if (method === "generateContentStream" && shape.callable) {
							expect(r.govResult).toContain(`models.${method} with automatic function calling`);
						} else {
							expect(r.govResult).toBe("ok");
							expect(r.gov.requests.map((q) => q.body)).toEqual(r.raw.requests.map((q) => q.body));
						}
						if (method === "generateContentStream") {
							// The ONE declared difference: the stream's own Object.keys (needed only where the SDK will not
							// inspect the schema itself) depends on `tools`, so it runs after `tools` and before the entries,
							// where natively it runs first. Every other touch is in the SDK's order.
							const KEYS = "responseSchema.ownKeys";
							const governed = firstTouches(logs.governed);
							expect(firstTouches(logs.native).indexOf(KEYS)).toBe(1);
							expect(governed.indexOf(KEYS)).toBe(governed.indexOf("tools") + 1);
							expect(governed.indexOf("tools[0]")).toBe(governed.indexOf(KEYS) + 1);
							const without = (log: string[]) => firstTouches(log).filter((key) => key !== KEYS);
							expect(without(logs.governed)).toEqual(without(logs.native));
						} else {
							expect(firstTouches(logs.governed)).toEqual(firstTouches(logs.native));
						}
					});
				}

				it(`${on}: a callable tool's tool() is asked as often as on master (1 on generateContent's governed loop; 0 on the stream, which is refused)`, async () => {
					const asked = { native: 0, governed: 0 };
					const params = (who: keyof typeof asked) => () =>
						request({
							tools: [
								{
									tool: async () => {
										asked[who]++;
										return { functionDeclarations: [{ name: "lookup" }] };
									},
									callTool: async () => [
										{ functionResponse: { name: "lookup", response: { ok: true } } },
									],
								},
							],
						});
					const r = await nativeThenGoverned(
						method,
						{ native: params("native"), governed: params("governed") },
						{
							vertex,
							rounds: [
								{ functionCalls: [{ name: "lookup", args: {} }], text: "calling" },
								{ text: "done" },
							],
						},
					);

					// measured on master (7633eee2) with this same request: 1 and 0
					if (method === "generateContent") {
						expect(r.govResult).toBe("ok");
						expect(asked.governed).toBe(1);
						expect(r.gov.requests).toHaveLength(2);
					} else {
						expect(r.govResult).toContain(`models.${method} with automatic function calling`);
						expect(asked.governed).toBe(0);
						expect(r.gov.requests).toHaveLength(0);
					}
				});

				// generateContent reads automaticFunctionCalling only beside a callable tool (`!hasCallableTools(params) ||
				// shouldDisableAfc(...)`), and the snapshot reads it either way, so its row carries one.
				const ORDER_TOOLS: Array<[string, () => unknown[]]> =
					method === "generateContent"
						? [["a callable tool", () => [wireCallable()]]]
						: [["a plain tool", SEARCH]];
				for (const [tool, makeTools] of ORDER_TOOLS) {
					it(`${on}, ${tool}: config fields are FIRST read in the SDK's order for this method (the order recorded from the SDK itself)`, async () => {
						const logs = { native: [] as string[], governed: [] as string[] };
						const params = (log: string[]) => () => {
							const read = <T>(key: string, value: T): T => {
								log.push(key);
								return value;
							};
							class OrderedConfig {
								get responseSchema(): Loose {
									return read("responseSchema", { type: "object" });
								}
								get automaticFunctionCalling(): Loose {
									return read("automaticFunctionCalling", {});
								}
							}
							const config = new OrderedConfig();
							Object.defineProperty(config, "temperature", {
								get: () => read("temperature", 0.25),
								enumerable: true,
								configurable: true,
							});
							Object.defineProperty(config, "tools", {
								get: () => read("tools", makeTools()),
								enumerable: true,
								configurable: true,
							});
							return request(config);
						};
						const r = await nativeThenGoverned(
							method,
							{ native: params(logs.native), governed: params(logs.governed) },
							{ vertex },
						);
						const firstReads = (log: string[]) => log.filter((key, i) => log.indexOf(key) === i);

						expect(r.rawResult).toBe("ok");
						expect(r.govResult).toBe("ok");
						expect(r.gov.requests.map((q) => q.body)).toEqual(r.raw.requests.map((q) => q.body));
						expect(firstReads(logs.native).length).toBeGreaterThan(0);
						expect(firstReads(logs.governed)).toEqual(firstReads(logs.native));
					});
				}
			}
		}
	});
});
