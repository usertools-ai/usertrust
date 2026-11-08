// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { detectSpikes, SPIKE_MAX } from "../src/shared/spikes.js";

describe("detectSpikes", () => {
	it("returns exactly the one 10x bucket of a flat series", () => {
		const values = new Array(48).fill(1);
		values[30] = 10;
		expect(detectSpikes(values)).toEqual([30]);
	});

	it("sparse: 24 empty buckets, ten busy ones of 5, one of 500, gives exactly the 500 bucket", () => {
		const values = [...new Array(24).fill(0), ...new Array(10).fill(5), 500];
		expect(detectSpikes(values)).toEqual([34]);
	});

	it("uses the mean as well as the median, so a vault with quiet nights does not flag every busy bucket", () => {
		// A cycle of 8 busy buckets (10) then 16 empty ones. The median of any 24 is 0; the mean is 3.33, so a busy
		// bucket (10) is not 6x the base (20). One 500 in a later busy stretch is.
		const values: number[] = [];
		for (let cycle = 0; cycle < 4; cycle++)
			for (let i = 0; i < 24; i++) values.push(i < 8 ? 10 : 0);
		values[75] = 500;
		expect(detectSpikes(values)).toEqual([75]);
	});

	it("gives no spikes, and no NaN, for an all-zero series", () => {
		expect(detectSpikes(new Array(40).fill(0))).toEqual([]);
		expect(detectSpikes([])).toEqual([]);
	});

	it("gives no verdict before 6 buckets of history", () => {
		expect(detectSpikes([1, 1, 1, 1, 1, 50])).toEqual([]);
		expect(detectSpikes([1, 1, 1, 1, 1, 1, 50])).toEqual([6]);
	});

	it("returns at most 5, the largest first", () => {
		const values = new Array(200).fill(1);
		const at = [20, 45, 70, 95, 120, 145, 170];
		at.forEach((k, i) => {
			values[k] = 100 + i;
		});
		const out = detectSpikes(values);
		expect(out).toHaveLength(SPIKE_MAX);
		expect(out).toEqual([170, 145, 120, 95, 70]);
	});
});
