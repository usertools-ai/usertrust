// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * local-endpoint.test.ts — M2 local-model governance through trust() (plan Task 2).
 *
 * Covers: stream_options.include_usage injection + A4 merge/retry semantics,
 * unknownModelPolicy enforcement at authorize (A5), receipt endpoint/meter
 * provenance (A6), usage sanitation (A7), the per-call >=1 nominal floor (A11),
 * and the streaming.ts REPLACE-WITH-LATEST accumulation for OpenAI/Google usage
 * snapshots (design decision 5.2 — vLLM continuous_usage_stats double-count fix).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trust } from "../../src/govern.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { PolicyDeniedError } from "../../src/shared/errors.js";
import type { TrustReceipt } from "../../src/shared/types.js";
import { type StreamCompletion, wrapStream } from "../../src/streaming.js";

// Mock tigerbeetle-node (native module, never loaded in tests)
vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: {
		linked: 1,
		pending: 2,
		post_pending_transfer: 4,
		void_pending_transfer: 8,
	},
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

// ── Helpers ──

function makeTmpVault(): string {
	const dir = join(tmpdir(), `local-endpoint-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeVaultConfig(vaultBase: string, config: Record<string, unknown>): void {
	const configDir = join(vaultBase, VAULT_DIR);
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "usertrust.config.json"), JSON.stringify(config));
}

const LOCAL_BASE_URL = "http://localhost:11434/v1";

/** OpenAI-SDK-shaped mock whose create() returns an async-iterable stream. */
function makeStreamClient(
	chunks: unknown[],
	opts?: { baseURL?: string | null; rejectStreamOptions?: boolean },
) {
	const createFn = vi.fn(async (params: Record<string, unknown>) => {
		if (opts?.rejectStreamOptions === true && params.stream_options != null) {
			throw new Error("400: unknown parameter stream_options");
		}
		async function* gen(): AsyncGenerator<unknown> {
			for (const c of chunks) yield c;
		}
		return gen();
	});
	const client: Record<string, unknown> = {
		chat: { completions: { create: createFn } },
	};
	if (opts?.baseURL !== null) {
		client.baseURL = opts?.baseURL ?? LOCAL_BASE_URL;
	}
	return { client, createFn };
}

/** OpenAI-SDK-shaped mock whose create() resolves a non-stream response. */
function makeJsonClient(response: Record<string, unknown>, opts?: { baseURL?: string | null }) {
	const createFn = vi.fn(async () => response);
	const client: Record<string, unknown> = {
		chat: { completions: { create: createFn } },
	};
	if (opts?.baseURL !== null) {
		client.baseURL = opts?.baseURL ?? LOCAL_BASE_URL;
	}
	return { client, createFn };
}

interface CallResult {
	response: unknown;
	receipt: TrustReceipt;
}

/** Call the governed chat.completions.create and cast past the mock's type. */
async function call(governed: unknown, params: Record<string, unknown>): Promise<CallResult> {
	const g = governed as {
		chat: { completions: { create: (p: Record<string, unknown>) => Promise<CallResult> } };
	};
	return g.chat.completions.create(params);
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

const STREAM_CHUNKS_WITH_USAGE = [
	{ choices: [{ delta: { content: "Hello" } }] },
	{ choices: [{ delta: { content: " world" } }] },
	{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } },
];

const STREAM_CHUNKS_NO_USAGE = [
	{ choices: [{ delta: { content: "Hello" } }] },
	{ choices: [{ delta: { content: " world" } }] },
];

// ── Tests ──

describe("M2 local endpoint governance (govern.ts + streaming.ts)", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = makeTmpVault();
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
		vi.restoreAllMocks();
	});

	// ───────────────────────────────────────────────────────────────────────
	// wrapStream: REPLACE-WITH-LATEST usage accumulation (OpenAI/Google)
	// ───────────────────────────────────────────────────────────────────────

	describe("wrapStream replace-with-latest usage accumulation", () => {
		async function collect(chunks: unknown[], kind: "openai" | "google" | "anthropic") {
			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(
				(async function* () {
					for (const c of chunks) yield c;
				})(),
				kind,
				onComplete,
				onError,
			);
			for await (const _ of wrapped) {
				// consume
			}
			expect(onError).not.toHaveBeenCalled();
			return onComplete.mock.calls[0]?.[0] as StreamCompletion;
		}

		it("openai: cumulative running totals on every chunk are not double-counted", async () => {
			// vLLM continuous_usage_stats shape: RUNNING totals on each chunk.
			const completion = await collect(
				[
					{
						choices: [{ delta: { content: "a" } }],
						usage: { prompt_tokens: 10, completion_tokens: 5 },
					},
					{
						choices: [{ delta: { content: "b" } }],
						usage: { prompt_tokens: 10, completion_tokens: 12 },
					},
					{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } },
				],
				"openai",
			);
			expect(completion.usage).toEqual({
				inputTokens: 10,
				outputTokens: 20,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			});
			expect(completion.usageReported).toBe(true);
		});

		it("openai: decreasing cumulative totals take the LAST chunk's values (A7)", async () => {
			const completion = await collect(
				[
					{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 40 } },
					{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 25 } },
				],
				"openai",
			);
			expect(completion.usage).toEqual({
				inputTokens: 100,
				outputTokens: 25,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			});
		});

		it("openai: a usage-bearing chunk with explicit zeros counts as reported usage (A11)", async () => {
			const completion = await collect(
				[{ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }],
				"openai",
			);
			expect(completion.usage).toEqual({
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			});
			expect(completion.usageReported).toBe(true);
		});

		it("openai: NaN/negative usage values clamp to 0 AND lose the provider label (A7+D5)", async () => {
			const completion = await collect(
				[
					{
						choices: [],
						usage: { prompt_tokens: Number.NaN, completion_tokens: -7 },
					},
				],
				"openai",
			);
			expect(completion.usage).toEqual({
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			});
			// A7 clamping is unchanged — the counts are 0. What changed is the LABEL:
			// spec D5 requires a provider-reported input AND output for provider
			// provenance, and NaN/-7 are not reported counts. Treating the clamped
			// zeros as "reported" settled a real call at the 1-usertoken floor under a
			// "provider" label — an understatement AND a mislabel. It now falls back to
			// the estimate (which the hold already reserved), the fail-safe direction.
			expect(completion.usageReported).toBe(false);
		});

		it("google: usageMetadata snapshots replace, never sum", async () => {
			const completion = await collect(
				[
					{ candidates: [], usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 10 } },
					{ candidates: [], usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 33 } },
				],
				"google",
			);
			expect(completion.usage).toEqual({
				inputTokens: 60,
				outputTokens: 33,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			});
		});

		it("anthropic: incremental message_start/message_delta path is unchanged (regression)", async () => {
			const completion = await collect(
				[
					{ type: "message_start", message: { usage: { input_tokens: 100 } } },
					{ type: "message_delta", usage: { output_tokens: 25 } },
				],
				"anthropic",
			);
			expect(completion.usage).toEqual({
				inputTokens: 100,
				outputTokens: 25,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			});
			expect(completion.usageReported).toBe(true);
		});
	});

	// ───────────────────────────────────────────────────────────────────────
	// include_usage injection (A4)
	// ───────────────────────────────────────────────────────────────────────

	describe("stream_options.include_usage injection (A4)", () => {
		it("injects include_usage for local openai streams without mutating caller params", async () => {
			const { client, createFn } = makeStreamClient(STREAM_CHUNKS_WITH_USAGE);
			const governed = await trust(client, { dryRun: true, budget: 1000, vaultBase: tmpVault });

			const params: Record<string, unknown> = {
				model: "qwen2.5:7b",
				stream: true,
				messages: [{ role: "user", content: "hi" }],
			};
			const result = await call(governed, params);

			const forwarded = createFn.mock.calls[0]?.[0] as Record<string, unknown>;
			expect(forwarded.stream_options).toEqual({ include_usage: true });
			// Transparent middleware: the caller's params object is never mutated.
			expect("stream_options" in params).toBe(false);

			const { receipt } = await consumeStream(result);
			expect(receipt.usageSource).toBe("provider");
			expect(receipt.cost).toBe(1);
			await destroy(governed);
		});

		it("merges with the caller's other stream_options fields", async () => {
			const { client, createFn } = makeStreamClient(STREAM_CHUNKS_WITH_USAGE);
			const governed = await trust(client, { dryRun: true, budget: 1000, vaultBase: tmpVault });

			const result = await call(governed, {
				model: "qwen2.5:7b",
				stream: true,
				stream_options: { chunk_size: 8 },
				messages: [{ role: "user", content: "hi" }],
			});
			const forwarded = createFn.mock.calls[0]?.[0] as Record<string, unknown>;
			expect(forwarded.stream_options).toEqual({ chunk_size: 8, include_usage: true });

			await consumeStream(result);
			await destroy(governed);
		});

		it("respects an explicit include_usage: false (never overridden)", async () => {
			const { client, createFn } = makeStreamClient(STREAM_CHUNKS_NO_USAGE);
			const governed = await trust(client, { dryRun: true, budget: 1000, vaultBase: tmpVault });

			const result = await call(governed, {
				model: "qwen2.5:7b",
				stream: true,
				stream_options: { include_usage: false },
				messages: [{ role: "user", content: "hi" }],
			});
			const forwarded = createFn.mock.calls[0]?.[0] as Record<string, unknown>;
			expect(forwarded.stream_options).toEqual({ include_usage: false });

			await consumeStream(result);
			await destroy(governed);
		});

		it("leaves an explicit include_usage: true untouched", async () => {
			const { client, createFn } = makeStreamClient(STREAM_CHUNKS_WITH_USAGE);
			const governed = await trust(client, { dryRun: true, budget: 1000, vaultBase: tmpVault });

			const result = await call(governed, {
				model: "qwen2.5:7b",
				stream: true,
				stream_options: { include_usage: true },
				messages: [{ role: "user", content: "hi" }],
			});
			const forwarded = createFn.mock.calls[0]?.[0] as Record<string, unknown>;
			expect(forwarded.stream_options).toEqual({ include_usage: true });
			expect(createFn).toHaveBeenCalledTimes(1);

			await consumeStream(result);
			await destroy(governed);
		});

		it("does not inject when config local.injectUsageOptions is false", async () => {
			writeVaultConfig(tmpVault, { budget: 1000, local: { injectUsageOptions: false } });
			const { client, createFn } = makeStreamClient(STREAM_CHUNKS_NO_USAGE);
			const governed = await trust(client, { dryRun: true, vaultBase: tmpVault });

			const result = await call(governed, {
				model: "qwen2.5:7b",
				stream: true,
				messages: [{ role: "user", content: "hi" }],
			});
			const forwarded = createFn.mock.calls[0]?.[0] as Record<string, unknown>;
			expect("stream_options" in forwarded).toBe(false);

			await consumeStream(result);
			await destroy(governed);
		});

		it("does not inject for cloud endpoints", async () => {
			const { client, createFn } = makeStreamClient(STREAM_CHUNKS_NO_USAGE, {
				baseURL: "https://api.openai.com/v1",
			});
			const governed = await trust(client, { dryRun: true, budget: 1000, vaultBase: tmpVault });

			const result = await call(governed, {
				model: "gpt-4o",
				stream: true,
				messages: [{ role: "user", content: "hi" }],
			});
			const forwarded = createFn.mock.calls[0]?.[0] as Record<string, unknown>;
			expect("stream_options" in forwarded).toBe(false);

			await consumeStream(result);
			await destroy(governed);
		});

		it("does not inject for non-stream local calls", async () => {
			const { client, createFn } = makeJsonClient({
				id: "x",
				choices: [{ message: { role: "assistant", content: "hi" } }],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			});
			const governed = await trust(client, { dryRun: true, budget: 1000, vaultBase: tmpVault });

			await call(governed, { model: "qwen2.5:7b", messages: [{ role: "user", content: "hi" }] });
			const forwarded = createFn.mock.calls[0]?.[0] as Record<string, unknown>;
			expect("stream_options" in forwarded).toBe(false);

			await destroy(governed);
		});

		it("retries ONCE without the injection when the server rejects stream_options (A4)", async () => {
			const { client, createFn } = makeStreamClient(STREAM_CHUNKS_NO_USAGE, {
				rejectStreamOptions: true,
			});
			const governed = await trust(client, { dryRun: true, budget: 1000, vaultBase: tmpVault });

			const result = await call(governed, {
				model: "qwen2.5:7b",
				stream: true,
				messages: [{ role: "user", content: "hi" }],
			});

			expect(createFn).toHaveBeenCalledTimes(2);
			const first = createFn.mock.calls[0]?.[0] as Record<string, unknown>;
			const second = createFn.mock.calls[1]?.[0] as Record<string, unknown>;
			expect(first.stream_options).toEqual({ include_usage: true });
			expect("stream_options" in second).toBe(false);

			// No usage tail without the injection → settles on the estimate.
			const { receipt } = await consumeStream(result);
			expect(receipt.usageSource).toBe("estimated");
			expect(receipt.cost).toBe(1);
			await destroy(governed);
		});

		it("does NOT retry an injected stream that fails with a generic (non-stream_options) error (F3)", async () => {
			// Local + stream ⇒ include_usage IS injected, so a retry path exists. But
			// this failure is a transient network error, not a stream_options
			// rejection — govern must surface it as-is and NOT duplicate the provider
			// call (indiscriminate retry would double compute and mask the root cause).
			const createFn = vi.fn(async () => {
				throw new Error("ECONNRESET: socket hang up");
			});
			const client = {
				baseURL: LOCAL_BASE_URL,
				chat: { completions: { create: createFn } },
			};
			const governed = await trust(client, { dryRun: true, budget: 1000, vaultBase: tmpVault });

			await expect(
				call(governed, {
					model: "qwen2.5:7b",
					stream: true,
					messages: [{ role: "user", content: "hi" }],
				}),
			).rejects.toThrow("ECONNRESET");
			// Exactly once — the injected call failed and was NOT retried without it.
			expect(createFn).toHaveBeenCalledTimes(1);
			await destroy(governed);
		});

		it("does not retry when nothing was injected", async () => {
			const createFn = vi.fn(async () => {
				throw new Error("boom");
			});
			const client = {
				baseURL: "https://api.openai.com/v1",
				chat: { completions: { create: createFn } },
			};
			const governed = await trust(client, { dryRun: true, budget: 1000, vaultBase: tmpVault });

			await expect(
				call(governed, {
					model: "gpt-4o",
					stream: true,
					messages: [{ role: "user", content: "hi" }],
				}),
			).rejects.toThrow("boom");
			expect(createFn).toHaveBeenCalledTimes(1);
			await destroy(governed);
		});
	});

	// ───────────────────────────────────────────────────────────────────────
	// unknownModelPolicy at authorize (A5)
	// ───────────────────────────────────────────────────────────────────────

	describe("unknownModelPolicy enforcement at authorize (A5)", () => {
		it("deny: cloud-scope unknown model throws PolicyDeniedError before the LLM call", async () => {
			writeVaultConfig(tmpVault, { budget: 1000, unknownModelPolicy: "deny" });
			const { client, createFn } = makeJsonClient({ id: "x" }, { baseURL: null });
			const governed = await trust(client, { dryRun: true, vaultBase: tmpVault });

			await expect(
				call(governed, {
					model: "made-up-model-deny-1",
					messages: [{ role: "user", content: "hi" }],
				}),
			).rejects.toThrow(PolicyDeniedError);
			await expect(
				call(governed, {
					model: "made-up-model-deny-1",
					messages: [{ role: "user", content: "hi" }],
				}),
			).rejects.toThrow("unknown_model: made-up-model-deny-1 not in pricing table");
			expect(createFn).not.toHaveBeenCalled();
			await destroy(governed);
		});

		it("deny: local-scope unknown model NEVER denies — resolves at local-default", async () => {
			writeVaultConfig(tmpVault, { budget: 1000, unknownModelPolicy: "deny" });
			const { client, createFn } = makeJsonClient({
				id: "x",
				choices: [{ message: { role: "assistant", content: "hi" } }],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			});
			const governed = await trust(client, { dryRun: true, vaultBase: tmpVault });

			const result = await call(governed, {
				model: "made-up-model-deny-2",
				messages: [{ role: "user", content: "hi" }],
			});
			expect(createFn).toHaveBeenCalledTimes(1);
			expect(result.receipt.cost).toBe(1);
			expect(result.receipt.meter).toMatchObject({
				costBasis: "nominal",
				rateSource: "local-default",
			});
			await destroy(governed);
		});

		it("warn: console.warn fires ONCE per model; every receipt still carries rateSource fallback", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { client } = makeJsonClient(
				{
					id: "x",
					choices: [{ message: { role: "assistant", content: "hi" } }],
					usage: { prompt_tokens: 10, completion_tokens: 5 },
				},
				{ baseURL: null },
			);
			const governed = await trust(client, { dryRun: true, budget: 1000, vaultBase: tmpVault });

			const r1 = await call(governed, {
				model: "made-up-model-warn-1",
				messages: [{ role: "user", content: "hi" }],
			});
			const r2 = await call(governed, {
				model: "made-up-model-warn-1",
				messages: [{ role: "user", content: "hi" }],
			});

			const unknownModelWarns = warnSpy.mock.calls.filter((c) =>
				String(c[0]).includes("made-up-model-warn-1"),
			);
			expect(unknownModelWarns).toHaveLength(1);
			expect(r1.receipt.meter).toMatchObject({ costBasis: "usd-proxy", rateSource: "fallback" });
			expect(r2.receipt.meter).toMatchObject({ costBasis: "usd-proxy", rateSource: "fallback" });
			await destroy(governed);
		});

		it("fallback: silent — no warn, receipt still marked fallback", async () => {
			writeVaultConfig(tmpVault, { budget: 1000, unknownModelPolicy: "fallback" });
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { client } = makeJsonClient(
				{
					id: "x",
					choices: [{ message: { role: "assistant", content: "hi" } }],
					usage: { prompt_tokens: 10, completion_tokens: 5 },
				},
				{ baseURL: null },
			);
			const governed = await trust(client, { dryRun: true, vaultBase: tmpVault });

			const result = await call(governed, {
				model: "made-up-model-silent-1",
				messages: [{ role: "user", content: "hi" }],
			});
			const unknownModelWarns = warnSpy.mock.calls.filter((c) =>
				String(c[0]).includes("made-up-model-silent-1"),
			);
			expect(unknownModelWarns).toHaveLength(0);
			expect(result.receipt.meter).toMatchObject({
				costBasis: "usd-proxy",
				rateSource: "fallback",
			});
			await destroy(governed);
		});
	});

	// ───────────────────────────────────────────────────────────────────────
	// Receipt endpoint/meter provenance (A6) + floors (A11) + sanitation (A7)
	// ───────────────────────────────────────────────────────────────────────

	describe("receipt endpoint/meter provenance", () => {
		it("local non-stream receipt carries endpoint, meter, usageSource — computeMs omitted (A6)", async () => {
			const { client } = makeJsonClient({
				id: "x",
				choices: [{ message: { role: "assistant", content: "hi" } }],
				usage: { prompt_tokens: 100, completion_tokens: 50 },
			});
			const governed = await trust(client, { dryRun: true, budget: 1000, vaultBase: tmpVault });

			const result = await call(governed, {
				model: "qwen2.5:7b",
				messages: [{ role: "user", content: "hi" }],
			});
			expect(result.receipt.endpoint).toEqual({ class: "local", runtime: "ollama" });
			// A6: absent optional fields are OMITTED. `meter` is no longer asserted
			// exhaustively (D5 added appliedRates + pricingTableVersion), so the
			// omission is pinned directly on the key.
			expect(result.receipt.meter).toMatchObject({
				costBasis: "nominal",
				rateSource: "local-default",
			});
			expect(Object.hasOwn(result.receipt.meter as object, "computeMs")).toBe(false);
			expect(result.receipt.usageSource).toBe("provider");
			expect(result.receipt.cost).toBe(1);
			await destroy(governed);
		});

		it("A11: provider usage of 0 input + 0 output still floors at 1 nominal usertoken", async () => {
			const { client } = makeJsonClient({
				id: "x",
				choices: [{ message: { role: "assistant", content: "" } }],
				usage: { prompt_tokens: 0, completion_tokens: 0 },
			});
			const governed = await trust(client, { dryRun: true, budget: 1000, vaultBase: tmpVault });

			const result = await call(governed, {
				model: "qwen2.5:7b",
				messages: [{ role: "user", content: "hi" }],
			});
			expect(result.receipt.usageSource).toBe("provider");
			expect(result.receipt.cost).toBe(1);
			await destroy(governed);
		});

		it("A7+D5: negative/NaN non-stream usage clamps to 0 and settles as ESTIMATED", async () => {
			const { client } = makeJsonClient({
				id: "x",
				choices: [{ message: { role: "assistant", content: "hi" } }],
				usage: { prompt_tokens: -10, completion_tokens: Number.NaN },
			});
			const governed = await trust(client, { dryRun: true, budget: 1000, vaultBase: tmpVault });

			const result = await call(governed, {
				model: "qwen2.5:7b",
				messages: [{ role: "user", content: "hi" }],
			});
			// D5: neither counter is a usable provider count, so the clamped zeros are
			// FABRICATED and must not be published as provider-sourced. Previously this
			// settled "provider" at the floor; it now settles on the estimate and says
			// so. On a local endpoint both are 1 usertoken (rate {0,0} + the A11 floor),
			// so the money is unchanged here — only the honesty of the label.
			expect(result.receipt.usageSource).toBe("estimated");
			expect(result.receipt.cost).toBe(1);
			await destroy(governed);
		});

		it("A7: stream ending WITHOUT a usage tail despite injection settles on the estimate", async () => {
			const { client, createFn } = makeStreamClient(STREAM_CHUNKS_NO_USAGE);
			const governed = await trust(client, { dryRun: true, budget: 1000, vaultBase: tmpVault });

			const result = await call(governed, {
				model: "qwen2.5:7b",
				stream: true,
				messages: [{ role: "user", content: "hi" }],
			});
			const forwarded = createFn.mock.calls[0]?.[0] as Record<string, unknown>;
			expect(forwarded.stream_options).toEqual({ include_usage: true });

			const { receipt } = await consumeStream(result);
			expect(receipt.usageSource).toBe("estimated");
			expect(receipt.cost).toBe(1);
			await destroy(governed);
		});

		it("streamed local settlement uses server-truth usage against local.models rates", async () => {
			writeVaultConfig(tmpVault, {
				budget: 1000,
				local: { models: { "llama3.3*": { inputPer1k: 10, outputPer1k: 20 } } },
			});
			const { client } = makeStreamClient(STREAM_CHUNKS_WITH_USAGE);
			const governed = await trust(client, { dryRun: true, vaultBase: tmpVault });

			const result = await call(governed, {
				model: "llama3.3:70b",
				stream: true,
				messages: [{ role: "user", content: "hi" }],
			});

			// Pre-settlement (estimated) receipt already carries authorize-time scope (A3).
			expect(result.receipt.endpoint).toEqual({ class: "local", runtime: "ollama" });
			expect(result.receipt.meter).toMatchObject({
				costBasis: "nominal",
				rateSource: "local-model",
			});

			const { chunks, receipt } = await consumeStream(result);
			// The injected usage chunk is forwarded to the consumer unmodified.
			expect(chunks).toHaveLength(3);
			// (100/1000)*10 + (50/1000)*20 = 1 + 1 = 2
			expect(receipt.cost).toBe(2);
			expect(receipt.usageSource).toBe("provider");
			expect(receipt.endpoint).toEqual({ class: "local", runtime: "ollama" });
			expect(receipt.meter).toMatchObject({ costBasis: "nominal", rateSource: "local-model" });
			await destroy(governed);
		});

		it("cloud known-model receipt carries usd-proxy/table meter", async () => {
			const { client } = makeJsonClient(
				{
					id: "x",
					choices: [{ message: { role: "assistant", content: "hi" } }],
					usage: { prompt_tokens: 200, completion_tokens: 100 },
				},
				{ baseURL: null },
			);
			const governed = await trust(client, { dryRun: true, budget: 1000, vaultBase: tmpVault });

			const result = await call(governed, {
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			});
			expect(result.receipt.endpoint).toEqual({ class: "cloud", runtime: "unknown" });
			expect(result.receipt.meter).toMatchObject({ costBasis: "usd-proxy", rateSource: "table" });
			// (200/1000)*25 + (100/1000)*100 = 5 + 10 = 15
			expect(result.receipt.cost).toBe(15);
			await destroy(governed);
		});

		it("spoof defense: model 'gpt-4o' on a LOCAL endpoint still settles nominal", async () => {
			const { client } = makeJsonClient({
				id: "x",
				choices: [{ message: { role: "assistant", content: "hi" } }],
				usage: { prompt_tokens: 200, completion_tokens: 100 },
			});
			const governed = await trust(client, { dryRun: true, budget: 1000, vaultBase: tmpVault });

			const result = await call(governed, {
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			});
			// Endpoint class — not the model string — picks the settlement regime.
			expect(result.receipt.cost).toBe(1);
			expect(result.receipt.meter).toMatchObject({
				costBasis: "nominal",
				rateSource: "local-default",
			});
			await destroy(governed);
		});

		it("trust() opts.endpoint override wins over loopback autodetect", async () => {
			const { client } = makeJsonClient({
				id: "x",
				choices: [{ message: { role: "assistant", content: "hi" } }],
				usage: { prompt_tokens: 100, completion_tokens: 50 },
			});
			const governed = await trust(client, {
				dryRun: true,
				budget: 1000,
				vaultBase: tmpVault,
				endpoint: { class: "cloud" },
			});

			const result = await call(governed, {
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			});
			expect(result.receipt.endpoint).toEqual({ class: "cloud", runtime: "unknown" });
			expect(result.receipt.meter).toMatchObject({ costBasis: "usd-proxy", rateSource: "table" });
			await destroy(governed);
		});

		it("local rateClass amortized-usd flips costBasis to usd-proxy", async () => {
			writeVaultConfig(tmpVault, {
				budget: 1000,
				local: { rateClass: "amortized-usd", defaultRate: { inputPer1k: 1, outputPer1k: 2 } },
			});
			const { client } = makeJsonClient({
				id: "x",
				choices: [{ message: { role: "assistant", content: "hi" } }],
				usage: { prompt_tokens: 1000, completion_tokens: 500 },
			});
			const governed = await trust(client, { dryRun: true, vaultBase: tmpVault });

			const result = await call(governed, {
				model: "qwen2.5:7b",
				messages: [{ role: "user", content: "hi" }],
			});
			expect(result.receipt.meter).toMatchObject({
				costBasis: "usd-proxy",
				rateSource: "local-default",
			});
			// (1000/1000)*1 + (500/1000)*2 = 2
			expect(result.receipt.cost).toBe(2);
			await destroy(governed);
		});
	});
});
