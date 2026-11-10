// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * What the Now window's render tests share: the window drawn inside the desk's contexts over chosen rows, and a past
 * position's answer for one of them. The contexts come from `withDesk`, so every field the desk has is filled.
 */

import { type ComponentType, createElement } from "react";
import type { AtPayload, SummaryPayload } from "../../src/shared/api.js";
import { rankColors } from "../../src/shared/colors.js";
import type { WindowId } from "../../src/shared/desk-layout.js";
import type { LoadPhase } from "../../src/shared/display.js";
import { EMPTY_FILTERS, type FilterState } from "../../src/shared/filters.js";
import { listView } from "../../src/shared/list-view.js";
import type { LedgerRow } from "../../src/shared/rows.js";
import { appExport, dayOneSummary } from "./day-one.js";
import { withDesk } from "./desk.js";

export interface NowOver {
	rows?: LedgerRow[];
	/** `null` is a summary that has not landed. */
	summary?: SummaryPayload | null;
	at?: AtPayload | null;
	filters?: FilterState;
	fill?: WindowId | null;
	nowMs?: number;
	phase?: LoadPhase;
}

/**
 * The Now window's markup. Every row is held (`rows`), as on the page; the list is drawn under `filters` and, at a
 * position, ends there. Colours are ranked from the rows.
 */
export async function renderNow(over: NowOver = {}): Promise<string> {
	const NowWindow = await appExport<ComponentType>("windows/now/now-window", "NowWindow");
	const rows = over.rows ?? [];
	const at = over.at ?? null;
	const filters = over.filters ?? EMPTY_FILTERS;
	const summary = over.summary === undefined ? dayOneSummary() : over.summary;
	const listed = at === null ? rows : rows.filter((r) => r.pos <= at.pos);
	return withDesk(createElement(NowWindow), {
		fill: over.fill ?? null,
		data: {
			rows,
			summary,
			at,
			headAt: at,
			...(over.nowMs === undefined ? {} : { nowMs: over.nowMs }),
			list: listView({ rows: listed, at: null, filters, phase: over.phase ?? "loaded", summary }),
			colorsFor: (dim) => rankColors(rows, dim),
		},
		view: { filters },
	});
}

/** The answer for the position of `row`: the vault as recorded there, with `spentUt` spent up to it. */
export function atOf(row: LedgerRow, spentUt: number, over: Partial<AtPayload> = {}): AtPayload {
	return {
		pos: row.pos,
		ts: row.ts,
		head: row.pos + 10,
		clamped: false,
		epoch: 0,
		spentUt,
		counts: { llm_call: 1, denied: 0, other: 0 },
		chain: { valid: true, breakIndex: null },
		budget: {
			ut: 1_000_000,
			source: "config",
			writtenAt: null,
			provenance: "from the vault config",
			note: "budget history starts with the first budget record; this is today's budget",
		},
		plan: null,
		windowStartPos: 0,
		statusAt: {},
		...over,
	};
}
