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

/**
 * A past position with no held row at or before it (`upTo`, the position shown, 0-based).
 * - `before`: the position is before the server's window, and the list holds rows: it starts at `firstHeld`, a record
 *   it holds.
 * - `not-held`: the server's window covers the position (a resync gap), or the list holds no row at all. No position
 *   the list holds can be named: the records for this point are not held yet.
 */
export type BeforeWindow =
	| { kind: "before"; firstHeld: number; upTo: number }
	| { kind: "not-held"; upTo: number };

export interface ListView {
	/** The rows at the position (live: every row held), before the filters. */
	shownRows: LedgerRow[];
	filtered: LedgerRow[];
	total: number;
	/** The chain the list reads: the position's at T, the summary's live, null while nothing is loaded. */
	chain: ChainStatus | null;
	/**
	 * Set at T whenever the cut is empty. The page's rows, not the server's `windowStartPos` alone, decide it: in a
	 * resync gap the two disagree, and an empty cut read as "no rows" told a healthy vault it had failed verification.
	 */
	beforeWindow: BeforeWindow | null;
	phase: LoadPhase;
	at: AtPayload | null;
}

export function listView(input: ListInput): ListView {
	const { rows, at, filters, phase, summary } = input;
	const shownRows = at === null ? rows : cutRows(rows, at);
	return {
		shownRows,
		filtered: applyFilters(shownRows, filters),
		total: shownRows.length,
		chain: at !== null ? chainAt(at) : summary === null ? null : chainStatus(summary.chain),
		beforeWindow: at !== null && shownRows.length === 0 ? beforeWindowAt(rows, at) : null,
		phase,
		at,
	};
}

function beforeWindowAt(rows: LedgerRow[], at: AtPayload): BeforeWindow {
	const first = rows[0];
	return first !== undefined && at.pos < at.windowStartPos
		? { kind: "before", firstHeld: first.pos, upTo: at.pos }
		: { kind: "not-held", upTo: at.pos };
}

/**
 * The list's input: the one frozen when a timeline drag began, while it is on, else the latest. Only the thumb, its
 * label and the header follow a drag; the list, the facets, Trends, the inspector and Export keep their last view and
 * render once when the drag is released or sits still, so no pass over the rows runs while the thumb moves.
 */
export function heldInput(frozen: ListInput | null, next: ListInput): ListInput {
	return frozen ?? next;
}

/**
 * What the views drawn from the list's input say while they show another position than the header, or null when
 * they show the same one. Positions are compared, not answers: a re-read of the same position is not a held view.
 * It holds during a drag (the input is frozen), after one until the deferred render lands, and after Live, Back,
 * Forward or a link too. Counted from 1, as the other position texts are.
 */
export function heldNote(drawnAt: AtPayload | null, shownAt: AtPayload | null): string | null {
	const drawn = drawnAt?.pos ?? null;
	const shown = shownAt?.pos ?? null;
	if (drawn === shown) return null;
	return shown === null
		? "Updating to the live vault…"
		: `Updating to record ${(shown + 1).toLocaleString()}…`;
}
