// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Spec D3 — hold sizing gains the write-premium guard.
 *
 * "Cold-cache worst case" was false for write premiums: a 1.25x (or
 * operator-set 2x) cache-write rate systematically exceeds an input-priced
 * hold. Fix: estimated input is reserved at
 * `max(inputPer1k, effective cacheWritePer1k)` at every hold-sizing site
 * (govern estimate, headless estimate) — never touching the settle-time
 * ACTUAL cost math, which already prices real cache tokens at their own
 * resolved rates (Task 3).
 *
 * `effectiveCacheWriteRate` (ledger/pricing.ts) is the ONE place the D1 `??`
 * chain is read for this purpose; these tests exercise it only through the
 * public hold-sizing behaviour, never by re-deriving the chain by hand.
 *
 * Five things pinned here:
 *  1. A model with no cache rates holds EXACTLY as before (regression pin) —
 *     at both hold-sizing sites (govern.ts, headless.ts).
 *  2. claude-sonnet-4-6 (37.5 write vs 30 input) holds ~1.25x fatter on the
 *     input half — at both sites.
 *  3. The interaction pin: a cold-cache actual (all of the reserved input
 *     tokens turn out to be cache-WRITE tokens) would have exceeded the
 *     PRE-FIX (input-only-priced) hold — asserted directly via `costFromRates`
 *     using the unmodified rates, which is exactly the pre-fix arithmetic —
 *     and fits under the fixed hold.
 *  4. A capped-settle case with a deliberately-overridden 2x `customRates`
 *     write premium still lands in the `settlement_shortfall` machinery
 *     (truncated post + audited shortfall + the TRUE higher `receipt.cost`)
 *     rather than silently under-debiting when the actual STILL outruns the
 *     (now fatter) hold.
 *
 * SECURITY: never log or snapshot a whole PolicyContext/receipt payload —
 * assert on individual fields, as the sibling suites do.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import {
	costFromRates,
	effectiveCacheWriteRate,
	estimateInputTokens,
	getModelRates,
	type ModelRates,
} from "../../src/ledger/pricing.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import type { AuditEvent, TrustReceipt } from "../../src/shared/types.js";

// tigerbeetle-node is a native module and is never loaded in unit tests.
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

// ── Shared fixtures ──

function makeTmpVault(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeConfig(vaultBase: string, config: Record<string, unknown>): void {
	const dir = join(vaultBase, VAULT_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "usertrust.config.json"), JSON.stringify(config));
}

function makeMockAudit(): AuditWriter & { events: AppendEventInput[] } {
	const events: AppendEventInput[] = [];
	return {
		events,
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
			events.push(input);
			return {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "a".repeat(64),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			};
		}),
		getWriteFailures: vi.fn(() => 0),
		isDegraded: vi.fn(() => false),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
	};
}

interface EngineHandle extends TrustEngine {
	spendPending: ReturnType<typeof vi.fn>;
	postPendingSpend: ReturnType<typeof vi.fn>;
	voidPendingSpend: ReturnType<typeof vi.fn>;
}

/**
 * Models real TigerBeetle: `postPendingSpend` CAPS the post at whatever
 * `amount` the matching `spendPending` reserved, and reports the truncation
 * back as `{ posted, shortfall }` — exactly the shape `trust()`'s
 * `settlement_shortfall` wiring (Task 3/a55b4fd) already consumes. This lets
 * the interaction and capped-settle tests observe the REAL hold amount that
 * was reserved, not a value the test asserts blind.
 */
function makeCappingEngine(): EngineHandle {
	const reserved = new Map<string, number>();
	return {
		spendPending: vi.fn(async (p: { transferId: string; amount: number }) => {
			reserved.set(p.transferId, p.amount);
			return { transferId: p.transferId };
		}),
		postPendingSpend: vi.fn(async (transferId: string, actualAmount?: number) => {
			const cap = reserved.get(transferId) ?? 0;
			const actual = actualAmount ?? cap;
			const posted = Math.min(actual, cap);
			return { posted, shortfall: actual - posted };
		}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
}

/** An Anthropic-shaped mock whose `usage` the test controls per call. */
function makeAnthropicMock(usage: Record<string, unknown>) {
	return {
		messages: {
			create: vi.fn(async () => ({
				id: "msg_1",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				model: "claude-sonnet-4-6",
				usage,
			})),
		},
	};
}

function shortfallEvents(audit: { events: AppendEventInput[] }): AppendEventInput[] {
	return audit.events.filter((e) => e.kind === "settlement_shortfall");
}

// ── Pure export: effectiveCacheWriteRate ──

describe("effectiveCacheWriteRate", () => {
	it("resolves to the published cache-write rate when present", () => {
		const rates = getModelRates("claude-sonnet-4-6");
		expect(effectiveCacheWriteRate(rates)).toBe(37.5);
	});

	it("falls back to inputPer1k when cacheWritePer1k is absent", () => {
		const rates = getModelRates("mistral-large");
		expect(rates.cacheWritePer1k).toBeUndefined();
		expect(effectiveCacheWriteRate(rates)).toBe(rates.inputPer1k);
	});

	it("honours an explicit 0 (a self-hosted operator override), same as costFromRates", () => {
		const rates: ModelRates = { inputPer1k: 10, outputPer1k: 20, cacheWritePer1k: 0 };
		expect(effectiveCacheWriteRate(rates)).toBe(0);
	});
});

// ── headless.ts hold-sizing site (~816-818) ──

describe("headless authorize() hold sizing (spec D3)", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = makeTmpVault("hold-sizing-headless");
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("regression pin: a model with no cache rates holds exactly as before", async () => {
		const governor = await createGovernor({ budget: 1_000_000, vaultBase: tmpVault, dryRun: true });
		const rates = getModelRates("mistral-large");
		expect(rates.cacheReadPer1k).toBeUndefined();
		expect(rates.cacheWritePer1k).toBeUndefined();

		const auth = await governor.authorize({
			model: "mistral-large",
			estimatedInputTokens: 1000,
			maxOutputTokens: 500,
		});

		// Unaffected by D3: max(inputPer1k, inputPer1k) === inputPer1k.
		expect(auth.estimatedCost).toBe(costFromRates(rates, 1000, 500));

		await governor.destroy();
	});

	it("write-premium guard: claude-sonnet-4-6 holds 1.25x fatter on the input half", async () => {
		const governor = await createGovernor({ budget: 1_000_000, vaultBase: tmpVault, dryRun: true });
		const rates = getModelRates("claude-sonnet-4-6");
		expect(rates.inputPer1k).toBe(30);
		expect(rates.cacheWritePer1k).toBe(37.5);

		const auth = await governor.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 1000,
			maxOutputTokens: 500,
		});

		const preFixHold = costFromRates(rates, 1000, 500);
		const holdRate = Math.max(rates.inputPer1k, effectiveCacheWriteRate(rates));
		const expectedHold = costFromRates({ ...rates, inputPer1k: holdRate }, 1000, 500);

		expect(auth.estimatedCost).toBe(expectedHold);
		expect(auth.estimatedCost).toBeGreaterThan(preFixHold);

		await governor.destroy();
	});
});

// ── govern.ts hold-sizing site (~915-919) ──

describe("govern trust() hold sizing (spec D3)", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = makeTmpVault("hold-sizing-govern");
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("regression pin: a model with no cache rates holds exactly as before", async () => {
		const engine = makeCappingEngine();
		const governed = await trust(makeAnthropicMock({ input_tokens: 10, output_tokens: 5 }), {
			budget: 1_000_000,
			vaultBase: tmpVault,
			_engine: engine,
		});

		await governed.messages.create({
			model: "mistral-large",
			max_tokens: 64,
			messages: [{ role: "user", content: "hello" }],
		});

		const rates = getModelRates("mistral-large");
		const promptParts = [{ role: "user", content: "hello" }];
		const estInput = estimateInputTokens(promptParts);
		const expectedHold = costFromRates(rates, estInput, 64);

		expect(engine.spendPending).toHaveBeenCalledTimes(1);
		const call = engine.spendPending.mock.calls[0]?.[0] as { amount: number };
		expect(call.amount).toBe(expectedHold);

		await governed.destroy();
	});

	it("write-premium guard: claude-sonnet-4-6 holds 1.25x fatter on the input half", async () => {
		const engine = makeCappingEngine();
		const governed = await trust(makeAnthropicMock({ input_tokens: 10, output_tokens: 5 }), {
			budget: 1_000_000,
			vaultBase: tmpVault,
			_engine: engine,
		});

		// A long message + a tiny max_tokens keeps the OUTPUT half of the hold
		// negligible, so the 1.25x change to the input half survives the ceil.
		const messages = [{ role: "user", content: "x".repeat(2000) }];
		await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1,
			messages,
		});

		const rates = getModelRates("claude-sonnet-4-6");
		const estInput = estimateInputTokens(messages);
		const preFixHold = costFromRates(rates, estInput, 1);
		const holdRate = Math.max(rates.inputPer1k, effectiveCacheWriteRate(rates));
		const expectedHold = costFromRates({ ...rates, inputPer1k: holdRate }, estInput, 1);

		expect(engine.spendPending).toHaveBeenCalledTimes(1);
		const call = engine.spendPending.mock.calls[0]?.[0] as { amount: number };
		expect(call.amount).toBe(expectedHold);
		expect(call.amount).toBeGreaterThan(preFixHold);

		await governed.destroy();
	});

	it("interaction pin: a cold-cache-write actual exceeds the pre-fix hold but fits the fixed one", async () => {
		const engine = makeCappingEngine();
		// A single long message keeps max_tokens tiny (1) so the OUTPUT half of the
		// hold barely moves — the whole point is isolating the INPUT-rate change.
		const messages = [{ role: "user", content: "x".repeat(2000) }];
		const estInput = estimateInputTokens(messages);
		const maxOutputTokens = 1;
		const rates = getModelRates("claude-sonnet-4-6");

		// THE PRE-FIX ARITHMETIC: this is exactly what the OLD hold-sizing call
		// computed — `costFromRates` unmodified, priced at plain `inputPer1k`.
		const preFixHold = costFromRates(rates, estInput, maxOutputTokens);

		// The actual: the ENTIRE estimated-input reservation turns out, at
		// settle time, to have been a cache WRITE (cold-cache worst case) — zero
		// fresh input, zero output, `estInput` cache-write tokens at 37.5/1k.
		const actualCost = costFromRates(rates, 0, 0, 0, estInput);

		// Pin the bug this task exists to fix: the pre-fix hold would have been
		// exceeded by this actual.
		expect(preFixHold).toBeLessThan(actualCost);

		const governed = await trust(
			makeAnthropicMock({
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_input_tokens: estInput,
			}),
			{ budget: 1_000_000, vaultBase: tmpVault, _engine: engine },
		);

		const { receipt } = (await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: maxOutputTokens,
			messages,
		})) as { receipt: TrustReceipt };

		const reservedAmount = engine.spendPending.mock.calls[0]?.[0]?.amount as number;
		expect(reservedAmount).toBeGreaterThan(preFixHold);
		expect(reservedAmount).toBeGreaterThanOrEqual(actualCost);

		// No truncation: the fixed hold covered the actual, so no shortfall.
		expect(receipt.cost).toBe(actualCost);
		expect(Object.hasOwn(receipt, "postedCost")).toBe(false);

		await governed.destroy();
	});

	it("capped-settle: a 2x customRates write premium still reports the shortfall, never silently under-debits", async () => {
		const MODEL = "hold-sizing-2x-test-model";
		const customRates: ModelRates = { inputPer1k: 10, outputPer1k: 50, cacheWritePer1k: 20 };
		writeConfig(tmpVault, {
			budget: 1_000_000,
			pricing: "custom",
			customRates: { [MODEL]: customRates },
		});

		const engine = makeCappingEngine();
		const audit = makeMockAudit();
		const messages = [{ role: "user", content: "x".repeat(400) }];
		const estInput = estimateInputTokens(messages);
		const maxOutputTokens = 1;

		// The hold IS write-premium-aware (2x, per the overridden rate) — but it
		// is still sized off the ESTIMATE, not off whatever actually happens.
		const holdRate = Math.max(customRates.inputPer1k, effectiveCacheWriteRate(customRates));
		const expectedHold = costFromRates(
			{ ...customRates, inputPer1k: holdRate },
			estInput,
			maxOutputTokens,
		);

		// The actual overruns even the fattened hold: far more cache-write
		// tokens land than were ever estimated as input.
		const overrunCacheWrite = estInput * 5;
		const actualCost = costFromRates(customRates, 0, 0, 0, overrunCacheWrite);
		expect(actualCost).toBeGreaterThan(expectedHold);

		const governed = await trust(
			makeAnthropicMock({
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_input_tokens: overrunCacheWrite,
			}),
			{ budget: 1_000_000, vaultBase: tmpVault, _engine: engine, _audit: audit },
		);

		const { receipt } = (await governed.messages.create({
			model: MODEL,
			max_tokens: maxOutputTokens,
			messages,
		})) as { receipt: TrustReceipt };

		const reservedAmount = engine.spendPending.mock.calls[0]?.[0]?.amount as number;
		expect(reservedAmount).toBe(expectedHold);

		// The TRUE metered cost — priced at the full 2x override — is preserved,
		// never silently discounted to the hold or to inputPer1k.
		expect(receipt.cost).toBe(actualCost);
		expect(receipt.cost).toBeGreaterThan(reservedAmount);
		// The ledger side is truncated at the hold, and the gap is AUDITED, not
		// swallowed.
		expect(receipt.postedCost).toBe(reservedAmount);

		const events = shortfallEvents(audit);
		expect(events).toHaveLength(1);
		expect(events[0]?.data).toMatchObject({
			model: MODEL,
			actual: actualCost,
			posted: reservedAmount,
			shortfall: actualCost - reservedAmount,
		});

		await governed.destroy();
	});
});
