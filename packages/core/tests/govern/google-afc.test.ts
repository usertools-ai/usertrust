import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trust } from "../../src/govern.js";
import { resolveGooglePipeline, snapshotGoogleRequest } from "../../src/google-request.js";

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
 * A `@google/genai` `Models` that behaves like the real one where it matters here: with a callable tool and AFC on,
 * `generateContent` LOOPS over its own internal model call (a method the governor does not trap) and returns only the
 * last round's response. `rounds` scripts the model: round N answers with `rounds[N]`.
 */
type Loose = Record<string, unknown>;
/** The slice of a Gemini response the fake SDK loop reads. */
type Resp = {
	functionCalls?: unknown[];
	candidates: Array<{ content: { parts: Array<{ text?: string }> } }>;
	automaticFunctionCallingHistory?: unknown;
	[k: string]: unknown;
};
type Tool = { callTool?: (calls: unknown[]) => Promise<unknown[]> };

interface Round {
	functionCalls?: unknown[];
	prompt: number;
	output: number;
}

function sdkLikeClient(rounds: Round[]) {
	let internalCalls = 0;
	const seen: Array<Record<string, unknown>> = [];
	const internal = async (params: Record<string, unknown>) => {
		seen.push(params);
		const r = rounds[Math.min(internalCalls, rounds.length - 1)] as Round;
		internalCalls++;
		return {
			candidates: [{ content: { role: "model", parts: [{ text: `round ${internalCalls}` }] } }],
			...(r.functionCalls ? { functionCalls: r.functionCalls } : {}),
			usageMetadata: {
				promptTokenCount: r.prompt,
				candidatesTokenCount: r.output,
				totalTokenCount: r.prompt + r.output,
			},
		} as Record<string, unknown>;
	};
	const toolCalls: unknown[][] = [];
	const models = {
		generateContent: async (params: Loose) => {
			const config = (params["config"] ?? {}) as Loose;
			const tools = (config["tools"] ?? []) as Tool[];
			const afcCfg = (config["automaticFunctionCalling"] ?? {}) as Loose;
			const afcOn =
				afcCfg["disable"] !== true && tools.some((t) => typeof t.callTool === "function");
			if (!afcOn) return internal(params);
			let response: Resp = { candidates: [] };
			let contents: unknown[] = Array.isArray(params["contents"]) ? [...params["contents"]] : [];
			const history = [...contents];
			const max = (afcCfg["maximumRemoteCalls"] as number | undefined) ?? 10;
			let remote = 0;
			while (remote < max) {
				response = (await internal({ ...params, contents })) as Resp;
				if (!response.functionCalls || response.functionCalls.length === 0) break;
				const parts: unknown[] = [];
				for (const t of tools) {
					if (typeof t.callTool === "function")
						parts.push(...(await t.callTool(response.functionCalls)));
				}
				remote++;
				const turn = response.candidates[0]?.content;
				const toolTurn = { role: "user", parts };
				contents = [...contents, turn, toolTurn];
				if (afcCfg["ignoreCallHistory"] !== true) history.push(turn, toolTurn);
			}
			if (afcCfg["ignoreCallHistory"] !== true) {
				response.automaticFunctionCallingHistory = history;
			}
			return response;
		},
	};
	const tool = {
		// a real CallableTool declares itself: the SDK (and so the governed loop) awaits this once before round 1
		tool: async () => ({ functionDeclarations: [{ name: "lookup" }] }),
		callTool: vi.fn(async (calls: unknown[]) => {
			toolCalls.push(calls);
			return [{ functionResponse: { name: "lookup", response: { ok: true } } }];
		}),
	};
	return { client: { models }, tool, internalCalls: () => internalCalls, seen, toolCalls };
}

const TWO_ROUNDS: Round[] = [
	{ functionCalls: [{ name: "lookup", args: {} }], prompt: 1000, output: 100 },
	{ prompt: 2000, output: 200 },
];

describe("Google automatic function calling is metered round by round", () => {
	let vault: string;
	beforeEach(() => {
		vault = join(tmpdir(), `trust-afc-${randomUUID()}`);
		mkdirSync(vault, { recursive: true });
	});
	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	const call = (extra: Record<string, unknown> = {}) => ({
		model: "gemini-2.5-flash",
		contents: [{ role: "user", parts: [{ text: "look it up" }] }],
		...extra,
	});

	it("a two-round tool call is billed for BOTH rounds, one governed call per round", async () => {
		const { client, tool } = sdkLikeClient(TWO_ROUNDS);
		const governed = await trust(client, { dryRun: true, budget: 500_000, vaultBase: vault });
		const out = (await governed.models.generateContent(
			call({ config: { tools: [tool] } }),
		)) as unknown as {
			response: Loose;
			receipt: { cost: number };
			receipts: Array<{ cost: number; transferId: string }>;
		};
		// gemini-2.5-flash: input 3, output 25 per 1k. Round 1: 3 + 2.5 = ceil(5.5) = 6. Round 2: 6 + 5 = 11.
		expect(out.receipts).toHaveLength(2);
		expect(out.receipts.map((r) => r.cost)).toEqual([6, 11]);
		expect(new Set(out.receipts.map((r) => r.transferId)).size).toBe(2);
		// the call as a whole cost both rounds, not the last one only
		expect(out.receipts.reduce((s, r) => s + r.cost, 0)).toBe(17);
		await governed.destroy();
	});

	it("the caller still gets the AFC result: tools ran, the last response, and the call history", async () => {
		const { client, tool } = sdkLikeClient(TWO_ROUNDS);
		const governed = await trust(client, { dryRun: true, budget: 500_000, vaultBase: vault });
		const out = (await governed.models.generateContent(
			call({ config: { tools: [tool] } }),
		)) as unknown as { response: Resp; receipt: { cost: number } };
		expect(tool.callTool).toHaveBeenCalledTimes(1);
		expect(out.response.candidates[0]?.content.parts[0]?.text).toBe("round 2");
		// original turn, the model's function call turn, the tool's reply
		expect(out.response.automaticFunctionCallingHistory).toHaveLength(3);
		expect(out.receipt.cost).toBe(11); // the envelope's own receipt is the LAST round's
		await governed.destroy();
	});

	it("ignoreCallHistory is honoured", async () => {
		const { client, tool } = sdkLikeClient(TWO_ROUNDS);
		const governed = await trust(client, { dryRun: true, budget: 500_000, vaultBase: vault });
		const out = (await governed.models.generateContent(
			call({ config: { tools: [tool], automaticFunctionCalling: { ignoreCallHistory: true } } }),
		)) as unknown as { response: Record<string, any> };
		expect(out.response.automaticFunctionCallingHistory).toBeUndefined();
		await governed.destroy();
	});

	it("maximumRemoteCalls bounds the rounds exactly as the SDK does: the last model response is returned as it is", async () => {
		const endless: Round[] = [
			{ functionCalls: [{ name: "lookup", args: {} }], prompt: 1000, output: 100 },
		];
		const { client, tool } = sdkLikeClient(endless);
		const governed = await trust(client, { dryRun: true, budget: 500_000, vaultBase: vault });
		const out = (await governed.models.generateContent(
			call({ config: { tools: [tool], automaticFunctionCalling: { maximumRemoteCalls: 2 } } }),
		)) as unknown as { receipts: unknown[] };
		expect(out.receipts).toHaveLength(2);
		expect(tool.callTool).toHaveBeenCalledTimes(2);
		await governed.destroy();
	});

	it("the SDK's own loop is off for every round the governor makes", async () => {
		const { client, tool, seen } = sdkLikeClient(TWO_ROUNDS);
		const governed = await trust(client, { dryRun: true, budget: 500_000, vaultBase: vault });
		await governed.models.generateContent(call({ config: { tools: [tool] } }));
		expect(seen).toHaveLength(2);
		for (const p of seen) {
			expect(((p.config as Loose)["automaticFunctionCalling"] as Loose)["disable"]).toBe(true);
		}
		// round 2 carries round 1's turns
		expect(((seen[1] as Loose).contents as unknown[]).length).toBe(3);
		await governed.destroy();
	});

	it("a round that fails ends the call there: the first round is already settled, the tool ran once, nothing after it runs", async () => {
		const sdk = sdkLikeClient(TWO_ROUNDS);
		const original = sdk.client.models.generateContent;
		let n = 0;
		sdk.client.models.generateContent = async (params) => {
			n++;
			if (n === 2) throw new Error("provider down");
			return original(params);
		};
		const governed = await trust(sdk.client, { dryRun: true, budget: 500_000, vaultBase: vault });
		await expect(
			governed.models.generateContent(call({ config: { tools: [sdk.tool] } })),
		).rejects.toThrow("provider down");
		expect(n).toBe(2);
		expect(sdk.tool.callTool).toHaveBeenCalledTimes(1);
		await governed.destroy();
	});

	it("without a callable tool, or with AFC disabled, it is one ordinary governed call", async () => {
		for (const config of [
			undefined,
			{ tools: [{ googleSearch: {} }] },
			{
				tools: [
					{
						tool: async () => ({ functionDeclarations: [{ name: "f" }] }),
						callTool: async () => [],
					},
				],
				automaticFunctionCalling: { disable: true },
			},
		]) {
			const { client } = sdkLikeClient([{ prompt: 1000, output: 100 }]);
			const governed = await trust(client, { dryRun: true, budget: 500_000, vaultBase: vault });
			const out = (await governed.models.generateContent(
				call(config ? { config } : {}),
			)) as unknown as { receipt: { cost: number }; receipts?: unknown };
			expect(out.receipt.cost).toBe(6);
			expect(out.receipts).toBeUndefined();
			await governed.destroy();
		}
	});

	it("the envelope's per-round receipts are typed: no cast is needed to read them", async () => {
		const { client, tool } = sdkLikeClient(TWO_ROUNDS);
		const governed = await trust(client, { dryRun: true, budget: 500_000, vaultBase: vault });
		const out = await governed.models.generateContent(call({ config: { tools: [tool] } }));
		const receipts: Array<{ cost: number }> = out.receipts ?? [];
		expect(receipts.map((r) => r.cost)).toEqual([6, 11]);
		await governed.destroy();
	});

	it("the AFC decision is the SDK's own, made by running its pipeline over the request", async () => {
		const pipeline = await resolveGooglePipeline(new GoogleGenAI({ apiKey: "test" }), false);
		if (pipeline === undefined) throw new Error("the installed SDK's pipeline did not resolve");
		const tool = {
			tool: async () => ({ functionDeclarations: [{ name: "f" }] }),
			callTool: async () => [],
		};
		const decide = async (config?: Record<string, unknown>) => {
			const snap = await snapshotGoogleRequest(pipeline, "generateContent", {
				model: "gemini-2.5-flash",
				contents: "go",
				...(config !== undefined ? { config } : {}),
			});
			return snap.kind === "ok" ? snap.afcRan : snap.kind;
		};
		expect(await decide({ tools: [tool] })).toBe(true);
		expect(
			await decide({ tools: [tool], automaticFunctionCalling: { maximumRemoteCalls: 3 } }),
		).toBe(true);
		expect(await decide()).toBe(false);
		expect(await decide({ tools: [{ googleSearch: {} }] })).toBe(false);
		expect(await decide({ tools: [tool], automaticFunctionCalling: { disable: true } })).toBe(
			false,
		);
		// the SDK disables AFC for an invalid maximum: one plain call
		for (const bad of [0, -1, 1.5]) {
			expect(
				await decide({ tools: [tool], automaticFunctionCalling: { maximumRemoteCalls: bad } }),
			).toBe(false);
		}
		// a plain function declaration beside a callable tool is the SDK's own error
		expect(await decide({ tools: [tool, { functionDeclarations: [{ name: "g" }] }] })).toBe(
			"sdkError",
		);
	});
});
