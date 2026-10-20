// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Under `pii: "redact"`, PII in the prompt is replaced before the request leaves, and the
 * request's CONTROL fields are sent as the caller wrote them: credentials meant for a remote
 * server, cache keys, safety identifiers and metadata. Rewriting one breaks the call (a remote MCP
 * server refuses the rewritten token) or quietly changes what it does (a different cache key).
 *
 * Driven through the real SDKs over a recording `fetch` (Google: `globalThis.fetch`), so the rows
 * read the bytes each SDK sends. Each row has a control: the same request with no PII in the
 * prompt sends every control field unchanged, so a failure is the redaction, not the SDK.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type TrustEngine, trust } from "../../src/govern.js";
import { AUDIT_DIR, VAULT_DIR } from "../../src/shared/constants.js";
import { PolicyDeniedError } from "../../src/shared/errors.js";

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

// biome-ignore lint/suspicious/noExplicitAny: the rows send fields the SDK types do not all name.
type Loose = any;

/** Values each detector matches on its own (the first row checks it), as real requests carry them. */
const MCP_TOKEN = "sk-mcp-7f3a9c2e1b8d4f6a0e5c3b9d7a1f2e4c";
const BEARER = "Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const SHA256 = "3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea";
const ORDER_ID = "4155550123";
const EMAIL = "alice@example.com";

const json = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

/** Every request body and header set any SDK sends, in order. */
let bodies: Array<Record<string, Loose>> = [];
let headers: Array<Record<string, string>> = [];
async function recordingFetch(input: unknown, init?: RequestInit): Promise<Response> {
	const url = String(input instanceof Request ? input.url : input);
	bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : {});
	headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
	const path = new URL(url).pathname;
	if (path.endsWith("/messages")) {
		return json({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [{ type: "text", text: "ok" }],
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 5 },
		});
	}
	if (path.endsWith("/chat/completions") && bodies.at(-1)?.stream === true) {
		const chunk = (choice: unknown, usage?: unknown) =>
			`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "gpt-4o", choices: [choice], ...(usage === undefined ? {} : { usage }) })}\n\n`;
		const sse =
			chunk({ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }) +
			chunk(
				{ index: 0, delta: {}, finish_reason: "stop" },
				{ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			) +
			"data: [DONE]\n\n";
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	}
	if (path.endsWith("/chat/completions")) {
		return json({
			id: "c1",
			object: "chat.completion",
			created: 0,
			model: "gpt-4o",
			choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		});
	}
	if (path.endsWith("/responses")) {
		return json({
			id: "resp_1",
			object: "response",
			created_at: 0,
			model: "gpt-4o",
			status: "completed",
			output: [],
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		});
	}
	return json({
		candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
	});
}

const realFetch = globalThis.fetch;
beforeAll(() => {
	globalThis.fetch = recordingFetch as typeof fetch;
});
afterAll(() => {
	globalThis.fetch = realFetch;
});

let vault: string;
let open: Array<{ destroy(): Promise<void> }>;
beforeEach(() => {
	vault = join(tmpdir(), `redact-control-${randomUUID()}`);
	mkdirSync(vault, { recursive: true });
	bodies = [];
	headers = [];
	open = [];
});
afterEach(async () => {
	for (const c of open) await c.destroy().catch(() => {});
	rmSync(vault, { recursive: true, force: true });
});

async function govern(raw: unknown, pii: "redact" | "block" | "warn" = "redact"): Promise<Loose> {
	const engine = {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
	} satisfies TrustEngine;
	const client = await trust(raw as Loose, {
		budget: 1_000_000,
		vaultBase: vault,
		pii,
		_engine: engine,
	});
	open.push(client);
	return client;
}

const anthropic = () =>
	govern(
		new Anthropic({
			apiKey: "k",
			baseURL: "https://anthropic.test",
			fetch: recordingFetch as typeof fetch,
			maxRetries: 0,
		}),
	);
const openai = (pii: "redact" | "block" | "warn" = "redact") =>
	govern(
		new OpenAI({
			apiKey: "k",
			baseURL: "https://openai.test/v1",
			fetch: recordingFetch as typeof fetch,
			maxRetries: 0,
		}),
		pii,
	);
const google = (pii: "redact" | "block" | "warn" = "redact") =>
	govern(new GoogleGenAI({ apiKey: "k" }), pii);

const prompt = (pii: boolean) =>
	pii ? `my email is ${EMAIL}, summarize my order` : "summarize my order";

describe.each([true, false])(
	"under pii redact, prompt PII %s: control fields are sent as written",
	(pii) => {
		const promptIsRedacted = (sent: string) => {
			if (pii) {
				expect(sent, "the prompt's PII was redacted").not.toContain(EMAIL);
				expect(sent).toContain("[REDACTED:email]");
			} else {
				expect(sent, "control: nothing was redacted").not.toContain("REDACTED");
			}
		};

		it("Anthropic messages.create: an MCP server's authorization_token", async () => {
			const c = await anthropic();
			await c.messages.create({
				model: "claude-sonnet-4-5",
				max_tokens: 64,
				messages: [{ role: "user", content: prompt(pii) }],
				mcp_servers: [
					{
						type: "url",
						url: "https://mcp.example/sse",
						name: "orders",
						authorization_token: MCP_TOKEN,
					},
				],
			});
			const sent = bodies[0];
			promptIsRedacted(JSON.stringify(sent));
			expect(sent?.mcp_servers?.[0]?.authorization_token).toBe(MCP_TOKEN);
		});

		it("OpenAI chat.completions.create: metadata, prompt_cache_key and safety_identifier", async () => {
			const c = await openai();
			await c.chat.completions.create({
				model: "gpt-4o",
				messages: [{ role: "user", content: prompt(pii) }],
				metadata: { order_id: ORDER_ID },
				prompt_cache_key: SHA256,
				safety_identifier: SHA256,
			});
			const sent = bodies[0];
			promptIsRedacted(JSON.stringify(sent));
			expect.soft(sent?.metadata).toEqual({ order_id: ORDER_ID });
			expect.soft(sent?.prompt_cache_key).toBe(SHA256);
			expect.soft(sent?.safety_identifier).toBe(SHA256);
		});

		it("OpenAI responses.create: an MCP tool's Authorization header", async () => {
			const c = await openai();
			await c.responses.create({
				model: "gpt-4o",
				input: prompt(pii),
				tools: [
					{
						type: "mcp",
						server_label: "orders",
						server_url: "https://mcp.example/sse",
						headers: { Authorization: BEARER },
						require_approval: "never",
					},
				],
			});
			const sent = bodies[0];
			promptIsRedacted(JSON.stringify(sent));
			expect(sent?.tools?.[0]?.headers).toEqual({ Authorization: BEARER });
		});

		it("Google generateContent: a header sent through config.httpOptions.headers", async () => {
			const c = await google();
			await c.models.generateContent({
				model: "gemini-2.5-flash",
				contents: [{ role: "user", parts: [{ text: prompt(pii) }] }],
				config: { httpOptions: { headers: { "x-gateway-authorization": BEARER } } },
			});
			promptIsRedacted(JSON.stringify(bodies[0]));
			expect(headers[0]?.["x-gateway-authorization"]).toBe(BEARER);
		});

		it("Google generateContent: an MCP server's streamable HTTP transport headers", async () => {
			const c = await google();
			await c.models.generateContent({
				model: "gemini-2.5-flash",
				contents: [{ role: "user", parts: [{ text: prompt(pii) }] }],
				config: {
					tools: [
						{
							mcpServers: [
								{
									name: "orders",
									streamableHttpTransport: {
										url: "https://mcp.example/mcp",
										headers: { Authorization: BEARER },
									},
								},
							],
						},
					],
				} as Loose,
			});
			const sent = bodies[0];
			promptIsRedacted(JSON.stringify(sent));
			expect(JSON.stringify(sent)).toContain(BEARER);
			expect(JSON.stringify(sent)).not.toContain("REDACTED:bearer_token");
		});
	},
);

describe("under pii redact, through the real SDKs", () => {
	it("Anthropic: a replayed thinking block is sent byte for byte while the text beside it is redacted", async () => {
		const thinking = {
			type: "thinking",
			thinking: "I will look up who to write to",
			signature: "EqQBCkYIBRgCKkB",
		};
		const c = await anthropic();
		await c.messages.create({
			model: "claude-sonnet-4-5",
			max_tokens: 64,
			messages: [
				{ role: "user", content: "who do I write to?" },
				{ role: "assistant", content: [thinking, { type: "text", text: EMAIL }] },
				{ role: "user", content: "thanks" },
			],
		});
		const blocks = bodies[0]?.messages?.[1]?.content;
		expect(blocks?.[0]).toEqual(thinking);
		expect(blocks?.[1]).toEqual({ type: "text", text: "[REDACTED:email]" });
	});

	it("Anthropic: PII in a replayed thinking block, which redaction cannot rewrite, refuses the call and sends nothing", async () => {
		const c = await anthropic();
		const call = c.messages.create({
			model: "claude-sonnet-4-5",
			max_tokens: 64,
			messages: [
				{ role: "user", content: "who do I write to?" },
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: `I will write to ${EMAIL}`,
							signature: "EqQBCkYIBRgCKkB",
						},
						{ type: "text", text: "noted" },
					],
				},
				{ role: "user", content: "thanks" },
			],
		});
		await expect(call).rejects.toBeInstanceOf(PolicyDeniedError);
		await expect(call).rejects.toThrow("PII detected: email");
		expect(bodies).toHaveLength(0);
	});

	it("Google: a part whose thoughtSignature key holds undefined or an empty string is content, and is redacted", async () => {
		const c = await google();
		await c.models.generateContent({
			model: "gemini-2.5-flash",
			contents: [
				{ role: "user", parts: [{ text: EMAIL, thoughtSignature: undefined }] },
				{ role: "model", parts: [{ text: EMAIL, thoughtSignature: "" }] },
			],
		});
		// A bare part whose role key holds undefined is a part, as the SDK reads it.
		await c.models.generateContent({
			model: "gemini-2.5-flash",
			contents: { role: undefined, text: EMAIL } as Loose,
		});
		expect(bodies).toHaveLength(2);
		const [both, bare] = bodies.map((b) => JSON.stringify(b));
		expect(both).not.toContain(EMAIL);
		expect(both?.split("[REDACTED:email]")).toHaveLength(3);
		expect(bare).not.toContain(EMAIL);
		expect(bare).toContain("[REDACTED:email]");
	});

	it.each([
		["a role and no parts", { role: "user", text: EMAIL }],
		["parts that are not an array", { parts: null, text: EMAIL }],
	])(
		"Google: an element of contents with %s is a Part, as the SDK sends it, and its text is redacted",
		async (_, element) => {
			const c = await google();
			await c.models.generateContent({ model: "gemini-2.5-flash", contents: [element] as Loose });
			expect(bodies).toHaveLength(1);
			const sent = JSON.stringify(bodies[0]);
			expect(sent).not.toContain(EMAIL);
			expect(sent).toContain("[REDACTED:email]");
		},
	);

	it.each([
		["a role and no parts", { role: "user", text: EMAIL }],
		["parts that are not an array", { parts: null, text: EMAIL }],
	])(
		"Google: under pii block, an element of contents with %s that holds PII is refused",
		async (_, element) => {
			const c = await google("block");
			const call = c.models.generateContent({
				model: "gemini-2.5-flash",
				contents: [element] as Loose,
			});
			await expect(call).rejects.toBeInstanceOf(PolicyDeniedError);
			expect(bodies).toHaveLength(0);
		},
	);

	it("Google: under pii block, a hidden (non-enumerable) text part the SDK sends, also held in a function response, is refused", async () => {
		const hidden = Object.defineProperty({}, "text", { value: EMAIL, enumerable: false });
		const c = await google("block");
		const call = c.models.generateContent({
			model: "gemini-2.5-flash",
			contents: [
				{ role: "user", parts: [hidden, { text: "and the rest" }] },
				{
					role: "user",
					parts: [{ functionResponse: { name: "lookup", response: { item: hidden } } }],
				},
			],
		});
		await expect(call).rejects.toBeInstanceOf(PolicyDeniedError);
		expect(bodies).toHaveLength(0);
	});

	it("OpenAI chat: under pii block, an address written with JSON escapes in a tool call's arguments is refused", async () => {
		const c = await openai("block");
		const call = c.chat.completions.create({
			model: "gpt-4o",
			messages: [
				{ role: "user", content: "send it" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "send", arguments: '{"to":"alice\\u0040example.com"}' },
						},
					],
				},
				{ role: "tool", tool_call_id: "call_1", content: "sent" },
			],
		});
		await expect(call).rejects.toBeInstanceOf(PolicyDeniedError);
		expect(bodies).toHaveLength(0);
	});

	it("Google: a text part the caller hid (non-enumerable), which the SDK still sends, is redacted", async () => {
		const hidden = Object.defineProperty({}, "text", { value: EMAIL, enumerable: false });
		const c = await google();
		await c.models.generateContent({
			model: "gemini-2.5-flash",
			contents: [{ role: "user", parts: [hidden, { text: "and the rest" }] }],
		});
		const sent = JSON.stringify(bodies[0]);
		expect(sent).not.toContain(EMAIL);
		expect(sent).toContain("[REDACTED:email]");
	});

	it("OpenAI chat: a tool call's JSON arguments are sent as valid JSON, with the address redacted", async () => {
		const c = await openai();
		await c.chat.completions.create({
			model: "gpt-4o",
			messages: [
				{ role: "user", content: "send it" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "send", arguments: JSON.stringify({ to: EMAIL, copies: 2 }) },
						},
					],
				},
				{ role: "tool", tool_call_id: "call_1", content: "sent" },
			],
		});
		const call = bodies[0]?.messages?.[1]?.tool_calls?.[0];
		expect(call?.id).toBe("call_1");
		expect(JSON.parse(call?.function?.arguments)).toEqual({ to: "[REDACTED:email]", copies: 2 });
	});

	it("OpenAI chat: deeply nested JSON arguments with a big number keep every other byte", async () => {
		const depth = 10_000;
		const args = (v: string) =>
			`{"id":9007199254740993,"to":${"[".repeat(depth)}"${v}"${"]".repeat(depth)}}`;
		const c = await openai();
		await c.chat.completions.create({
			model: "gpt-4o",
			messages: [
				{ role: "user", content: "send it" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{ id: "call_1", type: "function", function: { name: "send", arguments: args(EMAIL) } },
					],
				},
				{ role: "tool", tool_call_id: "call_1", content: "sent" },
			],
		});
		expect(bodies[0]?.messages?.[1]?.tool_calls?.[0]?.function?.arguments).toBe(
			args("[REDACTED:email]"),
		);
	});

	it("a field the schema does not name is sent as written and reported once per governor, by path only", async () => {
		const warnings: Array<{ message: string; code: unknown }> = [];
		const emit = vi.spyOn(process, "emitWarning").mockImplementation(((
			message: string,
			options?: { code?: string },
		) => {
			warnings.push({ message, code: options?.code });
		}) as typeof process.emitWarning);
		const log = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const c = await openai();
			const call = () =>
				c.chat.completions.create({
					model: "gpt-4o",
					messages: [{ role: "user", content: prompt(true) }],
					future_field: { note: EMAIL },
				} as Loose);
			await call();
			await call();
			expect(bodies).toHaveLength(2);
			for (const sent of bodies) {
				expect(sent.future_field).toEqual({ note: EMAIL });
				expect(sent.messages[0].content).toBe("[REDACTED:email]");
			}
			const mine = warnings.filter((w) => w.code === "USERTRUST_PII_UNLISTED_FIELD");
			expect(mine).toHaveLength(1);
			expect(mine[0]?.message).toContain("future_field");
			expect(mine[0]?.message).not.toContain(EMAIL);
		} finally {
			emit.mockRestore();
			log.mockRestore();
		}
	});
});

/**
 * Every mode decides on the same scan as before redaction was narrowed to content: every string in
 * the prompt fields, control values included, each read as written. A value it detects that
 * redaction leaves as written is refused under redact as block refuses it. `warn` is each row's
 * control: the same request is sent, with the value as written.
 */
describe.each([
	{
		where: "an address in a chat message's name",
		messages: [{ role: "user", name: EMAIL, content: "summarize my order" }],
		sent: (b: Loose) => b.messages[0].name,
		value: EMAIL,
		type: "email",
	},
	{
		where: "an address as an object key in a tool call's JSON arguments",
		messages: [
			{ role: "user", content: "send it" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "send", arguments: `{"${EMAIL}":"primary"}` },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "sent" },
		],
		sent: (b: Loose) => b.messages[1].tool_calls[0].function.arguments,
		value: `{"${EMAIL}":"primary"}`,
		type: "email",
	},
	{
		where: "a card number as a JSON number in a tool call's arguments",
		messages: [
			{ role: "user", content: "pay it" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "pay", arguments: '{"card":4111111111111111}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "paid" },
		],
		sent: (b: Loose) => b.messages[1].tool_calls[0].function.arguments,
		value: '{"card":4111111111111111}',
		type: "credit_card",
	},
])("PII the scan detects in $where", ({ messages, sent, value, type }) => {
	for (const mode of ["block", "redact"] as const) {
		it(`pii ${mode} refuses the call and sends nothing`, async () => {
			const c = await openai(mode);
			const call = c.chat.completions.create({ model: "gpt-4o", messages });
			await expect(call).rejects.toBeInstanceOf(PolicyDeniedError);
			await expect(call).rejects.toThrow(`PII detected: ${type}`);
			expect(bodies).toHaveLength(0);
		});
	}

	it("pii warn (the control) sends it as written", async () => {
		const c = await openai("warn");
		await c.chat.completions.create({ model: "gpt-4o", messages });
		expect(bodies).toHaveLength(1);
		expect(sent(bodies[0])).toBe(value);
	});
});

describe("the llm_call audit record under pii warn", () => {
	/** The `llm_call` events the governor wrote to its vault's audit chain. */
	const llmCalls = () =>
		readFileSync(join(vault, VAULT_DIR, AUDIT_DIR, "events.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as { kind: string; data: Record<string, Loose> })
			.filter((e) => e.kind === "llm_call");
	const arguments_ = '{"to":"alice\\u0040example.com"}';
	const messages = [
		{ role: "user", content: "send it" },
		{
			role: "assistant",
			content: null,
			tool_calls: [
				{ id: "call_1", type: "function", function: { name: "send", arguments: arguments_ } },
			],
		},
		{ role: "tool", tool_call_id: "call_1", content: "sent" },
	];

	it.each([false, true])(
		"stream %s: an address only the content scan sees (JSON-escaped in arguments) is sent and recorded",
		async (stream) => {
			const c = await openai("warn");
			if (stream) {
				const s = await c.chat.completions.create({ model: "gpt-4o", messages, stream: true });
				for await (const _ of s.response) {
				}
			} else {
				await c.chat.completions.create({ model: "gpt-4o", messages });
			}
			expect(bodies).toHaveLength(1);
			expect(bodies[0]?.messages?.[1]?.tool_calls?.[0]?.function?.arguments).toBe(arguments_);
			await c.destroy();
			const events = llmCalls();
			expect(events).toHaveLength(1);
			expect(events[0]?.data.piiDetected).toEqual(["email"]);
			expect(events[0]?.data.piiPaths).toEqual([
				"messages[1].tool_calls[0].function.arguments(email)",
			]);
		},
	);
});
