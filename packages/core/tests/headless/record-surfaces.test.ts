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
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { createGovernor, type Governor, type SettleParams } from "../../src/headless.js";
import { costFromRates, getModelRates, PRICING_TABLE_VERSION } from "../../src/ledger/pricing.js";
import type {
	AppliedRates,
	AuditEvent,
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

/** The D5 reconciliation claim, hand-written from the record (see the govern twin). */
function recomputeCost(usage: ReceiptUsage, rates: AppliedRates): number {
	const total =
		(usage.inputTokens * rates.inputPer1k) / 1000 +
		(usage.outputTokens * rates.outputPer1k) / 1000 +
		(usage.cacheReadTokens * rates.cacheReadPer1k) / 1000 +
		(usage.cacheWriteTokens * rates.cacheWritePer1k) / 1000;
	return Math.max(1, Math.ceil(total));
}

function expectRecomputable(receipt: TrustReceipt): void {
	expect(receipt.usageSource).toBe("provider");
	const usage = receipt.usage;
	const applied = receipt.meter?.appliedRates;
	if (usage === undefined || applied === undefined) {
		throw new Error("receipt is not recomputable: usage or appliedRates missing");
	}
	expect(recomputeCost(usage, applied)).toBe(receipt.cost);
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

	it("cache-only params COUNT AS REPORTED — never a fallback to the estimate", async () => {
		const gov = await governor();
		const rates = getModelRates(MODEL);
		const meteredEstimate = costFromRates(rates, 10_000, 1);

		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, { cacheReadTokens: 500_000 });

		// 500k reads at 3/1k = 1500 — the call really did consume that.
		expect(receipt.cost).toBe(1500);
		expect(receipt.cost).not.toBe(meteredEstimate);
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.usage).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 500_000,
			cacheWriteTokens: 0,
		});
		expectRecomputable(receipt);

		await gov.destroy();
	});

	it("a cache-write-only settle is reported too", async () => {
		const gov = await governor();
		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, { cacheWriteTokens: 8000 });

		// 8000 writes at 37.5/1k = 300.
		expect(receipt.cost).toBe(300);
		expect(receipt.usage?.cacheWriteTokens).toBe(8000);
		expectRecomputable(receipt);

		await gov.destroy();
	});

	it("publishes the resolved rates and the pricing table version on every settle", async () => {
		const gov = await governor();
		const rates = getModelRates(MODEL);

		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, { inputTokens: 100, outputTokens: 50 });

		expect(receipt.meter?.appliedRates).toEqual({
			inputPer1k: rates.inputPer1k,
			outputPer1k: rates.outputPer1k,
			cacheReadPer1k: rates.cacheReadPer1k,
			cacheWritePer1k: rates.cacheWritePer1k,
		});
		expect(receipt.meter?.pricingTableVersion).toBe(PRICING_TABLE_VERSION);
		// The other meter fields are untouched.
		expect(receipt.meter?.costBasis).toBe("usd-proxy");
		expect(receipt.meter?.rateSource).toBe("table");

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
		expect(data.appliedRates).toEqual(receipt.meter?.appliedRates);
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
		expect(receipt.meter?.appliedRates).toBeDefined();

		const data = llmCalls(audit)[0]?.data as Record<string, unknown>;
		expect(Object.hasOwn(data, "usage")).toBe(false);

		await gov.destroy();
	});

	it('omits usage when the caller labels its own counts "estimated"', async () => {
		const gov = await governor();
		const auth = await gov.authorize(AUTHORIZE);
		const receipt = await gov.settle(auth, {
			inputTokens: 1000,
			outputTokens: 500,
			usageSource: "estimated",
		});

		// The caller's label is honoured (operator boundary) — and the counts it
		// supplied still price the call, exactly as before.
		expect(receipt.usageSource).toBe("estimated");
		expect(Object.hasOwn(receipt, "usage")).toBe(false);
		expect(receipt.cost).toBe(costFromRates(getModelRates(MODEL), 1000, 500));

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
		// D5 kills. The cost still meters off what was usable.
		expect(Object.hasOwn(receipt, "usage")).toBe(false);
		expect(receipt.usageSource).toBe("estimated");
		expect(receipt.cost).toBe(costFromRates(getModelRates(MODEL), 0, 500));

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
		const receipt = await gov.settle(auth, {
			inputTokens: 2_000_000,
			outputTokens: 500_000,
			cacheReadTokens: 1_140_000_000,
			cacheWriteTokens: 12_000_000,
		});

		expectRecomputable(receipt);
		// The killed understatement, stated as arithmetic: the pre-fix reading
		// billed the two cache tiers at ZERO.
		const preFix = costFromRates(getModelRates(MODEL), 2_000_000, 500_000);
		expect(receipt.cost).toBeGreaterThan(preFix * 7);

		await gov.destroy();
	});
});
