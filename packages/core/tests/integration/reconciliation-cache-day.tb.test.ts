// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * THE RECONCILIATION SCENARIO, against a REAL TigerBeetle cluster (plan task 10,
 * step 2) — one attributed cache-heavy settle.
 *
 * `reconciliation-cache-day.test.ts` proves the record: the 1.14B-cache-read day
 * reprices exactly from its own receipts and chain events. It cannot prove that
 * the four-tier number reaches a real ledger, because its engines are injected.
 * This file closes that gap on the surface where it matters most — a
 * `withCostCenter` envelope, where a mis-metered settle silently leaves an
 * operator's cost center reporting headroom it does not have.
 *
 * The call is the same day, scaled 1:5000 so one call fits one envelope:
 *
 * | tier        | tokens  | rate/1k | usertokens |
 * |-------------|---------|---------|------------|
 * | cache read  | 228,000 |     3   |        684 |
 * | cache write |   8,000 |    37.5 |        300 |
 * | fresh input |     800 |    30   |         24 |
 * | output      |     800 |   150   |        120 |
 * | **four-tier** |       |         |  **1,128** |
 * | two-tier (pre-fix) |  |         |    **144** |
 *
 * Same 7.83x understatement as the full day, and the assertion here is on the
 * REAL envelope balance: the cluster must be down exactly 1,128 — not 144, and
 * not the reserved hold.
 *
 * **Hold sizing (D3) is load-bearing here and nowhere else in this pair.** A real
 * cluster REJECTS a post above its pending transfer, so `createTBEngine` caps at
 * the reserve and reports the gap; a hold that failed to cover a cache-writing
 * settle would come back capped, with a `settlement_shortfall` on the chain and
 * an under-debited envelope. The prompt below is therefore a REAL one of the size
 * a 228k-cache-read call actually sends (cached tokens are prompt tokens), so the
 * hold is the one a production caller would take, sized at
 * `max(inputPer1k, effectiveCacheWriteRate)` per D3.
 *
 * The suite self-skips (via `describe.skipIf`) when `USERTRUST_TB_ADDRESS` is
 * absent, exactly like its two siblings in this directory, so it collects into
 * the normal `test` job without failing it. Because it loads the real native
 * `tigerbeetle-node` binding at import time, everything cluster-touching lives
 * INSIDE the `it` body.
 *
 * SECURITY: assert individual fields; never snapshot a whole receipt payload.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLedgerEvents } from "../../src/audit/read.js";
import { allocateBudget, getBudgetStatus } from "../../src/budget/allocation.js";
import { withCostCenter } from "../../src/budget/attribution.js";
import { trust } from "../../src/govern.js";
import { TrustTBClient, XFER_PURCHASE } from "../../src/ledger/client.js";
import {
	costFromRates,
	effectiveCacheWriteRate,
	estimateInputTokens,
	getModelRates,
	PRICING_TABLE_VERSION,
} from "../../src/ledger/pricing.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import type { AppliedRates, ReceiptUsage, TrustReceipt } from "../../src/shared/types.js";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;

// ── Fixtures ──

const MODEL = "claude-sonnet-4-6";
const RATES = getModelRates(MODEL);
const MAX_TOKENS = 1024;

/** The day, scaled 1:5000 — see the header table. */
const USAGE: ReceiptUsage = {
	inputTokens: 800,
	outputTokens: 800,
	cacheReadTokens: 228_000,
	cacheWriteTokens: 8_000,
};

/** What the call must cost, and what the envelope must be down afterwards. */
const ACTUAL_COST = 1_128;
/** What the pre-fix two-tier code would have debited for the same call. */
const TWO_TIER_COST = 144;

/**
 * A REAL prompt of the size this call sends. Cached tokens are prompt tokens —
 * they are served from the cache rather than re-processed, but the caller still
 * puts them in the request — so a 228k-read call carries a ~237k-token prompt,
 * and that is what the hold has to be sized from. `estimateInputTokens` is
 * chars/4 with a 1.5x margin, so ~632k characters lands there.
 */
const PROMPT_CHARS = 632_000;
const MESSAGES = [{ role: "user", content: "x".repeat(PROMPT_CHARS) }];

/**
 * The EXACT hold `trust()` reserves for this call, reproduced from the same
 * exported pieces the production hold-sizing site uses (govern.ts: the estimated
 * INPUT leg prices at `max(inputPer1k, effectiveCacheWriteRate(rates))` per D3,
 * the output leg at the caller's cap). Written out rather than imported because
 * the hold-sizing expression is internal to the governor; the pieces are not.
 */
const HOLD = costFromRates(
	{ ...RATES, inputPer1k: Math.max(RATES.inputPer1k, effectiveCacheWriteRate(RATES)) },
	estimateInputTokens(MESSAGES),
	MAX_TOKENS,
);

/** The envelope holds exactly one hold's worth, as its sibling suites do. */
const ENVELOPE_ALLOCATED = HOLD;
const PARENT_FUND = ENVELOPE_ALLOCATED;
/** Irrelevant to every assertion — attributed calls never debit it. */
const SESSION_BUDGET = 10_000_000;

const COST_CENTER = "cache-heavy";

// ── Helpers ──

const vaults: string[] = [];

/** Write a tmp vault whose config points the engine at the live cluster. */
function makeVault(budget: number): string {
	const dir = join(tmpdir(), `tb-reconciliation-${randomUUID()}`);
	mkdirSync(join(dir, VAULT_DIR), { recursive: true });
	writeFileSync(
		join(dir, VAULT_DIR, "usertrust.config.json"),
		JSON.stringify({
			budget,
			// A 632k-character prompt is a synthetic filler string; scanning it on
			// every call buys this suite nothing and costs it seconds.
			pii: "off",
			tigerbeetle: { addresses: [TB_ADDRESS], clusterId: 0 },
		}),
	);
	vaults.push(dir);
	return dir;
}

/** The auditor's own arithmetic — never `costFromRates`, see the sibling file. */
function recomputeCost(usage: ReceiptUsage, rates: AppliedRates): number {
	const total =
		(usage.inputTokens * rates.inputPer1k) / 1000 +
		(usage.outputTokens * rates.outputPer1k) / 1000 +
		(usage.cacheReadTokens * rates.cacheReadPer1k) / 1000 +
		(usage.cacheWriteTokens * rates.cacheWritePer1k) / 1000;
	return Math.max(1, Math.ceil(total));
}

/** An Anthropic response carrying the disjoint four-tier usage. */
function cacheHeavyResponse(): Record<string, unknown> {
	return {
		id: `msg_${randomUUID()}`,
		type: "message",
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		model: MODEL,
		usage: {
			input_tokens: USAGE.inputTokens,
			output_tokens: USAGE.outputTokens,
			cache_read_input_tokens: USAGE.cacheReadTokens,
			cache_creation_input_tokens: USAGE.cacheWriteTokens,
		},
	};
}

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

describe.skipIf(!TB_ADDRESS)("real TigerBeetle — attributed cache-heavy settle", () => {
	it("debits the envelope the FOUR-TIER amount, with a D3-sized hold that never caps", async () => {
		// The fixture's premises, asserted rather than assumed — either one
		// silently turns this into a different test.
		expect(ACTUAL_COST).toBeGreaterThan(TWO_TIER_COST * 7);
		expect(HOLD).toBeGreaterThan(ACTUAL_COST);

		const PARENT = `reconciliation-tb-${randomUUID()}`;
		const tb = new TrustTBClient({ addresses: [TB_ADDRESS as string], clusterId: 0n });
		try {
			// ── Fund the parent and allocate the envelope, operator-style ──
			const treasury = await tb.createTreasury();
			const parentAccountId = await tb.createUserWallet(PARENT);
			await tb.immediateTransfer({
				debitAccountId: treasury,
				creditAccountId: parentAccountId,
				amount: PARENT_FUND,
				code: XFER_PURCHASE,
			});
			const allocation = await allocateBudget(tb, {
				parentUserId: PARENT,
				costCenter: COST_CENTER,
				amount: ENVELOPE_ALLOCATED,
			});
			expect(allocation.allocated).toBe(ENVELOPE_ALLOCATED);

			const vaultBase = makeVault(SESSION_BUDGET);
			const periodStartMs = Date.now();
			const create = vi.fn(async () => cacheHeavyResponse());
			const governed = await trust({ messages: { create } }, { vaultBase, parentUserId: PARENT });

			let receipt: TrustReceipt;
			try {
				({ receipt } = (await withCostCenter(
					COST_CENTER,
					() =>
						governed.messages.create({ model: MODEL, max_tokens: MAX_TOKENS, messages: MESSAGES }),
					{ allocated: ENVELOPE_ALLOCATED, periodStartMs },
				)) as { receipt: TrustReceipt });
			} finally {
				await governed.destroy();
			}

			expect(create).toHaveBeenCalledTimes(1);
			expect(receipt.settled).toBe(true);

			// ── The record reprices itself ──
			expect(receipt.usageSource).toBe("provider");
			expect(receipt.usage).toEqual(USAGE);
			const applied = receipt.meter?.appliedRates;
			if (applied === undefined) throw new Error("receipt carries no appliedRates");
			expect(applied).toEqual({
				inputPer1k: 30,
				outputPer1k: 150,
				cacheReadPer1k: 3,
				cacheWritePer1k: 37.5,
			});
			expect(receipt.meter?.pricingTableVersion).toBe(PRICING_TABLE_VERSION);
			expect(receipt.cost).toBe(ACTUAL_COST);
			expect(recomputeCost(USAGE, applied)).toBe(ACTUAL_COST);

			// ── Nothing was capped: the D3 hold covered a cache-WRITING settle ──
			// TigerBeetle rejects (never caps) a post above the pending transfer, so a
			// hold that did not cover this would have come back as a truncation with a
			// `settlement_shortfall` beside it.
			expect(receipt.postedCost).toBeUndefined();

			// ── THE ASSERTION: the real envelope is down the four-tier amount ──
			// This is the post-settle snapshot the ledger itself answered with.
			expect(receipt.budget).toEqual({
				costCenter: COST_CENTER,
				remaining: ENVELOPE_ALLOCATED - ACTUAL_COST,
				fraction: (ENVELOPE_ALLOCATED - ACTUAL_COST) / ENVELOPE_ALLOCATED,
			});

			// ...re-read through a FRESH connection that took no part in the session,
			// AFTER destroy() voided everything still pending. A settle that had been
			// capped, or a hold left stranded, reads differently here.
			const verifier = new TrustTBClient({ addresses: [TB_ADDRESS as string], clusterId: 0n });
			try {
				const status = await getBudgetStatus(verifier, {
					parentUserId: PARENT,
					costCenter: COST_CENTER,
					allocated: ENVELOPE_ALLOCATED,
					periodStartMs,
				});
				expect(status.balance).toBe(ENVELOPE_ALLOCATED - ACTUAL_COST);
				expect(status.runway.remaining).toBe(ENVELOPE_ALLOCATED - ACTUAL_COST);
				// The killed bug, stated against the real ledger: the two-tier code
				// would have left this envelope reporting 984 usertokens of headroom
				// it had already spent.
				expect(status.balance).not.toBe(ENVELOPE_ALLOCATED - TWO_TIER_COST);
				expect(ENVELOPE_ALLOCATED - TWO_TIER_COST - status.balance).toBe(
					ACTUAL_COST - TWO_TIER_COST,
				);
			} finally {
				verifier.destroy();
			}

			// ── The durable chain agrees, and records no truncation ──
			const events = readLedgerEvents(join(vaultBase, VAULT_DIR));
			expect(events.filter((e) => e.kind === "settlement_shortfall")).toHaveLength(0);
			expect(events.filter((e) => e.kind === "settlement_ambiguous")).toHaveLength(0);
			const llmCalls = events.filter((e) => e.kind === "llm_call");
			expect(llmCalls).toHaveLength(1);
			const data = llmCalls[0]?.data as Record<string, unknown>;
			expect(data.costCenter).toBe(COST_CENTER);
			expect(data.cost).toBe(ACTUAL_COST);
			expect(data.usage).toEqual(USAGE);
			expect(recomputeCost(data.usage as ReceiptUsage, data.appliedRates as AppliedRates)).toBe(
				ACTUAL_COST,
			);
		} finally {
			tb.destroy();
		}
	});
});
