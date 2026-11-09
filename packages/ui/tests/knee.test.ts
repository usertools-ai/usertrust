// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { KNEE_LIFT, KNEE_SLOPE, kneeOf, squeeze, unsqueeze } from "../src/shared/knee.js";

describe("knee", () => {
	it("unsqueeze undoes squeeze at 0, the knee and three times the knee", () => {
		const k = 10;
		// Exact at and below the knee; above it the 28% factor is not a binary fraction, so allow one rounding step.
		expect(unsqueeze(squeeze(0, k), k)).toBe(0);
		expect(unsqueeze(squeeze(k, k), k)).toBe(k);
		expect(unsqueeze(squeeze(3 * k, k), k)).toBeCloseTo(3 * k, 12);
	});

	it("draws values above the knee at 28% of their excess, and leaves the rest as they are", () => {
		expect(squeeze(5, 10)).toBe(5);
		expect(squeeze(10, 10)).toBe(10);
		expect(squeeze(20, 10)).toBeCloseTo(10 + 10 * KNEE_SLOPE, 12);
	});

	it("is the 95th percentile times 1.15", () => {
		const values = Array.from({ length: 100 }, (_, i) => i + 1);
		expect(kneeOf(values)).toBeCloseTo(95 * KNEE_LIFT, 9);
	});

	it("puts one outlier above the knee, so it is compressed and not hidden", () => {
		const values = [...new Array(99).fill(1), 1000];
		const knee = kneeOf(values);
		expect(knee).toBeCloseTo(1.15, 9);
		const drawn = squeeze(1000, knee);
		expect(drawn).toBeLessThan(1000);
		expect(drawn).toBeGreaterThan(knee);
		expect(unsqueeze(drawn, knee)).toBeCloseTo(1000, 9);
	});

	it("ignores empty buckets, and is 0 rather than NaN for an all-zero series", () => {
		expect(kneeOf(new Array(50).fill(0))).toBe(0);
		expect(kneeOf([])).toBe(0);
		expect(kneeOf([...new Array(90).fill(0), 2, 2, 2, 2, 2])).toBeCloseTo(2 * KNEE_LIFT, 9);
		expect(Number.isNaN(squeeze(0, kneeOf(new Array(5).fill(0))))).toBe(false);
	});
});
