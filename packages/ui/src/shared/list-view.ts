// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * What the list (and Trends) draw, derived in one place from ONE input. The page defers that input
 * (`useDeferredValue`), so a timeline drag paints the thumb, the label and the header first and the list follows;
 * because the rows, the position, the filters, the load phase and the summary travel together, the list never pairs
 * one position's rows with another moment's phase or chain. Pure.
 */

import type { AtPayload, SummaryPayload } from "./api.js";
import { chainAt, cutRows } from "./asof.js";
import { type ChainStatus, chainStatus, type LoadPhase } from "./display.js";
import { applyFilters, type FilterState } from "./filters.js";
import type { LedgerRow } from "./rows.js";

export interface ListInput {
	/** Every row held, in position order. */
	rows: LedgerRow[];
	/** The past position shown, or null for live. */
	at: AtPayload | null;
	filters: FilterState;
	phase: LoadPhase;
	summary: SummaryPayload | null;
}

/** A past position with no held row at or before it: where the list starts, and the position shown (0-based). */
export interface BeforeWindow {
	firstHeld: number;
	upTo: number;
}

export interface ListView {
	/** The rows at the position (live: every row held), before the filters. */
	shownRows: LedgerRow[];
	filtered: LedgerRow[];
	total: number;
	/** The chain the list reads: the position's at T, the summary's live, null while nothing is loaded. */
	chain: ChainStatus | null;
	/**
	 * Set at T whenever the cut is empty. The page's rows, not the server's `windowStartPos`, decide it: in a resync gap
	 * the two disagree, and an empty cut read as "no rows" told a healthy vault it had failed verification.
	 */
	beforeWindow: BeforeWindow | null;
	phase: LoadPhase;
	at: AtPayload | null;
}

export function listView(input: ListInput): ListView {
	const { rows, at, filters, phase, summary } = input;
	const shownRows = at === null ? rows : cutRows(rows, at);
	const beforeWindow =
		at !== null && shownRows.length === 0
			? { firstHeld: rows[0]?.pos ?? at.windowStartPos, upTo: at.pos }
			: null;
	return {
		shownRows,
		filtered: applyFilters(shownRows, filters),
		total: shownRows.length,
		chain: at !== null ? chainAt(at) : summary === null ? null : chainStatus(summary.chain),
		beforeWindow,
		phase,
		at,
	};
}
