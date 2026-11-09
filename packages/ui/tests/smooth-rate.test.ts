// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { smoothRadius, smoothRate } from "../src/shared/smooth-rate.js";

describe("smoothRate", () => {
	it("is a centred triangle-weighted mean: a lone peak spreads to its neighbours and stays the highest", () => {
		const out = smoothRate([0, 0, 9, 0, 0], 1);
		expect(out).toBeInstanceOf(Float64Array);
		expect([...out]).toEqual([0, 2.25, 4.5, 2.25, 0]);
	});

	it("weights by distance over 2 * radius + 1 values, fewer at the ends", () => {
		// Radius 2: weights 1 2 3 2 1 in the middle; at an end only the values that exist count.
		expect([...smoothRate([0, 0, 0, 9, 0, 0, 0], 2)]).toEqual([0, 1.125, 2, 3, 2, 1.125, 0]);
		// The first value sees itself (3) and two to its right (2, 1): (3 * 6 + 2 * 0 + 1 * 0) / 6.
		expect(smoothRate([6, 0, 0, 0], 2)[0]).toBe(3);
	});

	it("keeps a flat series flat and never leaves the input's range", () => {
		expect([...smoothRate([4, 4, 4, 4, 4], 2)]).toEqual([4, 4, 4, 4, 4]);
		const xs = [3, 0, 7, 1, 9, 2, 0, 5];
		for (const r of [1, 2, 3]) {
			for (const v of smoothRate(xs, r)) {
				expect(v).toBeGreaterThanOrEqual(0);
				expect(v).toBeLessThanOrEqual(9);
			}
		}
	});

	it("returns the input's values for a radius of 0 or less, or fewer than 3 values", () => {
		expect([...smoothRate([0, 0, 9, 0, 0], 0)]).toEqual([0, 0, 9, 0, 0]);
		expect([...smoothRate([0, 0, 9, 0, 0], -1)]).toEqual([0, 0, 9, 0, 0]);
		expect([...smoothRate([1, 8], 1)]).toEqual([1, 8]);
		expect([...smoothRate([5], 2)]).toEqual([5]);
		expect(smoothRate([], 1)).toEqual(new Float64Array(0));
		expect(smoothRate([1, 8], 1)).toBeInstanceOf(Float64Array);
	});

	it("reads a typed array and never writes to it", () => {
		const input = Float64Array.from([0, 0, 9, 0, 0]);
		const out = smoothRate(input, 1);
		expect(out).not.toBe(input);
		expect([...input]).toEqual([0, 0, 9, 0, 0]);
		expect(smoothRate(input, 0)).not.toBe(input);
	});
});

describe("smoothRadius", () => {
	it("is 2 for the 5 min and 6 h buckets, 1 for every other", () => {
		expect(smoothRadius("5 min")).toBe(2);
		expect(smoothRadius("6 h")).toBe(2);
		expect(smoothRadius("hour")).toBe(1);
		expect(smoothRadius("4 h")).toBe(1);
		expect(smoothRadius("day")).toBe(1);
		expect(smoothRadius("")).toBe(1);
	});
});
