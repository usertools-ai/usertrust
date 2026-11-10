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
/** The hours before the last that its usual range reads. */
export const USUAL_HOURS = 24;
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
	/** The first hour held whole: 0 unless the rows are a cut vault's newest. No hour before it is known. */
	firstHour: number;
	band: { mid: Float64Array; lo: Float64Array; hi: Float64Array };
}

/** The time of the oldest record held, of any kind; infinite with none, or none with a time that can be read. */
export function oldestHeldMs(rows: readonly LedgerRow[]): number {
	let firstMs = Number.POSITIVE_INFINITY;
	for (const row of rows) {
		const t = Date.parse(row.ts);
		if (t < firstMs) firstMs = t;
	}
	return firstMs;
}

/**
 * Whether `rows` reach back over `spanMs` before `endMs`: the oldest record held is at or before that point. A list
 * that holds only the newest of a vault's records (a cut one) says nothing of a span it does not reach, and where its
 * cut falls is not where the vault began.
 */
export function reachesBack(rows: readonly LedgerRow[], endMs: number, spanMs: number): boolean {
	return oldestHeldMs(rows) <= endMs - spanMs;
}

/**
 * `heldFromMs` is set when `rows` are the newest part of a vault, to the time of the oldest row of every record the
 * list holds (`oldestHeldMs`): that is where the cut falls, not where spend began. Hours before it are not known, and
 * the hour it falls in is partial, so `firstHour` is the first hour held whole, no hour before it is drawn or read,
 * and the usual range is given only when the hours it reads are whole.
 */
export function rateNow(
	rows: readonly LedgerRow[],
	endMs: number,
	heldFromMs: number | null = null,
): RateNowView {
	const startMs = endMs - RATE_HOURS * HOUR_MS;
	const hours = bucketTotals(rows, { startMs, endMs }, HOUR_MS);
	const skip = skipBeforeFirstSpend(rows, startMs, HOUR_MS, RATE_HOURS);
	const band = usualBand(hours, skip);
	const firstHour =
		heldFromMs === null
			? 0
			: Math.min(RATE_HOURS, Math.max(0, Math.ceil((heldFromMs - startMs) / HOUR_MS)));
	if (firstHour > RATE_HOURS - 1 - USUAL_HOURS)
		for (const a of [band.mid, band.lo, band.hi]) a.fill(Number.NaN);
	const { mid, lo, hi } = band;
	const last = RATE_HOURS - 1;
	const ratePerHourUt = hours[last] as number;
	const top = hi[last] as number;
	// With no range the bound is NaN, and nothing compares above NaN: `unusual` is then false.
	const unusual = ratePerHourUt > top;
	return {
		hours,
		ratePerHourUt,
		known: Number.isFinite(top),
		unusual,
		firstHour,
		band: { mid, lo, hi },
	};
}

/** The rate in words. With too little history it says so, and nothing about the rate. */
export function rateWords(v: Pick<RateNowView, "known" | "unusual">): string {
	if (!v.known) return NOW_COPY.rateUnknown;
	return v.unusual ? NOW_COPY.rateUnusual : NOW_COPY.rateNormal;
}
