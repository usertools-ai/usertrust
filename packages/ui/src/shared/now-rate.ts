// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The spend rate now: the last hour's spend against the usual range of the 24 hours before it. Pure.
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
/** How many hours are returned: one week. The last is read against the 24 before it, as on every chart. */
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

/** The hours the last hour's usual range reads, and the last hour itself: the span a cut list must reach back over. */
export const RANGE_REACH_MS = 25 * HOUR_MS;

/**
 * Whether `rows` reach back over `spanMs` before `endMs`: the oldest record held, of any kind, is at or before that
 * point. A list that holds only the newest of a vault's records (a cut one) says nothing of a span it does not
 * reach, and where its cut falls is not where the vault began. With no record held, or none with a readable time, it
 * does not.
 */
export function reachesBack(rows: readonly LedgerRow[], endMs: number, spanMs: number): boolean {
	let firstMs = Number.POSITIVE_INFINITY;
	for (const row of rows) {
		const t = Date.parse(row.ts);
		if (t < firstMs) firstMs = t;
	}
	return firstMs <= endMs - spanMs;
}

/**
 * `reaches` is false when `rows` are the newest part of a vault that the cut stops short of the hours the usual range
 * reads: the oldest row held is then where the cut falls, not where spend began, so the hours before it are not
 * known to be quiet and the hour it falls in is partial. There is then no range ("not known"), whatever the rows say.
 */
export function rateNow(rows: readonly LedgerRow[], endMs: number, reaches = true): RateNowView {
	const startMs = endMs - RATE_HOURS * HOUR_MS;
	const hours = bucketTotals(rows, { startMs, endMs }, HOUR_MS);
	const skip = skipBeforeFirstSpend(rows, startMs, HOUR_MS, RATE_HOURS);
	const band = usualBand(hours, skip);
	if (!reaches) for (const a of [band.mid, band.lo, band.hi]) a.fill(Number.NaN);
	const { mid, lo, hi } = band;
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
