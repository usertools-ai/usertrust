// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * What the list (and Trends) draw, derived in one place from ONE input. The page defers that input
 * (`useDeferredValue`), so a new position paints the header first and the list follows; because the rows, the position,
 * the filters, the load phase and the summary travel together, the list never pairs one position's rows with another
 * moment's phase or chain. Pure.
 */

import type { AtPayload, SummaryPayload } from "./api.js";
import { type Cutter, chainAt, cutRows } from "./asof.js";
import { FACET_FIELD, withoutDimension } from "./desk-filters.js";
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
	/** A past view waiting for the records of its answer's own vault (`pastRows`: held): `rows` is then empty on purpose. */
	reloading?: boolean;
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
	/** The filters the list was drawn with, which `filtered` is under: read these, not newer ones, for what is drawn beside it. */
	filters: FilterState;
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
	/** The input's `reloading`: the views say they are updating, never that nothing is held. */
	reloading: boolean;
}

/** The rows the list draws: live, the rows themselves (the cutter's projections end); else the cut at `at`. */
function drawnRows(
	rows: LedgerRow[],
	at: AtPayload | null,
	cutter: Cutter | undefined,
): LedgerRow[] {
	if (at === null) return cutter === undefined ? rows : cutter.live(rows);
	return cutter === undefined ? cutRows(rows, at) : cutter.cut(rows, at);
}

/**
 * The list drawn from `input`. `cutter` is the list's own (`createCutter`): with it, a past row keeps its identity from
 * one draw to the next while its record and its status there are unchanged; without one, the cut keeps nothing.
 */
export function listView(input: ListInput, cutter?: Cutter): ListView {
	const { rows, at, filters, phase, summary } = input;
	const shownRows = drawnRows(rows, at, cutter);
	return {
		shownRows,
		filters,
		filtered: applyFilters(shownRows, filters),
		total: shownRows.length,
		chain: at !== null ? chainAt(at) : summary === null ? null : chainStatus(summary.chain),
		beforeWindow: at !== null && shownRows.length === 0 ? beforeWindowAt(rows, at) : null,
		phase,
		at,
		reloading: input.reloading === true,
	};
}

/**
 * The rows the share window's level is read from (`effectiveLevel`): the list's rows under every filter it was drawn
 * with but the models one, so a model slice picked at the models level does not drop the donut to lanes. With no
 * model picked those are the list's own filtered rows, and no second pass is made over every row.
 */
export function levelRows(list: ListView): LedgerRow[] {
	return list.filters[FACET_FIELD.model].length === 0
		? list.filtered
		: applyFilters(list.shownRows, withoutDimension(list.filters, "model"));
}

function beforeWindowAt(rows: LedgerRow[], at: AtPayload): BeforeWindow {
	// The first row the server still holds: the page keeps rows it has since evicted, and those are not drawn.
	const first = rows.find((r) => r.pos >= at.windowStartPos);
	return first !== undefined && at.pos < at.windowStartPos
		? { kind: "before", firstHeld: first.pos, upTo: at.pos }
		: { kind: "not-held", upTo: at.pos };
}

/**
 * What the status, the announcement, the list and Trends say while a past view waits for the records of its answer's own
 * vault (`pastRows`: held). `reloaded`: the answer shown came from a reload of the vault.
 */
export function pastHeldNote(reloaded: boolean): string {
	return reloaded ? "Updating to the reloaded vault…" : "Loading this point's records…";
}

/**
 * What the views drawn from the list's input say while they show another position than the header, or null when
 * they show the same one. Positions are compared, not answers: a re-read of the same position is not a held view.
 * It holds from the moment a new position is shown until the deferred render lands, after Back, Forward or a link
 * too. Counted from 1, as the other position texts are.
 */
export function heldNote(drawnAt: AtPayload | null, shownAt: AtPayload | null): string | null {
	const drawn = drawnAt?.pos ?? null;
	const shown = shownAt?.pos ?? null;
	if (drawn === shown) return null;
	return shown === null
		? "Updating to the live vault…"
		: `Updating to record ${(shown + 1).toLocaleString()}…`;
}

/** What the status's live region says about the held views, and whether they were held when it last changed. */
export interface HoldAnnouncement {
	held: boolean;
	text: string;
}

/**
 * The live region's text moves only when the held state flips: once when the views start to lag the header ("Updating to
 * record N…"), once when they catch up ("Showing record N", or the live vault). In between it keeps its text, so a
 * screen reader hears two announcements per change of position, not one per answer. Returns `prev` itself when nothing
 * flips.
 */
export function holdAnnouncement(
	prev: HoldAnnouncement,
	note: string | null,
	shownAt: AtPayload | null,
): HoldAnnouncement {
	const held = note !== null;
	if (held === prev.held) return prev;
	if (note !== null) return { held, text: note };
	return {
		held,
		text:
			shownAt === null
				? "Showing the live vault"
				: `Showing record ${(shownAt.pos + 1).toLocaleString()}`,
	};
}
