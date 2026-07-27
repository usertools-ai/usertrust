// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Real-TigerBeetle two-phase hard-budget integration test.
 *
 * Every OTHER ledger test in this repo mocks `tigerbeetle-node` at the module
 * level — even the stateful double-entry fake in
 * `tests/harden/ledger-funded-wallet.test.ts` only SIMULATES
 * `debits_must_not_exceed_credits`. This file proves the same invariant against a
 * REAL, running TigerBeetle cluster: it does NOT mock the native client and it
 * does NOT use dryRun, so `trust()` builds an actual `createTBEngine` that opens a
 * funded, balance-enforcing wallet on the live cluster.
 *
 * The suite self-skips (via `describe.skipIf`) whenever `USERTRUST_TB_ADDRESS` is
 * absent. The root vitest `include` glob (`packages/*​/tests/**​/*.test.ts`)
 * auto-collects this file into the normal `test` job, so the skip is what keeps
 * that job green without a cluster. Green-against-real-TB is proven by the
 * dedicated `tb-integration` CI job, which exports `USERTRUST_TB_ADDRESS`.
 *
 * NOTE: because this file loads the real native `tigerbeetle-node` binding at
 * import time, all cluster-touching code lives INSIDE `it` bodies — which never
 * run when the suite is skipped. Only pure pricing math executes at collection.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trust } from "../../src/govern.js";
import { estimateCost, estimateInputTokens } from "../../src/ledger/pricing.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { InsufficientBalanceError, PolicyDeniedError } from "../../src/shared/errors.js";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;

/** A correct hard budget stop — pre-spend policy denial or the ledger's atomic rejection. */
const isHardDenial = (err: unknown): boolean =>
	err instanceof InsufficientBalanceError || err instanceof PolicyDeniedError;

// ── Fixtures ──
// A single, fixed call shape so budgets can be sized to the exact PENDING hold.
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024;
const MESSAGES = [{ role: "user", content: "Summarize two-phase commit in one line." }];

// The EXACT hold the governor reserves for this call: cloud sonnet rates against
// the max_tokens ceiling, derived from the same pricing helpers govern.ts uses
// (`resolveRates`→`getModelRates` on the recommended table == `estimateCost`).
// Seeding a funded wallet with exactly this value drives it to the boundary where
// one hold fits and a second cannot.
const HOLD = estimateCost(MODEL, estimateInputTokens(MESSAGES), MAX_TOKENS);

// Provider-reported usage → a SETTLED cost strictly below the reserved hold, so a
// settle permanently frees less than a full hold on the real ledger.
const USAGE = { input_tokens: 100, output_tokens: 50 };
const ACTUAL_COST = estimateCost(MODEL, USAGE.input_tokens, USAGE.output_tokens);

// ── Helpers ──

const vaults: string[] = [];

/** Write a tmp vault whose config points the engine at the live cluster. */
function makeVault(budget: number): string {
	const dir = join(tmpdir(), `tb-integration-${randomUUID()}`);
	mkdirSync(join(dir, VAULT_DIR), { recursive: true });
	writeFileSync(
		join(dir, VAULT_DIR, "usertrust.config.json"),
		JSON.stringify({
			budget,
			// `addresses`/`clusterId` are the exact TrustTBClient config keys (ledger/client.ts).
			tigerbeetle: { addresses: [TB_ADDRESS], clusterId: 0 },
		}),
	);
	vaults.push(dir);
	return dir;
}

/** An Anthropic-shaped client whose `messages.create` is the given spy. */
function anthropicClient(create: (...args: unknown[]) => unknown): Record<string, unknown> {
	return { messages: { create } };
}

/** A successful non-stream Anthropic response carrying provider usage. */
function okResponse(): Record<string, unknown> {
	return {
		id: `msg_${randomUUID()}`,
		type: "message",
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		model: MODEL,
		usage: { ...USAGE },
	};
}

const CALL = { model: MODEL, max_tokens: MAX_TOKENS, messages: MESSAGES } as const;

afterEach(() => {
	for (const dir of vaults.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
});

// ── Suite (self-skips with no live cluster) ──

describe.skipIf(!TB_ADDRESS)("real TigerBeetle — two-phase hard-budget invariant", () => {
	it("settles an in-budget call at reported usage and decrements the ledger monotonically", async () => {
		const create = vi.fn(async () => okResponse());
		const governed = await trust(anthropicClient(create), { vaultBase: makeVault(50_000) });
		try {
			const r1 = await governed.messages.create({ ...CALL });
			const r2 = await governed.messages.create({ ...CALL });

			// (a) The hold was POSTed at the provider-reported actual cost on the real ledger.
			expect(r1.receipt.settled).toBe(true);
			expect(r1.receipt.usageSource).toBe("provider");
			expect(r1.receipt.cost).toBe(ACTUAL_COST);
			expect(r1.receipt.budgetRemaining).toBe(50_000 - ACTUAL_COST);

			// A second real settlement decrements again — the ledger tracks cumulative spend.
			expect(r2.receipt.settled).toBe(true);
			expect(r2.receipt.budgetRemaining).toBe(50_000 - 2 * ACTUAL_COST);
			expect(r2.receipt.budgetRemaining).toBeLessThan(r1.receipt.budgetRemaining);

			expect(create).toHaveBeenCalledTimes(2);
		} finally {
			await governed.destroy();
		}
	});

	it("hard-refuses a sequential over-budget call pre-spend and keeps the real ledger consistent", async () => {
		// The funded wallet holds EXACTLY one reservation. Call 1 settles at its
		// (smaller) actual cost, leaving real remaining = HOLD - ACTUAL_COST, which is
		// below a full hold. Call 2's hold no longer fits, so it is hard-refused
		// BEFORE the provider is ever called. NOTE: for a SEQUENTIAL over-budget call
		// the pre-spend policy gate (block-budget-overshoot, a non-disable-able default
		// rule) denies first — that is correct defense-in-depth. The atomic ledger
		// (debits_must_not_exceed_credits) is the backstop for what per-call policy
		// cannot catch: concurrent/cross-process holds — proven in the next test.
		const create = vi.fn(async () => okResponse());
		const governed = await trust(anthropicClient(create), { vaultBase: makeVault(HOLD) });
		try {
			const r1 = await governed.messages.create({ ...CALL });
			expect(r1.receipt.settled).toBe(true);
			expect(r1.receipt.cost).toBeLessThan(HOLD);
			// The REAL ledger tracked the settle to the exact usertoken.
			expect(r1.receipt.budgetRemaining).toBe(HOLD - ACTUAL_COST);
			expect(create).toHaveBeenCalledTimes(1);

			// Hard governance refusal — pre-spend policy denial or the ledger's atomic
			// rejection; either is a correct hard stop. What matters: money never moved.
			const denied = await governed.messages.create({ ...CALL }).then(
				() => null,
				(e: unknown) => e,
			);
			expect(denied).not.toBeNull();
			expect(isHardDenial(denied)).toBe(true);
			expect(create).toHaveBeenCalledTimes(1);
		} finally {
			await governed.destroy();
		}
	});

	it("bounds total spend under concurrent holds — the atomic-ledger ceiling", async () => {
		// The scenario only the real ledger can enforce: N calls authorized
		// concurrently, each individually within budget, collectively far over it.
		// Per-call policy evaluated across interleaved holds cannot guarantee the
		// ceiling on its own; TigerBeetle's debits_must_not_exceed_credits does,
		// atomically. We assert the INVARIANT (bounded, never exceeded) rather than
		// which specific calls win — so the test is deterministic, not flaky.
		const CAPACITY = 2; // exactly two holds fit
		const create = vi.fn(async () => okResponse());
		const governed = await trust(anthropicClient(create), {
			vaultBase: makeVault(HOLD * CAPACITY),
		});
		try {
			const results = await Promise.allSettled(
				Array.from({ length: 5 }, () => governed.messages.create({ ...CALL })),
			);
			const settled = results.filter((r) => r.status === "fulfilled");
			const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

			// Ceiling held: no more than CAPACITY calls ever reached the provider or
			// settled, and every rejection is a hard governance denial.
			expect(create.mock.calls.length).toBeLessThanOrEqual(CAPACITY);
			expect(settled.length).toBeLessThanOrEqual(CAPACITY);
			expect(rejected.length).toBeGreaterThanOrEqual(5 - CAPACITY);
			for (const r of rejected) expect(isHardDenial(r.reason)).toBe(true);

			// Total settled cost never exceeded the funded budget on the real ledger.
			const totalSettled = settled.reduce(
				(sum, r) => sum + (r.value as { receipt: { cost: number } }).receipt.cost,
				0,
			);
			expect(totalSettled).toBeLessThanOrEqual(HOLD * CAPACITY);
		} finally {
			await governed.destroy();
		}
	});

	it("voids the pending hold and restores the balance when a call aborts", async () => {
		// The funded wallet holds EXACTLY one reservation. If the aborted call's hold
		// were NOT voided it would pin the whole budget and the follow-up hold would
		// be rejected. The follow-up settling proves the abort released the hold on
		// the real ledger and restored the balance.
		const boom = new Error("provider aborted mid-call");
		const create = vi.fn().mockRejectedValueOnce(boom).mockResolvedValue(okResponse());
		const governed = await trust(anthropicClient(create), { vaultBase: makeVault(HOLD) });
		try {
			await expect(governed.messages.create({ ...CALL })).rejects.toBe(boom);

			// (c) The restored budget lets an identical follow-up call succeed and settle.
			const r = await governed.messages.create({ ...CALL });
			expect(r.receipt.settled).toBe(true);
			expect(r.receipt.cost).toBe(ACTUAL_COST);
			expect(create).toHaveBeenCalledTimes(2);
		} finally {
			await governed.destroy();
		}
	});
});
