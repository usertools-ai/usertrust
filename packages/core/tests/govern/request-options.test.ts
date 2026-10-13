// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Request options that would change what is sent past governance are refused.
 *
 * trust() scans, holds and prices a call from its request parameters. Each SDK posts
 * `{ body, ...options }` and spreads the per-call `fetchOptions` last over the request, so a
 * per-call option can replace the body (`body`, `fetchOptions`, Anthropic `middleware`), move the
 * call to another endpoint or host (`path`, `defaultBaseURL`), or change how its answer is read
 * (`__binaryResponse` and every other `__` option). On Google, `httpOptions.extraBody` merges into
 * the body and `httpOptions.baseUrl` moves the host. Every one of these is refused before
 * anything is held or sent, with one `policy_denied` event; the options that move neither the
 * body nor the host stay governed.
 *
 * Driven through the REAL SDKs over a recording `fetch` (Google: `globalThis.fetch`, its SDK has
 * no injectable one): no network, no real keys.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import Anthropic, { betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { createClient } from "tigerbeetle-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withCostCenter } from "../../src/budget/attribution.js";
import { movedClientOptions, movedRequestOptions } from "../../src/default-deny.js";
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

// biome-ignore lint/suspicious/noExplicitAny: the rows reach SDK members the TrustedClient type hides.
type Loose = any;

const json = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

/** Every request any SDK sends: `METHOD url`. */
let sent: string[] = [];
/** Every request body any SDK sends, in order. */
let bodies: string[] = [];
async function recordingFetch(input: unknown, init?: RequestInit): Promise<Response> {
	const url = String(input instanceof Request ? input.url : input);
	sent.push(`${init?.method ?? "GET"} ${url}`);
	bodies.push(typeof init?.body === "string" ? init.body : "");
	const path = new URL(url).pathname;
	const streamed = typeof init?.body === "string" && JSON.parse(init.body).stream === true;
	if (path.endsWith("/messages") && streamed) return sse(ANTHROPIC_STREAM);
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
	const gemini = {
		candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
	};
	if (path.endsWith(":streamGenerateContent")) {
		return new Response(`data: ${JSON.stringify(gemini)}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	return json(gemini);
}

/** A streamed Anthropic message, as its SSE events. */
const ANTHROPIC_STREAM = [
	{
		type: "message_start",
		message: {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 5 },
	},
	{ type: "message_stop" },
];
function sse(events: Array<{ type: string }>): Response {
	const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
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
	vault = join(tmpdir(), `request-options-${randomUUID()}`);
	mkdirSync(vault, { recursive: true });
	sent = [];
	bodies = [];
	open = [];
	vi.mocked(createClient).mockClear();
});
afterEach(async () => {
	for (const c of open) await c.destroy().catch(() => {});
	rmSync(vault, { recursive: true, force: true });
});

function engine() {
	return {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
	} satisfies TrustEngine;
}

async function govern(raw: unknown) {
	const eng = engine();
	const client = await trust(raw as Loose, { budget: 1_000_000, vaultBase: vault, _engine: eng });
	open.push(client);
	return { client: client as Loose, eng };
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

function policyDenied(): Array<Record<string, unknown>> {
	let text = "";
	try {
		text = readFileSync(join(vault, VAULT_DIR, AUDIT_DIR, "events.jsonl"), "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> })
		.filter((e) => e.kind === "policy_denied")
		.map((e) => e.data);
}

const A = {
	model: "claude-sonnet-4-5",
	max_tokens: 16,
	messages: [{ role: "user", content: "hi" }],
};
const C = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
const R = { model: "gpt-4o", input: "hi" };
const G = { model: "gemini-2.5-pro", contents: "hi" };

/** The refusal's four facts: the error names the key, nothing sent, nothing held, one event. */
async function expectRefused(
	call: () => Promise<unknown>,
	eng: ReturnType<typeof engine>,
	key: RegExp,
): Promise<void> {
	const err = await call().then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(PolicyDeniedError);
	expect(String((err as Error).message)).toMatch(/request_option_refused/);
	expect(String((err as Error).message)).toMatch(key);
	expect(sent).toEqual([]);
	expect(eng.spendPending).not.toHaveBeenCalled();
	expect(policyDenied()).toHaveLength(1);
}

describe("per-call request options that replace the body, the destination or the reading are refused", () => {
	const swapped = JSON.stringify({ ...A, messages: [{ role: "user", content: "other" }] });
	const rows: Array<
		[
			string,
			() => Promise<{ client: Loose; eng: ReturnType<typeof engine> }>,
			(c: Loose) => Promise<unknown>,
			RegExp,
		]
	> = [
		[
			"Anthropic messages.create, body",
			anthropic,
			(c) => c.messages.create(A, { body: A }),
			/\bbody\b/,
		],
		[
			"Anthropic messages.create, fetchOptions",
			anthropic,
			(c) => c.messages.create(A, { fetchOptions: { body: swapped } }),
			/fetchOptions/,
		],
		[
			"Anthropic messages.create, middleware",
			anthropic,
			(c) => c.messages.create(A, { middleware: [async (req: Loose, next: Loose) => next(req)] }),
			/middleware/,
		],
		[
			"Anthropic messages.create, path",
			anthropic,
			(c) => c.messages.create(A, { path: "/v1/messages/batches" }),
			/\bpath\b/,
		],
		[
			"Anthropic messages.create, defaultBaseURL",
			anthropic,
			(c) => c.messages.create(A, { defaultBaseURL: "https://elsewhere.test" }),
			/defaultBaseURL/,
		],
		[
			"Anthropic messages.create, __binaryResponse",
			anthropic,
			(c) => c.messages.create(A, { __binaryResponse: true }),
			/__binaryResponse/,
		],
		[
			"Anthropic messages.stream, body",
			anthropic,
			(c) => c.messages.stream(A, { body: A }),
			/\bbody\b/,
		],
		[
			"Anthropic messages.parse, body",
			anthropic,
			(c) => c.messages.parse(A, { body: A }),
			/\bbody\b/,
		],
		[
			"Anthropic beta.messages.create, body",
			anthropic,
			(c) => c.beta.messages.create(A, { body: A }),
			/\bbody\b/,
		],
		[
			"OpenAI chat.completions.create, body",
			openai,
			(c) => c.chat.completions.create(C, { body: C }),
			/\bbody\b/,
		],
		[
			"OpenAI chat.completions.create, fetchOptions",
			openai,
			(c) => c.chat.completions.create(C, { fetchOptions: { body: "{}" } }),
			/fetchOptions/,
		],
		[
			"OpenAI chat.completions.create, path",
			openai,
			(c) => c.chat.completions.create(C, { path: "/responses" }),
			/\bpath\b/,
		],
		[
			"OpenAI chat.completions.create, defaultBaseURL",
			openai,
			(c) => c.chat.completions.create(C, { defaultBaseURL: "https://elsewhere.test/v1" }),
			/defaultBaseURL/,
		],
		[
			"OpenAI chat.completions.create, __binaryResponse",
			openai,
			(c) => c.chat.completions.create(C, { __binaryResponse: true }),
			/__binaryResponse/,
		],
		[
			"OpenAI chat.completions.create (stream), body",
			openai,
			(c) => c.chat.completions.create({ ...C, stream: true }, { body: C }),
			/\bbody\b/,
		],
		[
			"OpenAI responses.create, body",
			openai,
			(c) => c.responses.create(R, { body: R }),
			/\bbody\b/,
		],
		[
			"Anthropic messages.create, fallbackState (not on the list, unmeasured)",
			anthropic,
			(c) => c.messages.create(A, { fallbackState: {} }),
			/fallbackState/,
		],
		[
			"Anthropic messages.create, an option an SDK adds later",
			anthropic,
			(c) => c.messages.create(A, { someFutureOption: 1 }),
			/someFutureOption/,
		],
		[
			"OpenAI chat.completions.create, an option an SDK adds later",
			openai,
			(c) => c.chat.completions.create(C, { someFutureOption: 1 }),
			/someFutureOption/,
		],
		[
			"OpenAI chat.completions.create, an internal option is named as internal",
			openai,
			(c) => c.chat.completions.create(C, { __metadata: {} }),
			/__metadata \(internal\)/,
		],
		[
			"Google generateContent, httpOptions.baseUrlResourceScope (not on the list)",
			google,
			(c) =>
				c.models.generateContent({ ...G, config: { httpOptions: { baseUrlResourceScope: "x" } } }),
			/httpOptions\.baseUrlResourceScope/,
		],
		[
			"Google generateContent, httpOptions.extraBody",
			google,
			(c) =>
				c.models.generateContent({
					...G,
					config: { httpOptions: { extraBody: { systemInstruction: { parts: [{ text: "x" }] } } } },
				}),
			/httpOptions\.extraBody/,
		],
		[
			"Google generateContent, httpOptions.baseUrl",
			google,
			(c) =>
				c.models.generateContent({
					...G,
					config: { httpOptions: { baseUrl: "https://elsewhere.test" } },
				}),
			/httpOptions\.baseUrl/,
		],
		[
			"Google generateContentStream, httpOptions.extraBody",
			google,
			(c) =>
				c.models.generateContentStream({ ...G, config: { httpOptions: { extraBody: { a: 1 } } } }),
			/httpOptions\.extraBody/,
		],
	];
	for (const [name, make, call, key] of rows) {
		it(name, async () => {
			const { client, eng } = await make();
			await expectRefused(() => call(client), eng, key);
		});
	}
});

describe("the check reads without running caller code, and fails closed where it cannot", () => {
	it("request options given as a Proxy are refused whole, and its traps never run", async () => {
		const { client, eng } = await anthropic();
		const traps = vi.fn();
		const options = new Proxy(
			{},
			{
				ownKeys: () => {
					traps();
					return [];
				},
				get: () => {
					traps();
					return undefined;
				},
			},
		);
		await expectRefused(() => client.messages.create(A, options), eng, /\(a Proxy\)/);
		expect(traps).not.toHaveBeenCalled();
	});

	it("a refused key held by an accessor counts as set, and the accessor never runs", async () => {
		const { client, eng } = await openai();
		const getter = vi.fn(() => C);
		const options = {};
		Object.defineProperty(options, "body", { get: getter, enumerable: true });
		await expectRefused(() => client.chat.completions.create(C, options), eng, /\bbody\b/);
		expect(getter).not.toHaveBeenCalled();
	});

	it("a refused key set to undefined is refused too: the SDK's spread copies it, and `path: undefined` replaces the call's path", async () => {
		const { client, eng } = await anthropic();
		await expectRefused(() => client.messages.create(A, { path: undefined }), eng, /\bpath\b/);
	});
});

describe("options that move neither the body nor the host stay governed", () => {
	it("Anthropic: timeout, maxRetries, signal, headers, query and idempotencyKey", async () => {
		const { client, eng } = await anthropic();
		await client.messages.create(A, {
			timeout: 5000,
			maxRetries: 0,
			signal: new AbortController().signal,
			headers: { "anthropic-beta": "x" },
			query: { beta: "true" },
			idempotencyKey: "k1",
		});
		expect(sent).toEqual(["POST https://anthropic.test/v1/messages?beta=true"]);
		expect(eng.spendPending).toHaveBeenCalledTimes(1);
		expect(policyDenied()).toEqual([]);
	});

	it("OpenAI: timeout, headers, query and method", async () => {
		const { client, eng } = await openai();
		await client.chat.completions.create(C, {
			timeout: 5000,
			headers: { "x-extra": "1" },
			query: { a: "1" },
		});
		expect(sent).toEqual(["POST https://openai.test/v1/chat/completions?a=1"]);
		expect(eng.spendPending).toHaveBeenCalledTimes(1);
	});

	it("Google: httpOptions apiVersion, headers and timeout", async () => {
		const { client, eng } = await google();
		await client.models.generateContent({
			...G,
			config: {
				httpOptions: { apiVersion: "v1alpha", headers: { "x-extra": "1" }, timeout: 5000 },
			},
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatch(/\/v1alpha\/models\/gemini-2\.5-pro:generateContent$/);
		expect(eng.spendPending).toHaveBeenCalledTimes(1);
	});
});

describe("a Google client whose own httpOptions carry extraBody", () => {
	it("is refused at trust(), before any call", async () => {
		const raw = new GoogleGenAI({ apiKey: "k", httpOptions: { extraBody: { a: 1 } } });
		await expect(
			trust(raw as Loose, { budget: 1_000_000, vaultBase: vault, _engine: engine() }),
		).rejects.toThrow(/request_option_refused.*client httpOptions\.extraBody/s);
	});

	it("given extraBody AFTER trust() (on the raw client the caller kept), refuses every call", async () => {
		const raw = new GoogleGenAI({ apiKey: "k" });
		const { client, eng } = await govern(raw);
		(raw.models as Loose).apiClient.clientOptions.httpOptions.extraBody = { a: 1 };
		await expectRefused(
			() => client.models.generateContent(G),
			eng,
			/client httpOptions\.extraBody/,
		);
	});
});

describe("an Anthropic client constructed with middleware (it rewrites every request after governance)", () => {
	const raw = (middleware?: unknown[]) =>
		new Anthropic({
			apiKey: "k",
			baseURL: "https://anthropic.test",
			fetch: recordingFetch as typeof fetch,
			maxRetries: 0,
			...(middleware ? { middleware: middleware as Loose } : {}),
		});

	it("is refused at trust(): a middleware that swaps the body", async () => {
		const swap = async (req: Loose, next: Loose) => next({ ...req, body: JSON.stringify(A) });
		await expect(
			trust(raw([swap]) as Loose, { budget: 1_000_000, vaultBase: vault, _engine: engine() }),
		).rejects.toThrow(/request_option_refused.*client middleware/s);
		expect(sent).toEqual([]);
	});

	it("is refused at trust(): the SDK's own betaRefusalFallbackMiddleware, which re-sends to another model after pricing", async () => {
		const fallback = betaRefusalFallbackMiddleware({ fallbackModel: "claude-sonnet-4-5" } as Loose);
		await expect(
			trust(raw([fallback]) as Loose, { budget: 1_000_000, vaultBase: vault, _engine: engine() }),
		).rejects.toThrow(/client middleware/);
	});

	it("given middleware AFTER trust() (pushed on the raw client the caller kept), refuses every call", async () => {
		const r = raw();
		const { client, eng } = await govern(r);
		(r as Loose).middleware.push(async (req: Loose, next: Loose) => next(req));
		await expectRefused(() => client.messages.create(A), eng, /client middleware/);
	});

	it("never widens to the default: a default client, and a subclass whose backendMiddleware() signs requests, both pass", async () => {
		expect(movedClientOptions("anthropic", new Anthropic({ apiKey: "k" }))).toEqual([]);
		class Signed extends Anthropic {
			override backendMiddleware() {
				return [async (req: Loose, next: Loose) => next(req)] as Loose;
			}
		}
		const { client, eng } = await govern(
			new Signed({
				apiKey: "k",
				baseURL: "https://anthropic.test",
				fetch: recordingFetch as typeof fetch,
				maxRetries: 0,
			}),
		);
		await client.messages.create(A);
		expect(sent).toEqual(["POST https://anthropic.test/v1/messages"]);
		expect(eng.spendPending).toHaveBeenCalledTimes(1);
		expect(policyDenied()).toEqual([]);
	});
});

describe("the SDK helpers' own options are on the governed list", () => {
	it("Anthropic messages.stream is held and sent", async () => {
		const { client, eng } = await anthropic();
		// The governed stream authorizes first, so it is awaited; it resolves to the SDK's handle.
		const handle = await client.messages.stream(A);
		await handle.finalMessage();
		expect(sent).toEqual(["POST https://anthropic.test/v1/messages"]);
		expect(eng.spendPending).toHaveBeenCalledTimes(1);
		expect(policyDenied()).toEqual([]);
	});

	it("Anthropic messages.parse is held and sent", async () => {
		const { client, eng } = await anthropic();
		await client.messages.parse(A);
		expect(sent).toEqual(["POST https://anthropic.test/v1/messages"]);
		expect(eng.spendPending).toHaveBeenCalledTimes(1);
	});
});

describe("what is forwarded is a copy of the governed options, never the caller's object", () => {
	const SECRET = "ssn 123-45-6789";
	it("Anthropic: a body added to the options after the call starts never reaches the wire", async () => {
		const { client } = await anthropic();
		const options: Record<string, unknown> = {};
		const pending = client.messages.create(A, options);
		options.body = { ...A, messages: [{ role: "user", content: SECRET }] };
		await pending;
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).not.toContain(SECRET);
	});

	it("OpenAI chat: a fetchOptions body added after the call starts never reaches the wire", async () => {
		const { client } = await openai();
		const options: Record<string, unknown> = {};
		const pending = client.chat.completions.create(C, options);
		options.fetchOptions = {
			body: JSON.stringify({ ...C, messages: [{ role: "user", content: SECRET }] }),
		};
		await pending;
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).not.toContain(SECRET);
	});

	it("OpenAI Responses: a body added after the call starts never reaches the wire", async () => {
		const { client } = await openai();
		const options: Record<string, unknown> = {};
		const pending = client.responses.create(R, options);
		options.body = { ...R, input: SECRET };
		await pending;
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).not.toContain(SECRET);
	});

	it("Google: an extraBody added to config.httpOptions after the call starts never reaches the wire", async () => {
		const { client } = await google();
		const httpOptions: Record<string, unknown> = { timeout: 5000 };
		const pending = client.models.generateContent({ ...G, config: { httpOptions } });
		httpOptions.extraBody = { systemInstruction: { parts: [{ text: SECRET }] } };
		await pending;
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).not.toContain(SECRET);
	});

	it("an ALLOWED option held by an accessor is refused, and the accessor never runs", async () => {
		const { client, eng } = await anthropic();
		const getter = vi.fn(() => 5000);
		const options = {};
		Object.defineProperty(options, "timeout", { get: getter, enumerable: true });
		await expectRefused(() => client.messages.create(A, options), eng, /timeout \(an accessor\)/);
		expect(getter).not.toHaveBeenCalled();
	});

	it("a Google request given as a Proxy is refused whole (by whichever check reaches it first), nothing sent or held", async () => {
		const { client, eng } = await google();
		const err = await client.models.generateContent(new Proxy({ ...G }, {})).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(PolicyDeniedError);
		expect(sent).toEqual([]);
		expect(eng.spendPending).not.toHaveBeenCalled();
	});
});

describe("a client constructed with fetchOptions that replace the body is refused", () => {
	for (const [name, make] of [
		[
			"Anthropic",
			(fetchOptions: object) =>
				new Anthropic({
					apiKey: "k",
					baseURL: "https://anthropic.test",
					fetch: recordingFetch as typeof fetch,
					maxRetries: 0,
					fetchOptions: fetchOptions as Loose,
				}),
		],
		[
			"OpenAI",
			(fetchOptions: object) =>
				new OpenAI({
					apiKey: "k",
					baseURL: "https://openai.test/v1",
					fetch: recordingFetch as typeof fetch,
					maxRetries: 0,
					fetchOptions: fetchOptions as Loose,
				}),
		],
	] as const) {
		it(`${name}: fetchOptions.body is refused at trust()`, async () => {
			await expect(
				trust(make({ body: "{}" }) as Loose, {
					budget: 1_000_000,
					vaultBase: vault,
					_engine: engine(),
				}),
			).rejects.toThrow(/request_option_refused.*client fetchOptions\.body/s);
		});
		it(`${name}: fetchOptions.method is refused at trust()`, async () => {
			await expect(
				trust(make({ method: "GET" }) as Loose, {
					budget: 1_000_000,
					vaultBase: vault,
					_engine: engine(),
				}),
			).rejects.toThrow(/client fetchOptions\.method/);
		});
		it(`${name}: a transport-only fetchOptions (a proxy dispatcher) is governed and passes`, async () => {
			const { client, eng } = await govern(make({ dispatcher: {} }));
			await (name === "Anthropic" ? client.messages.create(A) : client.chat.completions.create(C));
			expect(sent).toHaveLength(1);
			expect(eng.spendPending).toHaveBeenCalledTimes(1);
		});
	}

	it("a refusal at trust() builds no ledger client: nothing is left to keep the process alive", async () => {
		const raw = new Anthropic({
			apiKey: "k",
			baseURL: "https://anthropic.test",
			fetch: recordingFetch as typeof fetch,
			maxRetries: 0,
			middleware: [async (req: Loose, next: Loose) => next(req)],
		});
		// No injected engine and not a dry run: trust() would build the ledger client next.
		await expect(trust(raw as Loose, { budget: 1_000_000, vaultBase: vault })).rejects.toThrow(
			/client middleware/,
		);
		expect(vi.mocked(createClient)).not.toHaveBeenCalled();
	});
});

describe("nothing that cannot be read without running caller code is read as absent", () => {
	const SECRET = "ssn 123-45-6789";
	const rawAnthropic = () =>
		new Anthropic({
			apiKey: "k",
			baseURL: "https://anthropic.test",
			fetch: recordingFetch as typeof fetch,
			maxRetries: 0,
		});
	const rawOpenAI = () =>
		new OpenAI({
			apiKey: "k",
			baseURL: "https://openai.test/v1",
			fetch: recordingFetch as typeof fetch,
			maxRetries: 0,
		});

	it("per-call options given as a FUNCTION (its own length and name deleted) are refused", async () => {
		const { client, eng } = await anthropic();
		const options = () => {};
		delete (options as Loose).length;
		delete (options as Loose).name;
		await expectRefused(
			() => client.messages.create(A, options),
			eng,
			/options \(not a plain object\)/,
		);
	});

	for (const [name, make] of [
		["Anthropic", rawAnthropic],
		["OpenAI", rawOpenAI],
	] as const) {
		const call = (c: Loose) =>
			name === "Anthropic" ? c.messages.create(A) : c.chat.completions.create(C);

		it(`${name}: a client fetchOptions that is a FUNCTION carrying body is refused at trust()`, async () => {
			const fetchOptions = Object.assign(() => {}, { body: "{}" });
			const raw = make();
			Object.defineProperty(raw, "fetchOptions", {
				value: fetchOptions,
				writable: true,
				configurable: true,
			});
			await expect(
				trust(raw as Loose, { budget: 1_000_000, vaultBase: vault, _engine: engine() }),
			).rejects.toThrow(/client fetchOptions \(not a plain object\)/);
		});

		it(`${name}: a client fetchOptions.body set on the raw client AFTER trust() refuses every call`, async () => {
			const raw = make();
			const { client, eng } = await govern(raw);
			(raw as Loose).fetchOptions = { body: JSON.stringify({ secret: SECRET }) };
			await expectRefused(() => call(client), eng, /client fetchOptions\.body/);
		});

		it(`${name}: the raw client's fetchOptions turned into an ACCESSOR after trust() refuses every call, and is never read`, async () => {
			const raw = make();
			const { client, eng } = await govern(raw);
			const getter = vi.fn(() => ({ body: JSON.stringify({ secret: SECRET }) }));
			Object.defineProperty(raw, "fetchOptions", { get: getter, configurable: true });
			await expectRefused(() => call(client), eng, /client fetchOptions \(unreadable\)/);
			expect(getter).not.toHaveBeenCalled();
		});

		it(`${name}: an ACCESSOR on the resource's _client after trust() refuses every call`, async () => {
			const raw = make();
			const { client, eng } = await govern(raw);
			const resource =
				name === "Anthropic" ? (raw as Loose).messages : (raw as Loose).chat.completions;
			Object.defineProperty(resource, "_client", { get: () => raw, configurable: true });
			await expectRefused(() => call(client), eng, /client \(unreadable\)/);
		});
	}

	it("Anthropic: the raw client's middleware turned into an ACCESSOR after trust() refuses every call", async () => {
		const raw = rawAnthropic();
		const { client, eng } = await govern(raw);
		Object.defineProperty(raw, "middleware", { get: () => [], configurable: true });
		await expectRefused(() => client.messages.create(A), eng, /client middleware \(unreadable\)/);
	});

	it("Google: the raw client's httpOptions.extraBody turned into an ACCESSOR after trust() refuses every call", async () => {
		const raw = new GoogleGenAI({ apiKey: "k" });
		const { client, eng } = await govern(raw);
		const http = (raw.models as Loose).apiClient.clientOptions.httpOptions;
		Object.defineProperty(http, "extraBody", {
			get: () => ({ systemInstruction: { parts: [{ text: SECRET }] } }),
			enumerable: true,
			configurable: true,
		});
		await expectRefused(
			() => client.models.generateContent(G),
			eng,
			/client httpOptions\.extraBody/,
		);
	});

	it("Google: a Proxy for the raw client's clientOptions after trust() refuses every call", async () => {
		const raw = new GoogleGenAI({ apiKey: "k" });
		const { client, eng } = await govern(raw);
		const apiClient = (raw.models as Loose).apiClient;
		apiClient.clientOptions = new Proxy(apiClient.clientOptions, {});
		await expectRefused(
			() => client.models.generateContent(G),
			eng,
			/client httpOptions \(unreadable\)/,
		);
	});

	it("Google: an ACCESSOR on models.apiClient after trust() refuses every call", async () => {
		const raw = new GoogleGenAI({ apiKey: "k" });
		const { client, eng } = await govern(raw);
		const apiClient = (raw.models as Loose).apiClient;
		Object.defineProperty(raw.models, "apiClient", { get: () => apiClient, configurable: true });
		await expectRefused(
			() => client.models.generateContent(G),
			eng,
			/client httpOptions \(unreadable\)/,
		);
	});

	it("an INHERITED allowed option is refused, not silently dropped from the copy", async () => {
		const { client, eng } = await anthropic();
		const options = Object.create({ headers: { "anthropic-beta": "x" } });
		await expectRefused(
			() => client.messages.create(A, options),
			eng,
			/options \(not a plain object\)/,
		);
	});

	it("a null-prototype options object is plain, and an accessor on it is still refused, uncalled", async () => {
		const { client, eng } = await anthropic();
		const getter = vi.fn(() => 5000);
		const options = Object.create(null);
		Object.defineProperty(options, "timeout", { get: getter, enumerable: true });
		await expectRefused(() => client.messages.create(A, options), eng, /timeout \(an accessor\)/);
		expect(getter).not.toHaveBeenCalled();
		// and a null-prototype object of data passes, copied
		const { client: c2, eng: e2 } = await anthropic();
		const plain = Object.assign(Object.create(null), { timeout: 5000 });
		await c2.messages.create(A, plain);
		expect(e2.spendPending).toHaveBeenCalledTimes(1);
	});

	it("Google: a per-call config held by an accessor, or given as a Proxy, is refused", async () => {
		const { client, eng } = await google();
		const request: Record<string, unknown> = { ...G };
		Object.defineProperty(request, "config", {
			get: () => ({ httpOptions: { extraBody: { a: 1 } } }),
			enumerable: true,
		});
		const err = await client.models.generateContent(request).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(PolicyDeniedError);
		expect(sent).toEqual([]);
		expect(eng.spendPending).not.toHaveBeenCalled();
		const err2 = await client.models
			.generateContent({ ...G, config: new Proxy({ httpOptions: { extraBody: { a: 1 } } }, {}) })
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(err2).toBeInstanceOf(PolicyDeniedError);
		expect(sent).toEqual([]);
	});

	it("the trusted root is no wider than the root: a Proxy client whose resource carries a plain _client with fetchOptions.body is refused", async () => {
		const raw = rawAnthropic();
		const tainted = Object.create(raw.messages);
		// a fresh, plain stand-in for the resource's client, carrying a body in its fetchOptions
		Object.defineProperty(tainted, "_client", {
			value: { fetchOptions: { body: "{}" } },
			enumerable: true,
		});
		const wrapped = new Proxy(raw, {
			get: (target, key, receiver) =>
				key === "messages" ? tainted : Reflect.get(target, key, receiver),
		});
		const { client, eng } = await govern(wrapped);
		await expectRefused(() => client.messages.create(A), eng, /client fetchOptions\.body/);
	});

	it("a signing subclass whose EMPTY middleware array gets an own iterator after trust() refuses every call (the SDK spreads it)", async () => {
		class Signed extends Anthropic {
			override backendMiddleware() {
				return [async (req: Loose, next: Loose) => next(req)] as Loose;
			}
		}
		const raw = new Signed({
			apiKey: "k",
			baseURL: "https://anthropic.test",
			fetch: recordingFetch as typeof fetch,
			maxRetries: 0,
		});
		const { client, eng } = await govern(raw);
		const evil = async (req: Loose, next: Loose) =>
			next({ ...req, body: JSON.stringify({ secret: SECRET }) });
		(raw as Loose).middleware[Symbol.iterator] = function* () {
			yield evil;
		};
		await expectRefused(
			() => client.messages.create(A),
			eng,
			/client middleware \(not a plain array\)/,
		);
		expect(bodies.join("")).not.toContain(SECRET);
	});

	it("DECLARED: a client handed to trust() inside a forwarding Proxy is trusted transport, and works", async () => {
		const { client, eng } = await govern(new Proxy(rawAnthropic(), {}));
		await client.messages.create(A);
		expect(sent).toEqual(["POST https://anthropic.test/v1/messages"]);
		expect(eng.spendPending).toHaveBeenCalledTimes(1);
		expect(policyDenied()).toEqual([]);
	});
});

describe("plain options from another realm (a vm context) are plain", () => {
	const foreign = <T>(source: string): T => runInNewContext(`(${source})`) as T;

	it("Anthropic messages.create with cross-realm options is held and sent", async () => {
		const { client, eng } = await anthropic();
		await client.messages.create(A, foreign("{ timeout: 5000 }"));
		expect(sent).toEqual(["POST https://anthropic.test/v1/messages"]);
		expect(eng.spendPending).toHaveBeenCalledTimes(1);
	});

	it("OpenAI chat and Responses with cross-realm options are held and sent", async () => {
		const { client, eng } = await openai();
		await client.chat.completions.create(C, foreign("{ timeout: 5000 }"));
		await client.responses.create(R, foreign("{ maxRetries: 0 }"));
		expect(sent).toHaveLength(2);
		expect(eng.spendPending).toHaveBeenCalledTimes(2);
	});

	it("Google with a cross-realm config.httpOptions is held and sent", async () => {
		const { client, eng } = await google();
		await client.models.generateContent({
			...G,
			config: { httpOptions: foreign("{ timeout: 5000 }") },
		});
		expect(sent).toHaveLength(1);
		expect(eng.spendPending).toHaveBeenCalledTimes(1);
	});

	it("a cross-realm client fetchOptions carrying body is still refused at trust(); one carrying a dispatcher passes", async () => {
		const withBody = new OpenAI({
			apiKey: "k",
			baseURL: "https://openai.test/v1",
			fetch: recordingFetch as typeof fetch,
			maxRetries: 0,
			fetchOptions: foreign("{ body: '{}' }"),
		});
		await expect(
			trust(withBody as Loose, { budget: 1_000_000, vaultBase: vault, _engine: engine() }),
		).rejects.toThrow(/client fetchOptions\.body/);
		const { client, eng } = await govern(
			new OpenAI({
				apiKey: "k",
				baseURL: "https://openai.test/v1",
				fetch: recordingFetch as typeof fetch,
				maxRetries: 0,
				fetchOptions: foreign("{ dispatcher: {} }"),
			}),
		);
		await client.chat.completions.create(C);
		expect(eng.spendPending).toHaveBeenCalledTimes(1);
	});

	it("a cross-realm middleware ARRAY put on the raw client after trust() is refused (the SDK spreads it)", async () => {
		const raw = new Anthropic({
			apiKey: "k",
			baseURL: "https://anthropic.test",
			fetch: recordingFetch as typeof fetch,
			maxRetries: 0,
		});
		const { client, eng } = await govern(raw);
		(raw as Loose).middleware = foreign("[]");
		await expectRefused(
			() => client.messages.create(A),
			eng,
			/client middleware \(not a plain array\)/,
		);
	});
});

describe("movedRequestOptions, on argument lists built by hand", () => {
	it("names every refused key, and only those", () => {
		expect(
			movedRequestOptions("openai", [C, { body: 1, timeout: 1, __metadata: {}, query: {} }]),
		).toEqual(["body", "__metadata (internal)"]);
		expect(movedRequestOptions("anthropic", [A])).toEqual([]);
		expect(movedRequestOptions("anthropic", [A, null])).toEqual([]);
	});
});

describe("an INHERITED transport property is read where the SDK reads it, never taken as absent", () => {
	const SECRET = "ssn 123-45-6789";
	const extraBody = () => ({ systemInstruction: { parts: [{ text: SECRET }] } });
	const rawAnthropic = () =>
		new Anthropic({
			apiKey: "k",
			baseURL: "https://anthropic.test",
			fetch: recordingFetch as typeof fetch,
			maxRetries: 0,
		});

	it("a client handed to trust() as Object.create(client), whose fetchOptions carries body, is refused at trust()", async () => {
		const raw = rawAnthropic();
		(raw as Loose).fetchOptions = { body: JSON.stringify({ secret: SECRET }) };
		await expect(
			trust(Object.create(raw) as Loose, {
				budget: 1_000_000,
				vaultBase: vault,
				_engine: engine(),
			}),
		).rejects.toThrow(/request_option_refused.*client fetchOptions\.body/s);
	});

	it("a resource whose _client is inherited, on a client given fetchOptions.body after trust(), refuses every call", async () => {
		const raw = rawAnthropic();
		const { client, eng } = await govern(raw);
		// the resource the governed client runs on now INHERITS its _client from a prototype
		const messages = (raw as Loose).messages;
		const proto = Object.create(Object.getPrototypeOf(messages));
		proto._client = raw;
		Object.setPrototypeOf(messages, proto);
		delete messages._client;
		(raw as Loose).fetchOptions = { body: JSON.stringify({ secret: SECRET }) };
		await expectRefused(() => client.messages.create(A), eng, /client fetchOptions\.body/);
		expect(bodies.join("")).not.toContain(SECRET);
	});

	it("Google: a client whose clientOptions INHERIT an httpOptions carrying extraBody refuses every call", async () => {
		const raw = new GoogleGenAI({ apiKey: "k" });
		const { client, eng } = await govern(raw);
		const apiClient = (raw.models as Loose).apiClient;
		const own = apiClient.clientOptions;
		apiClient.clientOptions = Object.create({
			...own,
			httpOptions: { ...own.httpOptions, extraBody: extraBody() },
		});
		await expectRefused(
			() => client.models.generateContent(G),
			eng,
			/client httpOptions\.extraBody/,
		);
	});

	it("Google: a per-call config whose httpOptions is INHERITED is checked, and refused for extraBody", async () => {
		const { client, eng } = await google();
		await expectRefused(
			() =>
				client.models.generateContent({
					...G,
					config: Object.create({ httpOptions: { extraBody: extraBody() } }),
				}),
			eng,
			/config\.httpOptions\.extraBody/,
		);
	});

	it("Google: a request whose config is INHERITED is checked, and refused for extraBody", async () => {
		const { client, eng } = await google();
		const request = Object.assign(
			Object.create({ config: { httpOptions: { extraBody: extraBody() } } }),
			G,
		);
		await expectRefused(
			() => client.models.generateContent(request),
			eng,
			/config\.httpOptions\.extraBody/,
		);
	});

	it("a Proxy on the prototype chain is refused as unreadable, and none of its traps runs", async () => {
		const trap = vi.fn();
		const proto = new Proxy(
			{},
			{
				get: () => trap(),
				getOwnPropertyDescriptor: () => trap(),
				getPrototypeOf: () => trap() ?? null,
				has: () => trap() ?? false,
			},
		);
		const config = Object.create(proto);
		expect(movedRequestOptions("google", [{ ...G, config }])).toEqual([
			"config.httpOptions (unreadable)",
		]);
		// Through the client, by whichever check reaches it first: nothing sent, held, or run.
		const { client, eng } = await google();
		const err = await client.models.generateContent({ ...G, config }).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(PolicyDeniedError);
		expect(sent).toEqual([]);
		expect(eng.spendPending).not.toHaveBeenCalled();
		expect(policyDenied()).toHaveLength(1);
		expect(trap).not.toHaveBeenCalled();
	});

	it("the walk is bounded: a key 64 objects down is read, one 65 down is unreadable", () => {
		const chain = (depth: number): object => {
			let o: object = { httpOptions: { extraBody: {} } };
			for (let i = 1; i < depth; i++) o = Object.create(o);
			return o;
		};
		expect(movedRequestOptions("google", [{ ...G, config: chain(64) }])).toEqual([
			"config.httpOptions.extraBody",
		]);
		expect(movedRequestOptions("google", [{ ...G, config: chain(65) }])).toEqual([
			"config.httpOptions (unreadable)",
		]);
	});

	it("an inherited ALLOWED per-call option still sends (Google config from a class instance)", async () => {
		const { client, eng } = await google();
		class Config {
			get kind(): string {
				return "config";
			}
		}
		const config = Object.assign(new Config(), { httpOptions: { timeout: 5000 } });
		await client.models.generateContent({ ...G, config });
		expect(sent).toHaveLength(1);
		expect(eng.spendPending).toHaveBeenCalledTimes(1);
	});
});

describe("a Google client's httpOptions is held to what the SDK would find on it", () => {
	const SECRET = "ssn 123-45-6789";
	const extraBody = { systemInstruction: { parts: [{ text: SECRET }] } };

	it("one from another realm, whose Object.prototype carries extraBody, refuses every call", async () => {
		const raw = new GoogleGenAI({ apiKey: "k" });
		const { client, eng } = await govern(raw);
		const apiClient = (raw.models as Loose).apiClient;
		const foreign = runInNewContext(
			"(extraBody) => { Object.prototype.extraBody = extraBody; return {}; }",
		) as (e: unknown) => Record<string, unknown>;
		apiClient.clientOptions.httpOptions = Object.assign(
			foreign(extraBody),
			apiClient.clientOptions.httpOptions,
		);
		await expectRefused(
			() => client.models.generateContent(G),
			eng,
			/client httpOptions \(another realm's object\)/,
		);
		expect(bodies.join("")).not.toContain(SECRET);
	});

	it("one carrying toJSON (the SDK JSON-copies it under a call's own httpOptions) refuses every call", async () => {
		const raw = new GoogleGenAI({ apiKey: "k" });
		const { client, eng } = await govern(raw);
		const http = (raw.models as Loose).apiClient.clientOptions.httpOptions;
		const copy = { ...http };
		http.toJSON = () => ({ ...copy, extraBody });
		await expectRefused(
			() => client.models.generateContent({ ...G, config: { httpOptions: { timeout: 5000 } } }),
			eng,
			/client httpOptions\.toJSON/,
		);
		expect(bodies.join("")).not.toContain(SECRET);
	});

	it("an extraBody it inherits from this realm's Object.prototype refuses every call", async () => {
		const raw = new GoogleGenAI({ apiKey: "k" });
		const { client, eng } = await govern(raw);
		Object.defineProperty(Object.prototype, "extraBody", {
			value: extraBody,
			configurable: true,
			writable: true,
		});
		try {
			await expectRefused(
				() => client.models.generateContent(G),
				eng,
				/client httpOptions\.extraBody/,
			);
		} finally {
			delete (Object.prototype as Loose).extraBody;
		}
		expect(bodies.join("")).not.toContain(SECRET);
	});

	it("a null-prototype one of data passes, and the call is held and sent", async () => {
		const raw = new GoogleGenAI({ apiKey: "k" });
		const { client, eng } = await govern(raw);
		const apiClient = (raw.models as Loose).apiClient;
		apiClient.clientOptions.httpOptions = Object.assign(
			Object.create(null),
			apiClient.clientOptions.httpOptions,
		);
		await client.models.generateContent(G);
		expect(sent).toHaveLength(1);
		expect(eng.spendPending).toHaveBeenCalledTimes(1);
	});
});

describe("a revoked Proxy is refused and recorded, never thrown past the denial record", () => {
	const rawAnthropic = () =>
		new Anthropic({
			apiKey: "k",
			baseURL: "https://anthropic.test",
			fetch: recordingFetch as typeof fetch,
			maxRetries: 0,
		});
	const revoked = (): unknown => {
		const { proxy, revoke } = Proxy.revocable([], {});
		revoke();
		return proxy;
	};

	it("Anthropic: a revoked Proxy as the client's middleware is refused at trust()", async () => {
		const raw = rawAnthropic();
		(raw as Loose).middleware = revoked();
		await expect(
			trust(raw as Loose, { budget: 1_000_000, vaultBase: vault, _engine: engine() }),
		).rejects.toThrow(/request_option_refused.*client middleware \(not a plain array\)/s);
	});

	it("Anthropic: a revoked Proxy put on the raw client's middleware after trust() refuses every call, recorded", async () => {
		const raw = rawAnthropic();
		const { client, eng } = await govern(raw);
		(raw as Loose).middleware = revoked();
		await expectRefused(
			() => client.messages.create(A),
			eng,
			/client middleware \(not a plain array\)/,
		);
	});
});

describe("a request that cannot be serialized to JSON is refused before anything is held or sent", () => {
	const SECRET = "ssn 123-45-6789";
	/** A request whose `toJSON` throws the first time it is asked, then answers `later`. */
	const throwOnce = (base: Record<string, unknown>, later: Record<string, unknown>) => {
		let first = true;
		return {
			...base,
			toJSON() {
				if (first) {
					first = false;
					throw new Error("not yet");
				}
				return later;
			},
		};
	};
	async function expectUnserializable(
		call: () => Promise<unknown>,
		eng: ReturnType<typeof engine>,
	): Promise<void> {
		const err = await call().then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(PolicyDeniedError);
		expect(String((err as Error).message)).toMatch(/request_unserializable/);
		expect(sent).toEqual([]);
		expect(eng.spendPending).not.toHaveBeenCalled();
		expect(policyDenied()).toHaveLength(1);
	}
	const surfaces: Array<
		[
			string,
			() => ReturnType<typeof govern>,
			(c: Loose, p: unknown) => Promise<unknown>,
			Record<string, unknown>,
			Record<string, unknown>,
		]
	> = [
		[
			"Anthropic messages.create",
			anthropic,
			(c, p) => c.messages.create(p),
			A,
			{ ...A, messages: [{ role: "user", content: SECRET }] },
		],
		[
			"OpenAI chat",
			openai,
			(c, p) => c.chat.completions.create(p),
			C,
			{ ...C, messages: [{ role: "user", content: SECRET }] },
		],
		["OpenAI Responses", openai, (c, p) => c.responses.create(p), R, { ...R, input: SECRET }],
	];

	it.each(surfaces)(
		"%s: a toJSON that throws once and then answers is refused, and what it would answer never leaves",
		async (_, make, call, base, later) => {
			const { client, eng } = await make();
			await expectUnserializable(() => call(client, throwOnce(base, later)), eng);
			expect(bodies.join("")).not.toContain(SECRET);
		},
	);

	it("an honest null (a cycle) is refused at entry, with its denial recorded; nothing was ever sent for it", async () => {
		const { client, eng } = await anthropic();
		const message: Record<string, unknown> = { role: "user", content: "hi" };
		message.self = message;
		await expectUnserializable(() => client.messages.create({ ...A, messages: [message] }), eng);
	});

	it("an honest null (a BigInt) is refused before any hold, where it used to fail inside the SDK after one", async () => {
		const { client, eng } = await openai();
		await expectUnserializable(
			() => client.chat.completions.create({ ...C, metadata: { n: 1n } as Loose }),
			eng,
		);
	});

	it("the refusal and its record carry no caller data", async () => {
		const { client, eng } = await anthropic();
		const later = { ...A, messages: [{ role: "user", content: SECRET }] };
		const err = await client.messages.create(throwOnce(A, later)).then(
			() => null,
			(e: unknown) => e,
		);
		expect(String((err as Error).message)).not.toContain(SECRET);
		expect(readFileSync(join(vault, VAULT_DIR, AUDIT_DIR, "events.jsonl"), "utf8")).not.toContain(
			SECRET,
		);
		expect(eng.spendPending).not.toHaveBeenCalled();
	});

	it("Google, positive control: a callable tool holding a cyclic client (an MCP client's shape) is sent, as on master", async () => {
		const { client, eng } = await google();
		const mcpClient: Record<string, unknown> = { name: "mcp" };
		mcpClient.self = mcpClient;
		const tool = {
			mcpClients: [mcpClient],
			async tool() {
				return { functionDeclarations: [{ name: "lookup", description: "x" }] };
			},
			async callTool() {
				return [];
			},
		};
		await client.models.generateContent({
			...G,
			config: { tools: [tool], automaticFunctionCalling: { disable: true } },
		});
		expect(sent).toHaveLength(1);
		expect(eng.spendPending).toHaveBeenCalledTimes(1);
		expect(policyDenied()).toEqual([]);
	});

	it("Google: a request's own toJSON never reaches what is sent (the request gate sends its plain mirror), so there is nothing to refuse", async () => {
		const { client, eng } = await google();
		await client.models.generateContent(throwOnce(G, { ...G, contents: SECRET }));
		expect(sent).toHaveLength(1);
		expect(bodies.join("")).not.toContain(SECRET);
		expect(eng.spendPending).toHaveBeenCalledTimes(1);
	});
});

describe("what the unserializable-request check leaves as it was", () => {
	/** A real AbortSignal of this realm carrying an own cycle. */
	const cyclicSignal = () => {
		const signal = new AbortController().signal;
		Object.assign(signal, { self: signal });
		return signal;
	};
	it("Google: a real AbortSignal with an own cycle is the transport's, not the request's: generateContent is sent and held", async () => {
		const { client, eng } = await google();
		await client.models.generateContent({ ...G, config: { abortSignal: cyclicSignal() } });
		expect(sent).toHaveLength(1);
		expect(eng.spendPending).toHaveBeenCalledTimes(1);
		expect(policyDenied()).toEqual([]);
	});

	it("Google: the same signal on generateContentStream is sent and held too", async () => {
		const { client, eng } = await google();
		const stream = await client.models.generateContentStream({
			...G,
			config: { abortSignal: cyclicSignal() },
		});
		for await (const _ of stream) {
			// drain
		}
		expect(sent).toHaveLength(1);
		expect(eng.spendPending).toHaveBeenCalledTimes(1);
		expect(policyDenied()).toEqual([]);
	});

	it.each(["generateContent", "generateContentStream"] as const)(
		"Google %s: a NON-signal object with a cycle at config.abortSignal is the request's, and is refused before any hold (it never reached the wire before either: the SDK's transport threw on it, after a hold)",
		async (method) => {
			const { client, eng } = await google();
			const lookalike: Record<string, unknown> = { aborted: false };
			lookalike.self = lookalike;
			const err = await (async () => {
				const result = await client.models[method]({ ...G, config: { abortSignal: lookalike } });
				if (method === "generateContentStream") {
					for await (const _ of result as AsyncIterable<unknown>) {
						// drain
					}
				}
			})().then(
				() => null,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(PolicyDeniedError);
			expect(String((err as Error).message)).toMatch(/request_unserializable/);
			expect(sent).toEqual([]);
			expect(eng.spendPending).not.toHaveBeenCalled();
			expect(policyDenied()).toHaveLength(1);
		},
	);

	it("an attributed call with no parentUserId fails on its identity first: no hook of the caller's runs, and no refusal is recorded", async () => {
		const { client, eng } = await anthropic();
		let hooks = 0;
		const request = {
			...A,
			toJSON() {
				hooks += 1;
				throw new Error("never serializable");
			},
		};
		const err = await withCostCenter("team-a", () => client.messages.create(request)).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(Error);
		expect(String((err as Error).message)).not.toMatch(/request_unserializable/);
		expect(String((err as Error).message)).toMatch(/parentUserId/);
		expect(hooks).toBe(0);
		expect(policyDenied()).toEqual([]);
		expect(sent).toEqual([]);
		expect(eng.spendPending).not.toHaveBeenCalled();
	});
});
