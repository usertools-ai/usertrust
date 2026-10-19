// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `createGovernor().settle()`: an incomplete report never prices below the metered estimate.
 *
 * COMPLETE = `inputTokens` AND `outputTokens` both present and usable (an explicit 0 counts),
 * judged on the caller's own values. Only a complete report is priced from its counts.
 * INCOMPLETE = either absent, NaN, negative, infinite or non-numeric, or cache tiers alone: it
 * costs max(metered estimate, its usable counts), is labelled "estimated" whatever the caller's
 * label, and publishes no `usage`. Absent CACHE tiers stay 0 (D5).
 *
 * Before this, a count left out was a 0 that priced the call, so `{ outputTokens: 500 }`
 * cost the output alone: 44% under the true cost in the measured case. The rig authorizes
 * 2000 in / 500 out, so the metered estimate equals the true cost; a LOW-estimate authorize
 * makes the other direction of max() observable, where the counts show more than the estimate.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { createGovernor, type Governor, type SettleParams } from "../../src/headless.js";
import { costFromRates, getModelRates } from "../../src/ledger/pricing.js";
import type { AuditEvent, TrustReceipt } from "../../src/shared/types.js";

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

const MODEL = "claude-sonnet-4-6";
const RATES = getModelRates(MODEL);
/** Metered estimate = costFromRates(2000, 500) = the true cost of a 2000 / 500 call. */
const AUTHORIZE = { model: MODEL, estimatedInputTokens: 2000, maxOutputTokens: 500 };
const EST = costFromRates(RATES, 2000, 500);
/** A small estimate, so counts that show more than it win the max(). */
const AUTHORIZE_LOW = { model: MODEL, estimatedInputTokens: 100, maxOutputTokens: 10 };
const EST_LOW = costFromRates(RATES, 100, 10);
const LABELS = [undefined, "provider", "estimated"] as const;

function makeAudit(): AuditWriter & { events: AppendEventInput[] } {
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

describe("headless: an incomplete report never prices below the metered estimate", () => {
	let vaultBase: string;
	let audit: AuditWriter & { events: AppendEventInput[] };
	let gov: Governor;
	beforeEach(async () => {
		vaultBase = join(tmpdir(), `incomplete-headless-${randomUUID()}`);
		mkdirSync(vaultBase, { recursive: true });
		audit = makeAudit();
		gov = await createGovernor({ dryRun: true, budget: 100_000_000, vaultBase, _audit: audit });
	});
	afterEach(async () => {
		await gov.destroy();
		rmSync(vaultBase, { recursive: true, force: true });
	});

	async function settle(
		params: SettleParams,
		authorize: typeof AUTHORIZE = AUTHORIZE,
	): Promise<TrustReceipt> {
		return await gov.settle(await gov.authorize(authorize), params);
	}

	/** "estimated", and no usage on the receipt or its llm_call event. */
	function expectEstimateClass(receipt: TrustReceipt): void {
		expect(receipt.usageSource).toBe("estimated");
		expect(Object.hasOwn(receipt, "usage")).toBe(false);
		expect(Object.hasOwn(receipt, "cacheWrite1h")).toBe(false);
		const call = audit.events.filter((e) => e.kind === "llm_call").at(-1);
		expect(Object.hasOwn(call?.data as object, "usage")).toBe(false);
	}

	it("a complete report prices from its counts and publishes them, under every label", async () => {
		for (const usageSource of LABELS) {
			const receipt = await settle({ inputTokens: 2000, outputTokens: 500, usageSource });
			expect(receipt.cost).toBe(EST);
			expect(receipt.usageSource).toBe(usageSource ?? "provider");
			expect(receipt.usage).toEqual({
				inputTokens: 2000,
				outputTokens: 500,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			});
		}
	});

	it("an explicit 0 is a usable count: the report is complete", async () => {
		const receipt = await settle({ inputTokens: 0, outputTokens: 500 });
		expect(receipt.cost).toBe(costFromRates(RATES, 0, 500));
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.usage?.inputTokens).toBe(0);
	});

	it("absent cache tiers are 0: a report of input and output alone is complete", async () => {
		const receipt = await settle({ inputTokens: 2000, outputTokens: 500 });
		expect(receipt.usage).toEqual({
			inputTokens: 2000,
			outputTokens: 500,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
	});

	const INCOMPLETE: Array<[string, SettleParams, number]> = [
		["absent input, output 500", { outputTokens: 500 }, costFromRates(RATES, 0, 500)],
		["absent output, input 2000", { inputTokens: 2000 }, costFromRates(RATES, 2000, 0)],
		[
			"NaN output, input 2000",
			{ inputTokens: 2000, outputTokens: Number.NaN },
			costFromRates(RATES, 2000, 0),
		],
		[
			"NaN input, output 500",
			{ inputTokens: Number.NaN, outputTokens: 500 },
			costFromRates(RATES, 0, 500),
		],
		[
			"negative input, output 500",
			{ inputTokens: -2000, outputTokens: 500 },
			costFromRates(RATES, 0, 500),
		],
		[
			"negative output, input 2000",
			{ inputTokens: 2000, outputTokens: -500 },
			costFromRates(RATES, 2000, 0),
		],
		[
			"infinite input, output 500",
			{ inputTokens: Number.POSITIVE_INFINITY, outputTokens: 500 },
			costFromRates(RATES, 0, 500),
		],
		["cache reads alone", { cacheReadTokens: 1000 }, costFromRates(RATES, 0, 0, 1000)],
	];

	for (const [name, params, countsCost] of INCOMPLETE) {
		it(`${name}: the estimate, "estimated", no usage, under every label`, async () => {
			// The usable counts show less than the estimate, so max() picks the estimate.
			expect(countsCost).toBeLessThan(EST);
			for (const usageSource of LABELS) {
				const receipt = await settle({ ...params, ...(usageSource ? { usageSource } : {}) });
				expect(receipt.cost, `${name} [${usageSource}]`).toBe(EST);
				expectEstimateClass(receipt);
			}
		});
	}

	it("max() picks the counts when they show more: input 100000 with no output", async () => {
		const countsCost = costFromRates(RATES, 100_000, 0);
		expect(countsCost).toBeGreaterThan(EST_LOW);
		const receipt = await settle({ inputTokens: 100_000 }, AUTHORIZE_LOW);
		expect(receipt.cost).toBe(countsCost);
		expectEstimateClass(receipt);
	});

	it("max() picks the counts when they show more: a 1,000,000-token cache read alone", async () => {
		// #85's aim: real billable cache counts are never discarded for an estimate below them.
		const countsCost = costFromRates(RATES, 0, 0, 1_000_000);
		expect(countsCost).toBeGreaterThan(EST_LOW);
		const receipt = await settle({ cacheReadTokens: 1_000_000 }, AUTHORIZE_LOW);
		expect(receipt.cost).toBe(countsCost);
		expectEstimateClass(receipt);
	});

	it("a settle with no counts prices at the estimate", async () => {
		const receipt = await settle({});
		expect(receipt.cost).toBe(EST);
		expectEstimateClass(receipt);
	});

	it("an absurd count prices at the estimate exactly, never at max() over it", async () => {
		for (const usageSource of LABELS) {
			const receipt = await settle({
				inputTokens: 2000,
				cacheReadTokens: 1e15,
				...(usageSource ? { usageSource } : {}),
			});
			expect(receipt.cost, String(usageSource)).toBe(EST);
			expectEstimateClass(receipt);
		}
		expect(audit.events.map((e) => e.kind)).toContain("usage_implausible");
	});

	it("an absurd count on a COMPLETE report prices at the estimate exactly", async () => {
		const receipt = await settle({ inputTokens: 2000, outputTokens: 1e15 });
		expect(receipt.cost).toBe(EST);
		expectEstimateClass(receipt);
	});

	it("an absurd 1-hour share alone prices at the estimate exactly (the model has the tier)", async () => {
		const receipt = await settle({
			inputTokens: 2000,
			outputTokens: 500,
			cacheWriteTokens: 1000,
			cacheWrite1hTokens: 1e15,
		});
		expect(receipt.cost).toBe(EST);
		expectEstimateClass(receipt);
	});

	describe("a tiered row (claude-haiku-5-5): an incomplete report is priced no cheaper than the tier authorize held", () => {
		const HAIKU = getModelRates("claude-haiku-5-5");
		/** Authorized with a prompt over the 100,000-token threshold: the dearer tier. */
		const AUTHORIZE_LONG = {
			model: "claude-haiku-5-5",
			estimatedInputTokens: 150_000,
			maxOutputTokens: 10,
		};
		const LOW_OUT = HAIKU.outputPer1k;
		const HIGH_OUT = HAIKU.longPrompt?.rates.outputPer1k ?? Number.NaN;

		it("input missing, output 100,000: the output at the HIGH tier, not the low", async () => {
			const estimate = costFromRates(HAIKU, 150_000, 10);
			// Hand-written: 100,000 output tokens at each tier's output rate.
			const lowTier = (100_000 * LOW_OUT) / 1000;
			const highTier = (100_000 * HIGH_OUT) / 1000;
			expect(lowTier).toBeLessThan(estimate);
			expect(highTier).toBeGreaterThan(estimate);
			for (const usageSource of LABELS) {
				const receipt = await settle(
					{ outputTokens: 100_000, ...(usageSource ? { usageSource } : {}) },
					AUTHORIZE_LONG,
				);
				expect(receipt.cost, String(usageSource)).toBe(highTier);
				expect(receipt.pricing?.appliedRates.outputPer1k).toBe(HIGH_OUT);
				expectEstimateClass(receipt);
			}
		});

		it("CONTROL: a complete report under the threshold keeps the LOW tier, whatever authorize held", async () => {
			const receipt = await settle({ inputTokens: 1000, outputTokens: 100_000 }, AUTHORIZE_LONG);
			expect(receipt.cost).toBe((1000 * HAIKU.inputPer1k) / 1000 + (100_000 * LOW_OUT) / 1000);
			expect(receipt.usageSource).toBe("provider");
			expect(receipt.pricing?.appliedRates.outputPer1k).toBe(LOW_OUT);
			expect(receipt.usage?.outputTokens).toBe(100_000);
		});
	});
});
