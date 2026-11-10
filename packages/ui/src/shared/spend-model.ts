// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The one model the Spend line is drawn from: records, buckets and rates over a window. Pure.
 *
 * Each range draws with a fixed bucket (`LINE_BUCKETS`), a unit people use, never one derived from the plot's width:
 * the same range then has the same buckets on any screen, and a bucket's spend can be named ("these 5 min"). The
 * rates stay per hour inside, so a figure shown per bucket goes through `toBucket`. `drawn` is the rates smoothed for
 * the path alone; every figure reads `values`, `rates` and `peakRate`, never `drawn`.
 *
 * `rangeUt` is the sum of the buckets, which is the breakdown's total over the same window (one number). `byStatus`
 * splits that same spend by outcome. An unresolved charge (a transfer whose outcome is not confirmed) keeps its cost:
 * it stays INSIDE spend as its own figure, never held and never settled, so `settledUt + unresolvedUt + heldUt +
 * otherUt` is `rangeUt`.
 */

import type { SpendWindow } from "./breakdown.js";
import { inWindow, type SpendRecords, spendRecords } from "./cumulative.js";
import { type LedgerRow, statusOf } from "./rows.js";
import { smoothRadius, smoothRate } from "./smooth-rate.js";
import { bucketSpanMs, rateOf } from "./spend-scale.js";
import { bucketTotals, type RangeId } from "./spend-series.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** The line's bucket: its length, and how it is named on screen (`per`). */
export interface LineBucket {
	ms: number;
	per: string;
}

/**
 * The bucket each range draws with. Above a month it is 6 h, not a day: a day's bucket averages an hour-long burst
 * of spend down until it no longer stands out from the rest of the line.
 */
export const LINE_BUCKETS: Record<RangeId, LineBucket> = {
	"1d": { ms: 5 * MINUTE, per: "5 min" },
	"1w": { ms: HOUR, per: "hour" },
	"1m": { ms: 4 * HOUR, per: "4 h" },
	"3m": { ms: 6 * HOUR, per: "6 h" },
	ytd: { ms: 6 * HOUR, per: "6 h" },
	"1y": { ms: 6 * HOUR, per: "6 h" },
};

/** A per-hour rate as the spend of one whole bucket, the unit every figure on the line is shown in. */
export function toBucket(ratePerHour: number, bucket: LineBucket): number {
	return (ratePerHour * bucket.ms) / HOUR;
}

/** The words for one bucket in a sentence: "this hour", "these 5 min", "these 6 h". */
export function bucketPhrase(per: string): string {
	return per === "hour" || per === "day" ? `this ${per}` : `these ${per}`;
}

/** The unit after a per-bucket figure: "/h" for an hour, else "/5 min", "/4 h", "/6 h". */
export function perShort(per: string): string {
	return per === "hour" ? "/h" : `/${per}`;
}

/** The range's spend by outcome. Every spend row in the range is in exactly one figure. */
export interface SpendByStatus {
	settledUt: number;
	/** Recorded, not confirmed: the transfer's verdict is ambiguous. */
	unresolvedUt: number;
	/** No producer writes a hold today; counted if a record ever carries one. */
	heldUt: number;
	/** Every other outcome, so the split is total. */
	otherUt: number;
}

export interface SpendModel {
	records: SpendRecords;
	/**
	 * The records inside the window, cut on each record's time as `spendRecords` keeps it (a record written out of order
	 * takes the running maximum). `rangeUt` and `byStatus` use each row's own time, so a row written out of order across
	 * a window edge can be in the totals and not in this span.
	 */
	span: { i0: number; i1: number };
	bucketMs: number;
	/** Spend per bucket, UT. */
	values: Float64Array;
	/** Spend rate per bucket, UT per hour, over each bucket's real span. */
	rates: Float64Array;
	rangeUt: number;
	/** The highest TRUE rate, UT per hour: what the peak's figures read. */
	peakRate: number;
	/** The bucket of the highest rate (the first, on a tie); 0 when there is no spend. */
	peakAt: number;
	/** The rates smoothed for drawing (`smoothRate` at the bucket's radius). The path reads it, no figure does. */
	drawn: Float64Array;
	/** The highest drawn value, 0 when none: the y scale's top comes from it, so the drawn line fills its band. */
	drawnPeak: number;
	byStatus: SpendByStatus;
}

export function buildSpendModel(
	rows: readonly LedgerRow[],
	win: SpendWindow,
	bucket: LineBucket,
	totalUt: number | null,
): SpendModel {
	const bucketMs = bucket.ms;
	// The buckets count a row only in a finite, non-empty window (`bucketTotals`); the split does the same.
	const span = win.endMs - win.startMs;
	const bounded = span > 0 && Number.isFinite(span);
	const byStatus: SpendByStatus = { settledUt: 0, unresolvedUt: 0, heldUt: 0, otherUt: 0 };
	const records = spendRecords(rows, totalUt, (row, t) => {
		if (!bounded || !(t >= win.startMs && t < win.endMs)) return;
		const cost = row.costUt as number;
		// The status tally's names: `ambiguous` is shown as unresolved. Read as text, as a hold is not a RowStatus yet.
		const status: string = statusOf(row);
		if (status === "settled") byStatus.settledUt += cost;
		else if (status === "ambiguous") byStatus.unresolvedUt += cost;
		else if (status === "held") byStatus.heldUt += cost;
		else byStatus.otherUt += cost;
	});
	const values = bucketTotals(rows, win, bucketMs);
	const n = values.length;
	const rates = new Float64Array(n);
	let rangeUt = 0;
	let peakRate = 0;
	let peakAt = 0;
	for (let k = 0; k < n; k++) {
		const v = values[k] as number;
		rangeUt += v;
		const r = rateOf(v, bucketSpanMs(k, win, bucketMs));
		rates[k] = r;
		if (r > peakRate) {
			peakRate = r;
			peakAt = k;
		}
	}
	const drawn = smoothRate(rates, smoothRadius(bucket.per));
	let drawnPeak = 0;
	for (const d of drawn) if (d > drawnPeak) drawnPeak = d;
	return {
		records,
		span: inWindow(records, win),
		bucketMs,
		values,
		rates,
		rangeUt,
		peakRate,
		peakAt,
		drawn,
		drawnPeak,
		byStatus,
	};
}
