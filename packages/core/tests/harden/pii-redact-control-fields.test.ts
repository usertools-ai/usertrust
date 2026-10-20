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
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type TrustEngine, trust } from "../../src/govern.js";

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

async function govern(raw: unknown): Promise<Loose> {
	const engine = {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
	} satisfies TrustEngine;
	const client = await trust(raw as Loose, {
		budget: 1_000_000,
		vaultBase: vault,
		pii: "redact",
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
const openai = () =>
	govern(
		new OpenAI({
			apiKey: "k",
			baseURL: "https://openai.test/v1",
			fetch: recordingFetch as typeof fetch,
			maxRetries: 0,
		}),
	);
const google = () => govern(new GoogleGenAI({ apiKey: "k" }));

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
			thinking: `I will write to ${EMAIL}`,
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
