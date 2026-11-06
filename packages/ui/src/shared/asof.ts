// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The row window as recorded at a past position. The server answers `/api/at` with the totals at that position and
 * the status each held row had there; this module cuts the rows the page already holds to match. Pure.
 */

import type { AtPayload, SummaryPayload } from "./api.js";
import { type ChainStatus, windowNotice } from "./display.js";
import type { LedgerRow } from "./rows.js";

/** Whether `rows` are in position order (each `pos` above the last), computed once per array: rows are replaced, never mutated. */
const ordered = new WeakMap<readonly LedgerRow[], boolean>();
function inPositionOrder(rows: readonly LedgerRow[]): boolean {
	let known = ordered.get(rows);
	if (known === undefined) {
		known = true;
		for (let i = 1; i < rows.length; i++) {
			if ((rows[i] as LedgerRow).pos <= (rows[i - 1] as LedgerRow).pos) {
				known = false;
				break;
			}
		}
		ordered.set(rows, known);
	}
	return known;
}

/** How many rows of a position-ordered array are at or before `pos`: a binary search. */
function prefixLength(rows: readonly LedgerRow[], pos: number): number {
	let lo = 0;
	let hi = rows.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((rows[mid] as LedgerRow).pos <= pos) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * The rows at positions `0..at.pos`, with `status` taken from `at.statusAt` (by event hash) where it has one. A
 * replaced row is a new object; every other row keeps its identity, so a list keyed on rows redraws only what changed.
 *
 * The rows are held in position order, so the cut is a prefix: found by binary search and copied, then the few rows
 * `statusAt` names are replaced, looked for from the cut's end back (they are the rows whose transfer is still open at
 * the position, so they sit near it), stopping once all are found. Rows out of order (never expected) are cut one by
 * one, as before.
 */
export function cutRows(rows: LedgerRow[], at: AtPayload): LedgerRow[] {
	const status = (r: LedgerRow): LedgerRow => {
		const s = Object.hasOwn(at.statusAt, r.hash) ? at.statusAt[r.hash] : undefined;
		return s !== undefined && s !== r.status ? { ...r, status: s } : r;
	};
	if (!inPositionOrder(rows)) {
		const out: LedgerRow[] = [];
		for (const r of rows) if (r.pos <= at.pos) out.push(status(r));
		return out;
	}
	const out = rows.slice(0, prefixLength(rows, at.pos));
	let left = Object.keys(at.statusAt).length;
	for (let i = out.length - 1; i >= 0 && left > 0; i--) {
		const r = out[i] as LedgerRow;
		if (!Object.hasOwn(at.statusAt, r.hash)) continue;
		left -= 1;
		out[i] = status(r);
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
