// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * RECONCILIATION WITH 1-HOUR CACHE WRITES (#203).
 *
 * The cache-day reconciliation proves an auditor recomputes the metered cost from the
 * record alone. 1-hour cache writes bill at 2x input, not the 5-minute 1.25x, so the
 * four-tier record is no longer enough on its own: the receipt carries a ROOT
 * `cacheWrite1h` ({ tokens, ratePer1k }) beside `usage`, and the recompute splits the
 * write term. This test writes that recompute the way an auditor would, straight from
 * the record's numbers and never through `costFromRates`, and requires it to reproduce
 * `cost` exactly, on the receipt AND on the durable chain event.
 *
 * Sonnet 4.6 (30 in / 150 out / 3 read / 37.5 5m write / 60 1h write per 1k).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLedgerEvents } from "../../src/audit/read.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import type {
	AppliedRates,
	CacheWrite1h,
	ReceiptUsage,
	TrustReceipt,
} from "../../src/shared/types.js";

const MODEL = "claude-sonnet-4-6";

function makeOpenEngine(): TrustEngine {
	return {
		spendPending: vi.fn(async () => {}),
		postPendingSpend: vi.fn(async (_id: string, amount: number) => ({
			posted: amount,
			shortfall: 0,
		})),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(async () => {}),
	} as unknown as TrustEngine;
}

/** The auditor: the record's own numbers, with the write term split on `cacheWrite1h`. */
function recompute(usage: ReceiptUsage, rates: AppliedRates, oneHour: CacheWrite1h | undefined) {
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

describe("reconciliation: 1-hour cache writes", () => {
	let tmpVault: string;
	beforeEach(() => {
		tmpVault = join(tmpdir(), `recon-1h-${randomUUID()}`);
		mkdirSync(tmpVault, { recursive: true });
	});
	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	async function call(usage: Record<string, unknown>) {
		const create = vi.fn(async (_params?: unknown) => ({
			id: "msg_1h",
			type: "message",
			role: "assistant",
			model: MODEL,
			content: [{ type: "text", text: "ok" }],
			stop_reason: "end_turn",
			usage,
		}));
		const governed = await trust(
			{ messages: { create } },
			{ budget: 50_000_000, vaultBase: tmpVault, _engine: makeOpenEngine() },
		);
		const { receipt } = (await governed.messages.create({
			model: MODEL,
			max_tokens: 1024,
			messages: [{ role: "user", content: "hi" }],
		})) as { receipt: TrustReceipt };
		await governed.destroy();
		return receipt;
	}

	it("a call with 1h writes: the split recompute reproduces cost on the receipt and the chain", async () => {
		// 100 in, 200 out, 10,000 read, 20,000 written of which 8,000 are 1-HOUR.
		//  100x30 + 200x150 + 10,000x3 + 12,000x37.5 + 8,000x60 = 3,000 + 30,000 + 30,000 + 450,000 + 480,000
		//  = 993,000 / 1000 = 993.
		const receipt = await call({
			input_tokens: 100,
			output_tokens: 200,
			cache_read_input_tokens: 10_000,
			cache_creation_input_tokens: 20_000,
			cache_creation: { ephemeral_5m_input_tokens: 12_000, ephemeral_1h_input_tokens: 8_000 },
		});
		expect(receipt.cost).toBe(993);
		expect(receipt.usage?.cacheWriteTokens).toBe(20_000);
		expect(receipt.cacheWrite1h).toEqual({ tokens: 8_000, ratePer1k: 60 });
		const usage = receipt.usage as ReceiptUsage;
		const rates = receipt.pricing?.appliedRates as AppliedRates;
		expect(recompute(usage, rates, receipt.cacheWrite1h)).toBe(receipt.cost);
		// And the proof that the OLD record was insufficient: without the split, the
		// four-tier recompute at the flat 5-minute rate understates this call by 8,000 x 22.5/1k.
		expect(recompute(usage, rates, undefined)).toBe(813);

		const events = await readLedgerEvents(join(tmpVault, VAULT_DIR));
		const llm = events.filter((e) => e.kind === "llm_call");
		expect(llm).toHaveLength(1);
		const data = llm[0]?.data as Record<string, unknown>;
		expect(data.cacheWrite1h).toEqual({ tokens: 8_000, ratePer1k: 60 });
		expect(
			recompute(
				data.usage as ReceiptUsage,
				data.appliedRates as AppliedRates,
				data.cacheWrite1h as CacheWrite1h,
			),
		).toBe(data.cost);
	});

	it("a 5-minute-only call is byte-identical to before: no cacheWrite1h key anywhere", async () => {
		const receipt = await call({
			input_tokens: 100,
			output_tokens: 200,
			cache_read_input_tokens: 10_000,
			cache_creation_input_tokens: 20_000,
			cache_creation: { ephemeral_5m_input_tokens: 20_000, ephemeral_1h_input_tokens: 0 },
		});
		expect("cacheWrite1h" in receipt).toBe(false);
		expect(Object.keys(receipt.usage ?? {}).sort()).toEqual([
			"cacheReadTokens",
			"cacheWriteTokens",
			"inputTokens",
			"outputTokens",
		]);
		const usage = receipt.usage as ReceiptUsage;
		const rates = receipt.pricing?.appliedRates as AppliedRates;
		expect(recompute(usage, rates, undefined)).toBe(receipt.cost);
		const events = await readLedgerEvents(join(tmpVault, VAULT_DIR));
		const data = events.find((e) => e.kind === "llm_call")?.data as Record<string, unknown>;
		expect("cacheWrite1h" in data).toBe(false);
	});

	it("a 1h count larger than the write total clamps to it", async () => {
		const receipt = await call({
			input_tokens: 1,
			output_tokens: 1,
			cache_creation_input_tokens: 1_000,
			cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 9_999 },
		});
		// The extractor sums the breakdown into the write total, so 9,999 are all 1h.
		expect(receipt.cacheWrite1h?.tokens).toBe(receipt.usage?.cacheWriteTokens);
		const usage = receipt.usage as ReceiptUsage;
		const rates = receipt.pricing?.appliedRates as AppliedRates;
		expect(recompute(usage, rates, receipt.cacheWrite1h)).toBe(receipt.cost);
	});
});
