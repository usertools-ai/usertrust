// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The hold covers what the provider bills for.
 *
 * A PENDING hold is posted at most at its own amount (TigerBeetle never posts above a pending
 * transfer, `postPendingSpend` caps), so a hold sized below the call's real cost under-debits the
 * wallet, and a budget check made against it lets a call through that the budget does not cover.
 * The hold was sized from the prompt parts alone (`estimateInputTokens`, which walks each part's
 * `content`): an Anthropic system given as text blocks, tools, Google `contents` (whose items carry
 * `parts`), Google's config, and Responses prompt variables were never counted. It is now the larger
 * of that and an estimate of the WHOLE request body (`estimateBodyTokens`), read from the one
 * serialized snapshot, and the output leg reads each provider's own cap, per candidate.
 *
 * Driven through the REAL SDKs over a recording `fetch` (Google: `globalThis.fetch`). The fake
 * provider bills `ceil(bytes sent / 4)` input tokens, a MODEL of a tokenizer, not one: calibration
 * against real counts is a separate, declared-unmeasured question (the calibration block below).
 * The engine posts at most what it holds, as the ledger does.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { extractPromptParts, type TrustEngine, trust } from "../../src/govern.js";
import {
	DEFAULT_OUTPUT_HOLD,
	estimateBodyTokens,
	estimateInputTokens,
	holdInputTokens,
	holdOutputTokens,
} from "../../src/ledger/pricing.js";
import { AUDIT_DIR, VAULT_DIR } from "../../src/shared/constants.js";

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
	CreateTransferStatus: {},
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

// biome-ignore lint/suspicious/noExplicitAny: the rows reach SDK members the TrustedClient type hides.
type Loose = any;

/** About 100k tokens of prose, at the provider model below. */
const BIG = "Reference article paragraph. ".repeat(14_000);
const SMALL = "Summarise the reference.";

const json = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

/** What the fake provider reports as output, per call (set by a row). */
let outputReport: { output: number; thoughts?: number } = { output: 10 };
/** An input-token count a row forces, for content the body does not carry (a URL). */
let forcedInput: number | undefined;
/** Google answers a function call this many times before it answers text (automatic function calling). */
let functionCallRounds = 0;
let sent: string[] = [];

async function provider(input: unknown, init?: RequestInit): Promise<Response> {
	const url = new URL(String(input instanceof Request ? input.url : input));
	const body = typeof init?.body === "string" ? init.body : "";
	sent.push(`${init?.method ?? "GET"} ${url.pathname}`);
	const tokens = forcedInput ?? Math.ceil(Buffer.byteLength(body, "utf8") / 4);
	const { output, thoughts } = outputReport;
	const streamed =
		body.includes('"stream":true') || url.pathname.includes(":streamGenerateContent");
	if (streamed) return streamAnswer(url.pathname, tokens, output);
	if (url.pathname.endsWith("/messages")) {
		return json({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [{ type: "text", text: "ok" }],
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: tokens, output_tokens: output },
		});
	}
	if (url.pathname.endsWith("/chat/completions")) {
		return json({
			id: "c1",
			object: "chat.completion",
			created: 0,
			model: "gpt-4o",
			choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
			usage: { prompt_tokens: tokens, completion_tokens: output, total_tokens: tokens + output },
		});
	}
	if (url.pathname.endsWith("/responses")) {
		return json({
			id: "resp_1",
			object: "response",
			created_at: 0,
			model: "gpt-4o",
			status: "completed",
			output: [],
			usage: { input_tokens: tokens, output_tokens: output, total_tokens: tokens + output },
		});
	}
	const calling = functionCallRounds > 0;
	if (calling) functionCallRounds -= 1;
	return json({
		candidates: [
			{
				content: {
					role: "model",
					parts: [calling ? { functionCall: { name: "lookup", args: {} } } : { text: "ok" }],
				},
				finishReason: "STOP",
			},
		],
		usageMetadata: {
			promptTokenCount: tokens,
			candidatesTokenCount: output,
			...(thoughts !== undefined ? { thoughtsTokenCount: thoughts } : {}),
			totalTokenCount: tokens + output + (thoughts ?? 0),
		},
	});
}

/** A streamed answer in each provider's SSE shape, its usage at the end. */
function streamAnswer(path: string, input: number, output: number): Response {
	const sse = (frames: string[]) =>
		new Response(frames.join(""), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	const data = (event: string | null, body: unknown) =>
		`${event !== null ? `event: ${event}\n` : ""}data: ${JSON.stringify(body)}\n\n`;
	if (path.endsWith("/messages")) {
		return sse([
			data("message_start", {
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude-sonnet-4-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: input, output_tokens: 0 },
				},
			}),
			data("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			data("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "ok" },
			}),
			data("content_block_stop", { type: "content_block_stop", index: 0 }),
			data("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: output },
			}),
			data("message_stop", { type: "message_stop" }),
		]);
	}
	if (path.endsWith("/chat/completions")) {
		const chunk = (extra: Record<string, unknown>) => ({
			id: "c1",
			object: "chat.completion.chunk",
			created: 0,
			model: "gpt-4o",
			...extra,
		});
		return sse([
			data(null, chunk({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })),
			data(null, chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })),
			data(
				null,
				chunk({
					choices: [],
					usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
				}),
			),
			"data: [DONE]\n\n",
		]);
	}
	return sse([
		data(null, {
			candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
			usageMetadata: {
				promptTokenCount: input,
				candidatesTokenCount: output,
				totalTokenCount: input + output,
			},
		}),
	]);
}

const realFetch = globalThis.fetch;
beforeAll(() => {
	globalThis.fetch = provider as typeof fetch;
});
afterAll(() => {
	globalThis.fetch = realFetch;
});

let vault: string;
let open: Array<{ destroy(): Promise<void> }>;
beforeEach(() => {
	vault = join(tmpdir(), `hold-estimate-${randomUUID()}`);
	mkdirSync(join(vault, VAULT_DIR), { recursive: true });
	sent = [];
	open = [];
	outputReport = { output: 10 };
	forcedInput = undefined;
	functionCallRounds = 0;
});
afterEach(async () => {
	for (const c of open) await c.destroy().catch(() => {});
	rmSync(vault, { recursive: true, force: true });
});

/** The ledger's behaviour: a post is capped at what the hold reserved. */
function cappingEngine() {
	const held = new Map<string, number>();
	const log = { holds: [] as number[], posts: [] as Array<{ actual: number; posted: number }> };
	const engine: TrustEngine = {
		spendPending: async (p) => {
			held.set(p.transferId, p.amount);
			log.holds.push(p.amount);
			return { transferId: p.transferId };
		},
		postPendingSpend: async (id, actual) => {
			const h = held.get(id) ?? 0;
			const posted = actual != null ? Math.min(actual, h) : h;
			log.posts.push({ actual: actual ?? h, posted });
			return { posted, shortfall: (actual ?? h) - posted };
		},
		voidPendingSpend: async () => {},
	};
	return { engine, log };
}

async function governed(raw: unknown, budget = 1_000_000_000) {
	writeFileSync(join(vault, VAULT_DIR, "usertrust.config.json"), JSON.stringify({ budget }));
	const { engine, log } = cappingEngine();
	const client = await trust(raw as Loose, { budget, vaultBase: vault, _engine: engine });
	open.push(client);
	return { client: client as Loose, log };
}

const anthropicRaw = () =>
	new Anthropic({
		apiKey: "k",
		baseURL: "https://anthropic.test",
		fetch: provider as typeof fetch,
		maxRetries: 0,
	});
const openaiRaw = () =>
	new OpenAI({
		apiKey: "k",
		baseURL: "https://openai.test/v1",
		fetch: provider as typeof fetch,
		maxRetries: 0,
	});
const googleRaw = () => new GoogleGenAI({ apiKey: "k" });

function events(): string[] {
	const path = join(vault, VAULT_DIR, AUDIT_DIR, "events.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => (JSON.parse(line) as { kind: string }).kind);
}

const fn = (description: string) => ({
	name: "lookup",
	description,
	input_schema: { type: "object", properties: {} },
});

/** A prompt of about 100k tokens, in a field the prompt parts never walked. */
const FIELD_ROWS: Array<{
	name: string;
	raw: () => unknown;
	call: (c: Loose) => Promise<unknown>;
}> = [
	{
		name: "Anthropic system as text blocks (cache_control)",
		raw: anthropicRaw,
		call: (c) =>
			c.messages.create({
				model: "claude-sonnet-4-5",
				max_tokens: 64,
				system: [{ type: "text", text: BIG, cache_control: { type: "ephemeral" } }],
				messages: [{ role: "user", content: SMALL }],
			}),
	},
	{
		name: "Anthropic tools[].description",
		raw: anthropicRaw,
		call: (c) =>
			c.messages.create({
				model: "claude-sonnet-4-5",
				max_tokens: 64,
				tools: [fn(BIG)],
				messages: [{ role: "user", content: SMALL }],
			}),
	},
	{
		name: "Google contents",
		raw: googleRaw,
		call: (c) =>
			c.models.generateContent({
				model: "gemini-2.5-pro",
				contents: [{ role: "user", parts: [{ text: BIG }] }],
			}),
	},
	{
		name: "Google config.systemInstruction",
		raw: googleRaw,
		call: (c) =>
			c.models.generateContent({
				model: "gemini-2.5-pro",
				contents: [{ role: "user", parts: [{ text: SMALL }] }],
				config: { systemInstruction: BIG },
			}),
	},
	{
		name: "Google config.tools functionDeclarations[].description",
		raw: googleRaw,
		call: (c) =>
			c.models.generateContent({
				model: "gemini-2.5-pro",
				contents: [{ role: "user", parts: [{ text: SMALL }] }],
				config: { tools: [{ functionDeclarations: [{ name: "lookup", description: BIG }] }] },
			}),
	},
	{
		name: "OpenAI Responses prompt.variables",
		raw: openaiRaw,
		call: (c) =>
			c.responses.create({
				model: "gpt-4o",
				input: SMALL,
				prompt: { id: "pmpt_1", variables: { reference: BIG } },
			}),
	},
	{
		name: "OpenAI Responses tools[].description",
		raw: openaiRaw,
		call: (c) =>
			c.responses.create({
				model: "gpt-4o",
				input: SMALL,
				tools: [
					{
						type: "function",
						name: "lookup",
						description: BIG,
						parameters: { type: "object", properties: {} },
						strict: false,
					},
				],
			}),
	},
	{
		name: "OpenAI chat tools[].function.description",
		raw: openaiRaw,
		call: (c) =>
			c.chat.completions.create({
				model: "gpt-4o",
				messages: [{ role: "user", content: SMALL }],
				tools: [
					{
						type: "function",
						function: { name: "lookup", description: BIG, parameters: { type: "object" } },
					},
				],
			}),
	},
];

describe("a large prompt in a field the prompt parts never walked is held", () => {
	for (const row of FIELD_ROWS) {
		it(`${row.name}: held >= actual, posted in full, no shortfall`, async () => {
			const { client, log } = await governed(row.raw());
			await row.call(client);
			expect(log.posts).toHaveLength(1);
			const [post] = log.posts;
			expect(log.holds[0]).toBeGreaterThanOrEqual(post?.actual ?? Number.POSITIVE_INFINITY);
			expect(post?.posted).toBe(post?.actual);
			expect(events()).not.toContain("settlement_shortfall");
		});
	}
});

describe("a streamed call is held before it starts and settles at its true usage", () => {
	const drain = async (stream: AsyncIterable<unknown>) => {
		for await (const _ of stream) {
			// consumed: the governed stream settles at its end
		}
	};
	it("Anthropic messages.create({ stream: true }) with a block-form system", async () => {
		const { client, log } = await governed(anthropicRaw());
		const { response } = await client.messages.create({
			model: "claude-sonnet-4-5",
			max_tokens: 64,
			stream: true,
			system: [{ type: "text", text: BIG }],
			messages: [{ role: "user", content: SMALL }],
		});
		await drain(response);
		await vi.waitFor(() => expect(log.posts).toHaveLength(1));
		expect(log.holds[0]).toBeGreaterThanOrEqual(log.posts[0]?.actual ?? Number.POSITIVE_INFINITY);
		expect(log.posts[0]?.posted).toBe(log.posts[0]?.actual);
		expect(events()).not.toContain("settlement_shortfall");
	});

	it("OpenAI chat.completions.create({ stream: true }) with a large tool description", async () => {
		const { client, log } = await governed(openaiRaw());
		const { response } = await client.chat.completions.create({
			model: "gpt-4o",
			stream: true,
			messages: [{ role: "user", content: SMALL }],
			tools: [{ type: "function", function: { name: "lookup", description: BIG } }],
		});
		await drain(response);
		await vi.waitFor(() => expect(log.posts).toHaveLength(1));
		expect(log.holds[0]).toBeGreaterThanOrEqual(log.posts[0]?.actual ?? Number.POSITIVE_INFINITY);
		expect(log.posts[0]?.posted).toBe(log.posts[0]?.actual);
		expect(events()).not.toContain("settlement_shortfall");
	});

	it("Google generateContentStream with a large systemInstruction", async () => {
		const { client, log } = await governed(googleRaw());
		// The governed Google stream resolves to the stream itself (with its receipt).
		const stream = await client.models.generateContentStream({
			model: "gemini-2.5-pro",
			contents: SMALL,
			config: { systemInstruction: BIG },
		});
		await drain(stream);
		await vi.waitFor(() => expect(log.posts).toHaveLength(1));
		expect(log.holds[0]).toBeGreaterThanOrEqual(log.posts[0]?.actual ?? Number.POSITIVE_INFINITY);
		expect(log.posts[0]?.posted).toBe(log.posts[0]?.actual);
		expect(events()).not.toContain("settlement_shortfall");
	});
});

describe("a call whose real cost exceeds the budget is refused before it is sent", () => {
	for (const row of FIELD_ROWS) {
		it(`${row.name}`, async () => {
			const { client, log } = await governed(row.raw(), 500);
			await expect(row.call(client)).rejects.toThrow(/Policy denied/);
			expect(sent).toEqual([]);
			expect(log.holds).toEqual([]);
			expect(events()).toContain("policy_denied");
		});
	}
});

describe("estimateBodyTokens: every key and scalar, in UTF-8 bytes, nothing skipped by name", () => {
	const t = (bytes: number) => Math.max(1, Math.ceil((bytes / 4) * 1.5));

	it("counts keys, strings, numbers and booleans, in bytes", () => {
		expect(estimateBodyTokens({ ab: "cd", n: 12, flag: true })).toBe(t(2 + 2 + 1 + 2 + 4 + 4));
		expect(estimateBodyTokens(["x", ["yy"]])).toBe(t(3));
		expect(estimateBodyTokens({})).toBe(1);
	});

	it("a prompt variable named like a discriminator (role, model, type) is counted as text", () => {
		const text = "w".repeat(400_000);
		for (const name of ["role", "model", "type"]) {
			expect(
				estimateBodyTokens({ prompt: { variables: { [name]: text } } }),
			).toBeGreaterThanOrEqual(150_000);
		}
	});

	it("a numeric payload is counted (a functionResponse of 100,000 numbers)", () => {
		const values = Array.from({ length: 100_000 }, (_, i) => 100_000 + i);
		expect(
			estimateBodyTokens({ functionResponse: { response: { values } } }),
		).toBeGreaterThanOrEqual((600_000 / 4) * 1.5);
	});

	it("a tool schema's property NAMES are counted (1,000 long keys)", () => {
		const properties = Object.fromEntries(
			Array.from({ length: 1000 }, (_, i) => [
				`measurement_${i}_${"x".repeat(80)}`,
				{ type: "number" },
			]),
		);
		expect(estimateBodyTokens({ tools: [{ input_schema: { properties } }] })).toBeGreaterThan(
			(90_000 / 4) * 1.5,
		);
	});

	it("non-ASCII is counted in bytes: a CJK character holds about 1.1 tokens, not 0.375", () => {
		const cjk = "参".repeat(10_000);
		expect(estimateBodyTokens({ text: cjk })).toBe(t(4 + 30_000));
	});
});

describe("the common path grows only by the request's own structure, and never shrinks", () => {
	const old = (params: Record<string, unknown>, kind: "anthropic" | "openai" | "google") =>
		estimateInputTokens(extractPromptParts(params, kind));
	const held = (params: Record<string, unknown>, kind: "anthropic" | "openai" | "google") =>
		holdInputTokens(extractPromptParts(params, kind), JSON.parse(JSON.stringify(params)));
	const prose = (n: number) => "lorem ipsum dolor sit amet ".repeat(n);
	const shapes: Array<[string, "anthropic" | "openai", Record<string, unknown>]> = [
		[
			"chat, 3 messages of about 2k chars",
			"openai",
			{
				model: "gpt-4o",
				temperature: 0.2,
				messages: [
					{ role: "system", content: prose(20) },
					{ role: "user", content: prose(30) },
					{ role: "assistant", content: prose(30) },
				],
			},
		],
		[
			"Anthropic, a string system and 10 messages",
			"anthropic",
			{
				model: "claude-sonnet-4-5",
				max_tokens: 1024,
				system: prose(40),
				messages: Array.from({ length: 10 }, (_, i) => ({
					role: i % 2 ? "assistant" : "user",
					content: prose(36),
				})),
			},
		],
		[
			"Anthropic, one 100k-char message",
			"anthropic",
			{
				model: "claude-sonnet-4-5",
				max_tokens: 1024,
				messages: [{ role: "user", content: prose(3700) }],
			},
		],
		[
			"Responses, a 4k string input",
			"openai",
			{ model: "gpt-4o", input: prose(150), max_output_tokens: 512 },
		],
		[
			"chat, 3 short messages",
			"openai",
			{
				model: "gpt-4o",
				messages: [
					{ role: "system", content: "Be brief." },
					{ role: "user", content: "hi" },
					{ role: "assistant", content: "hello" },
				],
			},
		],
	];
	for (const [name, kind, params] of shapes) {
		it(`${name}: held_new >= held_old, and grows by at most 32 tokens`, () => {
			const before = old(params, kind);
			const after = held(params, kind);
			expect(after).toBeGreaterThanOrEqual(before);
			expect(after - before).toBeLessThanOrEqual(32);
		});
	}

	it("non-ASCII: about 2k chars of mixed CJK and Latin grows by the byte unit, and stays monotone", () => {
		const text = "参考资料 reference 资料 ".repeat(100);
		const params = { model: "gpt-4o", messages: [{ role: "user", content: text }] };
		const before = old(params, "openai");
		const after = held(params, "openai");
		expect(after).toBeGreaterThanOrEqual(before);
		// chars/4 x 1.5 counts each CJK char once; bytes count it three times
		expect(after).toBeGreaterThan(before * 1.4);
	});

	it("max keeps today's figure where the parts' estimate is larger (a tool message's fixed overhead)", () => {
		const params = {
			model: "gpt-4o",
			messages: [
				{ role: "user", content: "x" },
				{ role: "tool", tool_call_id: "c1", content: "ok" },
			],
		};
		expect(old(params, "openai")).toBeGreaterThan(
			estimateBodyTokens(JSON.parse(JSON.stringify(params))),
		);
		expect(held(params, "openai")).toBe(old(params, "openai"));
	});
});

describe("holdOutputTokens: the cap the provider enforces, per candidate", () => {
	it("Anthropic: max_tokens, which bounds thinking too", () => {
		expect(holdOutputTokens("anthropic", { max_tokens: 2048 })).toBe(2048);
		expect(holdOutputTokens("anthropic", {})).toBe(DEFAULT_OUTPUT_HOLD);
	});

	it("OpenAI chat: max_completion_tokens, else max_tokens, times n", () => {
		expect(holdOutputTokens("openai", { max_completion_tokens: 32_768 }, "chat")).toBe(32_768);
		expect(
			holdOutputTokens("openai", { max_tokens: 100, max_completion_tokens: 200 }, "chat"),
		).toBe(200);
		expect(holdOutputTokens("openai", { max_completion_tokens: 2048, n: 2 }, "chat")).toBe(4096);
		expect(holdOutputTokens("openai", { n: 3 }, "chat")).toBe(3 * DEFAULT_OUTPUT_HOLD);
	});

	it("OpenAI Responses: max_output_tokens", () => {
		expect(holdOutputTokens("openai", { max_output_tokens: 512 }, "responses")).toBe(512);
	});

	it("Google: maxOutputTokens per candidate, thoughts included (documented), times candidateCount", () => {
		// the cap bounds thoughts too, so the thinking budget is never added to it
		expect(holdOutputTokens("google", { config: { maxOutputTokens: 64 } })).toBe(64);
		expect(
			holdOutputTokens("google", {
				config: { maxOutputTokens: 64, thinkingConfig: { thinkingBudget: 8192 } },
			}),
		).toBe(64);
		expect(
			holdOutputTokens("google", {
				config: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 8192 } },
			}),
		).toBe(8192);
		expect(
			holdOutputTokens("google", { config: { maxOutputTokens: 2048, candidateCount: 3 } }),
		).toBe(3 * 2048);
	});

	it("Google with no cap: never below the default, never below the thinking budget, times candidateCount", () => {
		expect(holdOutputTokens("google", {})).toBe(DEFAULT_OUTPUT_HOLD);
		expect(
			holdOutputTokens("google", { config: { thinkingConfig: { thinkingBudget: 1024 } } }),
		).toBe(DEFAULT_OUTPUT_HOLD);
		expect(
			holdOutputTokens("google", { config: { thinkingConfig: { thinkingBudget: 8192 } } }),
		).toBe(8192);
		// dynamic thinking (-1) names no budget: the default holds
		expect(holdOutputTokens("google", { config: { thinkingConfig: { thinkingBudget: -1 } } })).toBe(
			DEFAULT_OUTPUT_HOLD,
		);
		expect(holdOutputTokens("google", { config: { candidateCount: 2 } })).toBe(
			2 * DEFAULT_OUTPUT_HOLD,
		);
	});
});

describe("with thinking or reasoning on, output billed at the documented maximum is held", () => {
	it("Anthropic, max_tokens 2048 with a 1024 thinking budget: output reported at 2048", async () => {
		outputReport = { output: 2048 };
		const { client, log } = await governed(anthropicRaw());
		await client.messages.create({
			model: "claude-sonnet-4-5",
			max_tokens: 2048,
			thinking: { type: "enabled", budget_tokens: 1024 },
			messages: [{ role: "user", content: SMALL }],
		});
		expect(log.posts[0]?.posted).toBe(log.posts[0]?.actual);
		expect(events()).not.toContain("settlement_shortfall");
	});

	it("OpenAI chat, max_completion_tokens 2048 (reasoning included): output reported at 2048", async () => {
		outputReport = { output: 2048 };
		const { client, log } = await governed(openaiRaw());
		await client.chat.completions.create({
			model: "gpt-4o",
			max_completion_tokens: 2048,
			messages: [{ role: "user", content: SMALL }],
		});
		expect(log.posts[0]?.posted).toBe(log.posts[0]?.actual);
		expect(events()).not.toContain("settlement_shortfall");
	});

	it("Google, maxOutputTokens 64 with a thinking budget of 8192: output and thoughts at their documented total of 64 are held", async () => {
		outputReport = { output: 32, thoughts: 32 };
		const { client, log } = await governed(googleRaw());
		await client.models.generateContent({
			model: "gemini-2.5-pro",
			contents: SMALL,
			config: { maxOutputTokens: 64, thinkingConfig: { thinkingBudget: 8192 } },
		});
		expect(log.posts[0]?.posted).toBe(log.posts[0]?.actual);
		expect(events()).not.toContain("settlement_shortfall");
	});

	it("Google: a thinking budget beside a cap does not raise the hold (the cap already bounds the thoughts)", async () => {
		const { client, log } = await governed(googleRaw());
		await client.models.generateContent({
			model: "gemini-2.5-pro",
			contents: SMALL,
			config: { maxOutputTokens: 8192 },
		});
		await client.models.generateContent({
			model: "gemini-2.5-pro",
			contents: SMALL,
			config: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 8192 } },
		});
		expect(log.holds).toHaveLength(2);
		expect(log.holds[1]).toBe(log.holds[0]);
	});
});

describe("declared limits are VISIBLE, never silent", () => {
	it("content passed by reference (a document URL) is billed beyond the hold: posted capped, settlement_shortfall recorded", async () => {
		forcedInput = 400_000; // the provider fetched the document and billed for it
		const { client, log } = await governed(anthropicRaw());
		await client.messages.create({
			model: "claude-sonnet-4-5",
			max_tokens: 64,
			messages: [
				{
					role: "user",
					content: [
						{ type: "document", source: { type: "url", url: "https://example.test/report.pdf" } },
						{ type: "text", text: SMALL },
					],
				},
			],
		});
		expect(log.posts[0]?.posted).toBeLessThan(log.posts[0]?.actual ?? 0);
		expect(events()).toContain("settlement_shortfall");
	});
});

describe("Google automatic function calling: each round is held from its own body", () => {
	it("three rounds whose history outgrows the first round's estimate: every round held, no shortfall", async () => {
		functionCallRounds = 2;
		const third = BIG.slice(0, Math.floor(BIG.length / 3));
		const tool = {
			tool: async () => ({
				functionDeclarations: [{ name: "lookup", description: "Look it up." }],
			}),
			callTool: async () => [{ functionResponse: { name: "lookup", response: { text: third } } }],
		};
		const { client, log } = await governed(googleRaw());
		await client.models.generateContent({
			model: "gemini-2.5-pro",
			contents: [{ role: "user", parts: [{ text: SMALL }] }],
			config: { tools: [tool] },
		});
		expect(log.posts).toHaveLength(3);
		// each round's body is larger than the last, and each is held
		expect(log.posts[2]?.actual ?? 0).toBeGreaterThan(log.posts[0]?.actual ?? 0);
		for (const post of log.posts) expect(post.posted).toBe(post.actual);
		expect(events()).not.toContain("settlement_shortfall");
	});

	it("DECLARED: a callable tool's declarations resolve after authorization, so a large one is not held, and the shortfall is recorded", async () => {
		const tool = {
			tool: async () => ({ functionDeclarations: [{ name: "lookup", description: BIG }] }),
			callTool: async () => [],
		};
		const { client, log } = await governed(googleRaw());
		await client.models.generateContent({
			model: "gemini-2.5-pro",
			contents: [{ role: "user", parts: [{ text: SMALL }] }],
			config: { tools: [tool] },
		});
		expect(log.posts[0]?.posted).toBeLessThan(log.posts[0]?.actual ?? 0);
		expect(events()).toContain("settlement_shortfall");
	});
});

describe("the estimate reads the snapshot, never the live request", () => {
	it("DECLARED: a Google getter that answers short to the snapshot and long to the SDK is under-held, and the shortfall is recorded", async () => {
		let reads = 0;
		const part = {};
		Object.defineProperty(part, "text", {
			enumerable: true,
			get: () => {
				reads += 1;
				return reads === 1 ? SMALL : BIG;
			},
		});
		const { client, log } = await governed(googleRaw());
		await client.models.generateContent({
			model: "gemini-2.5-pro",
			contents: [{ role: "user", parts: [part] }],
		});
		// the snapshot read it once, short; the SDK read the original, long
		expect(reads).toBeGreaterThanOrEqual(2);
		expect(log.posts[0]?.posted).toBeLessThan(log.posts[0]?.actual ?? 0);
		expect(events()).toContain("settlement_shortfall");
	});
});

describe("the gate this estimate depends on: the snapshot IS the body sent", () => {
	// The estimate reads the serialized request. It is sound only while nothing replaces that body
	// after it is read, which the request-option refusal guarantees. A regression there fails here too.
	const swapped = {
		model: "claude-sonnet-4-5",
		max_tokens: 64,
		messages: [{ role: "user", content: BIG }],
	};
	const rows: Array<[string, () => unknown, (c: Loose) => Promise<unknown>]> = [
		[
			"Anthropic messages.create",
			anthropicRaw,
			(c) =>
				c.messages.create(
					{
						model: "claude-sonnet-4-5",
						max_tokens: 64,
						messages: [{ role: "user", content: SMALL }],
					},
					{ body: swapped },
				),
		],
		[
			"OpenAI chat.completions.create",
			openaiRaw,
			(c) =>
				c.chat.completions.create(
					{ model: "gpt-4o", messages: [{ role: "user", content: SMALL }] },
					{ body: { model: "gpt-4o", messages: [{ role: "user", content: BIG }] } },
				),
		],
		[
			"OpenAI responses.create",
			openaiRaw,
			(c) =>
				c.responses.create(
					{ model: "gpt-4o", input: SMALL },
					{ body: { model: "gpt-4o", input: BIG } },
				),
		],
	];
	for (const [name, raw, call] of rows) {
		it(`${name}: a per-call options.body is refused before anything is held or sent`, async () => {
			const { client, log } = await governed(raw());
			await expect(call(client)).rejects.toThrow(/request_option_refused/);
			expect(sent).toEqual([]);
			expect(log.holds).toEqual([]);
		});
	}

	it("a client constructed with fetchOptions carrying a body is refused at trust()", async () => {
		const raw = new OpenAI({
			apiKey: "k",
			baseURL: "https://openai.test/v1",
			fetch: provider as typeof fetch,
			maxRetries: 0,
			fetchOptions: { body: JSON.stringify({ model: "gpt-4o", input: BIG }) } as Loose,
		});
		await expect(governed(raw)).rejects.toThrow(/client fetchOptions\.body/);
		expect(sent).toEqual([]);
	});
});

describe("calibration against REAL token counts (declared UNMEASURED for every provider)", () => {
	// The fixture format, so counts recorded from a provider's own counter can be added later:
	// one JSON file per count, beside its corpus file, under tests/fixtures/token-calibration/:
	//   { provider, model, input, inputSha256, countedTokens, counter, recordedBy, recordedAt }
	const dir = join(__dirname, "..", "fixtures", "token-calibration");
	const fixtures = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".count.json")) : [];
	if (fixtures.length === 0) {
		it.skip("no recorded counts: Anthropic, OpenAI and Google calibration is unmeasured", () => {});
	}
	for (const file of fixtures) {
		it(`${file}: the estimate is at least the recorded count`, async () => {
			const fixture = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
				input: string;
				inputSha256: string;
				countedTokens: number;
			};
			const text = readFileSync(join(dir, fixture.input), "utf8");
			const { createHash } = await import("node:crypto");
			expect(createHash("sha256").update(text).digest("hex")).toBe(fixture.inputSha256);
			expect(estimateBodyTokens({ text })).toBeGreaterThanOrEqual(fixture.countedTokens);
		});
	}
});
