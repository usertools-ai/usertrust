import { readFileSync } from "node:fs";
import { getNiceTickValues } from "recharts";
import { describe, expect, it } from "vitest";
import { formatUsdAxis, Y_AXIS_ALLOW_DECIMALS } from "../src/shared/format.js";

// The chart's tick generator, as the cost axis calls it (domain from 0 to the tallest bucket, the default 5 ticks).
const labels = (maxUt: number, allowDecimals: boolean) =>
	getNiceTickValues([0, maxUt], 5, allowDecimals).map((t: number) => formatUsdAxis(t));

describe("the cost axis", () => {
	it("with a 1 UT tallest bucket, every tick label is distinct", () => {
		const shown = labels(1, Y_AXIS_ALLOW_DECIMALS);
		expect(new Set(shown).size).toBe(shown.length);
		expect(shown).toContain("$0.0001");
	});

	it("positive control: with decimals allowed, the same axis repeats its labels (the check can see the bug)", () => {
		const shown = labels(1, true);
		expect(new Set(shown).size).toBeLessThan(shown.length);
	});

	it("labels stay distinct across small and large tallest buckets", () => {
		for (const max of [1, 2, 3, 7, 40, 99, 100, 3_800, 76_045]) {
			const shown = labels(max, Y_AXIS_ALLOW_DECIMALS);
			expect(new Set(shown).size, `max ${max}: ${shown.join(" ")}`).toBe(shown.length);
		}
	});

	it("the chart's YAxis is wired to the constant", () => {
		const src = readFileSync(new URL("../src/app/trends.tsx", import.meta.url), "utf8");
		expect(src).toMatch(/<YAxis[^>]*allowDecimals=\{Y_AXIS_ALLOW_DECIMALS\}/s);
	});
});
