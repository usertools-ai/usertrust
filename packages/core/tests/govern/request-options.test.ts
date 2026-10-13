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
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { movedRequestOptions } from "../../src/default-deny.js";
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
async function recordingFetch(input: unknown, init?: RequestInit): Promise<Response> {
	const url = String(input instanceof Request ? input.url : input);
	sent.push(`${init?.method ?? "GET"} ${url}`);
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
	vault = join(tmpdir(), `request-options-${randomUUID()}`);
	mkdirSync(vault, { recursive: true });
	sent = [];
	open = [];
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

describe("movedRequestOptions, on argument lists built by hand", () => {
	it("names every refused key, and only those", () => {
		expect(
			movedRequestOptions("openai", [C, { body: 1, timeout: 1, __metadata: {}, query: {} }]),
		).toEqual(["body", "__metadata"]);
		expect(movedRequestOptions("anthropic", [A])).toEqual([]);
		expect(movedRequestOptions("anthropic", [A, null])).toEqual([]);
	});
});
