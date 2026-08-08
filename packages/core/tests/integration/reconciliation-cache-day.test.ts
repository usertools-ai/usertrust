// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * THE RECONCILIATION SCENARIO — the 1.14B-cache-read day (spec D5, plan task 10).
 *
 * This file is the ship's proof. Everything else in the cache-tier ship pins a
 * boundary; this pins the CLAIM: **from the record alone an auditor recomputes
 * usertrust's configured metered cost exactly**, at the scale of the day that
 * motivated the whole change, and the understatement that day used to be
 * recorded with is computed here explicitly rather than asserted in prose.
 *
 * ## The day
 *
 * A heavy agentic coding day on `claude-sonnet-4-6`, in the four columns a
 * provider usage report actually has:
 *
 * | tier            | tokens        | rate/1k | usertokens |
 * |-----------------|---------------|---------|------------|
 * | cache read      | 1,140,000,000 |     3   |  3,420,000 |
 * | cache write     |    40,000,000 |    37.5 |  1,500,000 |
 * | fresh input     |     4,000,000 |    30   |    120,000 |
 * | output          |     4,000,000 |   150   |    600,000 |
 * | **four-tier**   |               |         |  **5,640,000** ($564.00) |
 * | two-tier (pre-fix) |            |         |    **720,000** ($72.00) |
 *
 * Pre-fix, `ModelRates` had nowhere to price cache tokens and the extractors
 * dropped them, so only the fresh-input and output legs were ever recorded:
 * 720,000 usertokens for a day that really cost 5,640,000 — **7.83x
 * understated**, and understatement is the direction that makes budgets deplete
 * an order of magnitude slower than the invoice. That ratio is not hardcoded
 * below: it is computed from the counts on the RECORDED receipts, by re-pricing
 * them the way the two-tier code would have.
 *
 * ADAPTATION (reported): the plan's shorthand for this day is "~1.14B cache read
 * / 40M fresh / 4M output". Pricing 40M as FRESH input yields a 2.9x
 * understatement, which would contradict the ~7-8x figure this ship publishes in
 * `AGENTS.md`, `CHANGELOG.md` and the spec — the 40M column of a cache-heavy day
 * is cache CREATION, not fresh prompt (fresh input on such a day is small, and
 * cache writes are what a long-lived agent session actually spends its prompt
 * budget on). The day is therefore modelled with all four tiers, which also makes
 * it exercise the cache-WRITE leg the two-tier bug dropped as well. The 1.14B
 * read and 4M output are the plan's numbers unchanged.
 *
 * ## Two drives, because they prove different halves
 *
 * **A — the SDK path (`trust()`).** Eight mocked Anthropic responses carrying
 * the real disjoint shape (`cache_read_input_tokens` plus the nested per-TTL
 * `cache_creation` breakdown). This proves extraction → pricing → receipt →
 * durable chain event on the surface most callers use. Its engine never caps:
 * a stub `messages` array estimates ~1 input token, so the PENDING hold is
 * nothing like the hold a real 148M-token prompt would take, and hold sizing is
 * not what this drive is for (`tests/govern/settle-shortfall.test.ts` owns the
 * capping behaviour; drive B below owns the honest-hold case).
 *
 * **B — the governor (`createGovernor()`), with honest hold sizing.** The same
 * day, authorized with the prompt size a 1.14B-read day genuinely sends
 * (`estimatedInputTokens` = fresh + cache read + cache write per call, because
 * cached tokens ARE prompt tokens), settled against an engine that caps exactly
 * like TigerBeetle does. This proves the four-tier amount reaches the LEDGER in
 * full — no `settlement_shortfall`, `posted === cost` on every call — which the
 * never-capping drive cannot show.
 *
 * SECURITY: assert individual fields; never snapshot a whole receipt payload.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLedgerEvents } from "../../src/audit/read.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { PRICING_TABLE_VERSION } from "../../src/ledger/pricing.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import type { AppliedRates, ReceiptUsage, TrustReceipt } from "../../src/shared/types.js";

// tigerbeetle-node is a native module: this file's engines are injected, and the
// real-cluster half of task 10 lives in `reconciliation-cache-day.tb.test.ts`.
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

// ── The day ──

const MODEL = "claude-sonnet-4-6";

/** Calls the day is split across. Every tier below divides by it exactly. */
const CALLS = 8;

/** The day's totals, in tokens. */
const DAY = {
	inputTokens: 4_000_000,
	outputTokens: 4_000_000,
	cacheReadTokens: 1_140_000_000,
	cacheWriteTokens: 40_000_000,
} as const satisfies ReceiptUsage;

/** One call's share of the day. */
const PER_CALL: ReceiptUsage = {
	inputTokens: DAY.inputTokens / CALLS,
	outputTokens: DAY.outputTokens / CALLS,
	cacheReadTokens: DAY.cacheReadTokens / CALLS,
	cacheWriteTokens: DAY.cacheWriteTokens / CALLS,
};

/**
 * The per-TTL split of one call's cache-WRITE tier. Both TTLs bill at the single
 * `cacheWritePer1k` (the D6 approximation), so the split changes no money — it
 * exists so drive A exercises the nested `cache_creation` summing branch rather
 * than the flat `cache_creation_input_tokens` field. Written as literals, not as
 * fractions of the tier, so no float rounding can reach a token count.
 */
const EPHEMERAL_5M = 4_000_000;
const EPHEMERAL_1H = 1_000_000;

/**
 * The prompt a call like this genuinely sends: cached tokens are PROMPT tokens
 * — they are read from cache instead of re-processed, but they are still what
 * the caller put in the request. A headless caller that knows its prompt size
 * passes exactly this, and the D3 hold then covers the settle.
 */
const PER_CALL_PROMPT_TOKENS =
	PER_CALL.inputTokens + PER_CALL.cacheReadTokens + PER_CALL.cacheWriteTokens;

/** A realistic per-request output cap (Anthropic's own ceiling is in this range). */
const MAX_OUTPUT_TOKENS = 64_000;

/** The four-tier cost of one call — 705,000 usertokens; see the header table. */
const PER_CALL_COST = 705_000;
/** The four-tier cost of the whole day. */
const DAY_COST = PER_CALL_COST * CALLS;
/** What the two-tier code recorded for one call: fresh input + output only. */
const PER_CALL_TWO_TIER = 90_000;

/** Room for eight ~5.6M-usertoken holds plus the day's real spend. */
const BUDGET = 200_000_000;

// ── Harness ──

function makeTmpVault(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * An engine that posts in full — see the header: drive A is about the record,
 * not about hold sizing. Records what was RESERVED and what was POSTED so the
 * money that moved can be asserted, not just the money that was reported.
 */
function makeOpenEngine(): TrustEngine & { held: number[]; posted: number[] } {
	const held: number[] = [];
	const posted: number[] = [];
	return {
		held,
		posted,
		spendPending: vi.fn(async (p: { transferId: string; amount: number }) => {
			held.push(p.amount);
			return { transferId: p.transferId };
		}),
		postPendingSpend: vi.fn(async (_transferId: string, actualAmount?: number) => {
			posted.push(actualAmount ?? 0);
		}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
}

/**
 * A TigerBeetle-faithful engine: a post above the reserved hold is TRUNCATED to
 * the hold and the difference comes back as `shortfall` (the real cluster
 * rejects such a post outright, which is why `createTBEngine` caps at the
 * reserve and reports the gap — see govern.ts's pendingMap). Drive B's whole
 * point is that with an honestly sized hold this engine never truncates.
 */
function makeCappingEngine(): TrustEngine & {
	posts: { held: number; requested: number; posted: number; shortfall: number }[];
} {
	const held = new Map<string, number>();
	const posts: { held: number; requested: number; posted: number; shortfall: number }[] = [];
	return {
		posts,
		spendPending: vi.fn(async (p: { transferId: string; amount: number }) => {
			held.set(p.transferId, p.amount);
			return { transferId: p.transferId };
		}),
		postPendingSpend: vi.fn(async (transferId: string, actualAmount?: number) => {
			const reserved = held.get(transferId) ?? 0;
			held.delete(transferId);
			const requested = actualAmount ?? reserved;
			const posted = Math.min(requested, reserved);
			const record = { held: reserved, requested, posted, shortfall: requested - posted };
			posts.push(record);
			return { posted, shortfall: record.shortfall };
		}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
	};
}

/**
 * One call's Anthropic response. The three input counters are DISJOINT in the
 * SDK (D2), and the write tier arrives as the nested per-TTL breakdown so this
 * drive exercises the summing branch rather than the flat field.
 */
function anthropicResponse(): Record<string, unknown> {
	return {
		id: `msg_${randomUUID()}`,
		type: "message",
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		model: MODEL,
		usage: {
			input_tokens: PER_CALL.inputTokens,
			output_tokens: PER_CALL.outputTokens,
			cache_read_input_tokens: PER_CALL.cacheReadTokens,
			cache_creation: {
				ephemeral_5m_input_tokens: EPHEMERAL_5M,
				ephemeral_1h_input_tokens: EPHEMERAL_1H,
			},
		},
	};
}

// ── The auditor ──

/**
 * The claim, written the way an AUDITOR would write it: straight from the
 * record's own numbers, never through `costFromRates`. Calling the production
 * function here would prove nothing about whether the record is sufficient.
 */
function recomputeCost(usage: ReceiptUsage, rates: AppliedRates): number {
	const total =
		(usage.inputTokens * rates.inputPer1k) / 1000 +
		(usage.outputTokens * rates.outputPer1k) / 1000 +
		(usage.cacheReadTokens * rates.cacheReadPer1k) / 1000 +
		(usage.cacheWriteTokens * rates.cacheWritePer1k) / 1000;
	return Math.max(1, Math.ceil(total));
}

/**
 * What the PRE-FIX, two-tier code recorded for the same counts: cache tokens had
 * no rate and no field, so they were simply not billed. This is the killed bug,
 * expressed as a function of the record so the understatement can be measured
 * rather than asserted.
 */
function twoTierCost(usage: ReceiptUsage, rates: AppliedRates): number {
	const total =
		(usage.inputTokens * rates.inputPer1k) / 1000 + (usage.outputTokens * rates.outputPer1k) / 1000;
	return Math.max(1, Math.ceil(total));
}

/** The four-tier record on a receipt, or a loud failure. */
function recordOf(receipt: TrustReceipt): { usage: ReceiptUsage; rates: AppliedRates } {
	expect(receipt.usageSource).toBe("provider");
	const usage = receipt.usage;
	const rates = receipt.pricing?.appliedRates;
	if (usage === undefined || rates === undefined) {
		throw new Error("receipt is not recomputable: usage or appliedRates missing");
	}
	expect(receipt.pricing?.tableVersion).toBe(PRICING_TABLE_VERSION);
	return { usage, rates };
}

/** Sum the four tiers across a day's worth of records. */
function sumUsage(records: ReceiptUsage[]): ReceiptUsage {
	return records.reduce<ReceiptUsage>(
		(acc, u) => ({
			inputTokens: acc.inputTokens + u.inputTokens,
			outputTokens: acc.outputTokens + u.outputTokens,
			cacheReadTokens: acc.cacheReadTokens + u.cacheReadTokens,
			cacheWriteTokens: acc.cacheWriteTokens + u.cacheWriteTokens,
		}),
		{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
	);
}

// ── Drive A: the SDK path ──

describe("reconciliation — the 1.14B-cache-read day through trust()", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = makeTmpVault("reconciliation-cache-day");
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("recomputes the whole day exactly from the receipts and the durable chain, and measures the understatement the two-tier code recorded", async () => {
		// Fixture premises, asserted rather than assumed — a drifted split or a
		// day that no longer divides evenly would otherwise change what this test
		// proves without failing it.
		expect(EPHEMERAL_5M + EPHEMERAL_1H).toBe(PER_CALL.cacheWriteTokens);
		expect(PER_CALL_COST * CALLS).toBe(DAY_COST);

		const engine = makeOpenEngine();
		const create = vi.fn(async () => anthropicResponse());
		const governed = await trust(
			{ messages: { create } },
			{ budget: BUDGET, vaultBase: tmpVault, _engine: engine },
		);

		const receipts: TrustReceipt[] = [];
		try {
			for (let i = 0; i < CALLS; i++) {
				const { receipt } = (await governed.messages.create({
					model: MODEL,
					max_tokens: 1024,
					messages: [{ role: "user", content: `turn ${i}` }],
				})) as { receipt: TrustReceipt };
				receipts.push(receipt);
			}
		} finally {
			await governed.destroy();
		}

		expect(create).toHaveBeenCalledTimes(CALLS);
		expect(receipts).toHaveLength(CALLS);

		// ── Per call: the record reprices itself ──
		const perCallRecords: ReceiptUsage[] = [];
		for (const receipt of receipts) {
			const { usage, rates } = recordOf(receipt);
			// The nested per-TTL breakdown summed into ONE disjoint write tier (D2).
			expect(usage).toEqual(PER_CALL);
			// The resolved rates, published — an absent tier would be a hole an
			// auditor reads as free, which is the bug this ship kills.
			expect(rates).toEqual({
				inputPer1k: 30,
				outputPer1k: 150,
				cacheReadPer1k: 3,
				cacheWritePer1k: 37.5,
			});
			expect(receipt.cost).toBe(PER_CALL_COST);
			expect(recomputeCost(usage, rates)).toBe(receipt.cost);
			expect(receipt.settled).toBe(true);
			perCallRecords.push(usage);
		}

		// ── The day: counts x appliedRates, exactly ──
		const dayUsage = sumUsage(perCallRecords);
		expect(dayUsage).toEqual(DAY);
		const dayRates = recordOf(receipts[0] as TrustReceipt).rates;
		const dayRecorded = receipts.reduce((sum, r) => sum + r.cost, 0);
		expect(dayRecorded).toBe(DAY_COST);
		expect(recomputeCost(dayUsage, dayRates)).toBe(dayRecorded);

		// ── The money actually moved, in full ──
		expect(engine.posted).toHaveLength(CALLS);
		expect(engine.posted.every((p) => p === PER_CALL_COST)).toBe(true);
		expect(engine.posted.reduce((a, b) => a + b, 0)).toBe(DAY_COST);
		// No call was capped, so no receipt carries a posted-vs-metered gap.
		expect(receipts.every((r) => r.postedCost === undefined)).toBe(true);
		// The session's own budget arithmetic agrees with the ledger's.
		expect(receipts[CALLS - 1]?.budgetRemaining).toBe(BUDGET - DAY_COST);

		// ── The DURABLE record — the chain, not the return value ──
		// A receipt is an ephemeral object; the claim is only worth something on
		// the hash-chained event an auditor actually gets handed.
		const events = readLedgerEvents(join(tmpVault, VAULT_DIR));
		const llmCalls = events.filter((e) => e.kind === "llm_call");
		expect(llmCalls).toHaveLength(CALLS);
		// Nothing was capped, so nothing should have been audited as a shortfall.
		expect(events.filter((e) => e.kind === "settlement_shortfall")).toHaveLength(0);
		expect(events.filter((e) => e.kind === "settlement_ambiguous")).toHaveLength(0);

		const chainRecords: ReceiptUsage[] = [];
		let chainCost = 0;
		for (const event of llmCalls) {
			const data = event.data as Record<string, unknown>;
			const usage = data.usage as ReceiptUsage;
			const rates = data.appliedRates as AppliedRates;
			expect(data.usageSource).toBe("provider");
			expect(data.pricingTableVersion).toBe(PRICING_TABLE_VERSION);
			expect(usage).toEqual(PER_CALL);
			expect(recomputeCost(usage, rates)).toBe(data.cost);
			chainRecords.push(usage);
			chainCost += data.cost as number;
		}
		expect(sumUsage(chainRecords)).toEqual(DAY);
		expect(chainCost).toBe(DAY_COST);

		// ── THE KILLED BUG, computed ──
		// Re-price the SAME recorded counts the way the two-tier code did — fresh
		// input and output only, because cache tokens had no rate to hit.
		const twoTierDay = llmCalls.reduce((sum, event) => {
			const data = event.data as Record<string, unknown>;
			return sum + twoTierCost(data.usage as ReceiptUsage, data.appliedRates as AppliedRates);
		}, 0);
		expect(twoTierDay).toBe(PER_CALL_TWO_TIER * CALLS); // 720,000
		// 5,640,000 / 720,000 = 7.83x — the "~7-8x" this ship's CHANGELOG, AGENTS.md
		// and spec all name, derived here instead of quoted.
		const understatement = dayRecorded / twoTierDay;
		expect(understatement).toBeGreaterThan(7);
		expect(understatement).toBeLessThan(8);
		expect(understatement).toBeCloseTo(7.833, 3);
		// The absolute gap, in the unit that matters: 4,920,000 usertokens is
		// $492.00 of a $564.00 day that used to be recorded as $72.00.
		expect(dayRecorded - twoTierDay).toBe(4_920_000);
		// Direction is the whole point: the fix can only RAISE the recorded cost.
		expect(dayRecorded).toBeGreaterThan(twoTierDay);
	});
});

// ── Drive B: the governor, with an honestly sized hold ──

describe("reconciliation — the same day through createGovernor(), hold sized per D3", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = makeTmpVault("reconciliation-cache-day-headless");
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("posts the four-tier amount to the ledger in full — the hold covers it, nothing is truncated", async () => {
		const engine = makeCappingEngine();
		const governor = await createGovernor({
			budget: BUDGET,
			vaultBase: tmpVault,
			_engine: engine,
		});

		const receipts: TrustReceipt[] = [];
		for (let i = 0; i < CALLS; i++) {
			const auth = await governor.authorize({
				model: MODEL,
				// The honest prompt size — cached tokens are prompt tokens.
				estimatedInputTokens: PER_CALL_PROMPT_TOKENS,
				// A real per-request output cap, not the day's output total: the
				// output leg of the hold is not what has to cover a cache-heavy
				// settle, and pretending otherwise would hide whether the D3 input
				// leg does its job.
				maxOutputTokens: MAX_OUTPUT_TOKENS,
			});
			receipts.push(
				await governor.settle(auth, {
					inputTokens: PER_CALL.inputTokens,
					outputTokens: PER_CALL.outputTokens,
					cacheReadTokens: PER_CALL.cacheReadTokens,
					cacheWriteTokens: PER_CALL.cacheWriteTokens,
					usageSource: "provider",
				}),
			);
		}
		await governor.destroy();

		// ── Every settle reprices from its own record ──
		for (const receipt of receipts) {
			const { usage, rates } = recordOf(receipt);
			expect(usage).toEqual(PER_CALL);
			expect(receipt.cost).toBe(PER_CALL_COST);
			expect(recomputeCost(usage, rates)).toBe(receipt.cost);
			expect(receipt.settled).toBe(true);
		}
		expect(receipts.reduce((sum, r) => sum + r.cost, 0)).toBe(DAY_COST);

		// ── The ledger got the four-tier amount, not a truncation ──
		expect(engine.posts).toHaveLength(CALLS);
		for (const post of engine.posts) {
			// D3: the hold reserves the estimated input at the cache-WRITE rate, so a
			// cache-writing call cannot settle above its own reservation. Assert the
			// premise, not just the consequence — a hold that stopped covering this
			// would otherwise quietly turn this test into a capping test.
			expect(post.held).toBeGreaterThanOrEqual(PER_CALL_COST);
			expect(post.requested).toBe(PER_CALL_COST);
			expect(post.posted).toBe(PER_CALL_COST);
			expect(post.shortfall).toBe(0);
		}
		expect(engine.posts.reduce((sum, p) => sum + p.posted, 0)).toBe(DAY_COST);
		// A truncated post is audited as `settlement_shortfall`; there was none.
		const events = readLedgerEvents(join(tmpVault, VAULT_DIR));
		expect(events.filter((e) => e.kind === "settlement_shortfall")).toHaveLength(0);
		expect(events.filter((e) => e.kind === "llm_call")).toHaveLength(CALLS);
	});
});
