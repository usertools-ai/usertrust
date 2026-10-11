// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Per-request prompt tiers (`ModelRates.longPrompt`): Claude Haiku 5.5.
 *
 * Anthropic's pricing page (retrieved 2026-10-11) prices Haiku 5.5 by prompt length, per
 * request: up to 100,000 prompt tokens $0.10 in / $0.50 out / $0.01 cache read / $0.125
 * 5-minute write / $0.20 1-hour write; over 100,000, $0.50 / $2.50 / $0.05 / $0.625 / $1.
 * "A request's prompt length counts all of its input tokens, including cache reads and
 * cache writes. Each request is priced on its own." So: prompt = input + cache reads +
 * cache writes (the 1-hour writes are a subset of the writes), output never counts, and a
 * prompt of exactly 100,000 tokens is the LOWER tier.
 *
 * The tier is decided in ONE place (`promptTierRates`, called by the cost function), so
 * these tests price through the public functions and recompute independently by hand.
 */

import { describe, expect, it } from "vitest";
import {
	costFromRates,
	costFromRatesUnfloored,
	estimateCost,
	getModelRates,
	holdInputRate,
	holdTierRates,
	type ModelRates,
	PRICING_TABLE,
	promptTierRates,
	promptTokenCount,
	resolveAppliedRates,
	resolveCacheWrite1h,
	resolveRates,
	snapshotRates,
} from "../../src/ledger/pricing.js";
import { publishableUsageFields } from "../../src/ledger/usage.js";
import { type TrustConfig, TrustConfigSchema } from "../../src/shared/types.js";

const HAIKU = "claude-haiku-5-5";
const THRESHOLD = 100_000;
// The page's two rows, $/MTok x 10 = usertokens per 1k.
const LOW = {
	inputPer1k: 1,
	outputPer1k: 5,
	cacheReadPer1k: 0.1,
	cacheWritePer1k: 1.25,
	cacheWrite1hPer1k: 2,
};
const HIGH = {
	inputPer1k: 5,
	outputPer1k: 25,
	cacheReadPer1k: 0.5,
	cacheWritePer1k: 6.25,
	cacheWrite1hPer1k: 10,
};

const haiku = (): ModelRates => {
	const r = PRICING_TABLE[HAIKU];
	if (r === undefined) throw new Error("claude-haiku-5-5 is not in the table");
	return r;
};

/** The auditor's formula, by hand, at one explicit rate set. Never through the pricer. */
function byHand(
	rates: typeof LOW,
	input: number,
	output: number,
	read = 0,
	write = 0,
	write1h = 0,
): number {
	const total =
		(input * rates.inputPer1k) / 1000 +
		(output * rates.outputPer1k) / 1000 +
		(read * rates.cacheReadPer1k) / 1000 +
		((write - write1h) * rates.cacheWritePer1k) / 1000 +
		(write1h * rates.cacheWrite1hPer1k) / 1000;
	return Math.max(1, Math.ceil(total));
}

describe("the claude-haiku-5-5 row carries both published tiers", () => {
	it("the row's own rates are the up-to-100,000 tier, and longPrompt is the over-100,000 tier", () => {
		const { longPrompt, ...base } = haiku();
		expect(base).toStrictEqual(LOW);
		expect(longPrompt).toStrictEqual({ thresholdTokens: THRESHOLD, rates: HIGH });
	});

	it("every rate of the higher tier is at or above the lower tier's (a tier never discounts)", () => {
		for (const key of Object.keys(LOW) as (keyof typeof LOW)[]) {
			expect(HIGH[key], key).toBeGreaterThanOrEqual(LOW[key]);
		}
	});

	it("is the only tiered row in the table today", () => {
		const tiered = Object.entries(PRICING_TABLE)
			.filter(([, r]) => r.longPrompt !== undefined)
			.map(([id]) => id);
		expect(tiered).toEqual([HAIKU]);
	});
});

describe("promptTokenCount: all input tokens, never output", () => {
	it("sums fresh input, cache reads and cache writes", () => {
		expect(promptTokenCount(10, 20, 30)).toBe(60);
	});

	it("reads each count the way the cost function does: non-finite or negative is 0", () => {
		expect(promptTokenCount(Number.NaN, -5, Number.POSITIVE_INFINITY)).toBe(0);
		expect(promptTokenCount(100)).toBe(100);
	});
});

describe("promptTierRates: the one tier decision", () => {
	it("a prompt of EXACTLY 100,000 tokens is the lower tier", () => {
		expect(promptTierRates(haiku(), THRESHOLD)).toStrictEqual(LOW);
	});

	it("a prompt of 100,001 tokens is the higher tier", () => {
		expect(promptTierRates(haiku(), THRESHOLD + 1)).toStrictEqual(HIGH);
	});

	it("the result carries no tier, so nothing downstream re-selects", () => {
		expect(promptTierRates(haiku(), 1).longPrompt).toBeUndefined();
		expect(promptTierRates(haiku(), THRESHOLD + 1).longPrompt).toBeUndefined();
	});

	it("an untiered row comes back as the SAME object, so untiered pricing is unchanged", () => {
		const sonnet = getModelRates("claude-sonnet-4-6");
		expect(promptTierRates(sonnet, 5_000_000)).toBe(sonnet);
	});

	it("a tier with an unusable threshold is ignored (priced at the row's own rates)", () => {
		const broken: ModelRates = {
			...LOW,
			longPrompt: { thresholdTokens: Number.NaN, rates: HIGH },
		};
		expect(promptTierRates(broken, 10 * THRESHOLD)).toBe(broken);
	});
});

describe("costFromRates prices each request at the tier its prompt selects", () => {
	it("a small call costs one fifth of what the old flat row charged", () => {
		// 1,000 in + 1,000 out: 1 + 5 = 6 at the lower tier; the old over-100k-only row
		// charged 5 + 25 = 30 for the same call.
		expect(costFromRates(haiku(), 1000, 1000)).toBe(6);
		expect(costFromRates(haiku(), 1000, 1000)).toBe(byHand(LOW, 1000, 1000));
		expect(estimateCost(HAIKU, 1000, 1000)).toBe(6);
	});

	const shapes: Array<{ name: string; at: number[]; over: number[] }> = [
		// [input, output, cacheRead, cacheWrite, cacheWrite1h]
		{ name: "all fresh input", at: [100_000, 50, 0, 0, 0], over: [100_001, 50, 0, 0, 0] },
		{
			name: "crossing ONLY because of cache reads",
			at: [50_000, 50, 50_000, 0, 0],
			over: [50_000, 50, 50_001, 0, 0],
		},
		{
			name: "crossing because of cache writes",
			at: [99_998, 50, 0, 2, 0],
			over: [99_998, 50, 0, 3, 0],
		},
		{
			name: "1-hour writes counted ONCE (a subset of the writes, not added again)",
			at: [90_000, 50, 0, 10_000, 10_000],
			over: [90_000, 50, 0, 10_001, 10_001],
		},
	];
	for (const s of shapes) {
		it(`boundary, ${s.name}: 100,000 → lower tier, 100,001 → higher tier`, () => {
			const [ai, ao, ar, aw, a1] = s.at as [number, number, number, number, number];
			const [oi, oo, or, ow, o1] = s.over as [number, number, number, number, number];
			expect(promptTokenCount(ai, ar, aw)).toBe(THRESHOLD);
			expect(promptTokenCount(oi, or, ow)).toBe(THRESHOLD + 1);
			expect(costFromRates(haiku(), ai, ao, ar, aw, a1)).toBe(byHand(LOW, ai, ao, ar, aw, a1));
			expect(costFromRates(haiku(), oi, oo, or, ow, o1)).toBe(byHand(HIGH, oi, oo, or, ow, o1));
		});
	}

	it("OUTPUT never counts toward the prompt: a huge output on a small prompt stays lower tier", () => {
		expect(costFromRates(haiku(), 1000, 2_000_000)).toBe(byHand(LOW, 1000, 2_000_000));
	});

	it("the unfloored flow meter tiers the same way", () => {
		expect(costFromRatesUnfloored(haiku(), 100_001, 0)).toBeCloseTo(
			(100_001 * HIGH.inputPer1k) / 1000,
			9,
		);
		expect(costFromRatesUnfloored(haiku(), 100_000, 0)).toBeCloseTo(
			(100_000 * LOW.inputPer1k) / 1000,
			9,
		);
	});

	it("a large call over the threshold costs what the old flat row charged (unchanged above 100k)", () => {
		const oldFlat = { ...HIGH };
		expect(costFromRates(haiku(), 150_000, 4000, 20_000, 5000)).toBe(
			byHand(oldFlat, 150_000, 4000, 20_000, 5000),
		);
	});
});

describe("the record publishes the tier that priced the call", () => {
	for (const [label, counts, tier] of [
		["lower tier", [2000, 300, 40_000, 1000], LOW],
		["higher tier", [60_000, 300, 40_000, 1000], HIGH],
	] as const) {
		it(`${label}: resolveAppliedRates(row, prompt) reproduces the cost by the auditor's formula`, () => {
			const [input, output, read, write] = counts;
			const applied = resolveAppliedRates(haiku(), promptTokenCount(input, read, write));
			expect(applied).toStrictEqual({
				inputPer1k: tier.inputPer1k,
				outputPer1k: tier.outputPer1k,
				cacheReadPer1k: tier.cacheReadPer1k,
				cacheWritePer1k: tier.cacheWritePer1k,
			});
			const recompute = Math.max(
				1,
				Math.ceil(
					(input * applied.inputPer1k) / 1000 +
						(output * applied.outputPer1k) / 1000 +
						(read * applied.cacheReadPer1k) / 1000 +
						(write * applied.cacheWritePer1k) / 1000,
				),
			);
			expect(recompute).toBe(costFromRates(haiku(), input, output, read, write));
		});
	}

	it("the 1-hour record carries the 1-hour rate of the call's tier", () => {
		const low = publishableUsageFields(
			{
				inputTokens: 1000,
				outputTokens: 10,
				cacheReadTokens: 0,
				cacheWriteTokens: 500,
				cacheWrite1hTokens: 500,
				source: "provider",
			},
			haiku(),
		);
		expect(low.cacheWrite1h).toStrictEqual({ tokens: 500, ratePer1k: LOW.cacheWrite1hPer1k });
		const high = publishableUsageFields(
			{
				inputTokens: 100_000,
				outputTokens: 10,
				cacheReadTokens: 0,
				cacheWriteTokens: 500,
				cacheWrite1hTokens: 500,
				source: "provider",
			},
			haiku(),
		);
		expect(high.cacheWrite1h).toStrictEqual({ tokens: 500, ratePer1k: HIGH.cacheWrite1hPer1k });
		// The helper itself prices whatever rates it is handed: the TIER is the caller's job.
		expect(resolveCacheWrite1h(haiku(), 500, 500)?.ratePer1k).toBe(LOW.cacheWrite1hPer1k);
	});
});

describe("holds reserve the dearer tier, and always cover the settle", () => {
	it("holdTierRates gives the higher tier, with no tier left to re-select", () => {
		expect(holdTierRates(haiku())).toStrictEqual(HIGH);
		const sonnet = getModelRates("claude-sonnet-4-6");
		expect(holdTierRates(sonnet)).toBe(sonnet);
	});

	it("a hold spread over holdTierRates prices at the higher tier even for a small estimate", () => {
		const hr = holdTierRates(haiku());
		const held = costFromRates({ ...hr, inputPer1k: holdInputRate(hr) }, 1000, 1000);
		// The input leg at the dearest of input, 5m write and 1h write (10), output at 25.
		expect(held).toBe(Math.ceil((1000 * 10) / 1000 + (1000 * 25) / 1000));
	});

	it("sweep 0..250k: a hold sized at an estimate equal to the prompt is never below the settle", () => {
		const hr = holdTierRates(haiku());
		const holdRate = holdInputRate(hr);
		for (let prompt = 0; prompt <= 250_000; prompt += 2_500) {
			for (const output of [0, 1, 4096]) {
				const held = costFromRates({ ...hr, inputPer1k: holdRate }, prompt, output);
				// The prompt split every way the provider might report it.
				for (const [input, read, write] of [
					[prompt, 0, 0],
					[0, prompt, 0],
					[0, 0, prompt],
					[prompt / 2, prompt / 4, prompt / 4],
				] as const) {
					const settled = costFromRates(haiku(), input, output, read, write, write);
					expect(settled, `prompt ${prompt} out ${output}`).toBeLessThanOrEqual(held);
				}
			}
		}
	});
});

describe("snapshotRates is deep-frozen", () => {
	it("a tiered row's snapshot freezes the tier object too, and copies it", () => {
		const snap = snapshotRates(haiku());
		expect(Object.isFrozen(snap)).toBe(true);
		expect(Object.isFrozen(snap.longPrompt)).toBe(true);
		expect(Object.isFrozen(snap.longPrompt?.rates)).toBe(true);
		expect(snap.longPrompt).not.toBe(haiku().longPrompt);
		expect(snap).toStrictEqual(haiku());
	});

	it("an untiered row's snapshot is a frozen copy with the same rates", () => {
		const sonnet = getModelRates("claude-sonnet-4-6");
		const snap = snapshotRates(sonnet);
		expect(Object.isFrozen(snap)).toBe(true);
		expect(snap).not.toBe(sonnet);
		expect(snap).toStrictEqual(sonnet);
	});
});

describe("every built-in tier is dearer than its row, so a hold at the tier covers either", () => {
	const RATE_KEYS = [
		"inputPer1k",
		"outputPer1k",
		"cacheReadPer1k",
		"cacheWritePer1k",
		"cacheWrite1hPer1k",
	] as const;
	const tiered = Object.entries(PRICING_TABLE).filter(([, r]) => r?.longPrompt !== undefined);

	it("the table has at least one tiered row (the check below is not vacuous)", () => {
		expect(tiered.map(([m]) => m)).toContain(HAIKU);
	});

	for (const [model, row] of tiered) {
		it(`${model}: a finite threshold, and every tier rate finite and at least the row's`, () => {
			const tier = row?.longPrompt;
			if (row === undefined || tier === undefined) throw new Error("not tiered");
			expect(Number.isFinite(tier.thresholdTokens) && tier.thresholdTokens >= 0).toBe(true);
			for (const k of RATE_KEYS) {
				const base = row[k];
				const high = tier.rates[k];
				// A category the row prices, the tier prices too, never below it.
				if (base === undefined) continue;
				expect(Number.isFinite(high)).toBe(true);
				expect(high).toBeGreaterThanOrEqual(base);
			}
		});
	}
});

describe("an operator's row is priced FLAT, even one spread from a tiered table row", () => {
	// The shape an operator writes to override a tiered model: spread the table row and change
	// the base rates. The spread carries the table's `longPrompt`, which nothing validates and
	// which is now CHEAPER than the operator's own rates.
	const spread = (): ModelRates => ({ ...haiku(), inputPer1k: 100, outputPer1k: 100 });

	it("getModelRates drops the tier from a custom row", () => {
		const rates = getModelRates(HAIKU, { [HAIKU]: spread() });
		expect(rates.longPrompt).toBeUndefined();
		expect(rates.inputPer1k).toBe(100);
		// A 150,000-token prompt is priced at the operator's rates, not the table's tier.
		expect(costFromRates(rates, 150_000, 100)).toBe(Math.ceil(150_000 * 0.1 + 100 * 0.1));
	});

	it("an untiered custom row is returned as the operator's own object", () => {
		const own: ModelRates = { inputPer1k: 3, outputPer1k: 7 };
		expect(getModelRates("my-model", { "my-model": own })).toBe(own);
	});

	it("resolveRates drops the tier from a custom row and from local-model rates", () => {
		const parsed = TrustConfigSchema.parse({ budget: 1000, pricing: "custom" });
		// Built by hand: the schema would strip the field, and the point is a row that has it.
		const config = {
			...parsed,
			customRates: { [HAIKU]: spread() },
			local: { ...parsed.local, models: { "llama-*": spread() }, defaultRate: spread() },
		} as TrustConfig;
		const cloud = resolveRates(HAIKU, "cloud", config);
		expect(cloud.rateSource).toBe("custom");
		expect(cloud.rates.longPrompt).toBeUndefined();
		const local = resolveRates("llama-3", "local", config);
		expect(local.rateSource).toBe("local-model");
		expect(local.rates.longPrompt).toBeUndefined();
		const fallback = resolveRates("unmatched", "local", config);
		expect(fallback.rateSource).toBe("local-default");
		expect(fallback.rates.longPrompt).toBeUndefined();
	});
});
