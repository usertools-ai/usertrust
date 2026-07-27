// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Task 3 — OpenAI Responses API interception.
 *
 * The Responses API previously bypassed governance entirely (it was an
 * UNDOCUMENTED bypass — not even in detect.ts's list). It is now brought inside
 * the two-phase lifecycle:
 *   - A5: `responses.create` is feature-detected (`typeof responses.create ===
 *     "function"`); an older SDK without the namespace stays a raw pass-through.
 *   - A6: the Responses path is SEPARATE from chat.completions — it never receives
 *     the chat-only `stream_options.include_usage` injection, and its non-stream
 *     `??` chain reads `input_tokens`/`output_tokens` (verified here).
 *   - A7: Responses STREAMING flows through the EXISTING createGovernedStream path;
 *     only the terminal-event usage extractor (`response.completed` →
 *     `event.response.usage.{input_tokens,output_tokens}`) is new.
 *   - A8: `extractPromptParts` gains a narrow, ordered `input`/`instructions`
 *     branch that never preempts the chat/messages branch (byte-unchanged proof).
 *   - A3: a successful stream whose terminal event carries no usage settles at
 *     ESTIMATE, never voids.
 *   - A9: ledger mutations asserted by COUNT — settle-exactly-once / void-once.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, extractPromptParts, trust } from "../../src/govern.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { PolicyDeniedError } from "../../src/shared/errors.js";
import type { AuditEvent, TrustReceipt } from "../../src/shared/types.js";

// ── TigerBeetle native-module mock (never loaded in unit tests) ──

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

// ── Helpers ──

function makeTmpVault(): string {
	const dir = join(tmpdir(), `openai-responses-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeVaultConfig(vaultBase: string, config: Record<string, unknown>): void {
	const configDir = join(vaultBase, VAULT_DIR);
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "usertrust.config.json"), JSON.stringify(config));
}

function makeMockEngine(overrides?: Partial<TrustEngine>): TrustEngine {
	return {
		spendPending: vi.fn(async (p: { transferId: string; amount: number }) => ({
			transferId: p.transferId,
		})),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
		...overrides,
	};
}

function makeMockAudit(): AuditWriter {
	return {
		appendEvent: vi.fn(
			async (input: AppendEventInput): Promise<AuditEvent> => ({
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "a".repeat(64),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			}),
		),
		getWriteFailures: vi.fn(() => 0),
		isDegraded: vi.fn(() => false),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
	};
}

interface ResponsesClientOpts {
	/** Non-stream `response.usage`; `null` → omit the usage object entirely. */
	usage?: { input_tokens: number; output_tokens: number; total_tokens?: number } | null;
	/** Streaming events yielded in order (a `response.completed` carries usage). */
	streamEvents?: unknown[];
	/** Throw mid-stream AFTER this many events have been yielded (void path). */
	throwAfter?: number;
	/** SDK `baseURL` (drives cloud/local classification); `null` → omit. */
	baseURL?: string | null;
}

/**
 * OpenAI-SDK-shaped fake exposing `responses.create` (stream + non-stream) AND
 * `chat.completions.create` (so detectClientKind resolves "openai"). `calls`
 * records every params object forwarded to `responses.create` — used to assert
 * A6 (no stream_options.include_usage injection).
 */
function makeResponsesClient(opts: ResponsesClientOpts = {}) {
	const calls: Record<string, unknown>[] = [];
	const createFn = vi.fn(async (params: Record<string, unknown>) => {
		calls.push(params);
		if (params.stream === true) {
			const events = opts.streamEvents ?? [];
			const throwAfter = opts.throwAfter;
			async function* gen(): AsyncGenerator<unknown> {
				let i = 0;
				for (const ev of events) {
					if (throwAfter !== undefined && i >= throwAfter) {
						throw new Error("responses stream interrupted");
					}
					yield ev;
					i++;
				}
			}
			return gen();
		}
		const resp: Record<string, unknown> = { id: "resp_1", output: [] };
		if (opts.usage !== null) {
			resp.usage = opts.usage ?? { input_tokens: 100, output_tokens: 50, total_tokens: 150 };
		}
		return resp;
	});

	const client: Record<string, unknown> = {
		chat: {
			completions: {
				create: vi.fn(async () => ({
					id: "chat_1",
					usage: { prompt_tokens: 5, completion_tokens: 5 },
				})),
			},
		},
		responses: { create: createFn },
	};
	if (opts.baseURL !== null && opts.baseURL !== undefined) {
		client.baseURL = opts.baseURL;
	}
	return { client, createFn, calls };
}

interface CallResult {
	response: unknown;
	receipt: TrustReceipt;
}

async function callResponses(
	governed: unknown,
	params: Record<string, unknown>,
): Promise<CallResult> {
	const g = governed as {
		responses: { create: (p: Record<string, unknown>) => Promise<CallResult> };
	};
	return g.responses.create(params);
}

async function consumeStream(result: CallResult): Promise<{
	chunks: unknown[];
	receipt: TrustReceipt;
}> {
	const stream = result.response as AsyncIterable<unknown>;
	const chunks: unknown[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	const receipt = await (result.response as { receipt: Promise<TrustReceipt> }).receipt;
	return { chunks, receipt };
}

async function destroy(governed: unknown): Promise<void> {
	await (governed as { destroy(): Promise<void> }).destroy();
}

const NONSTREAM_PARAMS = {
	model: "gpt-4o",
	input: "Summarize the quarterly report.",
};

const STREAM_PARAMS = {
	model: "gpt-4o",
	input: "Stream me a story.",
	stream: true,
};

const RESPONSES_STREAM_WITH_USAGE = [
	{ type: "response.created", response: { id: "resp_1" } },
	{ type: "response.output_text.delta", delta: "Hello" },
	{ type: "response.output_text.delta", delta: " world" },
	{
		type: "response.completed",
		response: { id: "resp_1", usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 } },
	},
];

const RESPONSES_STREAM_NO_USAGE = [
	{ type: "response.created", response: { id: "resp_2" } },
	{ type: "response.output_text.delta", delta: "Hi" },
	// Terminal event WITHOUT a usage object (A7: some local runtimes omit it).
	{ type: "response.completed", response: { id: "resp_2" } },
];

// ── Non-stream ──

describe("OpenAI Responses non-stream governance (A6)", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	it("governs responses.create and settles at reported usage (A2/A9 settle-once)", async () => {
		const engine = makeMockEngine();
		const { client } = makeResponsesClient({
			usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
		});
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const { receipt } = await callResponses(governed, NONSTREAM_PARAMS);

		// Exactly one PENDING hold; settle POSTed exactly once; never voided.
		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		expect(receipt.settled).toBe(true);
		expect(receipt.provider).toBe("openai");
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.cost).toBeGreaterThan(0);
		// Task 1 divergence flag rides along on the settled receipt.
		expect(receipt.divergence).toBeDefined();
		expect(receipt.divergence?.actualCost).toBe(receipt.cost);

		await destroy(governed);
	});

	it("reads input_tokens/output_tokens (NOT prompt_/completion_) from Responses usage (A6 ?? chain)", async () => {
		// The Responses usage object carries ONLY input_tokens/output_tokens. If the
		// non-stream settle `??` chain did not read those field names, output would
		// fall to 0 and a huge reported usage would price the SAME as a tiny one.
		// A strictly larger cost for larger input_tokens/output_tokens PROVES the
		// chain reads the Responses field names.
		const bigEngine = makeMockEngine();
		const { client: bigClient } = makeResponsesClient({
			usage: { input_tokens: 200_000, output_tokens: 200_000 },
		});
		const bigGoverned = await trust(bigClient, {
			dryRun: false,
			budget: 5_000_000_000,
			vaultBase: makeTmpVault(),
			_engine: bigEngine,
			_audit: makeMockAudit(),
		});
		const big = await callResponses(bigGoverned, NONSTREAM_PARAMS);
		await destroy(bigGoverned);

		const smallEngine = makeMockEngine();
		const { client: smallClient } = makeResponsesClient({
			usage: { input_tokens: 1, output_tokens: 1 },
		});
		const smallGoverned = await trust(smallClient, {
			dryRun: false,
			budget: 5_000_000_000,
			vaultBase: makeTmpVault(),
			_engine: smallEngine,
			_audit: makeMockAudit(),
		});
		const small = await callResponses(smallGoverned, NONSTREAM_PARAMS);
		await destroy(smallGoverned);

		expect(big.receipt.usageSource).toBe("provider");
		expect(small.receipt.usageSource).toBe("provider");
		// output_tokens is read: 200k tokens must cost strictly more than 1 token.
		expect(big.receipt.cost).toBeGreaterThan(small.receipt.cost);
	});

	it("settles at ESTIMATE when the Responses call reports no usage (A3)", async () => {
		const engine = makeMockEngine();
		const { client } = makeResponsesClient({ usage: null });
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const { receipt } = await callResponses(governed, NONSTREAM_PARAMS);

		expect(receipt.settled).toBe(true);
		expect(receipt.usageSource).toBe("estimated");
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await destroy(governed);
	});

	it("detects PII in the Responses `input` (A8 — input feeds the PII scanner)", async () => {
		writeVaultConfig(tmpVault, { budget: 50_000, pii: "block" });
		const engine = makeMockEngine();
		const { client, createFn } = makeResponsesClient();
		const governed = await trust(client, {
			dryRun: false,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		await expect(
			callResponses(governed, {
				model: "gpt-4o",
				input: "Please email the report to alice@example.com right away.",
			}),
		).rejects.toBeInstanceOf(PolicyDeniedError);

		// PII block throws BEFORE any egress or PENDING hold — nothing forwarded/held.
		expect(createFn).not.toHaveBeenCalled();
		expect(engine.spendPending).not.toHaveBeenCalled();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await destroy(governed);
	});

	it("detects PII in the Responses `instructions` (A8)", async () => {
		writeVaultConfig(tmpVault, { budget: 50_000, pii: "block" });
		const engine = makeMockEngine();
		const { client, createFn } = makeResponsesClient();
		const governed = await trust(client, {
			dryRun: false,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		await expect(
			callResponses(governed, {
				model: "gpt-4o",
				instructions: "Contact the admin at ops@example.com if anything breaks.",
				input: "Do the task.",
			}),
		).rejects.toBeInstanceOf(PolicyDeniedError);

		expect(createFn).not.toHaveBeenCalled();

		await destroy(governed);
	});
});

// ── Streaming (A7) ──

describe("OpenAI Responses streaming governance (A7)", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	it("settles from the terminal response.completed usage (usageSource=provider)", async () => {
		const engine = makeMockEngine();
		const { client } = makeResponsesClient({ streamEvents: RESPONSES_STREAM_WITH_USAGE });
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const result = await callResponses(governed, STREAM_PARAMS);
		const { chunks, receipt } = await consumeStream(result);

		// All events (incl. the terminal) are yielded UNCHANGED to the consumer.
		expect(chunks).toHaveLength(RESPONSES_STREAM_WITH_USAGE.length);
		expect(receipt.settled).toBe(true);
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.chunksDelivered).toBe(RESPONSES_STREAM_WITH_USAGE.length);
		expect(receipt.cost).toBeGreaterThan(0);
		expect(receipt.divergence).toBeDefined();

		// Settle-exactly-once, never voided (A9).
		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await destroy(governed);
	});

	it("settles at ESTIMATE when the terminal event carries no usage (A3/A7)", async () => {
		const engine = makeMockEngine();
		const { client } = makeResponsesClient({ streamEvents: RESPONSES_STREAM_NO_USAGE });
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const result = await callResponses(governed, STREAM_PARAMS);
		const { receipt } = await consumeStream(result);

		expect(receipt.settled).toBe(true);
		expect(receipt.usageSource).toBe("estimated");
		// A billable success with unknown usage SETTLES (at estimate), never voids.
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await destroy(governed);
	});

	it("clamps non-finite/negative terminal usage counts (A7 sanitation)", async () => {
		const engine = makeMockEngine();
		const { client } = makeResponsesClient({
			streamEvents: [
				{ type: "response.output_text.delta", delta: "x" },
				{
					type: "response.completed",
					response: { id: "r", usage: { input_tokens: -5, output_tokens: Number.NaN } },
				},
			],
		});
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const result = await callResponses(governed, STREAM_PARAMS);
		const { receipt } = await consumeStream(result);

		// A present-but-garbage usage object still counts as reported (clamped to 0);
		// cost floors at the >=1 nominal per-call floor.
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.cost).toBeGreaterThanOrEqual(1);
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await destroy(governed);
	});

	it("VOIDs exactly once on a mid-stream error (A2/A9 void-once)", async () => {
		const engine = makeMockEngine();
		const { client } = makeResponsesClient({
			streamEvents: RESPONSES_STREAM_WITH_USAGE,
			throwAfter: 2,
		});
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const result = await callResponses(governed, STREAM_PARAMS);
		void (result.response as { receipt: Promise<TrustReceipt> }).receipt.catch(() => {});
		await expect(consumeStream(result)).rejects.toThrow(/interrupted/);

		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).not.toHaveBeenCalled();

		await destroy(governed);
	});
});

// ── A6: no include_usage injection on Responses params ──

describe("Responses stays separate from chat.completions (A6/A9)", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	it("does NOT inject stream_options.include_usage into Responses params on a LOCAL endpoint", async () => {
		// Force a local endpoint where injectUsageOptions is on by default — this is
		// the exact condition that injects include_usage for chat.completions. The
		// Responses path MUST skip it (A6): stream_options is chat-completions-only.
		writeVaultConfig(tmpVault, { budget: 50_000, local: { injectUsageOptions: true } });
		const engine = makeMockEngine();
		const { client, calls } = makeResponsesClient({
			streamEvents: RESPONSES_STREAM_WITH_USAGE,
		});
		const governed = await trust(client, {
			dryRun: false,
			vaultBase: tmpVault,
			endpoint: { class: "local", runtime: "ollama" },
			_engine: engine,
			_audit: makeMockAudit(),
		});

		const result = await callResponses(governed, { ...STREAM_PARAMS });
		const { receipt } = await consumeStream(result);

		// The forwarded params carry NO stream_options / include_usage of any kind.
		expect(calls).toHaveLength(1);
		expect("stream_options" in calls[0]).toBe(false);
		expect(JSON.stringify(calls[0])).not.toContain("include_usage");

		// And it still settled exactly once via the terminal event.
		expect(receipt.usageSource).toBe("provider");
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).not.toHaveBeenCalled();

		await destroy(governed);
	});
});

// ── A5: feature-detection ──

describe("Responses feature-detection (A5)", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = makeTmpVault();
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {}
	});

	it("a client WITHOUT responses still wraps; chat.completions works; .responses is a raw pass-through", async () => {
		const chatCreate = vi.fn(async () => ({
			id: "chat_1",
			usage: { prompt_tokens: 10, completion_tokens: 5 },
		}));
		const client: Record<string, unknown> = {
			chat: { completions: { create: chatCreate } },
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: makeMockEngine(),
			_audit: makeMockAudit(),
		});

		// No responses namespace on the client → the proxy leaves it undefined.
		expect((governed as { responses?: unknown }).responses).toBeUndefined();

		// The governed chat.completions.create still works.
		const g = governed as {
			chat: { completions: { create: (p: Record<string, unknown>) => Promise<CallResult> } };
		};
		const { receipt } = await g.chat.completions.create({
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(receipt.provider).toBe("openai");
		expect(receipt.settled).toBe(true);

		await destroy(governed);
	});

	it("a `responses` object WITHOUT a create function stays a raw pass-through (A5)", async () => {
		const rawResponses = { retrieve: vi.fn(), cancel: vi.fn() };
		const client: Record<string, unknown> = {
			chat: {
				completions: { create: vi.fn(async () => ({ id: "c", usage: {} })) },
			},
			responses: rawResponses,
		};
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: makeMockEngine(),
			_audit: makeMockAudit(),
		});

		// Feature-detect miss (no create) → Reflect.get returns the ORIGINAL object.
		expect((governed as { responses: unknown }).responses).toBe(rawResponses);

		await destroy(governed);
	});

	it("a throwing `responses` getter never breaks wrap-time (A5)", async () => {
		const client: Record<string, unknown> = {
			chat: {
				completions: { create: vi.fn(async () => ({ id: "c", usage: {} })) },
			},
		};
		Object.defineProperty(client, "responses", {
			configurable: true,
			enumerable: true,
			get() {
				throw new Error("responses getter boom");
			},
		});

		// A5's load-bearing property: wrapping a surface that throws on access must
		// NOT throw at wrap time — the feature-detect swallows it and leaves the
		// property a raw pass-through.
		const governed = await trust(client, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: makeMockEngine(),
			_audit: makeMockAudit(),
		});

		// Reading `.responses` re-evaluates the raw getter (we never synthesized one),
		// so the caller sees the original throwing behavior — exactly as un-governed.
		expect(() => (governed as { responses: unknown }).responses).toThrow(/boom/);

		await destroy(governed);
	});
});

// ── A8: extractPromptParts is narrow, ordered, and byte-unchanged ──

describe("extractPromptParts Responses branch (A8)", () => {
	it("leaves chat.completions / Anthropic messages extraction byte-unchanged", () => {
		// OpenAI chat.completions: messages array copied verbatim.
		expect(extractPromptParts({ messages: [{ role: "user", content: "hi" }] }, "openai")).toEqual([
			{ role: "user", content: "hi" },
		]);
		// Anthropic: messages + system appended as a system message.
		expect(
			extractPromptParts(
				{ messages: [{ role: "user", content: "hi" }], system: "be terse" },
				"anthropic",
			),
		).toEqual([
			{ role: "user", content: "hi" },
			{ role: "system", content: "be terse" },
		]);
		// Google: contents passed through.
		expect(extractPromptParts({ contents: [{ parts: [{ text: "hi" }] }] }, "google")).toEqual([
			{ parts: [{ text: "hi" }] },
		]);
	});

	it("does NOT preempt the messages branch even when `input` is also present", () => {
		// A params object carrying BOTH messages and input is a chat call — the
		// Responses branch must not fire (it is gated on messages === undefined).
		expect(
			extractPromptParts(
				{ messages: [{ role: "user", content: "m" }], input: "ignored" },
				"openai",
			),
		).toEqual([{ role: "user", content: "m" }]);
	});

	it("covers Responses `input` as a string plus `instructions`", () => {
		expect(extractPromptParts({ input: "hello", instructions: "be nice" }, "openai")).toEqual([
			{ role: "user", content: "hello" },
			{ role: "system", content: "be nice" },
		]);
	});

	it("covers Responses `input` as a message array", () => {
		expect(extractPromptParts({ input: [{ role: "user", content: "hi" }] }, "openai")).toEqual([
			{ role: "user", content: [{ role: "user", content: "hi" }] },
		]);
	});

	it("covers Responses `input` as a content-part array", () => {
		expect(extractPromptParts({ input: [{ type: "input_text", text: "hi" }] }, "openai")).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "hi" }] },
		]);
	});

	it("wraps a bare object `input` and ignores non-string instructions", () => {
		expect(
			extractPromptParts({ input: { type: "input_text", text: "x" }, instructions: 42 }, "openai"),
		).toEqual([{ role: "user", content: [{ type: "input_text", text: "x" }] }]);
	});
});
