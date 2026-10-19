// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Spec D5 — record surfaces on `createGovernor()`: `SettleParams`, the receipt,
 * the chain event.
 *
 * The headless governor is the boundary every non-SDK integration settles
 * through — openclaw included — so this is where the four-tier split either
 * survives into the record or dies. Two failures are pinned here:
 *
 *  - `SettleParams` could not express cache tokens at all, so an integration
 *    that HAD the counts had nowhere to put them and every cached token billed
 *    at zero.
 *  - the reported-usage condition read only `inputTokens`/`outputTokens`, so a
 *    settle carrying ONLY cache counts looked like "nothing reported" and fell
 *    back to the pre-call estimate — silently discarding real, billable data.
 *
 * The rest mirrors `tests/govern/record-surfaces.test.ts`: the recompute pin
 * (the reconciliation claim, hand-written from the record) and the divergence
 * probe (cost and record must derive from ONE snapshot object).
 *
 * Headless keeps its documented operator-boundary rule: the CALLER's
 * `usageSource` is trusted. What is not trusted is a count — a garbage
 * `inputTokens` under a `"provider"` label still demotes the record, because a
 * published four-tier record with a fabricated zero in it is the one thing D5
 * forbids outright.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { createGovernor, type Governor, type SettleParams } from "../../src/headless.js";
import { costFromRates, getModelRates, PRICING_TABLE_VERSION } from "../../src/ledger/pricing.js";
import type {
	AppliedRates,
	AuditEvent,
	CacheWrite1h,
	ReceiptUsage,
	TrustReceipt,
} from "../../src/shared/types.js";

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

// ── Harness ──

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

function llmCalls(audit: { events: AppendEventInput[] }): AppendEventInput[] {
	return audit.events.filter((e) => e.kind === "llm_call");
}

/**
 * The D5 reconciliation claim, hand-written from the record (see the govern twin), with the
 * write term split on the root `cacheWrite1h` record when the call wrote 1-hour cache.
 */
function recomputeCost(usage: ReceiptUsage, rates: AppliedRates, oneHour?: CacheWrite1h): number {
	const h = oneHour?.tokens ?? 0;
	const hRate = oneHour?.ratePer1k ?? 0;
	const total =
		(usage.inputTokens * rates.inputPer1k) / 1000 +
		(usage.outputTokens * rates.outputPer1k) / 1000 +
		(usage.cacheReadTokens * rates.cacheReadPer1k) / 1000 +
		((usage.cacheWriteTokens - h) * rates.cacheWritePer1k) / 1000 +
		(h * hRate) / 1000;
	return Math.max(1, Math.ceil(total));
}

function expectRecomputable(
	receipt: TrustReceipt,
	source: "provider" | "estimated" = "provider",
): void {
	expect(receipt.usageSource).toBe(source);
	const usage = receipt.usage;
	const applied = receipt.pricing?.appliedRates;
	if (usage === undefined || applied === undefined) {
		throw new Error("receipt is not recomputable: usage or appliedRates missing");
	}
	expect(recomputeCost(usage, applied, receipt.cacheWrite1h)).toBe(receipt.cost);
}

const MODEL = "claude-sonnet-4-6";
/** A tiny max_output keeps the metering estimate small and distinguishable. */
const AUTHORIZE = { model: MODEL, estimatedInputTokens: 10_000, maxOutputTokens: 1 };

describe("headless record surfaces (spec D5)", () => {
	let vaultBase: string;
	let audit: AuditWriter & { events: AppendEventInput[] };

	beforeEach(() => {
		vaultBase = join(tmpdir(), `record-surfaces-headless-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		audit = makeMockAudit();
	});

	afterEach(() => {
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	async function governor(): Promise<Governor> {
		return await createGovernor({
			dryRun: true,
			budget: 100_000_000,
			vaultBase,
			_audit: audit,
		});
	}

	it("SettleParams accepts the cache tiers and PRICES them", async () => {
		const gov = await governor();
		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 200_000,
			cacheWriteTokens: 4000,
		});

		// 30 + 75 + 600 + 150. Pre-fix this settle could only say 1000/500 and
		// billed the 204k cache tokens at zero: 105.
		expect(receipt.cost).toBe(855);
		expect(receipt.usage).toEqual({
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 200_000,
			cacheWriteTokens: 4000,
		});
		expectRecomputable(receipt);

		await gov.destroy();
	});

	it("cache-only params are never discarded: they price above the estimate when they show more", async () => {
		const gov = await governor();
		const rates = getModelRates(MODEL);
		const meteredEstimate = costFromRates(rates, 10_000, 1);

		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, { cacheReadTokens: 500_000 });

		// 500k reads at 3/1k = 1500 — the call really did consume that, and it is more than the
		// estimate. No input or output was reported, so the report is incomplete: "estimated", and
		// no usage is published (its input and output would be fabricated zeros).
		expect(receipt.cost).toBe(1500);
		expect(receipt.cost).toBeGreaterThan(meteredEstimate);
		expect(receipt.usageSource).toBe("estimated");
		expect(Object.hasOwn(receipt, "usage")).toBe(false);

		await gov.destroy();
	});

	it("a cache-write-only settle prices at max(estimate, its cost)", async () => {
		const gov = await governor();
		const rates = getModelRates(MODEL);
		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, { cacheWriteTokens: 8000 });

		// 8000 writes at 37.5/1k = 300, just under this authorize's metered estimate (301): the
		// incomplete report takes the dearer of the two.
		expect(costFromRates(rates, 0, 0, 0, 8000)).toBe(300);
		expect(receipt.cost).toBe(Math.max(costFromRates(rates, 10_000, 1), 300));
		expect(receipt.usageSource).toBe("estimated");
		expect(Object.hasOwn(receipt, "usage")).toBe(false);

		await gov.destroy();
	});

	it("publishes the resolved rates and the pricing table version on every settle", async () => {
		const gov = await governor();
		const rates = getModelRates(MODEL);

		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, { inputTokens: 100, outputTokens: 50 });

		expect(receipt.pricing?.appliedRates).toEqual({
			inputPer1k: rates.inputPer1k,
			outputPer1k: rates.outputPer1k,
			cacheReadPer1k: rates.cacheReadPer1k,
			cacheWritePer1k: rates.cacheWritePer1k,
		});
		expect(receipt.pricing?.tableVersion).toBe(PRICING_TABLE_VERSION);
		// The other meter fields are untouched.
		expect(receipt.meter?.costBasis).toBe("usd-proxy");
		expect(receipt.meter?.rateSource).toBe("table");

		await gov.destroy();
	});

	// Codex PR-85 P1-1. receipt.v1.schema.json declares the `meter` object
	// `additionalProperties: false` while leaving the receipt root open, so the
	// D5 rate surface has to be a root-level sibling: widening `meter` would make
	// every v1 validator reject every receipt this ship emits. Read from the
	// SHIPPED schema so the assertion tracks the file rather than restating it.
	it("emits no meter key that the frozen receipt.v1 schema would reject", async () => {
		const schema = JSON.parse(
			readFileSync(
				join(import.meta.dirname, "../../../../site/public/schemas/receipt.v1.schema.json"),
				"utf8",
			),
		) as {
			additionalProperties?: boolean;
			properties: {
				meter: { additionalProperties?: boolean; properties: Record<string, unknown> };
			};
		};
		expect(schema.properties.meter.additionalProperties).toBe(false);
		expect(schema.additionalProperties).toBe(true);
		const allowed = new Set(Object.keys(schema.properties.meter.properties));

		const gov = await governor();
		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, {
			inputTokens: 100,
			outputTokens: 50,
			computeMs: 42,
		});

		expect(receipt.meter).toBeDefined();
		expect(Object.keys(receipt.meter ?? {}).filter((k) => !allowed.has(k))).toEqual([]);
		expect(receipt.meter?.computeMs).toBe(42);
		expect(receipt.pricing?.tableVersion).toBe(PRICING_TABLE_VERSION);

		await gov.destroy();
	});

	// Codex PR-85 P1-2. The headless settle hands the caller a receipt and writes
	// a chain event from the same resolved snapshot. If they shared a mutable
	// object, editing the returned receipt would rewrite what the auditor reads.
	it("freezes the applied rates and gives the receipt and the chain event separate copies", async () => {
		const gov = await governor();
		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 200_000,
			cacheWriteTokens: 4000,
		});

		const rates = receipt.pricing?.appliedRates as AppliedRates;
		const truth = { ...rates };
		expect(Object.isFrozen(rates)).toBe(true);
		try {
			(rates as { cacheReadPer1k: number }).cacheReadPer1k = 0;
			(rates as { inputPer1k: number }).inputPer1k = 0;
		} catch {
			// frozen object in strict mode — the good path
		}
		expect(rates).toEqual(truth);

		const data = llmCalls(audit)[0]?.data as Record<string, unknown>;
		expect(data.appliedRates).toEqual(truth);
		expect(data.appliedRates).not.toBe(rates);
		expect(Object.isFrozen(data.appliedRates)).toBe(true);
		expect(recomputeCost(data.usage as ReceiptUsage, data.appliedRates as AppliedRates)).toBe(
			data.cost,
		);
		expectRecomputable(receipt);

		await gov.destroy();
	});

	it("mirrors receipt.usage onto the llm_call chain event", async () => {
		const gov = await governor();
		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 200_000,
			cacheWriteTokens: 4000,
		});

		const data = llmCalls(audit)[0]?.data as Record<string, unknown>;
		expect(data.usage).toEqual(receipt.usage);
		expect(data.appliedRates).toEqual(receipt.pricing?.appliedRates);
		expect(data.pricingTableVersion).toBe(PRICING_TABLE_VERSION);
		expect(recomputeCost(data.usage as ReceiptUsage, data.appliedRates as AppliedRates)).toBe(
			data.cost,
		);

		await gov.destroy();
	});

	it("omits usage on a settle with no counts at all (the estimate fallback)", async () => {
		const gov = await governor();
		const rates = getModelRates(MODEL);

		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth);

		expect(receipt.usageSource).toBe("estimated");
		expect(Object.hasOwn(receipt, "usage")).toBe(false);
		expect(receipt.cost).toBe(costFromRates(rates, 10_000, 1));
		expect(receipt.pricing?.appliedRates).toBeDefined();

		const data = llmCalls(audit)[0]?.data as Record<string, unknown>;
		expect(Object.hasOwn(data, "usage")).toBe(false);

		await gov.destroy();
	});

	it('publishes usage when the caller labels its own counts "estimated": they priced the call', async () => {
		const gov = await governor();
		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, {
			inputTokens: 1000,
			outputTokens: 500,
			usageSource: "estimated",
		});

		// The caller's label is honoured (operator boundary), and the counts it supplied price the
		// call. So the record carries them: without them, cost could not be reproduced from it.
		expect(receipt.usageSource).toBe("estimated");
		expect(receipt.cost).toBe(costFromRates(getModelRates(MODEL), 1000, 500));
		expect(receipt.usage).toEqual({
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		expectRecomputable(receipt, "estimated");
		const data = llmCalls(audit)[0]?.data as Record<string, unknown>;
		expect(data.usage).toEqual(receipt.usage);
		expect(data.usageSource).toBe("estimated");

		await gov.destroy();
	});

	it('an "estimated" label with 1-hour cache writes publishes the 1-hour record, and recomputes', async () => {
		const gov = await governor();
		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, {
			inputTokens: 1000,
			outputTokens: 500,
			cacheWriteTokens: 4000,
			cacheWrite1hTokens: 1500,
			usageSource: "estimated",
		});

		expect(receipt.usageSource).toBe("estimated");
		expect(receipt.cost).toBe(costFromRates(getModelRates(MODEL), 1000, 500, 0, 4000, 1500));
		expect(receipt.usage?.cacheWriteTokens).toBe(4000);
		expect(receipt.cacheWrite1h?.tokens).toBe(1500);
		// The 1-hour term is what separates this cost from an all-5-minute one.
		expect(receipt.cost).not.toBe(costFromRates(getModelRates(MODEL), 1000, 500, 0, 4000));
		expectRecomputable(receipt, "estimated");

		await gov.destroy();
	});

	it('an "estimated" label with an implausible count publishes no usage: the estimate priced it', async () => {
		const gov = await governor();
		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 1e15,
			usageSource: "estimated",
		});

		expect(receipt.usageSource).toBe("estimated");
		expect(receipt.cost).toBe(costFromRates(getModelRates(MODEL), 10_000, 1));
		expect(Object.hasOwn(receipt, "usage")).toBe(false);
		expect(Object.hasOwn(receipt, "cacheWrite1h")).toBe(false);
		const data = llmCalls(audit)[0]?.data as Record<string, unknown>;
		expect(Object.hasOwn(data, "usage")).toBe(false);

		await gov.destroy();
	});

	it('an "estimated" label with an unusable input or output count publishes no usage: its 0 is fabricated', async () => {
		const gov = await governor();
		const rates = getModelRates(MODEL);
		const meteredEstimate = costFromRates(rates, 10_000, 1);
		const cases: Array<[SettleParams, number]> = [
			[
				{ inputTokens: Number.NaN, outputTokens: 500, usageSource: "estimated" },
				Math.max(meteredEstimate, costFromRates(rates, 0, 500)),
			],
			[
				{ inputTokens: 1000, outputTokens: Number.NaN, usageSource: "estimated" },
				Math.max(meteredEstimate, costFromRates(rates, 1000, 0)),
			],
		];
		for (const [params, cost] of cases) {
			const auth = await gov.authorize(AUTHORIZE);
			const receipt = await gov.settle(auth, params);
			// An incomplete report: no less than the estimate, never published with a made-up 0.
			expect(receipt.usageSource).toBe("estimated");
			expect(receipt.cost).toBe(cost);
			expect(Object.hasOwn(receipt, "usage")).toBe(false);
		}
		const calls = llmCalls(audit);
		expect(calls).toHaveLength(2);
		for (const call of calls) expect(Object.hasOwn(call.data as object, "usage")).toBe(false);

		await gov.destroy();
	});

	it("an input or output left out, under either label, is an incomplete report: never below the estimate", async () => {
		const gov = await governor();
		const rates = getModelRates(MODEL);
		const meteredEstimate = costFromRates(rates, 10_000, 1);
		for (const usageSource of ["provider", "estimated"] as const) {
			const auth = await gov.authorize(AUTHORIZE);
			const receipt = await gov.settle(auth, { outputTokens: 500, usageSource });
			// A count left out is not a 0: the estimate, which shows more than the output alone, prices
			// it. "estimated", and no usage (its input would be a fabricated 0).
			expect(costFromRates(rates, 0, 500)).toBeLessThan(meteredEstimate);
			expect(receipt.cost).toBe(meteredEstimate);
			expect(receipt.usageSource).toBe("estimated");
			expect(Object.hasOwn(receipt, "usage")).toBe(false);
		}

		await gov.destroy();
	});

	it("a garbage count under a provider label publishes NO usage record", async () => {
		const gov = await governor();
		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, {
			inputTokens: Number.NaN,
			outputTokens: 500,
			usageSource: "provider",
		});

		// A four-tier record whose inputTokens is a fabricated 0 is the mislabel
		// D5 kills. An incomplete report costs no less than the estimate.
		const rates = getModelRates(MODEL);
		expect(Object.hasOwn(receipt, "usage")).toBe(false);
		expect(receipt.usageSource).toBe("estimated");
		expect(receipt.cost).toBe(
			Math.max(costFromRates(rates, 10_000, 1), costFromRates(rates, 0, 500)),
		);

		await gov.destroy();
	});

	it("sanitizes non-finite and negative counts before they reach the record", async () => {
		const gov = await governor();
		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: Number.POSITIVE_INFINITY,
			cacheWriteTokens: -5000,
		});

		expect(receipt.usage).toEqual({
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		// canonicalize() throws on non-finite — the chain write only survived
		// because the snapshot is what was emitted.
		const data = llmCalls(audit)[0]?.data as Record<string, unknown>;
		expect(JSON.stringify(data.usage)).toBe(JSON.stringify(receipt.usage));
		expectRecomputable(receipt);

		await gov.destroy();
	});

	it("divergence probe: each SettleParams count is read exactly once, into one snapshot", async () => {
		const gov = await governor();
		const auth = await gov.authorize(AUTHORIZE);

		// Every getter answers differently on each read. If the presence check,
		// the cost and the record each read the caller's object separately, they
		// see three different numbers and the pin below fails.
		const reads = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
		const params: SettleParams = {
			get inputTokens() {
				reads.inputTokens++;
				return 1000 * reads.inputTokens;
			},
			get outputTokens() {
				reads.outputTokens++;
				return 500 * reads.outputTokens;
			},
			get cacheReadTokens() {
				reads.cacheReadTokens++;
				return 200_000 * reads.cacheReadTokens;
			},
			get cacheWriteTokens() {
				reads.cacheWriteTokens++;
				return 4000 * reads.cacheWriteTokens;
			},
		};

		const receipt = await gov.settle(auth, params);

		expect(reads).toEqual({
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 1,
			cacheWriteTokens: 1,
		});
		expect(receipt.usage).toEqual({
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 200_000,
			cacheWriteTokens: 4000,
		});
		expectRecomputable(receipt);
		const data = llmCalls(audit)[0]?.data as Record<string, unknown>;
		expect(data.usage).toEqual(receipt.usage);

		await gov.destroy();
	});

	it("the 1.14B-cache-read day recomputes exactly from the record", async () => {
		const gov = await governor();
		const auth = await gov.authorize(AUTHORIZE);
		// One call cannot plausibly report more than 100 million tokens in a tier (the plausibility ceiling), so the day is
		// 12 calls of 95 million cache-read tokens each; the day's totals are unchanged.
		const calls = 12;
		let receipt!: Awaited<ReturnType<typeof gov.settle>>;
		for (let i = 0; i < calls; i++) {
			const a = i === 0 ? auth : await gov.authorize(AUTHORIZE);
			receipt = await gov.settle(a, {
				inputTokens: 2_000_000 / calls,
				outputTokens: 500_000 / calls,
				cacheReadTokens: 1_140_000_000 / calls,
				cacheWriteTokens: 12_000_000 / calls,
			});
			expectRecomputable(receipt);
		}
		// The killed understatement, stated as arithmetic: the pre-fix reading
		// billed the two cache tiers at ZERO.
		const preFix = costFromRates(getModelRates(MODEL), 2_000_000 / calls, 500_000 / calls);
		expect(receipt.cost).toBeGreaterThan(preFix * 7);

		await gov.destroy();
	});
});
