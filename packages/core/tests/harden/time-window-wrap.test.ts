// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A time window may wrap midnight.
 *
 * `isWithinTimeWindow` applied its two half-open bounds independently:
 *
 *   if (hour < startHour) return false;
 *   if (hour >= endHour)  return false;
 *
 * For a window whose `startHour` exceeds its `endHour` those cannot both pass at
 * any hour — 23:00 fails the second, 02:00 fails the first — so such a window
 * imposed no constraint. Measured across all 24 hours before the change:
 *
 *   {startHour:22, endHour:6} matched at: no hour
 *   {startHour:9,  endHour:17} matched at: 9..16
 */

import { describe, expect, it } from "vitest";
import { evaluatePolicy, type GateRule, isWithinTimeWindow } from "../../src/policy/gate.js";

/** Local-time ISO stamp for a given hour on Wed 12 Aug 2026. Windows are LOCAL by contract. */
function atHour(hour: number, day = 12): string {
	return new Date(2026, 7, day, hour, 30, 0).toISOString();
}

function matchingHours(tw: {
	startHour?: number;
	endHour?: number;
	daysOfWeek?: number[];
}): number[] {
	const hits: number[] = [];
	for (let h = 0; h < 24; h++) {
		if (isWithinTimeWindow([tw], atHour(h))) hits.push(h);
	}
	return hits;
}

describe("midnight-spanning time windows", () => {
	it("an overnight window {22, 6} covers 22,23,0..5", () => {
		expect(matchingHours({ startHour: 22, endHour: 6 })).toEqual([0, 1, 2, 3, 4, 5, 22, 23]);
	});

	it("excludes every hour outside the wrap", () => {
		const hits = new Set(matchingHours({ startHour: 22, endHour: 6 }));
		for (const h of [6, 7, 12, 17, 21]) {
			expect(hits.has(h), `hour ${h} must be outside a 22:00-06:00 curfew`).toBe(false);
		}
	});

	it("a one-hour wrap {23, 0} covers exactly 23:00", () => {
		expect(matchingHours({ startHour: 23, endHour: 0 })).toEqual([23]);
	});

	it("non-wrapping windows are unchanged", () => {
		expect(matchingHours({ startHour: 9, endHour: 17 })).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
	});

	it("open-ended bounds are unchanged", () => {
		expect(matchingHours({ startHour: 20 })).toEqual([20, 21, 22, 23]);
		expect(matchingHours({ endHour: 4 })).toEqual([0, 1, 2, 3]);
	});

	it("a zero-width window {9, 9} still matches nothing", () => {
		expect(matchingHours({ startHour: 9, endHour: 9 })).toEqual([]);
	});

	it("no window at all means no constraint", () => {
		expect(isWithinTimeWindow(undefined, atHour(3))).toBe(true);
		expect(isWithinTimeWindow([], atHour(3))).toBe(true);
	});

	it("the day gate applies to the timestamp's OWN local day", () => {
		// Wed 12 Aug 2026 is a Wednesday (3); Thu 13th is 4.
		const wedOnly = { startHour: 22, endHour: 6, daysOfWeek: [3] };
		expect(isWithinTimeWindow([wedOnly], atHour(23, 12))).toBe(true); // Wed 23:00
		expect(isWithinTimeWindow([wedOnly], atHour(2, 12))).toBe(true); // Wed 02:00
		expect(isWithinTimeWindow([wedOnly], atHour(2, 13))).toBe(false); // Thu 02:00
	});

	it("an overnight HARD rule actually denies overnight and allows midday", () => {
		const curfew: GateRule = {
			id: "no-frontier-overnight",
			name: "No frontier models overnight",
			effect: "deny",
			enforcement: "hard",
			timeWindows: [{ startHour: 22, endHour: 6 }],
			conditions: [{ field: "model", operator: "contains", value: "opus" }],
		};
		// `timestamp` is trusted-host input (#95); a host driving evaluatePolicy
		// directly owns its own clock, which is what lets this be deterministic.
		expect(
			evaluatePolicy([curfew], { model: "claude-opus-5", timestamp: atHour(23) } as never).decision,
		).toBe("deny");
		expect(
			evaluatePolicy([curfew], { model: "claude-opus-5", timestamp: atHour(2) } as never).decision,
		).toBe("deny");
		expect(
			evaluatePolicy([curfew], { model: "claude-opus-5", timestamp: atHour(13) } as never).decision,
		).toBe("allow");
	});
});
