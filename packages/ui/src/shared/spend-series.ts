// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Ranges, windows and buckets for the desk's spend views. Pure.
 *
 * Every window is half-open, `startMs <= t < endMs`, the same one `breakdown` uses, so the buckets of a window add up
 * to that window's breakdown total and a record on an edge is counted once. Buckets are for drawing only; a lane's
 * or a table's total is the exact sum, never a sum over smoothed buckets.
 */

import { isHeaderSpend } from "./aggregate.js";
import type { SpendWindow } from "./breakdown.js";
import type { LedgerRow } from "./rows.js";

export type RangeId = "1d" | "1w" | "1m" | "3m" | "ytd" | "1y";

export const DEFAULT_RANGE: RangeId = "1w";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MINUTE = 60_000;

const SPAN_MS: Record<Exclude<RangeId, "ytd">, number> = {
	"1d": DAY,
	"1w": 7 * DAY,
	"1m": 30 * DAY,
	"3m": 90 * DAY,
	"1y": 365 * DAY,
};

/** The window a range covers, ending now. YTD starts at 1 January 00:00 UTC of now's year. */
export function rangeWindow(range: RangeId, nowMs: number): SpendWindow {
	if (range === "ytd")
		return { startMs: Date.UTC(new Date(nowMs).getUTCFullYear(), 0, 1), endMs: nowMs };
	return { startMs: nowMs - SPAN_MS[range], endMs: nowMs };
}

/** The bucket the split lanes use at each range. */
export const LANE_BUCKET_MS: Record<RangeId, number> = {
	"1d": HOUR,
	"1w": 4 * HOUR,
	"1m": 12 * HOUR,
	"3m": DAY,
	ytd: 7 * DAY,
	"1y": 7 * DAY,
};

/** The line's bucket: about one per pixel of width, rounded up to a whole minute (never under one minute). */
export function lineBucketMs(win: SpendWindow, widthPx: number): number {
	const span = win.endMs - win.startMs;
	const px = widthPx >= 1 ? widthPx : 1;
	if (!(span > 0) || !Number.isFinite(span)) return MINUTE;
	return Math.max(1, Math.ceil(span / px / MINUTE)) * MINUTE;
}

/** Whether the window is finite and the bucket positive: buckets are for drawing, and an unbounded window has none. */
export function canBucket(win: SpendWindow, bucketMs: number): boolean {
	const span = win.endMs - win.startMs;
	return bucketMs > 0 && span > 0 && Number.isFinite(span);
}

/** How many buckets cover the window: `max(1, ceil((endMs - startMs) / bucketMs))`; 1 when it cannot be bucketed. */
export function bucketCount(win: SpendWindow, bucketMs: number): number {
	if (!canBucket(win, bucketMs)) return 1;
	return Math.max(1, Math.ceil((win.endMs - win.startMs) / bucketMs));
}

/**
 * The bucket a record's spend falls in, or -1 when it is not spend (`isHeaderSpend`), has no readable time, or lies
 * outside the half-open window. The one bucketing every view uses: `floor((t - startMs) / bucketMs)`, the last bucket
 * taking the final partial one. `n` is `bucketCount(win, bucketMs)` for a window that can be bucketed.
 */
export function bucketIndex(row: LedgerRow, win: SpendWindow, bucketMs: number, n: number): number {
	if (!isHeaderSpend(row.kind, row.costUt)) return -1;
	const t = Date.parse(row.ts);
	if (!(t >= win.startMs && t < win.endMs)) return -1;
	return Math.min(n - 1, Math.floor((t - win.startMs) / bucketMs));
}

/**
 * Spend per bucket over the half-open window. A record goes in bucket `floor((t - startMs) / bucketMs)`. The length is
 * exactly `max(1, ceil((endMs - startMs) / bucketMs))`: a final partial bucket is kept, never dropped. `pick` narrows
 * to the records a view keeps (a lane, a filter); spend is always `isHeaderSpend`.
 */
export function bucketTotals(
	rows: readonly LedgerRow[],
	win: SpendWindow,
	bucketMs: number,
	pick?: (r: LedgerRow) => boolean,
): Float64Array {
	const n = bucketCount(win, bucketMs);
	const out = new Float64Array(n);
	if (!canBucket(win, bucketMs)) return out;
	for (const row of rows) {
		const i = bucketIndex(row, win, bucketMs, n);
		if (i < 0) continue;
		if (pick !== undefined && !pick(row)) continue;
		out[i] = (out[i] as number) + (row.costUt as number);
	}
	return out;
}
