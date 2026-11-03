// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A text alternative for the Trends cost chart. The chart's figures are reachable only by hovering 12px bars, so a
 * reader who cannot hover gets this instead: one sentence that states the series, and one table row per bucket.
 * Pure, so it stays unit-tested; the component only renders what this returns.
 */

import { formatUsd, formatUt } from "./format.js";

export type BucketGranularity = "day" | "hour";

/** The newest buckets the hidden table lists. A year of daily buckets stays readable; a week of hourly ones fits. */
export const SUMMARY_ROW_CAP = 90;

export interface SummaryBucket {
	/** The bucket's start, epoch milliseconds (UTC). */
	t: number;
	costUt: number;
}

export interface SummaryRow {
	/** The bucket as the tooltip names it. */
	label: string;
	costUt: number;
	/** Dollars, as `formatUsd` prints them. */
	usd: string;
	/** Usertokens, as `formatUt` prints them. */
	ut: string;
}

export interface ChartSummary {
	/** One sentence for the chart's `aria-label`. */
	label: string;
	/** The newest `SUMMARY_ROW_CAP` buckets, oldest first. */
	rows: SummaryRow[];
	/** True when `rows` holds fewer buckets than the series has. */
	capped: boolean;
	/** The series' length, before any cap. */
	total: number;
	/** The table caption: what the rows are, and "newest 90 of N" when capped. */
	caption: string;
}

function plural(n: number, unit: string): string {
	return `${n.toLocaleString()} ${unit}${n === 1 ? "" : "s"}`;
}

/** A cost, dollars first, then its usertokens: `$2.8000 (28,000 UT)`. */
export function costWords(ut: number): string {
	return `${formatUsd(ut)} (${formatUt(ut)})`;
}

/**
 * The summary of a series in time order. `labelOf` names a bucket the way the chart's tooltip does, so the table and
 * the tooltip cannot print one bucket two ways. The highest bucket is the first one at the maximum (ties: the
 * earliest); a series with no cost at all, or none, reads "No cost in view".
 */
export function chartSummary(
	series: readonly SummaryBucket[],
	granularity: BucketGranularity,
	labelOf: (t: number) => string,
): ChartSummary {
	const unit = granularity === "day" ? "day" : "hour";
	const total = series.length;
	const capped = total > SUMMARY_ROW_CAP;
	const shown = capped ? series.slice(total - SUMMARY_ROW_CAP) : series;
	const rows = shown.map((b) => ({
		label: labelOf(b.t),
		costUt: b.costUt,
		usd: formatUsd(b.costUt),
		ut: formatUt(b.costUt),
	}));

	let highest: SummaryBucket | undefined;
	for (const b of series) {
		if (b.costUt > 0 && (highest === undefined || b.costUt > highest.costUt)) highest = b;
	}
	// The series holds only the buckets that have records (spendOverTime fills no gaps), so the count is of those
	// buckets, never a span of time: "60 hours with records", not "over 60 hours".
	const label =
		highest === undefined
			? "No cost in view"
			: `Cost per ${unit}, ${plural(total, unit)} with records, highest ${costWords(highest.costUt)} on ${labelOf(highest.t)}`;

	const caption = `Cost per ${unit}, UTC${capped ? ` (newest ${SUMMARY_ROW_CAP.toLocaleString()} of ${total.toLocaleString()})` : ""}`;
	return { label, rows, capped, total, caption };
}
