// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { computeRunway, type Runway, runwayHours } from "../../src/budget/runway.js";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;

describe("computeRunway", () => {
	it("computes remaining, fraction, and burn rate over the elapsed window", () => {
		const r = computeRunway({
			allocated: 1000,
			spent: 250,
			periodStartMs: T0,
			nowMs: T0 + 5 * HOUR,
		});
		expect(r.remaining).toBe(750);
		expect(r.fractionRemaining).toBeCloseTo(0.75);
		expect(r.burnRatePerHour).toBeCloseTo(50);
		expect(r.projectedExhaustionMs).toBe(T0 + 5 * HOUR + 15 * HOUR);
	});

	it("returns zero burn and no projection before any time elapses", () => {
		const r = computeRunway({ allocated: 100, spent: 0, periodStartMs: T0, nowMs: T0 });
		expect(r.burnRatePerHour).toBe(0);
		expect(r.projectedExhaustionMs).toBeNull();
		expect(r.onPace).toBeNull();
	});

	it("reports exhaustion at now when the budget is already spent", () => {
		const r = computeRunway({
			allocated: 100,
			spent: 100,
			periodStartMs: T0,
			nowMs: T0 + HOUR,
		});
		expect(r.remaining).toBe(0);
		expect(r.fractionRemaining).toBe(0);
		expect(r.projectedExhaustionMs).toBe(T0 + HOUR);
	});

	it("flags on-pace against a bounded period", () => {
		const slow = computeRunway({
			allocated: 1000,
			spent: 10,
			periodStartMs: T0,
			periodEndMs: T0 + 24 * HOUR,
			nowMs: T0 + HOUR,
		});
		expect(slow.onPace).toBe(true);
		const fast = computeRunway({
			allocated: 1000,
			spent: 500,
			periodStartMs: T0,
			periodEndMs: T0 + 24 * HOUR,
			nowMs: T0 + HOUR,
		});
		expect(fast.onPace).toBe(false);
	});

	it("never returns NaN or Infinity for degenerate input", () => {
		for (const input of [
			{ allocated: 0, spent: 0, periodStartMs: T0, nowMs: T0 },
			{ allocated: -5, spent: -5, periodStartMs: T0, nowMs: T0 - HOUR },
			{ allocated: 100, spent: 500, periodStartMs: T0, nowMs: T0 + HOUR },
			{ allocated: 1000, spent: Number.NaN, periodStartMs: T0, nowMs: T0 + HOUR },
		]) {
			const r = computeRunway(input);
			for (const v of [r.remaining, r.fractionRemaining, r.burnRatePerHour]) {
				expect(Number.isFinite(v)).toBe(true);
			}
			expect(r.fractionRemaining).toBeGreaterThanOrEqual(0);
			expect(r.fractionRemaining).toBeLessThanOrEqual(1);
		}
	});

	// ── D1: exact numeric normalization ──

	it("coerces non-finite allocated to 0", () => {
		for (const allocated of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const r = computeRunway({ allocated, spent: 0, periodStartMs: T0, nowMs: T0 + HOUR });
			expect(r.remaining).toBe(0);
			expect(r.fractionRemaining).toBe(0);
			expect(r.burnRatePerHour).toBe(0);
		}
	});

	it("coerces negative allocated to 0", () => {
		const r = computeRunway({ allocated: -5, spent: 0, periodStartMs: T0, nowMs: T0 + HOUR });
		expect(r.remaining).toBe(0);
		expect(r.fractionRemaining).toBe(0);
	});

	// A non-finite spend is unusable, and the fail-closed reading of an unusable
	// spend is "fully consumed" — the opposite direction from `allocated`.
	it("reads a non-finite spent as fully consumed, not as untouched", () => {
		for (const spent of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const r = computeRunway({ allocated: 100, spent, periodStartMs: T0, nowMs: T0 + HOUR });
			expect(r.remaining).toBe(0);
			expect(r.fractionRemaining).toBe(0);
			expect(Number.isFinite(r.burnRatePerHour)).toBe(true);
			expect(r.projectedExhaustionMs).toBe(T0 + HOUR);
		}
	});

	// The failure this guards: `spent = costTotal / callCount` with a zero call
	// count yields NaN, and a NaN spend that read as 0 would hand a hard
	// `budgetFractionRemaining lt 0.3` tier a full 1.0 and never fire.
	it("does not make a NaN spend indistinguishable from a zero spend", () => {
		const broken = computeRunway({
			allocated: 1000,
			spent: 0 / 0,
			periodStartMs: T0,
			periodEndMs: T0 + 24 * HOUR,
			nowMs: T0 + HOUR,
		});
		const untouched = computeRunway({
			allocated: 1000,
			spent: 0,
			periodStartMs: T0,
			periodEndMs: T0 + 24 * HOUR,
			nowMs: T0 + HOUR,
		});
		expect(broken).not.toEqual(untouched);
		expect(broken.fractionRemaining).toBe(0);
		expect(broken.fractionRemaining).toBeLessThan(0.3);
		expect(untouched.fractionRemaining).toBe(1);
	});

	it("keeps a non-finite spent finite in every field, including burn rate", () => {
		for (const allocated of [0, 100, Number.MAX_VALUE]) {
			const r = computeRunway({
				allocated,
				spent: Number.NaN,
				periodStartMs: T0,
				nowMs: T0 + HOUR,
			});
			for (const v of [r.remaining, r.fractionRemaining, r.burnRatePerHour]) {
				expect(Number.isFinite(v)).toBe(true);
			}
			expect(Number.isInteger(r.projectedExhaustionMs)).toBe(true);
		}
	});

	it("coerces negative spent to 0", () => {
		const r = computeRunway({ allocated: 100, spent: -50, periodStartMs: T0, nowMs: T0 + HOUR });
		expect(r.remaining).toBe(100);
		expect(r.fractionRemaining).toBe(1);
		expect(r.burnRatePerHour).toBe(0);
	});

	it("throws when periodStartMs is not finite", () => {
		for (const periodStartMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(() => computeRunway({ allocated: 100, spent: 10, periodStartMs, nowMs: T0 })).toThrow(
				"runway: periodStartMs and nowMs must be finite",
			);
		}
	});

	it("throws when nowMs is not finite", () => {
		for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(() => computeRunway({ allocated: 100, spent: 10, periodStartMs: T0, nowMs })).toThrow(
				"runway: periodStartMs and nowMs must be finite",
			);
		}
	});

	it("treats a non-finite periodEndMs as absent so onPace is null", () => {
		for (const periodEndMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const r = computeRunway({
				allocated: 1000,
				spent: 10,
				periodStartMs: T0,
				periodEndMs,
				nowMs: T0 + HOUR,
			});
			expect(r.projectedExhaustionMs).not.toBeNull();
			expect(r.onPace).toBeNull();
		}
	});

	it("treats periodEndMs at or before periodStartMs as absent so onPace is null", () => {
		for (const periodEndMs of [T0, T0 - HOUR]) {
			const r = computeRunway({
				allocated: 1000,
				spent: 10,
				periodStartMs: T0,
				periodEndMs,
				nowMs: T0 + HOUR,
			});
			expect(r.projectedExhaustionMs).not.toBeNull();
			expect(r.onPace).toBeNull();
		}
		// Sanity: one millisecond past the start is a real period and does yield a verdict.
		const bounded = computeRunway({
			allocated: 1000,
			spent: 10,
			periodStartMs: T0,
			periodEndMs: T0 + 1,
			nowMs: T0 + HOUR,
		});
		expect(bounded.onPace).toBe(true);
	});

	it("tolerates fractional allocated/spent for analytics reads", () => {
		const r = computeRunway({
			allocated: 100.5,
			spent: 25.25,
			periodStartMs: T0,
			nowMs: T0 + 2 * HOUR,
		});
		expect(r.remaining).toBeCloseTo(75.25);
		expect(r.fractionRemaining).toBeCloseTo(75.25 / 100.5);
		expect(r.burnRatePerHour).toBeCloseTo(12.625);
		expect(Number.isInteger(r.projectedExhaustionMs)).toBe(true);
	});

	it("returns an integer projectedExhaustionMs", () => {
		const r = computeRunway({
			allocated: 1000,
			spent: 7,
			periodStartMs: T0,
			nowMs: T0 + 3 * HOUR,
		});
		expect(Number.isInteger(r.projectedExhaustionMs)).toBe(true);
	});

	// ── Boundaries ──

	it("treats a clock behind the period start as a zero-length elapsed window", () => {
		const r = computeRunway({
			allocated: 100,
			spent: 50,
			periodStartMs: T0,
			nowMs: T0 - HOUR,
		});
		expect(r.remaining).toBe(50);
		expect(r.burnRatePerHour).toBe(0);
		expect(r.projectedExhaustionMs).toBeNull();
	});

	it("counts exhaustion exactly at periodEnd as on pace", () => {
		// burn 500/h with 500 remaining projects exhaustion to exactly T0 + 2h.
		const r = computeRunway({
			allocated: 1000,
			spent: 500,
			periodStartMs: T0,
			periodEndMs: T0 + 2 * HOUR,
			nowMs: T0 + HOUR,
		});
		expect(r.projectedExhaustionMs).toBe(T0 + 2 * HOUR);
		expect(r.onPace).toBe(true);
	});

	// ── D2: an exhausted budget is never on pace ──

	it("reports an exhausted budget as off pace after the period has ended", () => {
		const r = computeRunway({
			allocated: 1000,
			spent: 1000,
			periodStartMs: T0,
			periodEndMs: T0 + 24 * HOUR,
			nowMs: T0 + 48 * HOUR,
		});
		expect(r.remaining).toBe(0);
		expect(r.fractionRemaining).toBe(0);
		// Exhaustion projects to `now`, which is past periodEnd — the raw
		// comparison would read that as "the budget lasted".
		expect(r.projectedExhaustionMs).toBe(T0 + 48 * HOUR);
		expect(r.onPace).toBe(false);
	});

	it("reports an exhausted budget as off pace while the period is still open", () => {
		const r = computeRunway({
			allocated: 1000,
			spent: 1000,
			periodStartMs: T0,
			periodEndMs: T0 + 24 * HOUR,
			nowMs: T0 + HOUR,
		});
		expect(r.remaining).toBe(0);
		expect(r.onPace).toBe(false);
	});

	it("still reports a healthy budget as on pace past the period end", () => {
		// 10 UT over 48h => ~0.21 UT/h, 990 remaining => ~4752h of runway.
		const r = computeRunway({
			allocated: 1000,
			spent: 10,
			periodStartMs: T0,
			periodEndMs: T0 + 24 * HOUR,
			nowMs: T0 + 48 * HOUR,
		});
		expect(r.remaining).toBe(990);
		expect(r.onPace).toBe(true);
	});

	it("keeps onPace null for an exhausted budget with no usable period end", () => {
		const openEnded = computeRunway({
			allocated: 1000,
			spent: 1000,
			periodStartMs: T0,
			nowMs: T0 + 48 * HOUR,
		});
		expect(openEnded.onPace).toBeNull();
		const inverted = computeRunway({
			allocated: 1000,
			spent: 1000,
			periodStartMs: T0,
			periodEndMs: T0 - HOUR,
			nowMs: T0 + 48 * HOUR,
		});
		expect(inverted.onPace).toBeNull();
	});

	it("clamps fractionRemaining to 0 when spend exceeds the allocation", () => {
		const r = computeRunway({
			allocated: 100,
			spent: 500,
			periodStartMs: T0,
			nowMs: T0 + HOUR,
		});
		expect(r.remaining).toBe(0);
		expect(r.fractionRemaining).toBe(0);
		expect(r.burnRatePerHour).toBe(500);
	});

	it("is pure — repeated calls agree and the input is not mutated", () => {
		const input = {
			allocated: 1000,
			spent: 250,
			periodStartMs: T0,
			periodEndMs: T0 + 24 * HOUR,
			nowMs: T0 + 5 * HOUR,
		};
		const snapshot = { ...input };
		expect(computeRunway(input)).toEqual(computeRunway(input));
		expect(input).toEqual(snapshot);
	});
});

describe("runwayHours", () => {
	/** A Runway with only the field runwayHours reads, so each case is explicit. */
	function runway(projectedExhaustionMs: number | null): Runway {
		return {
			remaining: 0,
			fractionRemaining: 0,
			burnRatePerHour: 0,
			projectedExhaustionMs,
			onPace: null,
		};
	}

	it("converts a projection into hours from now", () => {
		expect(runwayHours(runway(T0 + 12 * HOUR), T0)).toBe(12);
		expect(runwayHours(runway(T0 + 90 * 60_000), T0)).toBe(1.5);
	});

	// The whole reason this function exists: the naive inline conversion,
	// (projectedExhaustionMs - nowMs) / 3.6e6, coerces null to a large NEGATIVE
	// number, so a `budgetRunwayHours lt 12` rule escalates a merely-idle budget.
	it("returns null when the runway is not projectable", () => {
		expect(runwayHours(runway(null), T0)).toBeNull();
	});

	it("never returns a negative — an already-exhausted projection clamps to 0", () => {
		expect(runwayHours(runway(T0 - 5 * HOUR), T0)).toBe(0);
		expect(runwayHours(runway(T0), T0)).toBe(0);
	});

	it("reads a real computeRunway result end to end", () => {
		// 250 UT spent over 5h => 50 UT/h, 750 remaining => 15h of runway.
		const spending = computeRunway({
			allocated: 1000,
			spent: 250,
			periodStartMs: T0,
			nowMs: T0 + 5 * HOUR,
		});
		expect(runwayHours(spending, T0 + 5 * HOUR)).toBeCloseTo(15);

		// Nothing spent yet: no burn rate, so no projection, so no runway figure.
		const idle = computeRunway({ allocated: 1000, spent: 0, periodStartMs: T0, nowMs: T0 + HOUR });
		expect(idle.projectedExhaustionMs).toBeNull();
		expect(runwayHours(idle, T0 + HOUR)).toBeNull();
	});

	it("rejects a non-finite clock, matching computeRunway's contract", () => {
		expect(() => runwayHours(runway(T0 + HOUR), Number.NaN)).toThrow("nowMs must be finite");
		expect(() => runwayHours(runway(T0 + HOUR), Number.POSITIVE_INFINITY)).toThrow(
			"nowMs must be finite",
		);
	});
});
