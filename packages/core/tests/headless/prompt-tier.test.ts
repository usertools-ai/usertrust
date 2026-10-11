// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Per-request prompt tiers through `createGovernor()` (Claude Haiku 5.5, `longPrompt`).
 *
 * - `authorize` holds at the DEARER tier: its prompt length is an estimate.
 * - `settle` with reported counts prices AND publishes the tier the reported prompt
 *   (input + cache reads + cache writes) selects; over 100,000 → the higher tier.
 * - `settle` with no counts settles on the estimate, and publishes the tier that estimate
 *   selected, so the published rates still describe the cost.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { createGovernor, type Governor } from "../../src/headless.js";
import { costFromRates, getModelRates } from "../../src/ledger/pricing.js";
import type {
	AppliedRates,
	AuditEvent,
	ReceiptUsage,
	TrustReceipt,
} from "../../src/shared/types.js";

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

const MODEL = "claude-haiku-5-5";
const LOW: AppliedRates = {
	inputPer1k: 1,
	outputPer1k: 5,
	cacheReadPer1k: 0.1,
	cacheWritePer1k: 1.25,
};
const HIGH: AppliedRates = {
	inputPer1k: 5,
	outputPer1k: 25,
	cacheReadPer1k: 0.5,
	cacheWritePer1k: 6.25,
};

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

/** The auditor's formula, from the record alone. Never through the pricer. */
function recomputeCost(usage: ReceiptUsage, rates: AppliedRates): number {
	const total =
		(usage.inputTokens * rates.inputPer1k) / 1000 +
		(usage.outputTokens * rates.outputPer1k) / 1000 +
		(usage.cacheReadTokens * rates.cacheReadPer1k) / 1000 +
		(usage.cacheWriteTokens * rates.cacheWritePer1k) / 1000;
	return Math.max(1, Math.ceil(total));
}

function expectRecomputable(receipt: TrustReceipt): void {
	const usage = receipt.usage;
	const applied = receipt.pricing?.appliedRates;
	if (usage === undefined || applied === undefined) throw new Error("receipt not recomputable");
	expect(recomputeCost(usage, applied)).toBe(receipt.cost);
}

describe("headless: Haiku 5.5 per-request prompt tiers", () => {
	let vaultBase: string;
	let audit: AuditWriter & { events: AppendEventInput[] };

	beforeEach(() => {
		vaultBase = join(tmpdir(), `prompt-tier-headless-${randomUUID()}`);
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
		return await createGovernor({ dryRun: true, budget: 100_000_000, vaultBase, _audit: audit });
	}

	it("authorize holds at the DEARER tier: an estimated prompt cannot know its side of the threshold", async () => {
		const gov = await governor();
		const auth = await gov.authorize({
			model: MODEL,
			estimatedInputTokens: 10_000,
			maxOutputTokens: 1,
		});
		// The input leg at the higher tier's dearest input rate (its 1-hour write, 10/1k):
		// 10,000 x 10 / 1000 = 100, plus 1 output token at 25/1k → ceil(100.025) = 101.
		// Held at the lower tier it would be ceil(10,000 x 2 / 1000 + 0.005) = 21.
		expect(auth.estimatedCost).toBe(101);
		await gov.destroy();
	});

	it("a reported prompt of 100,000 settles and publishes the lower tier", async () => {
		const gov = await governor();
		// An estimate large enough that the hold covers the settle (no overage in play).
		const auth = await gov.authorize({
			model: MODEL,
			estimatedInputTokens: 120_000,
			maxOutputTokens: 200,
		});
		const receipt = await gov.settle(auth, {
			inputTokens: 40_000,
			outputTokens: 200,
			cacheReadTokens: 50_000,
			cacheWriteTokens: 10_000,
		});
		expect(receipt.pricing?.appliedRates).toEqual(LOW);
		expectRecomputable(receipt);
		await gov.destroy();
	});

	it("a reported prompt of 100,001 settles and publishes the higher tier, the chain event too", async () => {
		const gov = await governor();
		// An estimate large enough that the hold covers the settle (no overage in play).
		const auth = await gov.authorize({
			model: MODEL,
			estimatedInputTokens: 120_000,
			maxOutputTokens: 200,
		});
		const receipt = await gov.settle(auth, {
			inputTokens: 40_001,
			outputTokens: 200,
			cacheReadTokens: 50_000,
			cacheWriteTokens: 10_000,
		});
		expect(receipt.pricing?.appliedRates).toEqual(HIGH);
		expectRecomputable(receipt);
		const data = audit.events.find((e) => e.kind === "llm_call")?.data as Record<string, unknown>;
		expect(data.appliedRates).toEqual(HIGH);
		await gov.destroy();
	});

	for (const [estimate, tier, label] of [
		[10_000, LOW, "lower"],
		[150_000, HIGH, "higher"],
	] as const) {
		it(`a settle with NO counts settles on the estimate and publishes the ${label} tier it selected`, async () => {
			const gov = await governor();
			const auth = await gov.authorize({
				model: MODEL,
				estimatedInputTokens: estimate,
				maxOutputTokens: 1,
			});
			const receipt = await gov.settle(auth);
			expect(receipt.usageSource).toBe("estimated");
			expect(receipt.cost).toBe(costFromRates(getModelRates(MODEL), estimate, 1));
			expect(receipt.pricing?.appliedRates).toEqual(tier);
			// The published rates describe the cost: the estimate priced at them reproduces it.
			expect(
				Math.max(1, Math.ceil((estimate * tier.inputPer1k) / 1000 + tier.outputPer1k / 1000)),
			).toBe(receipt.cost);
			await gov.destroy();
		});
	}
});
