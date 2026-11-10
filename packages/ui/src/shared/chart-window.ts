// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The window a chart draws, and the bucket its line is cut into. Pure.
 *
 * The window ends at the end of the current minute and opens at the range's start, no earlier than the first held
 * record, then rounds down to a whole bucket. So buckets sit on the clock ("this hour" is a clock hour, "At 08:00Z" is
 * a bucket's own start), the first bucket is whole, and only the last can be partial.
 */

import type { SpendWindow } from "./breakdown.js";
import { type RangeId, rangeWindow } from "./spend-series.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * The bucket sizes the chart draws at each range: 5 min, 1 h, 4 h, then 6 h. This file is where they are defined, and
 * the Spend line is to take them from here (until it does, its bucket follows its width), so the share ring and the
 * line name the same moment.
 */
export const LINE_BUCKETS: Readonly<Record<RangeId, number>> = {
	"1d": 5 * MINUTE_MS,
	"1w": HOUR_MS,
	"1m": 4 * HOUR_MS,
	"3m": 6 * HOUR_MS,
	ytd: 6 * HOUR_MS,
	"1y": 6 * HOUR_MS,
};

/**
 * The chart's window for a range. `firstMs` is the time of the first held record, or null when there is none or it is
 * not known. A range that opens before it starts at it, so no flat run-up is drawn.
 */
export function chartWindow(range: RangeId, nowMs: number, firstMs: number | null): SpendWindow {
	const endMs = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
	const bucketMs = LINE_BUCKETS[range];
	// The span is measured back from the end; the year for YTD is the year it is now, not the year of the end, which in
	// the last minute of December is already the next one.
	let startMs = (range === "ytd" ? rangeWindow(range, nowMs) : rangeWindow(range, endMs)).startMs;
	if (firstMs !== null && Number.isFinite(firstMs) && firstMs > startMs) startMs = firstMs;
	startMs = Math.floor(startMs / bucketMs) * bucketMs;
	// A start at or after the end (a first record at the end) falls back to the bucket the end's last instant is in.
	if (!(startMs < endMs)) startMs = Math.floor((endMs - 1) / bucketMs) * bucketMs;
	return { startMs, endMs };
}
