// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The usual range behind a spend line. Pure; for drawing and for the "unusual spend rate" caption.
 *
 * For each bucket the range is the median of the BAND_WINDOW buckets before it, plus and minus BAND_K times their
 * median absolute deviation (MAD). The bucket itself is left out of its own history, so one big bucket never widens the
 * range it is judged against. The median and the MAD are used rather than the mean and standard deviation because
 * spend is bursty: a single large hour would drag a mean-based range up for a day afterwards.
 *
 * BAND_K is 3, applied to the MAD scaled by 1.4826 (which makes it comparable to a standard deviation on steady
 * data): about "three deviations", a range a steady run stays inside and a real jump leaves. Where more than half the
 * recent buckets are empty the MAD is 0, the range collapses to the median, and any spend above it is unusual: that is
 * the intended reading of a vault that is normally quiet.
 */

/** How many buckets before a bucket make "the usual". */
export const BAND_WINDOW = 24;
/** Fewer buckets of history than this: no range yet (the bounds are NaN and drawing skips them). */
export const BAND_MIN_HISTORY = 6;
/** The range's half-width, in scaled MADs. */
export const BAND_K = 3;
/** Makes a MAD comparable to a standard deviation for normally distributed data. */
const MAD_SCALE = 1.4826;

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
}

/**
 * The usual range for every bucket of `values`. `hi >= mid >= lo >= 0` wherever it is defined; NaN where the bucket
 * has fewer than BAND_MIN_HISTORY buckets before it.
 */
export function usualBand(values: ArrayLike<number>): UsualBand {
	const n = values.length;
	const mid = new Float64Array(n).fill(Number.NaN);
	const lo = new Float64Array(n).fill(Number.NaN);
	const hi = new Float64Array(n).fill(Number.NaN);
	for (let k = BAND_MIN_HISTORY; k < n; k++) {
		const w: number[] = [];
		for (let j = Math.max(0, k - BAND_WINDOW); j < k; j++) w.push(values[j] as number);
		const m = medianOf(w);
		const mad = medianOf(w.map((v) => Math.abs(v - m))) * MAD_SCALE;
		mid[k] = m;
		hi[k] = m + BAND_K * mad;
		lo[k] = Math.max(0, m - BAND_K * mad);
	}
	return { mid, lo, hi };
}
