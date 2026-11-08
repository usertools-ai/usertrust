// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Spikes are compressed, never hidden: a soft knee on a spend chart's y scale, so one outlier bucket does not set the
 * scale for the whole range. Pure.
 *
 * - The knee is the range's 95th-percentile bucket times 1.15. At or below it a value is drawn as it is; above it, its
 *   excess is drawn at KNEE_SLOPE (28%). One mapping serves everything drawn on that scale.
 * - It changes only where things are DRAWN. Every figure a reader sees (hover, labels, totals) is the true value, and
 *   `unsqueeze` recovers it from a drawn height.
 */

/** The percentile that sets the knee, as a share (nearest rank). */
export const KNEE_PCTL = 0.95;
/** The knee sits this far above that percentile. */
export const KNEE_LIFT = 1.15;
/** Above the knee, a value's excess is drawn at this fraction. */
export const KNEE_SLOPE = 0.28;

/**
 * The knee for these bucket values: the 95th percentile times 1.15, taken over the buckets that have spend (empty
 * buckets are not a rate, and on a quiet vault they would put the percentile at 0 and compress everything). 0 when no
 * bucket has spend, so there is nothing above it and nothing to compress.
 */
export function kneeOf(values: ArrayLike<number>): number {
	const v = Array.from(values)
		.filter((x) => x > 0)
		.sort((a, b) => a - b);
	if (v.length === 0) return 0;
	const rank = Math.ceil((v.length * 95) / 100);
	return (v[Math.max(0, rank - 1)] as number) * KNEE_LIFT;
}

/** True value to drawn value. Monotone; the identity at or below the knee. */
export function squeeze(v: number, knee: number): number {
	return v <= knee ? v : knee + (v - knee) * KNEE_SLOPE;
}

/** Drawn value back to the true value: the inverse of `squeeze`. */
export function unsqueeze(d: number, knee: number): number {
	return d <= knee ? d : knee + (d - knee) / KNEE_SLOPE;
}
