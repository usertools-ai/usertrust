// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Real-TigerBeetle cost-center envelope spend cycle.
 *
 * `tigerbeetle.tb.test.ts` proves the session-wallet two-phase hold against a real
 * cluster; this file proves the SAME invariant for an attributed spend — a governed
 * call made inside a `withCostCenter(cc, fn)` scope debits the `(parent, costCenter)`
 * envelope wallet, not the session holding wallet, and every read surface
 * (`getBudgetStatus`, `budgetContext`, `receipt.budget`) reports the real ledger
 * balance rather than the `spent: 0` gap `budget/allocation.ts`'s module doc names.
 *
 * Like its sibling, this does NOT mock `tigerbeetle-node` and does NOT use dryRun —
 * `trust()` builds a real `createTBEngine` against a live cluster, and the setup
 * steps (fund the parent, `allocateBudget`) run through a second, directly
 * constructed `TrustTBClient` pointed at the same cluster, exactly as an operator's
 * own allocation tooling would.
 *
 * The suite self-skips (via `describe.skipIf`) whenever `USERTRUST_TB_ADDRESS` is
 * absent, so it auto-collects into the normal `test` job without failing it, and is
 * proven green against a real cluster only by the dedicated `tb-integration` CI job.
 *
 * NOTE: because this file loads the real native `tigerbeetle-node` binding at import
 * time, all cluster-touching code lives INSIDE the `it` body — which never runs when
 * the suite is skipped. Only pure pricing math executes at collection.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLedgerEvents } from "../../src/audit/read.js";
import { allocateBudget, getBudgetStatus, reclaimBudget } from "../../src/budget/allocation.js";
import { withCostCenter } from "../../src/budget/attribution.js";
import { budgetContext } from "../../src/budget/context.js";
import { trust } from "../../src/govern.js";
import { TrustTBClient, XFER_PURCHASE } from "../../src/ledger/client.js";
import { estimateCost, estimateInputTokens } from "../../src/ledger/pricing.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { InsufficientBalanceError, PolicyDeniedError } from "../../src/shared/errors.js";
import type { TrustReceipt } from "../../src/shared/types.js";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;

/**
 * A correct hard envelope stop — pre-spend policy denial or the ledger's atomic
 * rejection. Per A7, a SEQUENTIAL over-envelope call is denied at the policy gate
 * (`block-budget-overshoot`, the non-disableable pre-spend hard rule, firing on an
 * unfloored negative `budget_remaining_after`) before any hold reaches the engine —
 * the ledger's own `InsufficientBalanceError` is the backstop for what per-call
 * policy cannot catch (concurrent/cross-process holds), the same division of labor
 * `tigerbeetle.tb.test.ts` documents for the session wallet. This predicate — copied
 * from that file's own `isHardDenial` — accepts either, which is the conservative
 * reading of this task's literal "rejected by the ledger (`InsufficientBalanceError`)"
 * wording: the actual denial for a sequential call is `PolicyDeniedError`, pinned by
 * `tests/govern/envelope-threading.test.ts`'s "denies an over-envelope call at the
 * gate, BEFORE any hold" test (A7's correction post-dates this task's original
 * description). Recorded here rather than narrowed to one class, so this test keeps
 * proving the money invariant that matters — nothing moved — instead of an
 * implementation detail of which layer caught it.
 */
const isHardDenial = (err: unknown): boolean =>
	err instanceof InsufficientBalanceError || err instanceof PolicyDeniedError;

// ── Fixtures ──
// A single, fixed call shape so the envelope can be sized to the exact PENDING hold —
// same technique and same rates as tigerbeetle.tb.test.ts.
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024;
const MESSAGES = [{ role: "user", content: "Summarize two-phase commit in one line." }];

// The EXACT hold the governor reserves for this call against the envelope.
const HOLD = estimateCost(MODEL, estimateInputTokens(MESSAGES), MAX_TOKENS);

// Provider-reported usage → a SETTLED cost strictly below the reserved hold, so the
// envelope has real, nonzero headroom left after one settle and the second identical
// call's fresh HOLD-sized reservation no longer fits.
const USAGE = { input_tokens: 100, output_tokens: 50 };
const ACTUAL_COST = estimateCost(MODEL, USAGE.input_tokens, USAGE.output_tokens);

// Provider-reported usage → a SETTLED cost strictly ABOVE the reserved hold: the
// input side of the estimate is a chars/4×1.5 heuristic, so real usage can price
// above it (spec: settle-shortfall hardening). The settle must cap at HOLD, keep
// settled:true, and audit the shortfall — never strand the hold or void real spend.
const USAGE_OVER = { input_tokens: 5000, output_tokens: 1024 };
const ACTUAL_OVER = estimateCost(MODEL, USAGE_OVER.input_tokens, USAGE_OVER.output_tokens);

// The envelope is funded with exactly one hold's worth — the same boundary
// tigerbeetle.tb.test.ts's sequential-over-budget test uses, applied to the
// cost-center wallet instead of the session wallet.
const ENVELOPE_ALLOCATED = HOLD;
// The parent wallet is funded with exactly what it delegates — nothing left over
// after allocateBudget, which doubles as the budgetContext parent-balance check.
const PARENT_FUND = ENVELOPE_ALLOCATED;
// The session holding wallet an attributed call never debits — present only because
// TrustConfigSchema.budget is required. Its size is irrelevant to every assertion.
const SESSION_BUDGET = 1_000_000;

const COST_CENTER = "research";
// A cost center of its own for the overrun case: `(parent, costCenter)` IS the
// envelope's account id, and both tests may run against one long-lived cluster.
const COST_CENTER_OVER = "research-overrun";

// ── Helpers ──

const vaults: string[] = [];

/** Write a tmp vault whose config points the engine at the live cluster. */
function makeVault(budget: number): string {
	const dir = join(tmpdir(), `tb-envelope-${randomUUID()}`);
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

/** The same response, reporting the usage that prices ABOVE the reserved hold. */
function overResponse(): Record<string, unknown> {
	return { ...okResponse(), usage: { ...USAGE_OVER } };
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

describe.skipIf(!TB_ADDRESS)("real TigerBeetle — cost-center envelope spend cycle", () => {
	it(
		"funds a parent, allocates an envelope, spends it via withCostCenter, reports " +
			"real spend on both getBudgetStatus and budgetContext, hard-refuses an " +
			"over-envelope hold, and reclaims the remainder",
		async () => {
			// A fresh parent id per test run — this file's own setup client, not the
			// governed one, funds and allocates through it, exactly as an operator's
			// allocation tooling would against the live cluster.
			const PARENT = `envelope-tb-${randomUUID()}`;

			const tb = new TrustTBClient({ addresses: [TB_ADDRESS as string], clusterId: 0n });
			try {
				// ── Fund parent ──
				const treasury = await tb.createTreasury();
				const parentAccountId = await tb.createUserWallet(PARENT);
				await tb.immediateTransfer({
					debitAccountId: treasury,
					creditAccountId: parentAccountId,
					amount: PARENT_FUND,
					code: XFER_PURCHASE,
				});

				// ── allocateBudget ──
				const allocation = await allocateBudget(tb, {
					parentUserId: PARENT,
					costCenter: COST_CENTER,
					amount: ENVELOPE_ALLOCATED,
				});
				expect(allocation.allocated).toBe(ENVELOPE_ALLOCATED);

				const create = vi.fn(async () => okResponse());
				const governed = await trust(anthropicClient(create), {
					vaultBase: makeVault(SESSION_BUDGET),
					parentUserId: PARENT,
				});
				try {
					const periodStartMs = Date.now();
					const scopeOpts = { allocated: ENVELOPE_ALLOCATED, periodStartMs };

					// ── withCostCenter authorize+settle against the real envelope ──
					const r1 = (await withCostCenter(
						COST_CENTER,
						() => governed.messages.create({ ...CALL }),
						scopeOpts,
					)) as { receipt: { settled: boolean; cost: number; budget?: unknown } };

					expect(r1.receipt.settled).toBe(true);
					expect(r1.receipt.cost).toBe(ACTUAL_COST);
					// D7: the post-settle envelope snapshot on the settled receipt — this IS
					// the real ledger's own read, not an in-process estimate.
					expect(r1.receipt.budget).toEqual({
						costCenter: COST_CENTER,
						remaining: ENVELOPE_ALLOCATED - ACTUAL_COST,
						fraction: (ENVELOPE_ALLOCATED - ACTUAL_COST) / ENVELOPE_ALLOCATED,
					});
					expect(create).toHaveBeenCalledTimes(1);

					// ── getBudgetStatus shows real spent ──
					// The exact gap AGENTS.md's "Known drift" section names as closed by this
					// feature: an agent that spends inside a scope no longer reports spent: 0.
					const status = await getBudgetStatus(tb, {
						parentUserId: PARENT,
						costCenter: COST_CENTER,
						allocated: ENVELOPE_ALLOCATED,
						periodStartMs,
					});
					expect(status.balance).toBe(ENVELOPE_ALLOCATED - ACTUAL_COST);
					expect(status.runway.remaining).toBe(ENVELOPE_ALLOCATED - ACTUAL_COST);

					// ── budgetContext shows the same real spent, one round trip ──
					const ctx = await budgetContext(tb, PARENT, [
						{ costCenter: COST_CENTER, allocated: ENVELOPE_ALLOCATED, periodStartMs },
					]);
					expect(ctx.envelopes).toHaveLength(1);
					expect(ctx.envelopes[0]?.spent).toBe(ACTUAL_COST);
					expect(ctx.envelopes[0]?.remaining).toBe(ENVELOPE_ALLOCATED - ACTUAL_COST);
					// The parent gave away its entire balance in one allocateBudget call, so
					// its own remaining reads 0 — the same round trip proves the parent side
					// of `budgetContext` too.
					expect(ctx.parent.remaining).toBe(0);

					// ── Over-envelope hold rejected ──
					// A second identical call needs a fresh HOLD-sized reservation; the
					// envelope holds only (HOLD - ACTUAL_COST), strictly less. Hard-refused
					// pre-spend — see isHardDenial's doc comment for which layer denies it.
					const denied = await withCostCenter(
						COST_CENTER,
						() => governed.messages.create({ ...CALL }),
						scopeOpts,
					).then(
						() => null,
						(e: unknown) => e,
					);
					expect(denied).not.toBeNull();
					expect(isHardDenial(denied)).toBe(true);
					// The provider was never reached for the denied call — still exactly 1.
					expect(create).toHaveBeenCalledTimes(1);

					// The denial moved nothing: the real ledger balance is unchanged.
					const statusAfterDenial = await getBudgetStatus(tb, {
						parentUserId: PARENT,
						costCenter: COST_CENTER,
						allocated: ENVELOPE_ALLOCATED,
						periodStartMs,
					});
					expect(statusAfterDenial.balance).toBe(ENVELOPE_ALLOCATED - ACTUAL_COST);

					// ── reclaim remainder ──
					const reclaim = await reclaimBudget(tb, {
						parentUserId: PARENT,
						costCenter: COST_CENTER,
					});
					expect(reclaim.reclaimed).toBe(ENVELOPE_ALLOCATED - ACTUAL_COST);

					const statusAfterReclaim = await getBudgetStatus(tb, {
						parentUserId: PARENT,
						costCenter: COST_CENTER,
						allocated: ENVELOPE_ALLOCATED,
						periodStartMs,
					});
					expect(statusAfterReclaim.balance).toBe(0);
				} finally {
					await governed.destroy();
				}
			} finally {
				tb.destroy();
			}
		},
	);

	it(
		"caps a settle ABOVE the reserved hold at the hold, audits the shortfall once, " +
			"and leaves nothing pending on the real envelope",
		async () => {
			// The fixture's premise, asserted rather than assumed: a pricing-table
			// change that made the estimate generous again would quietly turn this into
			// a duplicate of the test above instead of failing.
			expect(ACTUAL_OVER).toBeGreaterThan(HOLD);

			// A fresh parent per run, as above — `(parent, costCenter)` IS the envelope
			// account, and this file's two tests share one cluster.
			const PARENT = `envelope-tb-over-${randomUUID()}`;

			const tb = new TrustTBClient({ addresses: [TB_ADDRESS as string], clusterId: 0n });
			try {
				// ── Fund parent, allocate exactly one hold's worth ──
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
					costCenter: COST_CENTER_OVER,
					amount: ENVELOPE_ALLOCATED,
				});
				expect(allocation.allocated).toBe(ENVELOPE_ALLOCATED);

				const vaultBase = makeVault(SESSION_BUDGET);
				const periodStartMs = Date.now();
				const create = vi.fn(async () => overResponse());
				const governed = await trust(anthropicClient(create), { vaultBase, parentUserId: PARENT });
				try {
					const { receipt } = (await withCostCenter(
						COST_CENTER_OVER,
						() => governed.messages.create({ ...CALL }),
						{ allocated: ENVELOPE_ALLOCATED, periodStartMs },
					)) as { receipt: TrustReceipt };

					// Against a REAL cluster this single assertion is the whole proof that
					// the engine capped: TigerBeetle REJECTS (never caps) a post above its
					// pending transfer, so an uncapped settle of ACTUAL_OVER would have come
					// back settled:false with a `settlement_ambiguous` event instead.
					expect(receipt.settled).toBe(true);
					// The receipt keeps the TRUE metered cost — the ledger's number sits
					// beside it in postedCost rather than overwriting it.
					expect(receipt.cost).toBe(ACTUAL_OVER);
					expect(receipt.postedCost).toBe(HOLD);
					expect(create).toHaveBeenCalledTimes(1);
					// D7 post-settle snapshot: one hold allocated, one hold consumed.
					expect(receipt.budget).toEqual({
						costCenter: COST_CENTER_OVER,
						remaining: 0,
						fraction: 0,
					});

					// ── Both read surfaces agree with the real ledger ──
					const status = await getBudgetStatus(tb, {
						parentUserId: PARENT,
						costCenter: COST_CENTER_OVER,
						allocated: ENVELOPE_ALLOCATED,
						periodStartMs,
					});
					expect(status.balance).toBe(0);
					expect(status.runway.remaining).toBe(0);

					const ctx = await budgetContext(tb, PARENT, [
						{ costCenter: COST_CENTER_OVER, allocated: ENVELOPE_ALLOCATED, periodStartMs },
					]);
					expect(ctx.envelopes[0]?.spent).toBe(HOLD);
					expect(ctx.envelopes[0]?.remaining).toBe(0);
				} finally {
					await governed.destroy();
				}

				// ── The hold was POSTED, not stranded ──
				// destroy() voids every hold still pending, so a hold left behind would
				// come BACK here as a full refund (balance === HOLD) — the exact signature
				// of the pre-capping behaviour this test exists to keep out. Read through a
				// FRESH client — a connection that took no part in the session.
				const verifier = new TrustTBClient({ addresses: [TB_ADDRESS as string], clusterId: 0n });
				try {
					const afterDestroy = await getBudgetStatus(verifier, {
						parentUserId: PARENT,
						costCenter: COST_CENTER_OVER,
						allocated: ENVELOPE_ALLOCATED,
						periodStartMs,
					});
					expect(afterDestroy.balance).toBe(0);
				} finally {
					verifier.destroy();
				}

				// ── The gap is on the REAL chain, exactly once ──
				const events = readLedgerEvents(join(vaultBase, VAULT_DIR));
				const shortfalls = events.filter((e) => e.kind === "settlement_shortfall");
				expect(shortfalls).toHaveLength(1);
				expect(shortfalls[0]?.data).toMatchObject({
					costCenter: COST_CENTER_OVER,
					actual: ACTUAL_OVER,
					posted: HOLD,
					shortfall: ACTUAL_OVER - HOLD,
				});
				// A capped settle is a SETTLED one — nothing about it is ambiguous.
				expect(events.filter((e) => e.kind === "settlement_ambiguous")).toHaveLength(0);
			} finally {
				tb.destroy();
			}
		},
	);
});
