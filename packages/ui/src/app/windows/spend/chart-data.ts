// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * What every chart of spend is drawn from, in one place: the rows run to now, whatever position is pinned. A pin is a
 * marker inside a chart, never its end; only the list, and the figures labelled with the position, are cut there.
 *
 * Under a filter a chart also gets every row the page holds, so it can keep the unfiltered scale and draw all spend
 * as a faint line, and the words that say what that faint line is.
 */

import { useMemo } from "react";
import { isHeaderSpend } from "../../../shared/aggregate.js";
import type { SpendWindow } from "../../../shared/breakdown.js";
import { chartWindow as windowFor } from "../../../shared/chart-window.js";
import { applyFilters } from "../../../shared/filters.js";
import type { LedgerRow } from "../../../shared/rows.js";
import type { RangeId } from "../../../shared/spend-series.js";
import { useDeskData, useRange } from "../../desk/desk-state.js";

export interface ChartData {
	/** Every row the page holds, under the filters the list was drawn with: what every figure reads. */
	chartRows: LedgerRow[];
	/** Every row the page holds, unfiltered, when the filters took some away; else null. */
	allRows: LedgerRow[] | null;
	/** The range's window, ending at the end of the current minute. */
	chartWindow: SpendWindow;
	/** What the faint line is, when there is one; else null. */
	filterNote: string | null;
}

const MINUTE_MS = 60_000;
const SEP = " · ";

/** The minute a moment falls in: the chart's window moves once a minute, not with every tick of the clock. */
export function minuteOf(nowMs: number): number {
	return Math.floor(nowMs / MINUTE_MS);
}

/**
 * The time of the first held spend record: the earliest position among the rows whose time reads, or null when there
 * is none. The chart's window opens no earlier than it, so no flat run-up is drawn.
 */
export function firstRecordMs(rows: readonly LedgerRow[]): number | null {
	let best: LedgerRow | null = null;
	let bestMs = 0;
	for (const row of rows) {
		if (!isHeaderSpend(row.kind, row.costUt)) continue;
		const t = Date.parse(row.ts);
		if (Number.isNaN(t) || (best !== null && row.pos >= best.pos)) continue;
		best = row;
		bestMs = t;
	}
	return best === null ? null : bestMs;
}

/** The chart's window: the range ending at the end of the current minute, never at a pinned position. */
export function chartWindowOf(range: RangeId, nowMs: number, firstMs: number | null): SpendWindow {
	return windowFor(range, nowMs, firstMs);
}

/**
 * The caption under a filter. Each filter token (`"<field>:<value>"`, in the order the filters were added, the newest
 * last) is named by its value, the text after the first colon. A text search is named `search`: the words typed are
 * not a name for what the line shows.
 */
export function filterNoteOf(order: readonly string[]): string {
	const values = order.map((t) =>
		t.startsWith("search:") ? "search" : t.slice(t.indexOf(":") + 1),
	);
	return `Filtered: ${values.length > 0 ? values.join(SEP) : "search"}${SEP}faint line: all spend`;
}

/**
 * The chart's rows, window, unfiltered rows and caption. The rows are the page's live rows (never a past view's) under
 * the filters the list was DRAWN with (`list.filters`), so the chart and the list agree on the filters and a keystroke
 * costs no pass over the rows. Filtered means a row was taken away, judged by count: a filter that keeps every row
 * changes nothing on the chart, and no filter field is left out of the judgement.
 */
export function useChartData(): ChartData {
	const { rows, list, nowMs, filterOrder } = useDeskData();
	const { range } = useRange();
	const chartRows = useMemo(() => applyFilters(rows, list.filters), [rows, list.filters]);
	const minute = minuteOf(nowMs);
	const firstMs = useMemo(() => firstRecordMs(rows), [rows]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: nowMs matters only through its minute
	const chartWindow = useMemo(() => chartWindowOf(range, nowMs, firstMs), [range, minute, firstMs]);
	const filtered = chartRows.length !== rows.length;
	const filterNote = useMemo(
		() => (filtered ? filterNoteOf(filterOrder) : null),
		[filtered, filterOrder],
	);
	return useMemo(
		() => ({ chartRows, allRows: filtered ? rows : null, chartWindow, filterNote }),
		[chartRows, filtered, rows, chartWindow, filterNote],
	);
}
