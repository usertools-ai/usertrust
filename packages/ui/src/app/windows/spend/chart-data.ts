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
import type { AtPayload } from "../../../shared/api.js";
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
 * The least time among the held spend rows whose time reads, or null when there is none. The chart's window opens no
 * earlier than it, so no flat run-up is drawn, and a row written out of order with an earlier time still falls inside
 * the window (its spend stays in the line and the range's total).
 */
export function firstRecordMs(rows: readonly LedgerRow[]): number | null {
	let best: number | null = null;
	for (const row of rows) {
		if (!isHeaderSpend(row.kind, row.costUt)) continue;
		const t = Date.parse(row.ts);
		if (Number.isNaN(t) || (best !== null && t >= best)) continue;
		best = t;
	}
	return best;
}

/**
 * The position the chart draws as pinned. The address's position can be past the vault's end (a link written when the
 * vault was longer, or a typed one): the server answers with the head and says so, and that is the position the pin
 * stands for, so records that arrive later are not counted into it. Until an answer says so, the address's own.
 */
export function resolvedPin(addressPos: number | null, at: AtPayload | null): number | null {
	if (addressPos === null) return null;
	return at !== null && addressPos > at.head ? at.pos : addressPos;
}

/** The chart's window: the range ending at the end of the current minute, never at a pinned position. */
export function chartWindowOf(range: RangeId, nowMs: number, firstMs: number | null): SpendWindow {
	return windowFor(range, nowMs, firstMs);
}

/**
 * The caption under a filter. Each filter token (`"<field>:<value>"`, in the order the filters were added, the newest
 * last) is named by its value, the text after the first colon. A text search is named `search`: the words typed are
 * not a name for what the line shows. The four bounds are not values of a list and are named by their field, as the
 * filter bar names them: `from 2026-11-01 UTC`, `to 2026-11-05 UTC`, `cost ≥ 500 UT`, `cost ≤ 900 UT`.
 */
export function filterNoteOf(order: readonly string[]): string {
	const values = order.map((t) => {
		const i = t.indexOf(":");
		if (i < 0) return t;
		const field = t.slice(0, i);
		const value = t.slice(i + 1);
		if (field === "search") return "search";
		if (field === "from" || field === "to") return `${field} ${value} UTC`;
		if (field === "costMin") return `cost ≥ ${value} UT`;
		if (field === "costMax") return `cost ≤ ${value} UT`;
		return value;
	});
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
