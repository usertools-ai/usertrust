// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The row window as recorded at a past position. The server answers `/api/at` with the totals at that position and
 * the status each held row had there; this module cuts the rows the page already holds to match. Pure.
 */

import type { AtPayload, SummaryPayload } from "./api.js";
import { type ChainStatus, windowNotice } from "./display.js";
import type { LedgerRow } from "./rows.js";

/**
 * The rows at positions `0..at.pos`, with `status` taken from `at.statusAt` (by event hash) where it has one. A
 * replaced row is a new object; every other row keeps its identity, so a list keyed on rows redraws only what changed.
 */
export function cutRows(rows: LedgerRow[], at: AtPayload): LedgerRow[] {
	const out: LedgerRow[] = [];
	for (const r of rows) {
		if (r.pos > at.pos) continue;
		const status = Object.hasOwn(at.statusAt, r.hash) ? at.statusAt[r.hash] : undefined;
		out.push(status !== undefined && status !== r.status ? { ...r, status } : r);
	}
	return out;
}

/** A position as the page prints it: counted from 1, as the integrity texts count chain positions. */
function shownPosition(pos: number): string {
	return (pos + 1).toLocaleString();
}

/**
 * The note for a position before the first row held, or null. A position inside the window says nothing here;
 * `windowNote` says where the list starts then.
 */
export function windowNoteAt(at: AtPayload): string | null {
	if (at.pos >= at.windowStartPos) return null;
	return `The list holds records from position ${shownPosition(at.windowStartPos)}; earlier records still count in the totals above.`;
}

/**
 * The one note about the list's window. Live, the truncation notice. At a position: the position's own note before
 * the window, and inside a truncated window where the list starts, in figures true at T (the live event count is
 * not one: `rowCount` is said to be now).
 */
export function windowNote(
	summary: Pick<SummaryPayload, "truncated" | "rowCount" | "chain">,
	at: AtPayload | null,
): string | null {
	if (at === null) return windowNotice(summary);
	const before = windowNoteAt(at);
	if (before !== null) return before;
	if (!summary.truncated) return null;
	return `The list holds records from position ${shownPosition(at.windowStartPos)} (the newest ${summary.rowCount.toLocaleString()} now); earlier ones count in the totals above.`;
}

/** The list's chain at a position: the position's own reading (`at.chain`), never the live verdict. */
export function chainAt(at: AtPayload): ChainStatus {
	return at.chain.valid ? "verified" : "broken";
}
