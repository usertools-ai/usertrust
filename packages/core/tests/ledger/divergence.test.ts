import { describe, expect, it } from "vitest";
import { computeDivergence } from "../../src/ledger/divergence.js";

describe("computeDivergence", () => {
	it("provider, ratio 1 → present, flagged false", () => {
		const d = computeDivergence(100, 100, "provider", 4);
		expect(d).toEqual({ ratio: 1, estimatedCost: 100, actualCost: 100, flagged: false });
	});

	it("provider, ratio 8 (blowout) → flagged", () => {
		const d = computeDivergence(100, 800, "provider", 4);
		expect(d).toBeDefined();
		expect(d?.ratio).toBe(8);
		expect(d?.flagged).toBe(true);
	});

	it("provider, ratio 0.1 (under-reporting server) → flagged", () => {
		const d = computeDivergence(100, 10, "provider", 4);
		expect(d).toBeDefined();
		expect(d?.ratio).toBeCloseTo(0.1, 10);
		expect(d?.flagged).toBe(true);
	});

	it("usageSource 'estimated' → undefined (nothing to compare)", () => {
		expect(computeDivergence(100, 100, "estimated", 4)).toBeUndefined();
		expect(computeDivergence(100, 900, "estimated", 4)).toBeUndefined();
	});

	it("estimatedCost 0 → undefined", () => {
		expect(computeDivergence(0, 50, "provider", 4)).toBeUndefined();
	});

	it("negative estimatedCost → undefined", () => {
		expect(computeDivergence(-100, 50, "provider", 4)).toBeUndefined();
	});

	it("non-finite actual → undefined, never a NaN ratio", () => {
		expect(computeDivergence(100, Number.NaN, "provider", 4)).toBeUndefined();
		expect(computeDivergence(100, Number.POSITIVE_INFINITY, "provider", 4)).toBeUndefined();
	});

	it("non-finite estimate → undefined", () => {
		expect(computeDivergence(Number.NaN, 100, "provider", 4)).toBeUndefined();
		expect(computeDivergence(Number.POSITIVE_INFINITY, 100, "provider", 4)).toBeUndefined();
	});

	it("negative actual → undefined", () => {
		expect(computeDivergence(100, -5, "provider", 4)).toBeUndefined();
	});

	it("boundary: ratio exactly === factor is NOT flagged", () => {
		const d = computeDivergence(100, 400, "provider", 4);
		expect(d?.ratio).toBe(4);
		expect(d?.flagged).toBe(false);
	});

	it("boundary: ratio just above factor IS flagged", () => {
		const d = computeDivergence(100, 401, "provider", 4);
		expect(d?.flagged).toBe(true);
	});

	it("boundary: ratio exactly === 1/factor is NOT flagged", () => {
		const d = computeDivergence(100, 25, "provider", 4);
		expect(d?.ratio).toBe(0.25);
		expect(d?.flagged).toBe(false);
	});

	it("boundary: ratio just below 1/factor IS flagged", () => {
		const d = computeDivergence(100, 24, "provider", 4);
		expect(d?.flagged).toBe(true);
	});

	it("non-finite/non-positive factor falls back to default 4", () => {
		// factor NaN → treated as 4 → ratio 8 flagged
		expect(computeDivergence(100, 800, "provider", Number.NaN)?.flagged).toBe(true);
		// factor 0 → treated as 4 → ratio 2 not flagged
		expect(computeDivergence(100, 200, "provider", 0)?.flagged).toBe(false);
	});

	it("actual 0 (provider reported zero usage) → present, ratio 0, flagged", () => {
		const d = computeDivergence(100, 0, "provider", 4);
		expect(d).toBeDefined();
		expect(d?.ratio).toBe(0);
		// 0 < 1/4 → flagged (extreme under-report)
		expect(d?.flagged).toBe(true);
	});

	it("ratio is always finite when a result is returned", () => {
		for (const [est, act] of [
			[1, 1],
			[100, 1],
			[1, 1_000_000],
			[7, 13],
		] as const) {
			const d = computeDivergence(est, act, "provider", 4);
			expect(d).toBeDefined();
			expect(Number.isFinite(d?.ratio)).toBe(true);
		}
	});
});
