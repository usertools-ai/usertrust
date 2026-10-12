// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Default-deny on Anthropic and OpenAI clients.
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

/** The SDK's injected fetch: records `METHOD /path`, answers from the canned bodies above. */
function recordingFetch(hits: string[], provider: "anthropic" | "openai"): typeof fetch {
	return (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		hits.push(`${init?.method ?? "GET"} ${url.pathname}`);
		const p = url.pathname;
		if (provider === "anthropic") {
			if (p === "/v1/messages/count_tokens") return json({ input_tokens: 3 });
			if (p.startsWith("/v1/messages/batches")) return json(ANTHROPIC_BATCH);
			if (p === "/v1/messages") return json(ANTHROPIC_MESSAGE);
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

async function anthropic(opts: Partial<TrustOpts> = {}) {
	const engine = mockEngine();
	const raw = new Anthropic({
		apiKey: "k",
		baseURL: "https://anthropic.test",
		fetch: recordingFetch(hits, "anthropic"),
		maxRetries: 0,
	});
	const client = await trust(raw, {
		budget: 1_000_000,
		vaultBase: vault,
		_engine: engine,
		...opts,
	});
	open.push(client);
	return { client: client as Loose, raw: raw as Loose, engine };
}

async function openai(opts: Partial<TrustOpts> = {}) {
	const engine = mockEngine();
	const raw = new OpenAI({
		apiKey: "k",
		baseURL: "https://openai.test/v1",
		fetch: recordingFetch(hits, "openai"),
		maxRetries: 0,
	});
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
	it("Anthropic withOptions({}) stays governed: messages.create holds, settles and audits", async () => {
		const { client, engine } = await anthropic();
		const child = client.withOptions({ timeout: 1000 });
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

	it("OpenAI withOptions({}) stays governed, and its ungoverned methods are refused", async () => {
		const { client, engine } = await openai();
		const child = client.withOptions({ timeout: 1000 });
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

	it("under audit.failClosed a healthy append lets the call through", async () => {
		writeConfig({ audit: { failClosed: true } });
		const { client } = await openai({ allowUngoverned: ["embeddings.create"] });
		const out = await client.embeddings.create({ model: "text-embedding-3-small", input: "hi" });
		expect(out.object).toBe("list");
		expect(chainEvents().map((e) => e.kind)).toEqual(["ungoverned_call"]);
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
