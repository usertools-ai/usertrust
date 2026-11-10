// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The usual range behind a spend line. Pure; for drawing and for the "unusual spend rate" caption.
 *
 * For each bucket the range is the mean of the BAND_WINDOW buckets before it, plus and minus BAND_K (population)
 * standard deviations, never below 0. The bucket itself is left out of its own history. Callers pass the rate they
 * draw, so a line leaving the range is seen to leave it; this function does not smooth.
 *
 * A mean and a standard deviation are pulled by a large bucket: one big hour widens the range for the day after it,
 * and can hide a second spike behind the first. So a caller may pass `skip`, the buckets already marked unusual
 * (see `spikeMask`), and those are left out of every history. Without it, an earlier spike stays in the range.
 */

/** How many buckets before a bucket make "the usual". */
export const BAND_WINDOW = 24;
/**
 * Fewer buckets of history than this, counting only the buckets not in `skip`: no range (the bounds are NaN and
 * drawing skips them).
 */
export const BAND_MIN_HISTORY = 6;
/** The range's half-width, in standard deviations. */
export const BAND_K = 2;

/** The median of `xs`, which must not be empty. */
export function medianOf(xs: readonly number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

export interface UsualBand {
	mid: Float64Array;
	lo: Float64Array;
	hi: Float64Array;
	/**
	 * The first bucket with enough history for a range: min(n, BAND_MIN_HISTORY). The bounds are NaN before it. A later
	 * bucket can still be NaN when most of its window is in `skip`, so callers must test `Number.isFinite`.
	 */
	from: number;
}

/**
 * The usual range for every bucket of `values`. `hi >= mid >= lo >= 0` wherever it is defined. The bounds are NaN
 * before `from`, and wherever fewer than BAND_MIN_HISTORY buckets of the window are left once `skip` is applied:
 * with only one or two buckets left the deviation is 0, so any spend above their mean would read as unusual, which so
 * few buckets cannot support. So a bucket at or after `from` can still be NaN; callers must test `Number.isFinite`.
 *
 * `skip`: buckets marked `true` are left out of every history (the unusual ones), so a spike does not widen the range
 * the buckets after it are judged against.
 */
export function usualBand(values: ArrayLike<number>, skip?: ArrayLike<boolean>): UsualBand {
	const n = values.length;
	const mid = new Float64Array(n).fill(Number.NaN);
	const lo = new Float64Array(n).fill(Number.NaN);
	const hi = new Float64Array(n).fill(Number.NaN);
	const from = Math.min(n, BAND_MIN_HISTORY);
	for (let k = from; k < n; k++) {
		const j0 = Math.max(0, k - BAND_WINDOW);
		let sum = 0;
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		let c = 0;
		for (let j = j0; j < k; j++) {
			if (skip?.[j] === true) continue;
			const v = values[j] as number;
			sum += v;
			if (v < min) min = v;
			if (v > max) max = v;
			c += 1;
		}
		if (c < BAND_MIN_HISTORY) continue;
		// A mean lies between the least and the greatest of its values; only rounding can put it outside them. Held
		// inside, a steady series has a mean exactly equal to its value, so a steady line never sits above its range.
		const mean = Math.min(max, Math.max(min, sum / c));
		// The deviation is taken from each value's difference from the mean, a sum of squares that cannot go below 0
		// and does not lose the small differences that a mean of squares minus a squared mean would.
		let dev = 0;
		for (let j = j0; j < k; j++) {
			if (skip?.[j] === true) continue;
			const d = (values[j] as number) - mean;
			dev += d * d;
		}
		const sd = Math.sqrt(dev / c);
		mid[k] = mean;
		hi[k] = mean + BAND_K * sd;
		lo[k] = Math.max(0, mean - BAND_K * sd);
	}
	return { mid, lo, hi, from };
}

/** The buckets to leave out of a range's history: each run, widened by `radius` buckets either side. */
export function spikeMask(
	n: number,
	runs: Array<{ k0: number; k1: number }>,
	radius: number,
): boolean[] {
	const out = new Array<boolean>(n).fill(false);
	for (const r of runs)
		for (let k = Math.max(0, r.k0 - radius); k <= Math.min(n - 1, r.k1 + radius); k++)
			out[k] = true;
	return out;
}

/** The maximal runs of buckets where `values` is above the range's upper bound, from `band.from` on. */
export function exceedRuns(
	values: ArrayLike<number>,
	band: Pick<UsualBand, "hi" | "from">,
): Array<{ k0: number; k1: number }> {
	const out: Array<{ k0: number; k1: number }> = [];
	let k0 = -1;
	for (let k = band.from; k <= values.length; k++) {
		const over = k < values.length && (values[k] as number) > (band.hi[k] as number);
		if (over && k0 < 0) k0 = k;
		else if (!over && k0 >= 0) {
			out.push({ k0, k1: k - 1 });
			k0 = -1;
		}
	}
	return out;
}
