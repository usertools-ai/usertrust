// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	BAND_K,
	BAND_MIN_HISTORY,
	BAND_WINDOW,
	exceedRuns,
	spikeMask,
	usualBand,
} from "../src/shared/band.js";

describe("usualBand", () => {
	it("is the mean of the buckets before it, plus and minus two standard deviations", () => {
		const steady = usualBand([...new Array(BAND_WINDOW).fill(10), 10]);
		expect(steady.mid[BAND_WINDOW]).toBe(10);
		expect(steady.hi[BAND_WINDOW]).toBe(10);
		expect(steady.lo[BAND_WINDOW]).toBe(10);
		// Bucket 24 sees 12 zeros and 12 twenties: mean 10, standard deviation 10.
		const alternating = usualBand(Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0 : 20)));
		expect(alternating.mid[BAND_WINDOW]).toBe(10);
		expect(alternating.hi[BAND_WINDOW]).toBe(30);
		// 10 - 2 * 10 is below 0: the lower bound is floored at 0.
		expect(alternating.lo[BAND_WINDOW]).toBe(0);
	});

	it("puts the lower bound two standard deviations below the mean when that is above 0", () => {
		// Bucket 24 sees 12 nineties and 12 one-hundred-and-tens: mean 100, variance 10100 - 10000 = 100.
		const values = [...Array.from({ length: BAND_WINDOW }, (_, i) => (i % 2 === 0 ? 90 : 110)), 0];
		const b = usualBand(values);
		expect(b.mid[BAND_WINDOW]).toBe(100);
		expect(b.hi[BAND_WINDOW]).toBe(120);
		expect(b.lo[BAND_WINDOW]).toBe(80);
	});

	it("uses a 24-bucket window, 6 buckets of history and two standard deviations", () => {
		expect(BAND_WINDOW).toBe(24);
		expect(BAND_MIN_HISTORY).toBe(6);
		expect(BAND_K).toBe(2);
		const b = usualBand(new Array(20).fill(3));
		expect(b.hi[5]).toBeNaN();
		expect(b.hi[6]).toBe(3);
	});

	it("gives bounds exactly equal to the value on a flat fractional series, so a steady line never reads as unusual", () => {
		// Adding up a fractional value and dividing back can round the mean a hair off the value (0.37 comes back
		// just below 0.37), and a mean of the squares minus the square of the mean can round a hair below 0. Either
		// would put the upper bound under a steady line, or make it NaN.
		for (const [v, n] of [
			[0.1, 48],
			[0.37, 48],
			[13 / 7, 48],
			[0.7, 7],
			[123.456, 25],
		] as const) {
			const values = new Array<number>(n).fill(v);
			const b = usualBand(values);
			for (let k = b.from; k < n; k++) {
				expect(b.mid[k]).toBe(v);
				expect(b.hi[k]).toBe(v);
				expect(b.lo[k]).toBe(v);
			}
			expect(exceedRuns(values, b)).toEqual([]);
		}
	});

	it("leaves the bucket itself out of its own history, and a big bucket moves the next one", () => {
		const b = usualBand([1, 2, 3, 4, 5, 6, 1000, 7]);
		// Bucket 6 sees [1, 2, 3, 4, 5, 6]: mean 3.5. Its own 1000 is not in it.
		expect(b.mid[6]).toBe(3.5);
		expect(b.hi[6] as number).toBeLessThan(100);
		// Bucket 7 sees [1..6, 1000]: the 1000 is in its mean.
		expect(b.mid[7]).toBeCloseTo(1021 / 7, 10);
	});

	it("has no bounds before `from`, the first bucket with 6 buckets of history", () => {
		const b = usualBand(new Array(20).fill(4));
		expect(b.from).toBe(BAND_MIN_HISTORY);
		for (let k = 0; k < b.from; k++) {
			expect(b.mid[k]).toBeNaN();
			expect(b.lo[k]).toBeNaN();
			expect(b.hi[k]).toBeNaN();
		}
		for (let k = b.from; k < 20; k++) {
			expect(b.mid[k]).toBe(4);
			expect(b.lo[k]).toBe(4);
			expect(b.hi[k]).toBe(4);
		}
		expect(b.hi.length).toBe(20);

		const short = usualBand([1, 2, 3, 4]);
		expect(short.from).toBe(4);
		for (let k = 0; k < 4; k++) expect(short.hi[k]).toBeNaN();
	});

	it("keeps hi at or above mid, and lo between 0 and mid, wherever it is defined", () => {
		const values = Array.from({ length: 80 }, (_, i) => (i * 37) % 11);
		const b = usualBand(values);
		let defined = 0;
		for (let k = 0; k < values.length; k++) {
			if (Number.isNaN(b.hi[k])) continue;
			defined += 1;
			expect(b.hi[k] as number).toBeGreaterThanOrEqual(b.mid[k] as number);
			expect(b.lo[k] as number).toBeLessThanOrEqual(b.mid[k] as number);
			expect(b.lo[k] as number).toBeGreaterThanOrEqual(0);
		}
		expect(defined).toBe(values.length - BAND_MIN_HISTORY);
	});

	it("looks back 24 buckets and no further", () => {
		const values = Array.from({ length: 30 }, (_, i) => (i * 7) % 5);
		const b = usualBand(values);
		const other = usualBand([100, ...values.slice(1)]);
		// Bucket 24 sees indices 0..23, so index 0 is the oldest bucket it counts.
		expect(other.mid[BAND_WINDOW]).not.toBe(b.mid[BAND_WINDOW]);
		// Bucket 25 sees indices 1..24: change index 0 and it does not move.
		expect(other.mid[BAND_WINDOW + 1]).toBe(b.mid[BAND_WINDOW + 1]);
		expect(other.hi[BAND_WINDOW + 1]).toBe(b.hi[BAND_WINDOW + 1]);
		expect(other.lo[BAND_WINDOW + 1]).toBe(b.lo[BAND_WINDOW + 1]);
	});

	it("leaves the buckets marked in `skip` out of every history", () => {
		const values = Array.from({ length: 22 }, (_, i) => (i === 20 ? 1000 : i));
		const skip = new Array<boolean>(22).fill(false);
		skip[20] = true;
		// Bucket 21 sees buckets 0..20; with 20 skipped its history is 0..19: mean 9.5.
		expect(usualBand(values, skip).mid[21]).toBe(9.5);
		expect(usualBand(values).mid[21]).toBeCloseTo((190 + 1000) / 21, 10);
	});

	it("counts only unskipped buckets toward the 6 buckets of history", () => {
		// Bucket 9 sees buckets 0..8 (9 buckets).
		const values = new Array(10).fill(4);
		const skip4 = new Array<boolean>(10).fill(false);
		for (const j of [0, 2, 4, 6]) skip4[j] = true;
		const five = usualBand(values, skip4);
		expect(five.from).toBe(BAND_MIN_HISTORY);
		expect(five.mid[9]).toBeNaN();
		expect(five.lo[9]).toBeNaN();
		expect(five.hi[9]).toBeNaN();

		const skip3 = new Array<boolean>(10).fill(false);
		for (const j of [0, 2, 4]) skip3[j] = true;
		const six = usualBand(values, skip3);
		expect(Number.isFinite(six.mid[9])).toBe(true);
		expect(Number.isFinite(six.lo[9])).toBe(true);
		expect(Number.isFinite(six.hi[9])).toBe(true);
		expect(six.hi[9]).toBe(4);
	});

	it("gives NaN, not 0, where every bucket of the history is skipped", () => {
		const b = usualBand(new Array(8).fill(5), new Array<boolean>(8).fill(true));
		for (let k = 0; k < 8; k++) {
			expect(b.mid[k]).toBeNaN();
			expect(b.lo[k]).toBeNaN();
			expect(b.hi[k]).toBeNaN();
		}
	});

	it("collapses to 0 on a flat series of zeros, with no NaN once defined", () => {
		const flat = usualBand(new Array(30).fill(0));
		expect(flat.hi[10]).toBe(0);
		expect(flat.lo[10]).toBe(0);
		expect(flat.mid[10]).toBe(0);
		for (let k = flat.from; k < 30; k++) expect(Number.isNaN(flat.hi[k])).toBe(false);
	});

	describe("an earlier spike in the history", () => {
		// History: 23 buckets of 10 and one of 1000, then a bucket of 400.
		const values = [...new Array(BAND_WINDOW - 1).fill(10), 1000, 400];
		const at = BAND_WINDOW;

		it("without skip, widens the range so a second spike is masked behind the first and reads as usual", () => {
			const b = usualBand(values);
			expect(b.mid[at]).toBe(51.25);
			// Population standard deviation of the history is about 197.8.
			expect(b.hi[at] as number).toBeCloseTo(446.9, 1);
			expect((values[at] as number) > (b.hi[at] as number)).toBe(false);
			expect(exceedRuns(values, b)).toEqual([{ k0: BAND_WINDOW - 1, k1: BAND_WINDOW - 1 }]);
		});

		it("with the first spike in skip, keeps the range to the steady buckets so the second spike reads as unusual", () => {
			const skip = spikeMask(values.length, [{ k0: BAND_WINDOW - 1, k1: BAND_WINDOW - 1 }], 0);
			const b = usualBand(values, skip);
			expect(b.mid[at]).toBe(10);
			expect(b.hi[at]).toBe(10);
			expect((values[at] as number) > (b.hi[at] as number)).toBe(true);
			expect(exceedRuns(values, b)).toEqual([{ k0: BAND_WINDOW - 1, k1: BAND_WINDOW }]);
		});
	});
});

describe("spikeMask", () => {
	it("marks each run widened by the radius", () => {
		const m = spikeMask(10, [{ k0: 4, k1: 5 }], 1);
		expect(m).toEqual([false, false, false, true, true, true, true, false, false, false]);
	});

	it("clamps at both ends", () => {
		const m = spikeMask(
			10,
			[
				{ k0: 0, k1: 0 },
				{ k0: 9, k1: 9 },
			],
			2,
		);
		expect(m).toEqual([true, true, true, false, false, false, false, true, true, true]);
	});
});

describe("exceedRuns", () => {
	const flat = (n: number, v: number) => new Float64Array(n).fill(v);

	it("gives the maximal runs above the upper bound", () => {
		const values = [1, 9, 9, 1, 9];
		expect(exceedRuns(values, { hi: flat(5, 5), from: 0 })).toEqual([
			{ k0: 1, k1: 2 },
			{ k0: 4, k1: 4 },
		]);
	});

	it("starts no run before `from`", () => {
		const values = [1, 9, 9, 1, 9];
		expect(exceedRuns(values, { hi: flat(5, 5), from: 2 })).toEqual([
			{ k0: 2, k1: 2 },
			{ k0: 4, k1: 4 },
		]);
		expect(exceedRuns(values, { hi: flat(5, 5), from: 5 })).toEqual([]);
	});
});
