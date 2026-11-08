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
 * Only rows the server still holds (`windowStartPos` and after) are drawn: the page keeps rows the server has since
 * evicted, and `statusAt` has nothing for them, so a later record's change to one would show as its status at the
 * position.
 *
 * The rows are held in position order, so the cut is a range: found by binary search and copied, then the few rows
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
		for (const r of rows) if (r.pos >= at.windowStartPos && r.pos <= at.pos) out.push(status(r));
		return out;
	}
	const out = rows.slice(prefixLength(rows, at.windowStartPos - 1), prefixLength(rows, at.pos));
	let left = Object.keys(at.statusAt).length;
	for (let i = out.length - 1; i >= 0 && left > 0; i--) {
		const r = out[i] as LedgerRow;
		if (!Object.hasOwn(at.statusAt, r.hash)) continue;
		left -= 1;
		out[i] = status(r);
	}
	return out;
}

/** The rows by event hash, per array: rows are replaced, never mutated. */
const byHash = new WeakMap<readonly LedgerRow[], Map<string, LedgerRow>>();
function indexByHash(rows: readonly LedgerRow[]): Map<string, LedgerRow> {
	let index = byHash.get(rows);
	if (index === undefined) {
		index = new Map(rows.map((r) => [r.hash, r]));
		byHash.set(rows, index);
	}
	return index;
}

/**
 * `rows` with each row at or before the answer's position given the status it had when the answer was read
 * (`answeredRows`: the rows the page held then), unless the answer names one for it. A live `status` frame can change an
 * earlier row between an answer and its re-read; the answer has no status for that row yet, and the row is no later
 * than the position, so the change is not what the position recorded. The re-read takes it up (`statusAt`), and
 * until it lands the list keeps what the answer was read against. Only for a position the page had already
 * received: for a later one, nothing is held. `rows` itself when nothing differs.
 */
export function rowsAsAnswered(
	rows: LedgerRow[],
	answeredRows: readonly LedgerRow[],
	at: AtPayload | null,
): LedgerRow[] {
	if (at === null || rows === answeredRows) return rows;
	// A record that arrives after the page's last one is after the position only when the position is no later than it.
	// An answer for a record the page had not received yet (it overtook the live stream) can be changed by one at or
	// before that position, which `statusAt` does not carry: nothing is held then.
	if ((answeredRows.at(-1)?.pos ?? -1) < at.pos) return rows;
	let index: Map<string, LedgerRow> | undefined;
	let out: LedgerRow[] | undefined;
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i] as LedgerRow;
		if (r.pos > at.pos || Object.hasOwn(at.statusAt, r.hash)) continue;
		index ??= indexByHash(answeredRows);
		const was = index.get(r.hash);
		if (was === undefined || was === r || was.status === r.status) continue;
		out ??= rows.slice();
		out[i] = was;
	}
	return out ?? rows;
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
