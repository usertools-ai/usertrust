// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The spend rate now: the last hour's spend against the usual range of the week before it. Pure.
 *
 * The range is `usualBand`, the one every chart draws, so the words here and a chart's shading cannot disagree. The
 * hours before the first spend record are not history: they are left out of the range (`skipBeforeFirstSpend`), so a
 * vault with only a few hours of spend reads "too little history to call" however large its last hour is. Quiet hours
 * after the first spend are real zeros and count.
 */

import { usualBand } from "./band.js";
import { skipBeforeFirstSpend } from "./band-skip.js";
import { NOW_COPY } from "./now-copy.js";
import type { LedgerRow } from "./rows.js";
import { bucketTotals } from "./spend-series.js";

export const HOUR_MS = 3_600_000;
/** How many hours the rate is read against: one week. */
export const RATE_HOURS = 168;

export interface RateNowView {
	/** Spend per hour, oldest first; the last hour ends at `endMs`. */
	hours: Float64Array;
	/** The last hour's spend. */
	ratePerHourUt: number;
	/** Whether the last hour has a usual range to be read against. */
	known: boolean;
	/** Above the usual range. Never true when the range is not known. */
	unusual: boolean;
	band: { mid: Float64Array; lo: Float64Array; hi: Float64Array };
}

export function rateNow(rows: readonly LedgerRow[], endMs: number): RateNowView {
	const startMs = endMs - RATE_HOURS * HOUR_MS;
	const hours = bucketTotals(rows, { startMs, endMs }, HOUR_MS);
	const skip = skipBeforeFirstSpend(rows, startMs, HOUR_MS, RATE_HOURS);
	// The whole week is the history: the last hour is read against the 167 hours before it, not the day before.
	const { mid, lo, hi } = usualBand(hours, skip, RATE_HOURS);
	const last = RATE_HOURS - 1;
	const ratePerHourUt = hours[last] as number;
	const top = hi[last] as number;
	// With no range the bound is NaN, and nothing compares above NaN: `unusual` is then false.
	const unusual = ratePerHourUt > top;
	return { hours, ratePerHourUt, known: Number.isFinite(top), unusual, band: { mid, lo, hi } };
}

/** The rate in words. With too little history it says so, and nothing about the rate. */
export function rateWords(v: Pick<RateNowView, "known" | "unusual">): string {
	if (!v.known) return NOW_COPY.rateUnknown;
	return v.unusual ? NOW_COPY.rateUnusual : NOW_COPY.rateNormal;
}
