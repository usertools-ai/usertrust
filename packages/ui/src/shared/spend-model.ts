// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The one model the Spend line is drawn from: records, buckets and rates over a window. Pure.
 *
 * `rangeUt` is the sum of the buckets, which is the breakdown's total over the same window (one number). `byStatus`
 * splits that same spend by outcome. An unresolved charge (a transfer whose outcome is not confirmed) keeps its cost:
 * it stays INSIDE spend as its own figure, never held and never settled, so `settledUt + unresolvedUt + heldUt +
 * otherUt` is `rangeUt`.
 */

import type { SpendWindow } from "./breakdown.js";
import { inWindow, type SpendRecords, spendRecords } from "./cumulative.js";
import { type LedgerRow, statusOf } from "./rows.js";
import { bucketSpanMs, rateOf } from "./spend-scale.js";
import { bucketTotals, lineBucketMs } from "./spend-series.js";

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
	peakRate: number;
	/** The bucket of the highest rate (the first, on a tie); 0 when there is no spend. */
	peakAt: number;
	byStatus: SpendByStatus;
}

export function buildSpendModel(
	rows: readonly LedgerRow[],
	win: SpendWindow,
	widthPx: number,
	totalUt: number | null,
): SpendModel {
	const bucketMs = lineBucketMs(win, widthPx > 0 ? widthPx : 1);
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
	return {
		records,
		span: inWindow(records, win),
		bucketMs,
		values,
		rates,
		rangeUt,
		peakRate,
		peakAt,
		byStatus,
	};
}
