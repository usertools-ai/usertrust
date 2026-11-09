// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The smoothing the Spend line is DRAWN with. Pure.
 *
 * A per-bucket rate is noisy at short buckets: one busy minute next to an idle one draws as grass. A centred,
 * triangle-weighted mean keeps a peak where it is (the centre counts most, so it never flattens into a plateau) while
 * calming the noise around it. Only the drawn path reads it: every figure a reader sees, the hover and the peak label
 * among them, reads the true rates.
 */

/**
 * The centred mean of `values` over `2 * radius + 1` neighbours, each weighted `radius + 1 - distance`. Near an end
 * only the neighbours that exist count, and the weights are divided by what was counted, so the ends are not pulled
 * toward 0. A radius of 0 or less, or fewer than 3 values, gives the values back unchanged (always a new array).
 */
export function smoothRate(values: ArrayLike<number>, radius: number): Float64Array {
	const n = values.length;
	const out = Float64Array.from({ length: n }, (_, i) => values[i] as number);
	if (!(radius > 0) || n < 3) return out;
	const r = Math.floor(radius);
	for (let i = 0; i < n; i++) {
		const lo = Math.max(0, i - r);
		const hi = Math.min(n - 1, i + r);
		let total = 0;
		let weight = 0;
		for (let j = lo; j <= hi; j++) {
			const wj = r + 1 - Math.abs(i - j);
			total += wj * (values[j] as number);
			weight += wj;
		}
		out[i] = total / weight;
	}
	return out;
}

/**
 * How far the drawn rate is averaged for a bucket. The 5 min bucket (1D) and the 6 h bucket (3M and longer) are the
 * noisiest relative to their range, so they reach two buckets either side; every other bucket reaches one.
 */
export function smoothRadius(per: string): number {
	return per === "5 min" || per === "6 h" ? 2 : 1;
}
