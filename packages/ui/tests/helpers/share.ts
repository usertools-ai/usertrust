// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * What the Share of spend window's render tests share: spend records at chosen hours of the chart's range, the desk
 * data that holds them, and a few readers of the drawn markup.
 */

import type { DeskData } from "../../src/app/desk/desk-types.js";
import { breakdown, type SpendWindow } from "../../src/shared/breakdown.js";
import { chartWindow } from "../../src/shared/chart-window.js";
import { rankColors } from "../../src/shared/colors.js";
import { deskWindow } from "../../src/shared/desk-filters.js";
import { EMPTY_FILTERS, type FilterState } from "../../src/shared/filters.js";
import { listView } from "../../src/shared/list-view.js";
import type { LedgerRow } from "../../src/shared/rows.js";

export const HOUR = 3_600_000;
/** The helper's clock: the same instant `defaultDeskData` uses. */
export const NOW_MS = Date.UTC(2026, 10, 8, 12, 0, 0);
/** The chart's window at 1W with no record before it: seven days to the end of the current minute, on an hour. */
export const CHART: SpendWindow = chartWindow("1w", NOW_MS, null);

let nextPos = 0;

/** A spend record `hour` hours (plus a minute) into the chart's window. */
export function spend(
	actor: string,
	hour: number,
	costUt: number,
	over: Partial<LedgerRow> = {},
): LedgerRow {
	const pos = nextPos++;
	return {
		seq: pos,
		pos,
		id: `r${pos}`,
		ts: new Date(CHART.startMs + hour * HOUR + 60_000).toISOString(),
		kind: "llm_call",
		actor,
		model: "claude-sonnet-5",
		hash: String(pos).padStart(64, "a"),
		previousHash: "0".repeat(64),
		integrity: "verified",
		costUt,
		...over,
	};
}

/**
 * The first record the page holds, at the start of the chart's window and with no spend: the window opens at the first
 * held record, so one at the start keeps the window the fixtures count their hours from.
 */
const ANCHOR: LedgerRow = {
	...spend("anchor", 0, 0, { kind: "info", ts: new Date(CHART.startMs).toISOString() }),
	pos: -1,
	seq: -1,
	id: "anchor",
};

/** The desk's data holding `rows`, drawn under `filters`, with colours ranked from those rows. */
export function shareData(
	held: LedgerRow[],
	filters: FilterState = EMPTY_FILTERS,
	over: Partial<DeskData> = {},
): Partial<DeskData> {
	const rows = [ANCHOR, ...held];
	return {
		rows,
		nowMs: NOW_MS,
		list: listView({ rows, at: null, filters, phase: "loaded", summary: null }),
		colorsFor: (dim) => rankColors(rows, dim),
		...over,
	};
}

/** Eight lanes, `k0` the highest spender, each with one record in hour 2 and one in hour 30. */
export function eightLanes(): LedgerRow[] {
	const rows: LedgerRow[] = [];
	for (let i = 0; i < 8; i++) {
		rows.push(spend(`k${i}`, 2, (8 - i) * 1_000));
		rows.push(spend(`k${i}`, 30, (8 - i) * 100 + 7));
	}
	return rows;
}

/** The text a reader sees: tags removed, and the entities React escapes read back. */
export function text(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/&#x27;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/** Every opening tag whose class list holds `cls`, in order. */
export function tagsOf(html: string, cls: string): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(/<[a-z][^>]*>/g)) {
		const c = /\bclass="([^"]*)"/.exec(m[0]);
		if (c !== null && (c[1] ?? "").split(" ").includes(cls)) out.push(m[0]);
	}
	return out;
}

/** An attribute of an opening tag, or null. */
export function attr(tag: string, name: string): string | null {
	const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
	return m === null ? null : text(m[1] ?? "");
}

/** The `data-ut` of every legend figure (`data-fig="share.legend"`), in order, as `[key, ut]`. */
export function legendFigures(html: string): Array<[string, number]> {
	const out: Array<[string, number]> = [];
	for (const m of html.matchAll(/<[a-z][^>]*data-fig="share\.legend"[^>]*>/g)) {
		out.push([attr(m[0], "data-key") ?? "", Number(attr(m[0], "data-ut"))]);
	}
	return out;
}

/** The inner text of the first element whose opening tag matches `open`. */
export function innerOf(html: string, open: RegExp): string | null {
	const m = open.exec(html);
	if (m === null) return null;
	const from = m.index + m[0].length;
	const end = html.indexOf("</", from);
	return text(html.slice(from, end));
}

/**
 * The desk's data with `pin` pinned: every row is still held (`rows`), while the list, the desk window and the desk's
 * own breakdown end at the pin, as they do on the page. A reader that takes the wrong one of the two shows less.
 */
export function pinnedData(
	rows: LedgerRow[],
	pin: LedgerRow,
	filters: FilterState = EMPTY_FILTERS,
): Partial<DeskData> {
	const upTo = rows.filter((r) => r.pos <= pin.pos);
	const window = deskWindow("1w", { ts: pin.ts }, NOW_MS);
	return {
		...shareData(rows, filters),
		list: listView({ rows: upTo, at: null, filters, phase: "loaded", summary: null }),
		window,
		breakdown: () => breakdown(upTo, window, "lane"),
	};
}
