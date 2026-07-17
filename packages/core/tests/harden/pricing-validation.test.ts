import { describe, expect, it } from "vitest";
import { estimateCost } from "../../src/ledger/pricing.js";

const MODEL = "claude-sonnet-4-6";

describe("estimateCost input validation (Finding: NaN/negative token counts)", () => {
	it("treats a NaN token count as 0 instead of poisoning the estimate with NaN", () => {
		const cost = estimateCost(MODEL, Number.NaN, 500);
		expect(Number.isFinite(cost)).toBe(true);
		// NaN input clamps to 0, so the estimate equals the output-only cost.
		expect(cost).toBe(estimateCost(MODEL, 0, 500));
	});

	it("does not let a negative token count collapse a real cost to the floor of 1", () => {
		const cost = estimateCost(MODEL, 1_000_000, -10_000_000);
		expect(Number.isFinite(cost)).toBe(true);
		// Negative output clamps to 0; the large positive input cost must survive.
		expect(cost).toBe(estimateCost(MODEL, 1_000_000, 0));
		expect(cost).toBeGreaterThan(1);
	});

	it("clamps a non-finite (Infinity) token count instead of returning Infinity", () => {
		const cost = estimateCost(MODEL, Number.POSITIVE_INFINITY, 0);
		expect(Number.isFinite(cost)).toBe(true);
		expect(cost).toBe(1);
	});

	it("still floors zero-token calls to 1 (unchanged behavior)", () => {
		expect(estimateCost(MODEL, 0, 0)).toBe(1);
	});
});
