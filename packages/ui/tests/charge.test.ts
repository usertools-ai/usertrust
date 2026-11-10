// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { type Charge, chargeOf, TIERS } from "../src/shared/charge.js";
import type { LedgerRow } from "../src/shared/rows.js";

type Inputs = Parameters<typeof chargeOf>[0];

const USAGE = {
	inputTokens: 1000,
	outputTokens: 500,
	cacheReadTokens: 2000,
	cacheWriteTokens: 100,
};
const RATES = { inputPer1k: 30, outputPer1k: 150, cacheReadPer1k: 3, cacheWritePer1k: 37.5 };
const NO_TOKENS = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** The first fixture: 30 + 75 + 6 + 3.75 = 114.75 usertokens, charged as 115. */
function fixture(overrides: Partial<Inputs> = {}): Inputs {
	return { costUt: 115, usage: USAGE, appliedRates: RATES, ...overrides };
}

const utTexts = (c: Charge) => c.lines.map((l) => l.utText);

describe("chargeOf", () => {
	it("the tiers are input, output, cache read, cache write, in that order", () => {
		expect(TIERS).toEqual(["input", "output", "cacheRead", "cacheWrite"]);
		const lines = chargeOf(fixture()).lines;
		expect(lines.map((l) => l.tier)).toEqual(["input", "output", "cacheRead", "cacheWrite"]);
		expect(lines.map((l) => l.label)).toEqual(["Input", "Output", "Cache read", "Cache write"]);
		// Four lines whatever the record carries.
		expect(chargeOf({}).lines.map((l) => l.tier)).toEqual([...TIERS]);
	});

	it("adds up: each tier's count, rate and product, the exact sum, and the whole usertokens charged", () => {
		const one = (count: number, ratePer1k: number, utText: string, usdText: string) => ({
			count,
			ratePer1k,
			parts: [{ label: null, count, ratePer1k, utText, usdText }],
			utText,
			usdText,
		});
		expect(chargeOf(fixture({ pricingTableVersion: "2026-11-02" }))).toEqual({
			state: "priced",
			lines: [
				{ tier: "input", label: "Input", ...one(1000, 30, "30", "$0.0030") },
				{ tier: "output", label: "Output", ...one(500, 150, "75", "$0.0075") },
				{ tier: "cacheRead", label: "Cache read", ...one(2000, 3, "6", "$0.0006") },
				{ tier: "cacheWrite", label: "Cache write", ...one(100, 37.5, "3.75", "$0.000375") },
			],
			sumText: "114.75",
			computedUt: 115,
			costUt: 115,
			differenceUt: 0,
			version: "2026-11-02",
		});
	});

	it("order, not residue: 560 tokens at 12.5 is exactly 7 when multiplied before dividing", () => {
		const c = chargeOf({
			costUt: 7,
			usage: { ...NO_TOKENS, inputTokens: 560 },
			appliedRates: { ...RATES, inputPer1k: 12.5 },
		});
		// (560 / 1000) * 12.5 leaves a residue above 7 and would round up to 8.
		expect(c.computedUt).toBe(7);
		expect(c.differenceUt).toBe(0);
		expect(c.sumText).toBe("7");
	});

	it("agrees with the charge where the terms leave a residue: the exact sum is 3, the charge is 4", () => {
		// 0.003 + 2.91 + 0.087 is 3 in decimals. Summed as the charge was made it lands just above 3, so 4 was charged.
		const c = chargeOf({
			costUt: 4,
			usage: { inputTokens: 1, outputTokens: 194, cacheReadTokens: 290, cacheWriteTokens: 0 },
			appliedRates: { inputPer1k: 3, outputPer1k: 15, cacheReadPer1k: 0.3, cacheWritePer1k: 3.75 },
		});
		expect(utTexts(c)).toEqual(["0.003", "2.91", "0.087", "0"]);
		expect(c.sumText).toBe("3");
		expect(c.computedUt).toBe(4);
		expect(c.differenceUt).toBe(0);
	});

	it("sums the terms in the order input, output, cache read, cache write", () => {
		// The same three products come to exactly 3 summed from the other end, or with the last two added first; in
		// this order, one at a time, they come to just above it.
		const c = chargeOf({
			costUt: 4,
			usage: { inputTokens: 41, outputTokens: 186, cacheReadTokens: 290, cacheWriteTokens: 0 },
			appliedRates: { inputPer1k: 3, outputPer1k: 15, cacheReadPer1k: 0.3, cacheWritePer1k: 3.75 },
		});
		expect(c.sumText).toBe("3");
		expect(c.computedUt).toBe(4);
		expect(c.differenceUt).toBe(0);
	});

	it("rounds a part of a usertoken up, never to the nearest", () => {
		const c = chargeOf({
			costUt: 31,
			usage: { ...NO_TOKENS, inputTokens: 1000, outputTokens: 250 },
			appliedRates: { ...RATES, outputPer1k: 1 },
		});
		expect(c.sumText).toBe("30.25");
		expect(c.computedUt).toBe(31);
		expect(c.differenceUt).toBe(0);
	});

	it("floor: a charge of no tokens is 1 usertoken, and the exact sum still says 0", () => {
		const c = chargeOf({ costUt: 1, usage: NO_TOKENS, appliedRates: RATES });
		expect(c.state).toBe("priced");
		expect(utTexts(c)).toEqual(["0", "0", "0", "0"]);
		expect(c.lines.map((l) => l.usdText)).toEqual(["$0.0000", "$0.0000", "$0.0000", "$0.0000"]);
		expect(c.sumText).toBe("0");
		expect(c.computedUt).toBe(1);
		expect(c.differenceUt).toBe(0);
	});

	describe("a 1-hour cache write", () => {
		const write = (tokens: number, costUt: number) =>
			chargeOf({
				costUt,
				usage: { ...NO_TOKENS, cacheWriteTokens: 2000 },
				appliedRates: RATES,
				cacheWrite1h: { tokens, ratePer1k: 60 },
			});

		it("is two terms: the 5-minute remainder at the write rate, the 1-hour share at its own rate", () => {
			const c = write(500, 87);
			expect(c.lines[3]).toEqual({
				tier: "cacheWrite",
				label: "Cache write",
				count: 2000,
				ratePer1k: 37.5,
				parts: [
					{
						label: "5-minute",
						count: 1500,
						ratePer1k: 37.5,
						utText: "56.25",
						usdText: "$0.005625",
					},
					{ label: "1-hour", count: 500, ratePer1k: 60, utText: "30", usdText: "$0.0030" },
				],
				utText: "86.25",
				usdText: "$0.008625",
			});
			expect(c.state).toBe("priced");
			expect(c.sumText).toBe("86.25");
			expect(c.computedUt).toBe(87);
			expect(c.differenceUt).toBe(0);
		});

		it("splits the write tier only: every other tier stays one term", () => {
			expect(write(500, 87).lines.map((l) => l.parts.map((p) => p.label))).toEqual([
				[null],
				[null],
				[null],
				["5-minute", "1-hour"],
			]);
		});

		it("the two terms join the sum one at a time, after the other tiers", () => {
			// 1.155 + 0.915 + 0.93 is 3 in decimals. Term by term it lands just above 3; with the two write terms
			// added to each other first it lands on 3.
			const c = chargeOf({
				costUt: 4,
				usage: { ...NO_TOKENS, inputTokens: 385, cacheWriteTokens: 399 },
				appliedRates: { ...RATES, inputPer1k: 3, cacheWritePer1k: 3.75 },
				cacheWrite1h: { tokens: 155, ratePer1k: 6 },
			});
			expect(c.lines[3]?.parts.map((p) => p.utText)).toEqual(["0.915", "0.93"]);
			expect(c.sumText).toBe("3");
			expect(c.computedUt).toBe(4);
			expect(c.differenceUt).toBe(0);
		});

		it("a share above the write count is the whole write count, and nothing is left at the 5-minute rate", () => {
			const c = write(5000, 120);
			expect(c.lines[3]?.parts).toEqual([
				{ label: "5-minute", count: 0, ratePer1k: 37.5, utText: "0", usdText: "$0.0000" },
				{ label: "1-hour", count: 2000, ratePer1k: 60, utText: "120", usdText: "$0.0120" },
			]);
			expect(c.lines[3]?.utText).toBe("120");
			expect(c.computedUt).toBe(120);
			expect(c.differenceUt).toBe(0);
		});

		it("a recorded share of 0 keeps both terms", () => {
			const c = write(0, 75);
			expect(c.lines[3]?.parts.map((p) => [p.label, p.count, p.utText])).toEqual([
				["5-minute", 2000, "75"],
				["1-hour", 0, "0"],
			]);
			expect(c.computedUt).toBe(75);
		});

		it("a share or a 1-hour rate that is not a usable number leaves the write tier unpriced", () => {
			for (const cacheWrite1h of [
				{ tokens: Number.NaN, ratePer1k: 60 },
				{ tokens: 1.5, ratePer1k: 60 },
				{ tokens: 500, ratePer1k: -1 },
				{ tokens: 500 },
			]) {
				const c = chargeOf({
					...fixture(),
					cacheWrite1h: cacheWrite1h as NonNullable<LedgerRow["cacheWrite1h"]>,
				});
				expect(c.state).toBe("partial");
				expect(c.lines[3]).toMatchObject({ count: 100, ratePer1k: 37.5, parts: [], utText: null });
				expect(c.computedUt).toBeNull();
			}
		});
	});

	it("a difference is shown, with its sign, and the charge is still priced", () => {
		const higher = chargeOf(fixture({ costUt: 120 }));
		expect(higher.differenceUt).toBe(5);
		expect(higher.computedUt).toBe(115);
		expect(higher.costUt).toBe(120);
		expect(higher.state).toBe("priced");
		const lower = chargeOf(fixture({ costUt: 112 }));
		expect(lower.differenceUt).toBe(-3);
		expect(lower.state).toBe("priced");
	});

	it("a recorded cost of 0 is a cost: the charge is priced and the difference shown", () => {
		const c = chargeOf({ costUt: 0, usage: NO_TOKENS, appliedRates: RATES });
		expect(c.state).toBe("priced");
		expect(c.costUt).toBe(0);
		expect(c.computedUt).toBe(1);
		expect(c.differenceUt).toBe(-1);
	});

	describe("the text is exact", () => {
		const input = (inputTokens: number, inputPer1k: number) =>
			chargeOf({
				costUt: 1,
				usage: { ...NO_TOKENS, inputTokens },
				appliedRates: { ...RATES, inputPer1k },
			}).lines[0];

		it("fractions: 7 tokens at 5", () => {
			expect(input(7, 5)).toMatchObject({ utText: "0.035", usdText: "$0.0000035" });
		});

		it("a fractional rate prints as its decimal, with no residue", () => {
			// As floats, (3 * 0.3) / 1000 is 0.0008999999999999999.
			expect(input(3, 0.3)).toEqual({
				tier: "input",
				label: "Input",
				count: 3,
				ratePer1k: 0.3,
				parts: [
					{ label: null, count: 3, ratePer1k: 0.3, utText: "0.0009", usdText: "$0.00000009" },
				],
				utText: "0.0009",
				usdText: "$0.00000009",
			});
			expect(input(3, 1.005)).toMatchObject({ utText: "0.003015" });
		});

		it("a rate with many digits is exact, small or large", () => {
			expect(input(1000, 0.000000000001)).toMatchObject({
				utText: "0.000000000001",
				usdText: "$0.0000000000000001",
			});
			expect(input(2, 1.5e-7)).toMatchObject({ utText: "0.0000000003" });
			// A float this large cannot hold .9 exactly; the text is the rate as recorded, not its binary residue.
			expect(input(1, 12_345_678.9)).toMatchObject({ utText: "12345.6789" });
		});

		it("dollars keep at least 4 decimals and group their whole part; usertokens are plain digits", () => {
			expect(input(2_000_000, 15_000)).toMatchObject({
				utText: "30000000",
				usdText: "$3,000.0000",
			});
			expect(input(1_234_567, 1000)).toMatchObject({
				utText: "1234567",
				usdText: "$123.4567",
			});
			expect(input(1_000_000, 12_345_678.9)).toMatchObject({
				utText: "12345678900",
				usdText: "$1,234,567.8900",
			});
		});

		it("a rate a number prints with an exponent is still exact", () => {
			expect(input(1, 1e21)).toMatchObject({
				utText: "1000000000000000000",
				usdText: "$100,000,000,000,000.0000",
			});
		});
	});

	it("absent is not 0: a tier with no count has no product, and nothing is summed", () => {
		const { cacheReadTokens: _absent, ...usage } = USAGE;
		const c = chargeOf(fixture({ usage }));
		expect(c.state).toBe("partial");
		expect(c.lines[2]).toEqual({
			tier: "cacheRead",
			label: "Cache read",
			count: null,
			ratePer1k: 3,
			parts: [],
			utText: null,
			usdText: null,
		});
		// The tiers that can be priced still are.
		expect(utTexts(c)).toEqual(["30", "75", null, "3.75"]);
		expect(c.sumText).toBeNull();
		expect(c.computedUt).toBeNull();
		expect(c.differenceUt).toBeNull();
		expect(c.costUt).toBe(115);
	});

	it("absent is not 0: a tier with no rate has no product either", () => {
		const { outputPer1k: _absent, ...appliedRates } = RATES;
		const c = chargeOf(fixture({ appliedRates }));
		expect(c.state).toBe("partial");
		expect(c.lines[1]).toMatchObject({ count: 500, ratePer1k: null, parts: [], utText: null });
		expect(c.sumText).toBeNull();
		expect(c.computedUt).toBeNull();
		expect(c.differenceUt).toBeNull();
	});

	it("0 is not absent: a recorded count of 0 is priced as 0", () => {
		const c = chargeOf(fixture({ costUt: 109, usage: { ...USAGE, cacheReadTokens: 0 } }));
		expect(c.state).toBe("priced");
		expect(c.lines[2]).toMatchObject({ count: 0, ratePer1k: 3, utText: "0", usdText: "$0.0000" });
		expect(c.lines[2]?.parts).toHaveLength(1);
		expect(c.sumText).toBe("108.75");
		expect(c.computedUt).toBe(109);
		expect(c.differenceUt).toBe(0);
	});

	it("0 is not absent: a recorded rate of 0 is priced as 0", () => {
		const c = chargeOf(fixture({ costUt: 40, appliedRates: { ...RATES, outputPer1k: 0 } }));
		expect(c.state).toBe("priced");
		expect(c.lines[1]).toMatchObject({ count: 500, ratePer1k: 0, utText: "0" });
		expect(c.sumText).toBe("39.75");
		expect(c.differenceUt).toBe(0);
	});

	it("rates only: a cost and rates but no usage is no-counts, with the rates present", () => {
		const c = chargeOf({ costUt: 115, appliedRates: RATES });
		expect(c.state).toBe("no-counts");
		expect(c.lines.map((l) => l.count)).toEqual([null, null, null, null]);
		expect(c.lines.map((l) => l.ratePer1k)).toEqual([30, 150, 3, 37.5]);
		expect(utTexts(c)).toEqual([null, null, null, null]);
		expect(c.sumText).toBeNull();
		expect(c.computedUt).toBeNull();
		expect(c.differenceUt).toBeNull();
		// A usage block that carries none of the four counts is no counts too.
		expect(chargeOf({ costUt: 115, usage: {}, appliedRates: RATES }).state).toBe("no-counts");
		expect(chargeOf({ costUt: 115 }).state).toBe("no-counts");
	});

	it("counts only: one recorded count and no rates is partial, never no-counts", () => {
		const c = chargeOf({ costUt: 115, usage: { outputTokens: 500 } });
		expect(c.state).toBe("partial");
		expect(c.lines.map((l) => l.count)).toEqual([null, 500, null, null]);
		expect(c.lines.map((l) => l.ratePer1k)).toEqual([null, null, null, null]);
	});

	it("a count or rate that is not a usable number is not recorded, and nothing throws", () => {
		for (const inputTokens of [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY]) {
			const c = chargeOf(fixture({ usage: { ...USAGE, inputTokens } }));
			expect(c.state).toBe("partial");
			expect(c.lines[0]).toMatchObject({ count: null, ratePer1k: 30, parts: [], utText: null });
		}
		for (const inputPer1k of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
			const c = chargeOf(fixture({ appliedRates: { ...RATES, inputPer1k } }));
			expect(c.state).toBe("partial");
			expect(c.lines[0]).toMatchObject({ count: 1000, ratePer1k: null, parts: [], utText: null });
		}
	});

	it("no cost: nothing to add up to, whatever else the record carries", () => {
		const { costUt: _none, ...rest } = fixture();
		const c = chargeOf(rest);
		expect(c.state).toBe("none");
		expect(c.costUt).toBeNull();
		expect(c.sumText).toBeNull();
		expect(c.computedUt).toBeNull();
		expect(c.differenceUt).toBeNull();
		expect(chargeOf({}).state).toBe("none");
	});

	it("version: the pricing table version passes through, and an absent one is null", () => {
		expect(chargeOf(fixture({ pricingTableVersion: "2026-11-02" })).version).toBe("2026-11-02");
		expect(chargeOf(fixture()).version).toBeNull();
	});
});
