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
	const span = win.endMs - win.startMs;
	if (!(bucketMs > 0) || !(span > 0) || !Number.isFinite(span)) return new Float64Array(1);
	const n = Math.max(1, Math.ceil(span / bucketMs));
	const out = new Float64Array(n);
	for (const row of rows) {
		if (!isHeaderSpend(row.kind, row.costUt)) continue;
		const t = Date.parse(row.ts);
		if (!(t >= win.startMs && t < win.endMs)) continue;
		if (pick !== undefined && !pick(row)) continue;
		const i = Math.min(n - 1, Math.floor((t - win.startMs) / bucketMs));
		out[i] = (out[i] as number) + row.costUt;
	}
	return out;
}
