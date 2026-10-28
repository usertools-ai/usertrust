// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Default-deny on Anthropic and OpenAI clients (Google: google-default-deny.test.ts), and the
 * parts of the boundary every provider shares (method identity, the SDK peer floors).
 *
 * A trust() client governs a handful of methods (messages.create/stream/parse,
 * chat.completions.create, responses.create, ...). Every OTHER SDK method reached off the
 * client, at any depth, is refused: the call rejects with a PolicyDeniedError naming the
 * method, one `policy_denied` event lands on the chain, nothing is held and the SDK is never
 * called. The exceptions are a free list of non-billable methods (which run on the raw SDK
 * resource), and the methods an operator lists in `allowUngoverned` (which run unmetered and
 * are audited as `ungoverned_call`).
 *
 * Driven through the REAL SDKs (@anthropic-ai/sdk, openai) over a recording `fetch` passed to
 * the SDK constructor: no network, no real keys. `globalThis.fetch` is replaced by a thrower,
 * so a request that escaped the injected fetch fails the run instead of leaving the machine.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyVault } from "../../../verify/src/index.js";
import type { AuditWriter } from "../../src/audit/chain.js";
import { run as runVerifyCli } from "../../src/cli/verify.js";
import * as defaultDeny from "../../src/default-deny.js";
import { FREE_METHODS, GOVERNED_PATHS, transportOptionKeys } from "../../src/default-deny.js";
import { type TrustEngine, type TrustOpts, trust } from "../../src/govern.js";
import { AUDIT_DIR, VAULT_DIR } from "../../src/shared/constants.js";
import { AuditDegradedError, PolicyDeniedError } from "../../src/shared/errors.js";

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

// ── Canned provider bodies ──

const ANTHROPIC_MESSAGE = {
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "claude-sonnet-4-5",
	content: [{ type: "text", text: '{"ok":true}' }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 10, output_tokens: 5 },
};
const ANTHROPIC_BATCH = {
	id: "msgbatch_1",
	type: "message_batch",
	processing_status: "in_progress",
	request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
	created_at: "2026-10-12T00:00:00Z",
	expires_at: "2026-10-13T00:00:00Z",
	ended_at: null,
	archived_at: null,
	cancel_initiated_at: null,
	results_url: null,
};
const ANTHROPIC_MODELS = {
	data: [{ type: "model", id: "claude-x", display_name: "X", created_at: "2026-01-01T00:00:00Z" }],
	has_more: false,
	first_id: "claude-x",
	last_id: "claude-x",
};
const OPENAI_COMPLETION = {
	id: "chatcmpl_1",
	object: "chat.completion",
	created: 0,
	model: "gpt-4o",
	choices: [
		{
			index: 0,
			finish_reason: "stop",
			logprobs: null,
			message: { role: "assistant", content: '{"ok":true}', refusal: null },
		},
	],
	usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};
const OPENAI_RESPONSE = {
	id: "resp_1",
	object: "response",
	created_at: 0,
	model: "gpt-4o",
	status: "completed",
	output: [
		{
			type: "message",
			id: "m",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }],
		},
	],
	usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};
const OPENAI_EMBEDDING = {
	object: "list",
	data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
	model: "text-embedding-3-small",
	usage: { prompt_tokens: 3, total_tokens: 3 },
};
const OPENAI_MODERATION = { id: "modr_1", model: "omni-moderation-latest", results: [] };
const OPENAI_MODELS = {
	object: "list",
	data: [{ id: "gpt-x", object: "model", created: 0, owned_by: "o" }],
};

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json", "request-id": "req_1" },
	});
}

/** A streamed Anthropic message, as the SDK's MessageStream reads it. */
const ANTHROPIC_STREAM_EVENTS: unknown[] = [
	{
		type: "message_start",
		message: {
			...ANTHROPIC_MESSAGE,
			content: [],
			stop_reason: null,
			usage: { input_tokens: 10, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"ok":true}' } },
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 5 },
	},
	{ type: "message_stop" },
];

function sse(events: unknown[]): Response {
	const body = events
		.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
		.join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** The SDK's injected fetch: records `METHOD /path`, answers from the canned bodies above. */
function recordingFetch(hits: string[], provider: "anthropic" | "openai"): typeof fetch {
	return (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		hits.push(`${init?.method ?? "GET"} ${url.pathname}`);
		const p = url.pathname;
		if (provider === "anthropic") {
			if (p === "/v1/messages/count_tokens") return json({ input_tokens: 3 });
			if (p.startsWith("/v1/messages/batches")) return json(ANTHROPIC_BATCH);
			if (p === "/v1/messages") {
				const streamed = typeof init?.body === "string" && JSON.parse(init.body).stream === true;
				return streamed ? sse(ANTHROPIC_STREAM_EVENTS) : json(ANTHROPIC_MESSAGE);
			}
			if (p === "/v1/models") return json(ANTHROPIC_MODELS);
			return json({});
		}
		if (p === "/v1/chat/completions") return json(OPENAI_COMPLETION);
		if (p === "/v1/responses") return json(OPENAI_RESPONSE);
		if (p === "/v1/embeddings") return json(OPENAI_EMBEDDING);
		if (p === "/v1/moderations") return json(OPENAI_MODERATION);
		if (p === "/v1/models") return json(OPENAI_MODELS);
		return json({});
	}) as unknown as typeof fetch;
}

// ── Harness ──

const realFetch = globalThis.fetch;
const strayFetches: string[] = [];
beforeAll(() => {
	globalThis.fetch = (async (u: unknown) => {
		strayFetches.push(String(u));
		throw new Error("network disabled in default-deny tests");
	}) as typeof fetch;
});
afterAll(() => {
	globalThis.fetch = realFetch;
	expect(strayFetches).toEqual([]);
});

let vault: string;
let hits: string[];
let open: Array<{ destroy(): Promise<void> }>;

beforeEach(() => {
	vault = join(tmpdir(), `default-deny-${randomUUID()}`);
	mkdirSync(vault, { recursive: true });
	hits = [];
	open = [];
});

afterEach(async () => {
	for (const c of open) await c.destroy().catch(() => {});
	rmSync(vault, { recursive: true, force: true });
});

function mockEngine() {
	return {
		spendPending: vi.fn(async (p: { transferId: string }) => ({ transferId: p.transferId })),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
	} satisfies TrustEngine;
}

function writeConfig(config: Record<string, unknown>): void {
	mkdirSync(join(vault, VAULT_DIR), { recursive: true });
	writeFileSync(join(vault, VAULT_DIR, "usertrust.config.json"), JSON.stringify(config));
}

// biome-ignore lint/suspicious/noExplicitAny: the rows reach SDK members the TrustedClient type hides.
type Loose = any;

/** `prepare` runs on the raw client before `trust()` wraps it. */
async function anthropic(opts: Partial<TrustOpts> = {}, prepare?: (raw: Loose) => void) {
	const engine = mockEngine();
	const raw = new Anthropic({
		apiKey: "k",
		baseURL: "https://anthropic.test",
		fetch: recordingFetch(hits, "anthropic"),
		maxRetries: 0,
	});
	prepare?.(raw);
	const client = await trust(raw, {
		budget: 1_000_000,
		vaultBase: vault,
		_engine: engine,
		...opts,
	});
	open.push(client);
	return { client: client as Loose, raw: raw as Loose, engine };
}

/** `prepare` runs on the raw client before `trust()` wraps it. */
async function openai(opts: Partial<TrustOpts> = {}, prepare?: (raw: Loose) => void) {
	const engine = mockEngine();
	const raw = new OpenAI({
		apiKey: "k",
		baseURL: "https://openai.test/v1",
		fetch: recordingFetch(hits, "openai"),
		maxRetries: 0,
	});
	prepare?.(raw);
	const client = await trust(raw, {
		budget: 1_000_000,
		vaultBase: vault,
		_engine: engine,
		...opts,
	});
	open.push(client);
	return { client: client as Loose, raw: raw as Loose, engine };
}

interface ChainEvent {
	kind: string;
	timestamp: string;
	data: Record<string, unknown>;
}

function chainEvents(): ChainEvent[] {
	let text: string;
	try {
		text = readFileSync(join(vault, VAULT_DIR, AUDIT_DIR, "events.jsonl"), "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as ChainEvent);
}

/** Run a call to completion: await a promise (or a thenable runner). A sync value is returned as is. */
async function settle(call: () => unknown): Promise<unknown> {
	return await call();
}

/** The four facts every refusal row asserts. */
async function expectRefused(
	path: string,
	call: () => unknown,
	engine: ReturnType<typeof mockEngine>,
): Promise<void> {
	const before = chainEvents().length;
	let caught: unknown;
	try {
		await settle(call);
	} catch (err) {
		caught = err;
	}
	expect(caught, `${path}: rejects with PolicyDeniedError`).toBeInstanceOf(PolicyDeniedError);
	expect((caught as PolicyDeniedError).reason).toMatch(
		new RegExp(`^ungoverned_method: ${path.replace(/\./g, "\\.")} `),
	);
	expect(hits, `${path}: the SDK was never called`).toEqual([]);
	expect(engine.spendPending, `${path}: nothing was held`).not.toHaveBeenCalled();
	const added = chainEvents().slice(before);
	expect(
		added.map((e) => e.kind),
		`${path}: one policy_denied event`,
	).toEqual(["policy_denied"]);
	expect(added[0]?.data.actionName).toBe(path);
	expect(added[0]?.data.decision).toBe("deny");
	// The handle on the error is the event on the chain.
	expect((caught as PolicyDeniedError).auditEventHash).toBe(
		(added[0] as unknown as { hash: string }).hash,
	);
}

const MP = {
	model: "claude-sonnet-4-5",
	max_tokens: 16,
	messages: [{ role: "user", content: "hi" }],
};
const CP = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };

// ── Refusal families ──

describe("Anthropic: every ungoverned SDK method is refused", () => {
	const rows: Array<[string, (c: Loose) => unknown]> = [
		[
			"messages.batches.create",
			(c) => c.messages.batches.create({ requests: [{ custom_id: "1", params: MP }] }),
		],
		[
			"beta.messages.batches.create",
			(c) => c.beta.messages.batches.create({ requests: [{ custom_id: "1", params: MP }] }),
		],
		[
			"completions.create",
			(c) =>
				c.completions.create({
					model: "claude-2.1",
					max_tokens_to_sample: 8,
					prompt: "\n\nHuman: hi",
				}),
		],
		["beta.sessions.create", (c) => c.beta.sessions.create({ agent: "agent_1" })],
		[
			"beta.messages.toolRunner",
			(c) => c.beta.messages.toolRunner({ ...MP, tools: [], max_iterations: 1 }),
		],
	];
	it.each(rows)("%s", async (path, call) => {
		const { client, engine } = await anthropic();
		await expectRefused(path, () => call(client), engine);
	});
});

describe("OpenAI: every ungoverned SDK method is refused", () => {
	const rows: Array<[string, (c: Loose) => unknown]> = [
		[
			"embeddings.create",
			(c) => c.embeddings.create({ model: "text-embedding-3-small", input: "hi" }),
		],
		["images.generate", (c) => c.images.generate({ model: "gpt-image-1", prompt: "a cat" })],
		[
			"audio.speech.create",
			(c) => c.audio.speech.create({ model: "tts-1", voice: "alloy", input: "hi" }),
		],
		[
			"batches.create",
			(c) =>
				c.batches.create({
					input_file_id: "file_1",
					endpoint: "/v1/chat/completions",
					completion_window: "24h",
				}),
		],
		[
			"fineTuning.jobs.create",
			(c) => c.fineTuning.jobs.create({ model: "gpt-4o-mini", training_file: "file_1" }),
		],
		[
			"beta.threads.runs.create",
			(c) => c.beta.threads.runs.create("thread_1", { assistant_id: "asst_1" }),
		],
		["vectorStores.create", (c) => c.vectorStores.create({ name: "v" })],
		["chat.completions.parse", (c) => c.chat.completions.parse(CP)],
		[
			"chat.completions.stream",
			// The SDK's stream helper is sync and not thenable: drive it to its final completion.
			(c) => {
				const s = c.chat.completions.stream(CP);
				return typeof s.then === "function" ? s : s.finalChatCompletion();
			},
		],
		["responses.parse", (c) => c.responses.parse({ model: "gpt-4o", input: "hi" })],
		["beta.responses.create", (c) => c.beta.responses.create({ model: "gpt-4o", input: "hi" })],
		[
			"completions.create",
			(c) => c.completions.create({ model: "gpt-3.5-turbo-instruct", prompt: "hi" }),
		],
		["videos.create", (c) => c.videos.create({ model: "sora-2", prompt: "a cat" })],
	];
	it.each(rows)("%s", async (path, call) => {
		const { client, engine } = await openai();
		await expectRefused(path, () => call(client), engine);
	});

	// The refusal labels its policy_denied event with the request's model WITHOUT running caller
	// code: only an own data property holding a string counts. A getter or a Proxy is never read.
	function deniedModel(): unknown {
		const denials = chainEvents().filter((e) => e.kind === "policy_denied");
		expect(denials).toHaveLength(1);
		return denials[0]?.data.model;
	}

	it("a model getter that throws is never called; the call is refused with its policy_denied record", async () => {
		const { client, engine } = await openai();
		let calls = 0;
		const params = {
			input: "hi",
			get model(): string {
				calls++;
				throw new Error("getter boom");
			},
		};
		await expectRefused("embeddings.create", () => client.embeddings.create(params), engine);
		expect(calls, "the getter ran").toBe(0);
		expect(deniedModel()).toBeUndefined();
	});

	it("a model getter with a side effect is never called, and no model is recorded", async () => {
		const { client, engine } = await openai();
		let calls = 0;
		const params = {
			input: "hi",
			get model(): string {
				calls++;
				return "gpt-x";
			},
		};
		await expectRefused("embeddings.create", () => client.embeddings.create(params), engine);
		expect(calls, "the getter ran").toBe(0);
		expect(deniedModel()).toBeUndefined();
	});

	it("a plain model data property is recorded", async () => {
		const { client, engine } = await openai();
		await expectRefused(
			"embeddings.create",
			() => client.embeddings.create({ model: "text-embedding-3-small", input: "hi" }),
			engine,
		);
		expect(deniedModel()).toBe("text-embedding-3-small");
	});

	it("a Proxy request records no model and runs none of its traps", async () => {
		const { client, engine } = await openai();
		const traps: string[] = [];
		const counting: ProxyHandler<object> = {};
		for (const name of [
			"get",
			"getOwnPropertyDescriptor",
			"has",
			"ownKeys",
			"getPrototypeOf",
			"defineProperty",
			"set",
			"deleteProperty",
			"isExtensible",
			"preventExtensions",
			"setPrototypeOf",
		] as const) {
			(counting as Record<string, unknown>)[name] = (...a: unknown[]) => {
				traps.push(name);
				return (Reflect as unknown as Record<string, (...x: unknown[]) => unknown>)[name]?.(...a);
			};
		}
		const params = new Proxy({ model: "gpt-x", input: "hi" }, counting);
		await expectRefused("embeddings.create", () => client.embeddings.create(params), engine);
		expect(deniedModel()).toBeUndefined();
		expect(traps, "a trap ran").toEqual([]);
	});

	it("a sync SDK helper is refused with a rejected promise, never a sync throw", async () => {
		const { client, engine } = await openai();
		let result: unknown;
		expect(() => {
			result = client.chat.completions.stream(CP);
		}).not.toThrow();
		expect(result).toBeInstanceOf(Promise);
		await expect(result).rejects.toBeInstanceOf(PolicyDeniedError);
		expect(hits).toEqual([]);
		expect(engine.spendPending).not.toHaveBeenCalled();
	});
});

// ── Escape hatches ──

describe("escape hatches", () => {
	it("Anthropic withOptions(timeout, retries, headers, query) stays governed: messages.create holds, settles and audits", async () => {
		const { client, engine } = await anthropic();
		const child = client.withOptions({
			timeout: 1000,
			maxRetries: 0,
			defaultHeaders: { "x-row": "1" },
			defaultQuery: { row: "1" },
		});
		const before = chainEvents().length;
		const out = await child.messages.create(MP);
		expect(out.receipt).toBeDefined();
		expect(out.response.id).toBe("msg_1");
		expect(engine.spendPending).toHaveBeenCalledTimes(1);
		expect(
			chainEvents()
				.slice(before)
				.map((e) => e.kind),
		).toEqual(["llm_call"]);
		expect(hits).toEqual(["POST /v1/messages"]);
	});

	it("OpenAI withOptions(timeout, retries, headers, query) stays governed, and its ungoverned methods are refused", async () => {
		const { client, engine } = await openai();
		const child = client.withOptions({
			timeout: 1000,
			maxRetries: 0,
			defaultHeaders: { "x-row": "1" },
			defaultQuery: { row: "1" },
		});
		const before = chainEvents().length;
		const out = await child.chat.completions.create(CP);
		expect(out.receipt).toBeDefined();
		expect(
			chainEvents()
				.slice(before)
				.map((e) => e.kind),
		).toEqual(["llm_call"]);
		expect(engine.spendPending).toHaveBeenCalledTimes(1);
		hits.length = 0;
		engine.spendPending.mockClear();
		await expectRefused(
			"embeddings.create",
			() => child.embeddings.create({ model: "text-embedding-3-small", input: "hi" }),
			engine,
		);
	});

	it("withOptions that moves the client to a different endpoint class refuses every call through it", async () => {
		const { client, engine } = await anthropic();
		const moved = client.withOptions({ baseURL: "http://127.0.0.1:11434" });
		await expectRefused("withOptions", () => moved.messages.create(MP), engine);
	});

	it.each([
		["anthropic", "fetch"],
		["openai", "fetch"],
		["anthropic", "fetchOptions"],
		["openai", "fetchOptions"],
		["anthropic", "middleware"],
		["openai", "httpAgent"],
		["openai", "fetch: undefined"],
	] as const)(
		"withOptions that changes the transport (%s %s) refuses every call through it",
		async (provider, key) => {
			const customHits: string[] = [];
			const customFetch = (async (input: unknown) => {
				customHits.push(String(input));
				return json({});
			}) as unknown as typeof fetch;
			const options: Record<string, unknown> = {
				fetch: { fetch: customFetch },
				fetchOptions: { fetchOptions: { dispatcher: {} } },
				middleware: { middleware: [] },
				httpAgent: { httpAgent: {} },
				"fetch: undefined": { fetch: undefined },
			}[key] as Record<string, unknown>;
			const { client, engine } = provider === "anthropic" ? await anthropic() : await openai();
			const moved = client.withOptions(options);
			await expectRefused(
				"withOptions",
				() =>
					provider === "anthropic" ? moved.messages.create(MP) : moved.chat.completions.create(CP),
				engine,
			);
			expect(customHits, "the custom fetch was never called").toEqual([]);
		},
	);

	// A withOptions() clone shares its parent's governor: destroy() on either ends both.
	const destroyedError = /TrustedClient has been destroyed/;

	it("a transport-refused clone's destroy() resolves and ends the parent too", async () => {
		const { client } = await anthropic();
		const clone = client.withOptions({ fetch: async () => json({}) });
		await expect(clone.destroy()).resolves.toBeUndefined();
		await expect(client.messages.create(MP)).rejects.toThrow(destroyedError);
		expect(hits).toEqual([]);
	});

	it("a governed clone's destroy() ends the parent", async () => {
		const { client } = await anthropic();
		const clone = client.withOptions({ timeout: 1000 });
		await clone.destroy();
		await expect(client.messages.create(MP)).rejects.toThrow(destroyedError);
		expect(hits).toEqual([]);
	});

	it("the parent's destroy() ends a governed clone", async () => {
		const { client } = await openai();
		const clone = client.withOptions({ timeout: 1000 });
		await client.destroy();
		await expect(clone.chat.completions.create(CP)).rejects.toThrow(destroyedError);
		expect(hits).toEqual([]);
	});

	it("governAction on a transport-refused clone runs under the shared governor", async () => {
		const { client } = await anthropic();
		const clone = client.withOptions({ fetch: async () => json({}) });
		const { result, receipt } = await clone.governAction(
			{ kind: "tool_use", name: "file_read", cost: 50 },
			async () => "ok",
		);
		expect(result).toBe("ok");
		expect(receipt.settled).toBe(true);
		expect(chainEvents().map((e) => e.kind)).toEqual(["tool_use"]);
		expect(hits).toEqual([]);
	});

	it("withOptions keys: the transport-changing ones, per SDK; an unknown key fails closed", () => {
		const governed = {
			timeout: 1,
			maxRetries: 1,
			defaultHeaders: {},
			defaultQuery: {},
			logLevel: "warn",
			logger: console,
			apiKey: "k",
		};
		expect(
			transportOptionKeys("anthropic", { ...governed, authToken: "t", webhookKey: "w" }),
		).toEqual([]);
		expect(
			transportOptionKeys("openai", {
				...governed,
				adminAPIKey: "a",
				organization: "o",
				project: "p",
				webhookSecret: "w",
			}),
		).toEqual([]);
		expect(
			transportOptionKeys("anthropic", {
				baseURL: "",
				fetch: undefined,
				fetchOptions: {},
				middleware: [],
				credentials: {},
				config: {},
				profile: "p",
			}),
		).toEqual([
			"baseURL",
			"fetch",
			"fetchOptions",
			"middleware",
			"credentials",
			"config",
			"profile",
		]);
		expect(
			transportOptionKeys("openai", {
				baseURL: "",
				fetch: undefined,
				fetchOptions: {},
				provider: {},
				workloadIdentity: {},
				httpAgent: {},
				endpoint: "",
				deployment: "",
				somethingNew: 1,
			}),
		).toEqual([
			"baseURL",
			"fetch",
			"fetchOptions",
			"provider",
			"workloadIdentity",
			"httpAgent",
			"endpoint",
			"deployment",
			"somethingNew",
		]);
	});

	it("a resource's _client is refused (Anthropic messages._client.messages.create)", async () => {
		const { client, engine } = await anthropic();
		await expectRefused(
			"messages._client",
			() => client.messages._client.messages.create(MP),
			engine,
		);
	});

	it("a resource's _client is refused (OpenAI chat.completions._client.chat.completions.create)", async () => {
		const { client, engine } = await openai();
		await expectRefused(
			"chat.completions._client",
			() => client.chat.completions._client.chat.completions.create(CP),
			engine,
		);
	});

	it.each([
		["messages._client", (c: Loose) => c.messages._client],
		["withOptions", (c: Loose) => c.withOptions({ fetch: async () => json({}) })],
	] as const)(
		"each refusal through one %s stand-in is its own error, with its own audit hash",
		async (_label, standInOf) => {
			const { client } = await anthropic();
			// ONE stand-in, refused twice: stand-ins are cached, which is where a shared error showed.
			const standIn = standInOf(client);
			const refuse = async (): Promise<PolicyDeniedError> => {
				try {
					await standIn.messages.create(MP);
				} catch (err) {
					return err as PolicyDeniedError;
				}
				throw new Error("expected a refusal");
			};
			const first = await refuse();
			const firstHash = first.auditEventHash;
			const second = await refuse();
			expect(first).toBeInstanceOf(PolicyDeniedError);
			expect(second).toBeInstanceOf(PolicyDeniedError);
			expect(second).not.toBe(first);
			const denials = chainEvents().filter((e) => e.kind === "policy_denied") as unknown as Array<{
				hash: string;
			}>;
			expect(denials).toHaveLength(2);
			expect(first.auditEventHash).toBe(denials[0]?.hash);
			expect(second.auditEventHash).toBe(denials[1]?.hash);
			// The second refusal did not re-label the error the caller already holds.
			expect(first.auditEventHash).toBe(firstHash);
			expect(hits).toEqual([]);
		},
	);

	it("client.post is a PolicyDeniedError, not the private-field TypeError", async () => {
		const a = await anthropic();
		await expectRefused("post", () => a.client.post("/v1/messages", { body: MP }), a.engine);
		const o = await openai();
		await expectRefused(
			"request",
			() => o.client.request({ method: "post", path: "/x" }),
			o.engine,
		);
	});
});

// ── Writes through the governed client ──

describe("writes through the governed client never reach the raw SDK", () => {
	it("Anthropic: assigning, defining or deleting a client property throws, and the raw client is unchanged", async () => {
		const { client, raw } = await anthropic();
		const baseURL = raw.baseURL;
		expect(() => {
			client.baseURL = "http://127.0.0.1:11434";
		}).toThrow(TypeError);
		expect(() => {
			client.baseURL = "http://127.0.0.1:11434";
		}).toThrow(/baseURL/);
		expect(() => Object.defineProperty(client, "baseURL", { value: "http://x.test" })).toThrow(
			/baseURL/,
		);
		expect(() => {
			delete client.baseURL;
		}).toThrow(/baseURL/);
		expect(() => {
			client.fetch = async () => new Response("{}");
		}).toThrow(/fetch/);
		expect(raw.baseURL).toBe(baseURL);
	});

	it("Anthropic: a resource, a reachable object and a _client stand-in are read-only too", async () => {
		const { client, raw } = await anthropic();
		const rawCreate = raw.messages.batches.create;
		expect(() => {
			client.messages.batches.create = async () => ({});
		}).toThrow(/create/);
		expect(raw.messages.batches.create).toBe(rawCreate);
		const middleware = raw.middleware.length;
		expect(() => client.middleware.push(async () => new Response("{}"))).toThrow(TypeError);
		expect(raw.middleware.length).toBe(middleware);
		const optionsBase = raw._options.baseURL;
		expect(() => {
			client._options.baseURL = "http://x.test";
		}).toThrow(/baseURL/);
		expect(raw._options.baseURL).toBe(optionsBase);
		expect(() => {
			client.messages._client.baseURL = "http://x.test";
		}).toThrow(/baseURL/);
		expect(raw.baseURL).toBe("https://anthropic.test");
	});

	it("OpenAI: fetch and _options.fetch cannot be replaced through the governed client", async () => {
		const { client, raw } = await openai();
		const rawFetch = raw.fetch;
		expect(() => {
			client.fetch = async () => new Response("{}");
		}).toThrow(/fetch/);
		expect(() => {
			client._options.fetch = async () => new Response("{}");
		}).toThrow(/fetch/);
		expect(() => {
			client.chat.completions.create = async () => ({});
		}).toThrow(/create/);
		expect(raw.fetch).toBe(rawFetch);
	});

	it("after refused writes, a governed call is still governed and goes to the original fetch", async () => {
		const { client, engine } = await anthropic();
		try {
			client.baseURL = "http://127.0.0.1:11434";
		} catch {}
		try {
			client.middleware.push(async () => new Response("{}"));
		} catch {}
		const out = await client.messages.create(MP);
		expect(out.receipt.settled).toBe(true);
		expect(engine.spendPending).toHaveBeenCalledTimes(1);
		expect(hits).toEqual(["POST /v1/messages"]);
		expect(chainEvents().map((e) => e.kind)).toEqual(["llm_call"]);
	});

	it("the read-only views never freeze the raw SDK objects: the SDK can still change its own state", async () => {
		const { client, raw } = await anthropic();
		// Read every transport object through the governed client, and try to write through each.
		for (const name of ["middleware", "_options", "_authState"]) {
			const view = client[name];
			expect(view).toBeDefined();
			expect(() => {
				view.x = 1;
			}).toThrow(TypeError);
		}
		expect(() => client.middleware.push(async () => new Response("{}"))).toThrow(TypeError);
		for (const name of ["middleware", "_options", "_authState"]) {
			expect(Object.isFrozen(raw[name]), `${name} frozen`).toBe(false);
			expect(Object.isExtensible(raw[name]), `${name} extensible`).toBe(true);
		}
		// The SDK's own write to its own state still lands, and the view reads it.
		const before = raw.middleware.length;
		raw.middleware.push(async (_req: unknown, next: (r: unknown) => unknown) => next(_req));
		expect(raw.middleware.length).toBe(before + 1);
		expect(client.middleware.length).toBe(before + 1);
	});

	it("reading still works: values, a logger, and JSON of a reachable object", async () => {
		const { client, raw } = await anthropic();
		expect(client._options.baseURL).toBe(raw._options.baseURL);
		expect(client.middleware.length).toBe(raw.middleware.length);
		expect(client.logger).toBe(raw.logger);
		expect(JSON.stringify(client._options.defaultHeaders ?? null)).toBe(
			JSON.stringify(raw._options.defaultHeaders ?? null),
		);
	});
});

// ── Opt-out ──

describe("allowUngoverned", () => {
	it("a listed method reaches the SDK once and is audited as ungoverned_call, unmetered", async () => {
		const { client, engine } = await openai({ allowUngoverned: ["embeddings.create"] });
		const out = await client.embeddings.create({
			model: "text-embedding-3-small",
			input: "hi",
			encoding_format: "float",
		});
		expect(out.data[0].embedding).toEqual([0.1, 0.2]);
		expect(hits).toEqual(["POST /v1/embeddings"]);
		expect(engine.spendPending).not.toHaveBeenCalled();
		await client.destroy();
		const events = chainEvents();
		expect(events.map((e) => e.kind)).toEqual(["ungoverned_call"]);
		expect(events[0]?.data).toEqual({ method: "embeddings.create", provider: "openai" });
		expect(Number.isNaN(Date.parse(events[0]?.timestamp ?? ""))).toBe(false);
	});

	it("a method that is not listed is still refused", async () => {
		const { client, engine } = await openai({ allowUngoverned: ["embeddings.create"] });
		await expectRefused(
			"images.generate",
			() => client.images.generate({ model: "gpt-image-1", prompt: "a cat" }),
			engine,
		);
	});

	it.each([
		["a string", "embeddings.create"],
		["an empty string", [""]],
		["a number", [3]],
		["null", [null]],
		["an object", { 0: "embeddings.create" }],
		["a raw-client hatch", ["post"]],
		["a _client path", ["messages._client"]],
	])("is validated at creation: %s throws", async (_label, value) => {
		const raw = new OpenAI({ apiKey: "k", fetch: recordingFetch(hits, "openai") });
		await expect(
			trust(raw, { dryRun: true, vaultBase: vault, allowUngoverned: value as never }),
		).rejects.toThrow(/allowUngoverned/);
	});

	// A free or governed method never reaches the opt-out branch, so it would run WITHOUT the
	// ungoverned_call event the option promises. It is refused by name when the client is created.
	function rawClient(provider: "anthropic" | "openai"): unknown {
		return provider === "anthropic"
			? new Anthropic({ apiKey: "k", fetch: recordingFetch(hits, "anthropic") })
			: new OpenAI({ apiKey: "k", fetch: recordingFetch(hits, "openai") });
	}

	it.each([
		["openai", "models.list", "an OpenAI"],
		["openai", "moderations.create", "an OpenAI"],
		["anthropic", "messages.countTokens", "an Anthropic"],
		["anthropic", "models.list", "an Anthropic"],
	] as const)("a FREE entry is refused at creation (%s %s)", async (provider, path, name) => {
		await expect(
			trust(rawClient(provider), { dryRun: true, vaultBase: vault, allowUngoverned: [path] }),
		).rejects.toMatchObject({
			name: "TypeError",
			message: `usertrust: allowUngoverned cannot list "${path}": it is free on ${name} client and already runs without governance.`,
		});
	});

	it.each([
		["anthropic", "messages.create", "an Anthropic"],
		["anthropic", "beta.messages.parse", "an Anthropic"],
		["openai", "chat.completions.create", "an OpenAI"],
		["openai", "responses.create", "an OpenAI"],
	] as const)("a GOVERNED entry is refused at creation (%s %s)", async (provider, path, name) => {
		await expect(
			trust(rawClient(provider), { dryRun: true, vaultBase: vault, allowUngoverned: [path] }),
		).rejects.toMatchObject({
			name: "TypeError",
			message: `usertrust: allowUngoverned cannot list "${path}": it is governed on ${name} client.`,
		});
	});

	it("the option is read once: a getter that answers differently on a second read still gets the free check", async () => {
		let reads = 0;
		const opts = {
			dryRun: true,
			vaultBase: vault,
			get allowUngoverned(): string[] | undefined {
				reads += 1;
				return reads === 1 ? ["models.list"] : undefined;
			},
		};
		await expect(trust(rawClient("openai"), opts)).rejects.toMatchObject({
			name: "TypeError",
			message:
				'usertrust: allowUngoverned cannot list "models.list": it is free on an OpenAI client and already runs without governance.',
		});
		expect(reads).toBe(1);
	});

	it("the event kind passes the verifiers: verifyVault and `usertrust verify`", async () => {
		const { client } = await openai({ allowUngoverned: ["embeddings.create"] });
		await client.embeddings.create({ model: "text-embedding-3-small", input: "hi" });
		await client.chat.completions.create(CP);
		await client.destroy();
		expect(chainEvents().map((e) => e.kind)).toEqual(["ungoverned_call", "llm_call"]);
		const result = verifyVault(join(vault, VAULT_DIR));
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const prevExit = process.exitCode;
		try {
			await runVerifyCli(vault, { json: true } as never, []);
			const out = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { success: boolean };
			expect(out.success).toBe(true);
			expect(process.exitCode ?? 0).toBe(0);
		} finally {
			log.mockRestore();
			process.exitCode = prevExit;
		}
	});

	function failingAudit(): AuditWriter {
		let failures = 0;
		return {
			appendEvent: vi.fn(async () => {
				failures++;
				throw new Error("disk full");
			}),
			getWriteFailures: () => failures,
			isDegraded: () => failures > 0,
			flush: async () => {},
			release: () => {},
		};
	}

	it("a failed ungoverned_call append does not block the call (audit.failClosed off)", async () => {
		const audit = failingAudit();
		const { client } = await openai({ allowUngoverned: ["embeddings.create"], _audit: audit });
		const out = await client.embeddings.create({ model: "text-embedding-3-small", input: "hi" });
		expect(out.object).toBe("list");
		expect(hits).toEqual(["POST /v1/embeddings"]);
		expect(audit.appendEvent).toHaveBeenCalledTimes(1);
	});

	it("under audit.failClosed a failed ungoverned_call append refuses the call before the SDK", async () => {
		writeConfig({ audit: { failClosed: true } });
		const audit = failingAudit();
		const { client } = await openai({ allowUngoverned: ["embeddings.create"], _audit: audit });
		await expect(
			client.embeddings.create({ model: "text-embedding-3-small", input: "hi" }),
		).rejects.toBeInstanceOf(AuditDegradedError);
		expect(hits).toEqual([]);
	});

	/** A writer already degraded by an earlier failure, whose disk has since recovered: appends succeed. */
	function degradedButRecoveredAudit(): AuditWriter {
		return {
			appendEvent: vi.fn(async (input: { kind: string }) => ({
				id: "e",
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "a".repeat(64),
				kind: input.kind,
				actor: "local",
				data: {},
			})) as unknown as AuditWriter["appendEvent"],
			getWriteFailures: () => 1,
			isDegraded: () => true,
			flush: async () => {},
			release: () => {},
		};
	}

	it("under audit.failClosed a writer degraded at the start refuses the call before anything is appended", async () => {
		writeConfig({ audit: { failClosed: true } });
		const audit = degradedButRecoveredAudit();
		const { client } = await openai({ allowUngoverned: ["embeddings.create"], _audit: audit });
		await expect(
			client.embeddings.create({ model: "text-embedding-3-small", input: "hi" }),
		).rejects.toBeInstanceOf(AuditDegradedError);
		expect(hits).toEqual([]);
		// No ungoverned_call is recorded for a call that never ran.
		expect(audit.appendEvent).not.toHaveBeenCalled();
	});

	it("control: without audit.failClosed the same degraded writer still lets the opted-out call run", async () => {
		const audit = degradedButRecoveredAudit();
		const { client } = await openai({ allowUngoverned: ["embeddings.create"], _audit: audit });
		const out = await client.embeddings.create({ model: "text-embedding-3-small", input: "hi" });
		expect(out.object).toBe("list");
		expect(hits).toEqual(["POST /v1/embeddings"]);
		expect(audit.appendEvent).toHaveBeenCalledTimes(1);
	});

	it("under audit.failClosed a healthy append lets the call through", async () => {
		writeConfig({ audit: { failClosed: true } });
		const { client } = await openai({ allowUngoverned: ["embeddings.create"] });
		const out = await client.embeddings.create({ model: "text-embedding-3-small", input: "hi" });
		expect(out.object).toBe("list");
		expect(chainEvents().map((e) => e.kind)).toEqual(["ungoverned_call"]);
	});

	/** An OpenAI client whose fetch answers a chat stream as SSE and notes the chain at each request. */
	async function openaiStreaming(opts: Partial<TrustOpts>) {
		const chainAtFetch: string[][] = [];
		const chunk = {
			id: "chatcmpl_1",
			object: "chat.completion.chunk",
			created: 0,
			model: "gpt-4o",
			choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
		};
		const sse = (async (input: unknown, init?: RequestInit) => {
			const url = new URL(String(input instanceof Request ? input.url : input));
			hits.push(`${init?.method ?? "GET"} ${url.pathname}`);
			chainAtFetch.push(chainEvents().map((e) => e.kind));
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;
		const raw = new OpenAI({
			apiKey: "k",
			baseURL: "https://openai.test/v1",
			fetch: sse,
			maxRetries: 0,
		});
		const client = (await trust(raw, {
			budget: 1_000_000,
			vaultBase: vault,
			_engine: mockEngine(),
			...opts,
		})) as Loose;
		open.push(client);
		return { client, chainAtFetch };
	}

	it("a sync SDK method listed in allowUngoverned stays sync without audit.failClosed", async () => {
		const { client } = await openaiStreaming({ allowUngoverned: ["chat.completions.stream"] });
		const result = client.chat.completions.stream(CP);
		expect(result).not.toBeInstanceOf(Promise);
		expect(typeof result.finalChatCompletion).toBe("function");
		const final = await result.finalChatCompletion();
		expect(final.choices[0].message.content).toBe("hi");
		expect(hits).toEqual(["POST /v1/chat/completions"]);
		await client.destroy();
		expect(chainEvents().map((e) => e.kind)).toEqual(["ungoverned_call"]);
	});

	it("under audit.failClosed a sync SDK method returns a Promise of its value, audited before the SDK runs", async () => {
		writeConfig({ audit: { failClosed: true } });
		const { client, chainAtFetch } = await openaiStreaming({
			allowUngoverned: ["chat.completions.stream"],
		});
		const result = client.chat.completions.stream(CP);
		expect(result).toBeInstanceOf(Promise);
		const stream = await result;
		expect(typeof stream.finalChatCompletion).toBe("function");
		const final = await stream.finalChatCompletion();
		expect(final.choices[0].message.content).toBe("hi");
		expect(hits).toEqual(["POST /v1/chat/completions"]);
		// The event was on the chain when the SDK sent its request.
		expect(chainAtFetch).toEqual([["ungoverned_call"]]);
		expect(chainEvents().map((e) => e.kind)).toEqual(["ungoverned_call"]);
	});

	it("under audit.failClosed an opted-out thenable (beta.messages.toolRunner) resolves to its FINAL result, not the runner", async () => {
		writeConfig({ audit: { failClosed: true } });
		const { client } = await anthropic({ allowUngoverned: ["beta.messages.toolRunner"] });
		const result = client.beta.messages.toolRunner({ ...MP, tools: [], max_iterations: 1 });
		expect(result).toBeInstanceOf(Promise);
		const settled = await result;
		// Promise resolution adopts the thenable runner: what arrives is the final message.
		expect(typeof settled.runUntilDone).toBe("undefined");
		expect(settled.id).toBe("msg_1");
		expect(settled.type).toBe("message");
		expect(hits).toEqual(["POST /v1/messages"]);
		expect(chainEvents().map((e) => e.kind)).toEqual(["ungoverned_call"]);
	});

	it("without audit.failClosed an opted-out beta.messages.toolRunner returns the runner itself", async () => {
		const { client } = await anthropic({ allowUngoverned: ["beta.messages.toolRunner"] });
		const runner = client.beta.messages.toolRunner({ ...MP, tools: [], max_iterations: 1 });
		expect(runner).not.toBeInstanceOf(Promise);
		expect(typeof runner.runUntilDone).toBe("function");
		const final = await runner.runUntilDone();
		expect(final.id).toBe("msg_1");
	});
});

// ── Free list ──

describe("free methods run on the raw SDK resource, unaudited", () => {
	it("Anthropic messages.countTokens and models.list", async () => {
		const { client, engine } = await anthropic();
		expect(await client.messages.countTokens(MP)).toEqual({ input_tokens: 3 });
		const page = await client.models.list();
		expect(page.data.map((m: { id: string }) => m.id)).toEqual(["claude-x"]);
		expect(hits).toEqual(["POST /v1/messages/count_tokens", "GET /v1/models"]);
		expect(engine.spendPending).not.toHaveBeenCalled();
		expect(chainEvents()).toEqual([]);
	});

	it("OpenAI moderations.create and models.list", async () => {
		const { client, engine } = await openai();
		const mod = await client.moderations.create({ input: "hi" });
		expect(mod.id).toBe("modr_1");
		const page = await client.models.list();
		expect(page.data.map((m: { id: string }) => m.id)).toEqual(["gpt-x"]);
		expect(hits).toEqual(["POST /v1/moderations", "GET /v1/models"]);
		expect(engine.spendPending).not.toHaveBeenCalled();
		expect(chainEvents()).toEqual([]);
	});

	it("a free method whose SDK code needs the raw `this` (OpenAI webhooks: #private methods)", async () => {
		const { client } = await openai();
		// verifySignature reads #private members off `this`: through a proxy it throws a TypeError.
		await expect(
			client.webhooks.verifySignature("{}", { "webhook-id": "x" }, "whsec_AAAA"),
		).rejects.toThrow(/webhook-signature|missing|header/i);
		expect(hits).toEqual([]);
		expect(chainEvents()).toEqual([]);
	});
});

// The boundary decides a method by the PATH it was reached at, so one raw resource object
// reachable at two paths is guarded separately at each. The pinned SDKs expose no such alias;
// these rows build one on the raw client (a duck-typed or modified client could carry it), and
// run in both read orders, since the first path read used to decide for both.
describe("one resource object reachable at two paths is guarded per path", () => {
	const ORDERS = ["the free path read first", "the gated path read first"] as const;

	/** `models` (where `list` is free) is also reachable at `aliasedModels` (where it is not). */
	async function aliasedModels(order: (typeof ORDERS)[number]) {
		let list: ReturnType<typeof vi.fn> | undefined;
		const built = await openai({}, (raw) => {
			raw.aliasedModels = raw.models;
			list = vi.spyOn(raw.models, "list");
		});
		const { client } = built;
		let free: Loose;
		let gated: Loose;
		if (order === ORDERS[0]) {
			free = client.models;
			gated = client.aliasedModels;
		} else {
			gated = client.aliasedModels;
			free = client.models;
		}
		return { ...built, free, gated, list: list as ReturnType<typeof vi.fn> };
	}

	it.each(ORDERS)("%s: the method is refused through the gated path", async (order) => {
		const { gated, list, engine } = await aliasedModels(order);
		await expectRefused("aliasedModels.list", () => gated.list(), engine);
		expect(list).not.toHaveBeenCalled();
	});

	it.each(ORDERS)(
		"%s: the method runs on the raw resource through the free path",
		async (order) => {
			const { free, list, raw, engine } = await aliasedModels(order);
			const page = await free.list();
			expect(page.data.map((m: { id: string }) => m.id)).toEqual(["gpt-x"]);
			expect(list).toHaveBeenCalledTimes(1);
			expect(list.mock.contexts[0]).toBe(raw.models);
			expect(hits).toEqual(["GET /v1/models"]);
			expect(engine.spendPending).not.toHaveBeenCalled();
			expect(chainEvents()).toEqual([]);
		},
	);

	it.each(ORDERS)("%s: each path is the same object on every read", async (order) => {
		const { client, free, gated } = await aliasedModels(order);
		expect(client.models).toBe(free);
		expect(client.aliasedModels).toBe(gated);
		expect(free).not.toBe(gated);
	});

	it.each(["the listed path read first", "the unlisted path read first"] as const)(
		"%s: allowUngoverned applies only at the path it lists",
		async (order) => {
			let create: ReturnType<typeof vi.fn> | undefined;
			const { client, engine } = await openai({ allowUngoverned: ["embeddings.create"] }, (raw) => {
				raw.aliasedEmbeddings = raw.embeddings;
				create = vi.spyOn(raw.embeddings, "create");
			});
			let listed: Loose;
			let unlisted: Loose;
			if (order === "the listed path read first") {
				listed = client.embeddings;
				unlisted = client.aliasedEmbeddings;
			} else {
				unlisted = client.aliasedEmbeddings;
				listed = client.embeddings;
			}
			await expectRefused(
				"aliasedEmbeddings.create",
				() => unlisted.create({ model: "text-embedding-3-small", input: "hi" }),
				engine,
			);
			expect(create).not.toHaveBeenCalled();
			await listed.create({
				model: "text-embedding-3-small",
				input: "hi",
				encoding_format: "float",
			});
			expect(create).toHaveBeenCalledTimes(1);
			await client.destroy();
			const events = chainEvents();
			expect(events.map((e) => e.kind)).toEqual(["policy_denied", "ungoverned_call"]);
			expect(events[1]?.data).toEqual({ method: "embeddings.create", provider: "openai" });
		},
	);
});

// ── The supported SDK range IS the classified range ──

/** `major.minor.patch` as numbers; a prerelease or build suffix is ignored. */
function versionParts(v: string): [number, number, number] {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
	if (m === null) throw new Error(`not a version: ${v}`);
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function compareVersions(a: string, b: string): number {
	const [x, y] = [versionParts(a), versionParts(b)];
	for (let i = 0; i < 3; i++)
		if ((x[i] as number) !== (y[i] as number)) return (x[i] as number) - (y[i] as number);
	return 0;
}

describe("the SDK peer floors are the versions the free list was classified on", () => {
	const corePkg = JSON.parse(
		readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"),
	) as { peerDependencies: Record<string, string> };
	const installed = (name: string): string =>
		(
			JSON.parse(
				readFileSync(
					join(import.meta.dirname, `../../../../node_modules/${name}/package.json`),
					"utf8",
				),
			) as { version: string }
		).version;
	const classified = (defaultDeny as { CLASSIFIED_SDK_VERSIONS?: Record<string, string> })
		.CLASSIFIED_SDK_VERSIONS;

	it.each([
		["openai", "openai"],
		["@anthropic-ai/sdk", "anthropic"],
		["@google/genai", "google"],
	] as const)("%s", (pkgName, key) => {
		expect(classified, "CLASSIFIED_SDK_VERSIONS is exported").toBeDefined();
		const floor = /^>=(\d+\.\d+\.\d+)$/.exec(corePkg.peerDependencies[pkgName] ?? "")?.[1];
		expect(floor, `${pkgName}'s peer range is a plain >= floor`).toBeDefined();
		// A floor moved without re-classifying the free list (or the reverse) fails here.
		expect(floor).toBe(classified?.[key]);
		// The SDK this suite runs against is inside the supported range.
		expect(compareVersions(installed(pkgName), floor as string)).toBeGreaterThanOrEqual(0);
	});
});

// ── GOVERNED_PATHS is pinned to the proxies' real traps ──
// The proxies trap the governed names one by one and do not read GOVERNED_PATHS, so the two could
// drift. Pinned both ways: every GOVERNED_PATHS entry IS governed (a hold, a settled receipt, one
// llm_call), and every OTHER method on the installed SDKs' resource trees that is not free is
// REFUSED, so a trap added for a name GOVERNED_PATHS does not list would not be refused and fails.

/** Call a governed path the way a caller would, and return the settled receipt. */
async function callGoverned(client: Loose, path: string): Promise<{ settled?: boolean }> {
	const segments = path.split(".");
	const name = segments.pop() as string;
	let holder = client;
	for (const seg of segments) holder = holder[seg];
	if (path === "chat.completions.create") return (await holder[name](CP)).receipt;
	if (path === "responses.create")
		return (await holder[name]({ model: "gpt-4o", input: "hi" })).receipt;
	if (name === "create") return (await holder[name](MP)).receipt;
	if (name === "parse") return (await holder[name](MP)).receipt;
	if (name === "stream") {
		const stream = await holder[name](MP);
		await stream.finalMessage();
		return await stream.receipt;
	}
	throw new Error(`no invocation for governed path ${path}`);
}

describe("every GOVERNED_PATHS entry is governed by the proxies", () => {
	it.each(
		(["anthropic", "openai"] as const).flatMap((provider) =>
			[...GOVERNED_PATHS[provider]].map((path) => [provider, path] as const),
		),
	)("%s %s", async (provider, path) => {
		const { client, engine } = provider === "anthropic" ? await anthropic() : await openai();
		const receipt = await callGoverned(client, path);
		expect(receipt?.settled, `${path} settled a receipt`).toBe(true);
		expect(engine.spendPending, `${path} held`).toHaveBeenCalledTimes(1);
		expect(chainEvents().map((e) => e.kind)).toEqual(["llm_call"]);
		expect(hits.length).toBe(1);
	});
});

/** Every method on an SDK client's resource trees, by path (the APIResource base's members excluded). */
function sdkMethodPaths(raw: Loose): string[] {
	const out: string[] = [];
	const seen = new Set<unknown>();
	const walk = (o: Loose, path: string): void => {
		if (seen.has(o)) return;
		seen.add(o);
		for (const key of Object.keys(o)) {
			if (key === "_client") continue;
			const v = o[key];
			if (v !== null && typeof v === "object" && "_client" in v)
				walk(v, path === "" ? key : `${path}.${key}`);
		}
		if (path === "") return; // client-level members are pinned by the raw-client rows
		let proto = Object.getPrototypeOf(o);
		while (
			proto !== null &&
			proto !== Object.prototype &&
			proto.constructor?.name !== "APIResource"
		) {
			for (const name of Object.getOwnPropertyNames(proto)) {
				if (name !== "constructor" && typeof o[name] === "function") out.push(`${path}.${name}`);
			}
			proto = Object.getPrototypeOf(proto);
		}
	};
	walk(raw, "");
	return [...new Set(out)].sort();
}

/**
 * The backstop for the sweep below, which calls every SDK method that is not free through the
 * governed client, one after another. What the case proves is structural (every such method is
 * refused with PolicyDeniedError, none reaches the SDK, nothing is reserved); the time only keeps a
 * hung case from hanging the run. The 5 s default was the real assertion by accident: the sweep takes
 * 0.9 s (anthropic) and 1.8 s (openai) alone, but up to 9.1 s and 16.9 s when twelve runs of this
 * file share a machine, and it failed the full suite under that load.
 */
// timing: bound 60000 ms; measured 0.9-1.8 s alone and up to 9.1-16.9 s with 12 concurrent runs, 3.5x headroom over the loaded worst case
const SWEEP_BACKSTOP_MS = 60_000;

describe("every other SDK method that is not free is refused: no trap outside GOVERNED_PATHS", () => {
	for (const provider of ["anthropic", "openai"] as const) {
		it(provider, { timeout: SWEEP_BACKSTOP_MS }, async () => {
			const { client, raw, engine } = provider === "anthropic" ? await anthropic() : await openai();
			const paths = sdkMethodPaths(raw).filter(
				(p) => !GOVERNED_PATHS[provider].has(p) && !FREE_METHODS[provider].has(p),
			);
			// Positive control: the walk found the refused families this file pins by name.
			expect(paths).toContain(
				provider === "anthropic" ? "messages.batches.create" : "embeddings.create",
			);
			const notRefused: string[] = [];
			for (const path of paths) {
				const segments = path.split(".");
				const name = segments.pop() as string;
				let holder = client;
				for (const seg of segments) holder = holder[seg];
				try {
					await holder[name]("id_1", {});
					notRefused.push(`${path}: resolved`);
				} catch (err) {
					if (!(err instanceof PolicyDeniedError)) notRefused.push(`${path}: ${String(err)}`);
				}
			}
			expect(notRefused).toEqual([]);
			expect(hits, "a refused method reached the SDK").toEqual([]);
			expect(engine.spendPending).not.toHaveBeenCalled();
		});
	}
});

// ── The free list's rule, pinned ──

/**
 * The free POSTs, each with the reason it cannot start billable work. Every other free method
 * must send only GET or DELETE: adding a POST to the free list without adding it here fails.
 */
const FREE_POSTS: Record<string, string> = {
	"anthropic:messages.countTokens": "counts tokens; runs no model and is not billed",
	"anthropic:beta.messages.countTokens": "counts tokens; runs no model and is not billed",
	"anthropic:messages.batches.cancel": "cancel: stops work",
	"anthropic:beta.messages.batches.cancel": "cancel: stops work",
	"anthropic:beta.dreams.cancel": "cancel: stops work",
	"anthropic:beta.deployments.pause": "pause: stops scheduled runs",
	"openai:moderations.create": 'priced "Free"',
	"openai:chat.completions.update": "metadata only, on a stored completion",
	"openai:responses.cancel": "cancel: stops work",
	"openai:beta.responses.cancel": "cancel: stops work",
	"openai:batches.cancel": "cancel: stops work",
	"openai:fineTuning.jobs.cancel": "cancel: stops work",
	"openai:fineTuning.jobs.pause": "pause: stops work",
	"openai:fineTuning.checkpoints.permissions.create": "an access grant on a checkpoint",
	"openai:fineTuning.alpha.graders.validate": "validates a grader definition; runs no grader",
	"openai:beta.assistants.update": "update params only reference existing vector stores",
	"openai:beta.threads.update": "update params only reference existing vector stores",
	"openai:beta.threads.messages.update": "metadata only",
	"openai:beta.threads.runs.cancel": "cancel: stops a run",
	"openai:vectorStores.fileBatches.cancel": "cancel: stops ingestion",
	"openai:uploads.cancel": "cancel: drops an upload",
	"openai:beta.chatkit.sessions.cancel": "cancel: ends a session",
	"openai:realtime.calls.hangup": "ends a call",
	"openai:realtime.calls.reject": "declines a call",
	"openai:realtime.calls.refer": "transfers a call away from the model",
	"openai:evals.create": "an eval definition; evals.runs.create is refused",
	"openai:evals.update": "metadata of an eval definition",
	"openai:evals.runs.cancel": "cancel: stops a run",
	"openai:conversations.create": "a state object; the spend lands on responses.create",
	"openai:conversations.update": "metadata only",
	"openai:conversations.items.create": "a state object; the spend lands on responses.create",
};

/**
 * GET or DELETE methods that stay refused, by the free list's two categories. None may be on the
 * free list, and each is refused through the governed client.
 */
const REFUSED_DESPITE_GET_OR_DELETE: Record<
	string,
	"starts billable work" | "lifts a spend control"
> = {
	"anthropic:beta.environments.work.poll": "starts billable work",
	"openai:admin.organization.spendLimit.delete": "lifts a spend control",
	"openai:admin.organization.projects.spendLimit.delete": "lifts a spend control",
	"openai:admin.organization.spendAlerts.delete": "lifts a spend control",
	"openai:admin.organization.projects.spendAlerts.delete": "lifts a spend control",
	"openai:admin.organization.projects.modelPermissions.delete": "lifts a spend control",
};

/** The free methods that send nothing at all. */
const FREE_LOCAL: Record<string, string> = {
	"anthropic:beta.webhooks.unwrap": "verifies a signature locally",
	"openai:webhooks.unwrap": "verifies a signature locally",
	"openai:webhooks.verifySignature": "verifies a signature locally",
};

/** Split a parameter list at its top-level commas (destructured defaults hold commas too). */
function parameterNames(fn: (...a: unknown[]) => unknown): string[] {
	const src = fn.toString();
	const open = src.indexOf("(");
	let depth = 0;
	let close = open;
	for (let i = open; i < src.length; i++) {
		const ch = src[i];
		if (ch === "(" || ch === "{" || ch === "[") depth++;
		if (ch === ")" || ch === "}" || ch === "]") depth--;
		if (depth === 0) {
			close = i;
			break;
		}
	}
	const parts: string[] = [];
	let cur = "";
	depth = 0;
	for (const ch of src.slice(open + 1, close)) {
		if (ch === "{" || ch === "[" || ch === "(") depth++;
		if (ch === "}" || ch === "]" || ch === ")") depth--;
		if (ch === "," && depth === 0) {
			parts.push(cur.trim());
			cur = "";
		} else cur += ch;
	}
	if (cur.trim() !== "") parts.push(cur.trim());
	return parts;
}

/**
 * Params that name their parent resources: a nested method reads its parent's id off `params`
 * (`{ vector_store_id }`, `{ fine_tuned_model_checkpoint }`) and the SDK refuses to build a path with an undefined segment.
 */
const PARENT_IDS = new Proxy(
	{},
	{
		get: (_t, key) =>
			typeof key === "string" && /(_id|ID|Id|_checkpoint)$/.test(key) ? "id_1" : undefined,
	},
);

/** Dummy arguments: a string for each leading path parameter, params with parent ids, no options. */
function dummyArgs(fn: (...a: unknown[]) => unknown): unknown[] {
	return parameterNames(fn).map((part) => {
		const name = (part.split("=")[0] ?? "").trim();
		if (name === "options") return undefined;
		if (name.startsWith("{") || /^(params|query|body)$/.test(name)) return PARENT_IDS;
		return "id_1";
	});
}

/** A body every free method can read: terminal statuses end the SDK's poll loops at once. */
function anyBody(pathname: string): Record<string, unknown> {
	return {
		id: "id_1",
		object: "list",
		status:
			/\/files\/[^/]+$/.test(pathname) && !pathname.includes("vector_stores")
				? "processed"
				: "completed",
		data: [],
		has_more: false,
		first_id: null,
		last_id: null,
	};
}

function resolveMember(root: Loose, path: string): { holder: Loose; fn: Loose; name: string } {
	const segments = path.split(".");
	const name = segments.pop() as string;
	let holder = root;
	for (const s of segments) holder = holder[s];
	return { holder, fn: holder[name], name };
}

describe("every free method sends only GET or DELETE, unless it is a named free POST", () => {
	const providers = ["anthropic", "openai"] as const;
	const methods: Record<string, string[]> = {};
	const vaults: Record<string, string> = {};
	const clients: Record<string, { governed: Loose; raw: Loose; requests: string[] }> = {};

	/** The provider vault's audit chain as text: the refusal rows above write to it too. */
	const auditText = (provider: string): string =>
		readFileSync(join(vaults[provider] as string, VAULT_DIR, AUDIT_DIR, "events.jsonl"), {
			encoding: "utf8",
			flag: "a+",
		});

	beforeAll(async () => {
		for (const provider of providers) {
			const requests: string[] = [];
			const fetchImpl = (async (input: unknown, init?: RequestInit) => {
				const url = new URL(String(input instanceof Request ? input.url : input));
				requests.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`);
				return json(anyBody(url.pathname));
			}) as unknown as typeof fetch;
			const raw =
				provider === "anthropic"
					? new Anthropic({
							apiKey: "k",
							baseURL: "https://anthropic.test",
							fetch: fetchImpl,
							maxRetries: 0,
						})
					: new OpenAI({
							apiKey: "k",
							adminAPIKey: "k",
							webhookSecret: "whsec_AAAA",
							baseURL: "https://openai.test/v1",
							fetch: fetchImpl,
							maxRetries: 0,
						});
			vaults[provider] = join(tmpdir(), `default-deny-free-${randomUUID()}`);
			mkdirSync(vaults[provider] as string, { recursive: true });
			const governed = await trust(raw, {
				budget: 1_000_000,
				vaultBase: vaults[provider],
				_engine: mockEngine(),
			});
			clients[provider] = { governed, raw, requests };
		}
	});

	afterAll(async () => {
		for (const provider of providers) {
			await clients[provider]?.governed.destroy();
			rmSync(vaults[provider] as string, { recursive: true, force: true });
		}
	});

	for (const provider of providers) {
		methods[provider] = [...FREE_METHODS[provider]].sort();
	}

	it("the named sets name only free methods", () => {
		for (const key of [...Object.keys(FREE_POSTS), ...Object.keys(FREE_LOCAL)]) {
			const [provider, path] = key.split(":") as ["anthropic" | "openai", string];
			expect(FREE_METHODS[provider].has(path), key).toBe(true);
		}
	});

	it.each(Object.keys(REFUSED_DESPITE_GET_OR_DELETE))(
		"%s is refused despite its verb (the category in REFUSED_DESPITE_GET_OR_DELETE)",
		async (key) => {
			const [provider, path] = key.split(":") as ["anthropic" | "openai", string];
			expect(FREE_METHODS[provider].has(path), `${key} is not on the free list`).toBe(false);
			const c = clients[provider] as { governed: Loose; raw: Loose; requests: string[] };
			c.requests.length = 0;
			const { fn: rawFn } = resolveMember(c.raw, path);
			expect(typeof rawFn, `${key} exists on the installed SDK`).toBe("function");
			const { holder, name } = resolveMember(c.governed, path);
			await expect(holder[name](...dummyArgs(rawFn))).rejects.toBeInstanceOf(PolicyDeniedError);
			expect(c.requests, `${key} sent nothing`).toEqual([]);
		},
	);

	it.each(
		providers.flatMap((provider) =>
			(methods[provider] ?? []).map((path) => [`${provider}:${path}`, provider, path] as const),
		),
	)("%s", async (key, provider, path) => {
		const c = clients[provider] as { governed: Loose; raw: Loose; requests: string[] };
		c.requests.length = 0;
		const eventsBefore = auditText(provider);
		const { fn: rawFn } = resolveMember(c.raw, path);
		expect(typeof rawFn, `${key} exists on the installed SDK`).toBe("function");
		const { holder, name } = resolveMember(c.governed, path);
		let caught: unknown;
		try {
			await Promise.race([
				(async () => await holder[name](...dummyArgs(rawFn)))(),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error(`${key}: no answer in 3s`)), 3000),
				),
			]);
		} catch (err) {
			caught = err;
		}
		// An SDK-side error over the dummy arguments is fine; a refusal or a hang is not.
		expect(caught, `${key} was refused`).not.toBeInstanceOf(PolicyDeniedError);
		expect(String((caught as Error | undefined)?.message ?? "")).not.toMatch(/no answer in 3s/);
		if (FREE_LOCAL[key] !== undefined) {
			expect(c.requests, `${key} is local`).toEqual([]);
			return;
		}
		// Positive control: the call reached the recording fetch, so the verb check below has a subject.
		expect(c.requests.length, `${key} sent a request`).toBeGreaterThan(0);
		const allowed = FREE_POSTS[key] !== undefined ? ["GET", "DELETE", "POST"] : ["GET", "DELETE"];
		for (const r of c.requests) {
			expect(allowed, `${key} sent ${r}`).toContain(r.split(" ")[0]);
		}
		expect(auditText(provider), `${key} wrote no audit event`).toBe(eventsBefore);
	});
});

// ── Inertness ──

describe("the boundary is inert to inspection and serialization", () => {
	it("then stays undefined: the client and its resources are not thenable", async () => {
		const { client } = await anthropic();
		expect(client.then).toBeUndefined();
		expect(client.messages.then).toBeUndefined();
		expect(client.messages.batches.then).toBeUndefined();
		expect(client.beta.messages.batches.then).toBeUndefined();
		expect(await Promise.resolve(client)).toBe(client);
		const o = await openai();
		expect(o.client.then).toBeUndefined();
		expect(o.client.embeddings.then).toBeUndefined();
		expect(o.client.beta.threads.runs.then).toBeUndefined();
	});

	it("util.inspect does not throw", async () => {
		const { client } = await anthropic();
		expect(() => inspect(client)).not.toThrow();
		expect(() => inspect(client.messages.batches)).not.toThrow();
		expect(() => inspect(client.messages._client)).not.toThrow();
		const o = await openai();
		expect(() => inspect(o.client, { depth: 4 })).not.toThrow();
	});

	it("JSON.stringify of a resource behaves as it does on the raw SDK (a circular TypeError)", async () => {
		const { client, raw } = await anthropic();
		const outcome = (v: unknown): string => {
			try {
				return `ok:${JSON.stringify(v)}`;
			} catch (err) {
				return `${(err as Error).name}:${(err as Error).message.split("\n")[0]}`;
			}
		};
		expect(outcome(client.messages.batches)).toBe(outcome(raw.messages.batches));
		expect(outcome(client.messages)).toBe(outcome(raw.messages));
		expect(outcome(client.beta)).toBe(outcome(raw.beta));
	});

	it("symbols and Object.prototype members pass", async () => {
		const { client, raw } = await anthropic();
		expect(client[Symbol.toStringTag]).toBe(raw[Symbol.toStringTag]);
		expect(client.messages[Symbol.asyncIterator]).toBe(raw.messages[Symbol.asyncIterator]);
		expect(client.messages.batches[inspect.custom]).toBe(raw.messages.batches[inspect.custom]);
		expect(client.messages.batches.constructor).toBe(raw.messages.batches.constructor);
		expect(client.beta.constructor).toBe(raw.beta.constructor);
		expect(String(client.messages.batches)).toBe("[object Object]");
		expect(client.messages.batches.valueOf()).toBeDefined();
		// biome-ignore lint/suspicious/noPrototypeBuiltins: the row is that an Object.prototype method still works through the boundary.
		expect(client.messages.hasOwnProperty("batches")).toBe(true);
		expect(client.messages.batches.toJSON).toBeUndefined();
	});

	it("non-function values pass untouched", async () => {
		const { client, raw } = await openai();
		expect(client.baseURL).toBe(raw.baseURL);
		expect(client.maxRetries).toBe(0);
		expect(client.apiKey).toBe("k");
	});

	it("a resource is the same object on every read", async () => {
		const { client } = await openai();
		expect(client.beta.threads.runs).toBe(client.beta.threads.runs);
		expect(client.embeddings).toBe(client.embeddings);
	});
});

// ── Method identity: a wrapper per (path, raw resource, name), built once ──

describe("a method keeps its identity across reads", () => {
	const CASES = {
		anthropic: {
			build: anthropic,
			free: "models.list",
			listed: "messages.batches.create",
			refused: "completions.create",
			refusedArgs: [{ model: "claude-2.1", max_tokens_to_sample: 8, prompt: "\n\nHuman: hi" }],
			listGet: "GET /v1/models",
		},
		openai: {
			build: openai,
			free: "models.list",
			listed: "embeddings.create",
			refused: "images.generate",
			refusedArgs: [{ model: "gpt-image-1", prompt: "a cat" }],
			listGet: "GET /v1/models",
		},
	} as const;

	for (const [provider, c] of Object.entries(CASES)) {
		it(`${provider}: free, listed and refused methods are the same function on every read`, async () => {
			const { client } = await c.build({ allowUngoverned: [c.listed] });
			for (const path of [c.free, c.listed, c.refused]) {
				const { holder, name } = resolveMember(client, path);
				expect(holder[name], path).toBe(resolveMember(client, path).holder[name]);
			}
		});

		it(`${provider}: the same raw function at two paths gets two wrappers, each deciding by its own path`, async () => {
			const { client, raw, engine } = await c.build({}, (r: Loose) => {
				r.aliasedModels = r.models;
			});
			expect(raw.aliasedModels.list).toBe(raw.models.list);
			const free = client.models.list;
			const gated = client.aliasedModels.list;
			expect(free).not.toBe(gated);
			await expectRefused("aliasedModels.list", () => gated(), engine);
			await free();
			expect(hits).toEqual([c.listGet]);
			expect(chainEvents().map((e) => e.kind)).toEqual(["policy_denied"]);
		});

		it(`${provider}: two calls of one cached refused wrapper give two errors, each with its own event`, async () => {
			const { client } = await c.build();
			const { holder, name } = resolveMember(client, c.refused);
			const refused = holder[name];
			const first = await refused(...c.refusedArgs).catch((e: unknown) => e);
			const second = await refused(...c.refusedArgs).catch((e: unknown) => e);
			expect(first).toBeInstanceOf(PolicyDeniedError);
			expect(second).toBeInstanceOf(PolicyDeniedError);
			expect(first).not.toBe(second);
			const events = chainEvents() as unknown as Array<{ kind: string; hash: string }>;
			expect(events.map((e) => e.kind)).toEqual(["policy_denied", "policy_denied"]);
			expect((first as PolicyDeniedError).auditEventHash).toBe(events[0]?.hash);
			expect((second as PolicyDeniedError).auditEventHash).toBe(events[1]?.hash);
			expect(events[0]?.hash).not.toBe(events[1]?.hash);
		});
	}
});

// ── Governed paths are unchanged ──

describe("governed methods still govern", () => {
	it("Anthropic messages.create", async () => {
		const { client, engine } = await anthropic();
		const out = await client.messages.create(MP);
		expect(out.receipt.settled).toBe(true);
		expect(engine.spendPending).toHaveBeenCalledTimes(1);
		expect(chainEvents().map((e) => e.kind)).toEqual(["llm_call"]);
	});

	it("OpenAI chat.completions.create and responses.create", async () => {
		const { client, engine } = await openai();
		const a = await client.chat.completions.create(CP);
		const b = await client.responses.create({ model: "gpt-4o", input: "hi" });
		expect(a.receipt.settled).toBe(true);
		expect(b.receipt.settled).toBe(true);
		expect(engine.spendPending).toHaveBeenCalledTimes(2);
		expect(chainEvents().map((e) => e.kind)).toEqual(["llm_call", "llm_call"]);
		expect(hits).toEqual(["POST /v1/chat/completions", "POST /v1/responses"]);
	});
});
