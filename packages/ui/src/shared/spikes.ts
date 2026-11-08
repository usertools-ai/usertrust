// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Unusual spend rates: the buckets whose spend is several times the usual rate before them. Pure.
 *
 * The records show a rate, never a cause, so a spike is only ever an "unusual spend rate".
 *
 * The usual rate before a bucket is the larger of the median and the mean of the SPIKE_WINDOW buckets before it. The
 * median alone is 0 on a vault with quiet nights, which would make every busy bucket "infinitely" unusual; the mean
 * keeps the bar where an ordinary busy bucket sits.
 */

import { medianOf } from "./band.js";

/** A bucket is unusual at this many times the usual rate before it. */
export const SPIKE_RATIO = 6;
/** How many buckets before a bucket make "the usual". */
export const SPIKE_WINDOW = 24;
/** Fewer buckets of history than this: no verdict yet. */
export const SPIKE_MIN_HISTORY = 6;
/** And strictly above this share of the range's peak bucket, so near-zero noise never fires. */
export const SPIKE_FLOOR_OF_PEAK = 0.01;
/** At most this many are returned, the largest first. */
export const SPIKE_MAX = 5;

/** The indices of the unusual buckets in `values`, the largest first (ties: the earlier bucket), at most SPIKE_MAX. */
export function detectSpikes(values: ArrayLike<number>): number[] {
	const n = values.length;
	let peak = 0;
	for (let k = 0; k < n; k++) peak = Math.max(peak, values[k] as number);
	const floor = peak * SPIKE_FLOOR_OF_PEAK;
	const hits: number[] = [];
	for (let k = SPIKE_MIN_HISTORY; k < n; k++) {
		const v = values[k] as number;
		if (!(v > floor)) continue;
		const w: number[] = [];
		for (let j = Math.max(0, k - SPIKE_WINDOW); j < k; j++) w.push(values[j] as number);
		const base = Math.max(medianOf(w), w.reduce((a, b) => a + b, 0) / w.length);
		if (v >= SPIKE_RATIO * base) hits.push(k);
	}
	hits.sort((a, b) => (values[b] as number) - (values[a] as number) || a - b);
	return hits.slice(0, SPIKE_MAX);
}
