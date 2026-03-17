/**
 * Decay Rate Calculator Tests
 *
 * Tests for exponential decay, configurable half-life,
 * weighted sum over timestamped entries, and convenience functions.
 */

import { describe, expect, it } from "vitest";
import {
	DecayRateCalculator,
	type TimestampedEntry,
	calculateDecayRate,
	createCostDecayCalculator,
} from "../../src/policy/decay.js";

// ===========================================================================
// DecayRateCalculator
// ===========================================================================

describe("DecayRateCalculator", () => {
	describe("constructor", () => {
		it("throws on zero half-life", () => {
			expect(() => new DecayRateCalculator({ halfLifeMs: 0 })).toThrow(
				"Half-life must be positive",
			);
		});

		it("throws on negative half-life", () => {
			expect(() => new DecayRateCalculator({ halfLifeMs: -1000 })).toThrow(
				"Half-life must be positive",
			);
		});

		it("accepts valid half-life", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 1000 });
			expect(calc.getHalfLifeMs()).toBeCloseTo(1000, 10);
		});
	});

	describe("calculate", () => {
		it("returns full value at t=0", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 1000 });
			const result = calc.calculate(100, 0);

			expect(result.decayedValue).toBe(100);
			expect(result.decayFactor).toBe(1);
			expect(result.elapsedMs).toBe(0);
			expect(result.fullyDecayed).toBe(false);
		});

		it("returns half value at t=halfLife", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 1000 });
			const result = calc.calculate(100, 1000);

			expect(result.decayedValue).toBeCloseTo(50, 10);
			expect(result.decayFactor).toBeCloseTo(0.5, 10);
			expect(result.elapsedMs).toBe(1000);
			expect(result.fullyDecayed).toBe(false);
		});

		it("returns quarter value at t=2*halfLife", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 1000 });
			const result = calc.calculate(100, 2000);

			expect(result.decayedValue).toBeCloseTo(25, 10);
			expect(result.decayFactor).toBeCloseTo(0.25, 10);
		});

		it("handles zero initial value", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 1000 });
			const result = calc.calculate(0, 500);

			expect(result.decayedValue).toBe(0);
			expect(result.fullyDecayed).toBe(true);
		});

		it("handles negative initial value", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 1000 });
			const result = calc.calculate(-10, 500);

			expect(result.decayedValue).toBe(0);
			expect(result.fullyDecayed).toBe(true);
		});

		it("throws on negative elapsed time", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 1000 });
			expect(() => calc.calculate(100, -1)).toThrow("Elapsed time cannot be negative");
		});

		it("marks value as fully decayed below threshold", () => {
			const calc = new DecayRateCalculator({
				halfLifeMs: 1000,
				minThreshold: 0.01,
			});
			// After ~20 half-lives, value should be well below threshold
			const result = calc.calculate(1, 20000);

			expect(result.decayedValue).toBe(0);
			expect(result.fullyDecayed).toBe(true);
		});
	});

	describe("calculateWeightedSum", () => {
		it("returns sum of all values when all are at reference time", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 1000 });
			const now = Date.now();
			const entries: TimestampedEntry[] = [
				{ ts: now, value: 10 },
				{ ts: now, value: 20 },
				{ ts: now, value: 30 },
			];

			const total = calc.calculateWeightedSum(entries, now);
			expect(total).toBeCloseTo(60, 10);
		});

		it("applies decay based on age — recent weighs more than old", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 1000 });
			const now = Date.now();
			const entries: TimestampedEntry[] = [
				{ ts: now, value: 100 }, // Full value
				{ ts: now - 1000, value: 100 }, // Half decayed
			];

			const total = calc.calculateWeightedSum(entries, now);
			expect(total).toBeCloseTo(150, 10); // 100 + 50
		});

		it("uses full value for future entries", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 1000 });
			const now = Date.now();
			const entries: TimestampedEntry[] = [{ ts: now + 1000, value: 50 }];

			const total = calc.calculateWeightedSum(entries, now);
			expect(total).toBe(50);
		});

		it("returns 0 for empty entries", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 1000 });
			const total = calc.calculateWeightedSum([]);
			expect(total).toBe(0);
		});

		it("older entries contribute less than recent ones", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 1000 });
			const now = Date.now();

			// Same value, but one is 5 half-lives old
			const recentOnly = calc.calculateWeightedSum([{ ts: now, value: 100 }], now);
			const oldOnly = calc.calculateWeightedSum([{ ts: now - 5000, value: 100 }], now);

			expect(recentOnly).toBeGreaterThan(oldOnly);
			// After 5 half-lives, value should be ~3.125
			expect(oldOnly).toBeCloseTo(100 * 0.5 ** 5, 5);
		});
	});

	describe("timeToDecay", () => {
		it("returns half-life for decay to half", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 1000 });
			const time = calc.timeToDecay(100, 50);
			expect(time).toBeCloseTo(1000, 10);
		});

		it("returns two half-lives for decay to quarter", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 1000 });
			const time = calc.timeToDecay(100, 25);
			expect(time).toBeCloseTo(2000, 10);
		});

		it("returns Infinity when target >= current", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 1000 });
			expect(calc.timeToDecay(50, 50)).toBe(Number.POSITIVE_INFINITY);
			expect(calc.timeToDecay(50, 100)).toBe(Number.POSITIVE_INFINITY);
		});

		it("returns Infinity when target <= 0", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 1000 });
			expect(calc.timeToDecay(100, 0)).toBe(Number.POSITIVE_INFINITY);
			expect(calc.timeToDecay(100, -10)).toBe(Number.POSITIVE_INFINITY);
		});
	});

	describe("getHalfLifeMs", () => {
		it("returns the configured half-life", () => {
			const calc = new DecayRateCalculator({ halfLifeMs: 5000 });
			expect(calc.getHalfLifeMs()).toBe(5000);
		});
	});
});

// ===========================================================================
// calculateDecayRate convenience function
// ===========================================================================

describe("calculateDecayRate", () => {
	it("computes weighted sum with default 1h half-life", () => {
		const now = Date.now();
		const entries: TimestampedEntry[] = [{ ts: now, value: 100 }];
		const rate = calculateDecayRate(entries);
		// At t=0 relative to now, should be ~100
		expect(rate).toBeCloseTo(100, 0);
	});

	it("applies configurable half-life", () => {
		const now = Date.now();
		const entries: TimestampedEntry[] = [{ ts: now - 1000, value: 100 }];
		// half-life of 1000ms
		const rate = calculateDecayRate(entries, 1000);
		// Should be ~50 (half-life has passed)
		expect(rate).toBeCloseTo(50, 0);
	});

	it("returns 0 for empty entries", () => {
		expect(calculateDecayRate([])).toBe(0);
	});
});

// ===========================================================================
// createCostDecayCalculator factory
// ===========================================================================

describe("createCostDecayCalculator", () => {
	it("creates calculator with half-life = window/4", () => {
		const windowMs = 86_400_000; // 24 hours
		const calc = createCostDecayCalculator(windowMs);
		expect(calc.getHalfLifeMs()).toBe(windowMs / 4);
	});

	it("uses $0.0001 as minimum threshold", () => {
		const calc = createCostDecayCalculator(3600_000);
		// Value of $0.00005 after massive decay should be zero
		const result = calc.calculate(0.00005, 100_000_000);
		expect(result.decayedValue).toBe(0);
		expect(result.fullyDecayed).toBe(true);
	});
});
