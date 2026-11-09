// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The row window as recorded at a past position. The server answers `/api/at` with the totals at that position and
 * the status each held row had there; this module cuts the rows the page already holds to match. Pure.
 */

import type { AtPayload, SummaryPayload } from "./api.js";
import { type ChainStatus, windowNotice } from "./display.js";
import type { LedgerRow, RowStatus } from "./rows.js";

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
 * One list's cut, keeping each past row's projection (a row whose status at the position differs from now, drawn with
 * that status) while its record and its status there are unchanged. A redraw (every summary recomputes the list) and a
 * new reading that leaves the row's status there unchanged keep the projection's identity, which the inspector holds a
 * check's result for (`heldFor`). A draw that does not show it (another point, one where its status is its status now,
 * or the live view: `live`) ends it, and so do a new version of the record (a status correction replaces the row
 * object) and another status there: a status that changes and changes back is a new version, and an old result never
 * returns. The state is the cutter's own (the list's owner keeps one) and holds only the projections of the draw on
 * screen. A draw is made in a render that React may throw away (the list is a deferred value), so it is only staged
 * there, and it is kept once the page commits it (`commit`). Kept when it was made, a draw thrown away ended the
 * projections on screen, and a check's result held for one of them was lost. `cutRows` keeps none.
 */
export interface Cutter {
	/** `cutRows`, reusing a projection only when the draw last committed showed it, with the same status. The draw is
	 *  staged: nothing the next cut reuses changes until it is committed. */
	cut(rows: LedgerRow[], at: AtPayload): LedgerRow[];
	/** The live view is drawn (its list is `rows` themselves): once committed, no projection carries over to the next
	 *  cut. */
	live(rows: LedgerRow[]): LedgerRow[];
	/** `drawn`, a list this cutter's `cut` or `live` returned, is on screen: its projections are the ones the next cut
	 *  may reuse. A draw never committed changes nothing, and nor does a list this cutter did not draw. */
	commit(drawn: LedgerRow[]): void;
}

export function createCutter(): Cutter {
	// The projections the draw on screen shows, by the row object each projects: the only ones a draw may reuse.
	let shown = new Map<LedgerRow, LedgerRow>();
	// The draws made since the last commit, by the list each returned, with the projections each shows.
	let staged = new Map<LedgerRow[], Map<LedgerRow, LedgerRow>>();
	return {
		cut(rows, at) {
			const now = new Map<LedgerRow, LedgerRow>();
			const out = cutWith(rows, at, (r, status) => {
				const kept = shown.get(r);
				const projected = kept !== undefined && kept.status === status ? kept : { ...r, status };
				now.set(r, projected);
				return projected;
			});
			staged.set(out, now);
			return out;
		},
		live(rows) {
			staged.set(rows, new Map());
			return rows;
		},
		commit(drawn) {
			const next = staged.get(drawn);
			if (next !== undefined) shown = next;
			staged = new Map();
		},
	};
}

/**
 * The rows at positions `0..at.pos`, with `status` taken from `at.statusAt` (by event hash) where it has one. A
 * replaced row is a new object (a `Cutter` keeps it across one list's draws); every other row keeps its identity, so a
 * list keyed on rows redraws only what changed.
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
	return cutWith(rows, at, (r, status) => ({ ...r, status }));
}

/** The cut (`cutRows`), with `project` giving the row drawn for one whose status at the position differs from now. */
function cutWith(
	rows: LedgerRow[],
	at: AtPayload,
	project: (r: LedgerRow, status: RowStatus) => LedgerRow,
): LedgerRow[] {
	const status = (r: LedgerRow): LedgerRow => {
		const s = Object.hasOwn(at.statusAt, r.hash) ? at.statusAt[r.hash] : undefined;
		return s !== undefined && s !== r.status ? project(r, s) : r;
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
 * `rows` with each row at or before the answer's position given the status it had when the answer's request was sent
 * (`answeredRows`: the rows the page held then, never the rows held when the answer renders), unless the answer names
 * one for it. The server answers at a head at least as new as that moment, so a record after the position that the
 * rows reflect is also known to it and `statusAt` corrects the row; a frame that arrives after the send is not. A live
 * `status` frame can change an earlier row between an answer and its re-read; the answer has no status for that row
 * yet, and the row is no later than the position, so the change is not what the position recorded. The re-read takes
 * it up (`statusAt`), and until it lands the list keeps what the answer was read against. Only for a position the page
 * had already received: for a later one nothing is held, and `pastRows` draws nothing until a re-read sent with rows
 * that reach the position lands. `rows` itself when nothing differs.
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
	if (!reachesPosition(answeredRows, at.pos)) return rows;
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

/** Whether rows reach `pos`: their last one is at or after it (the test the follower adopts a fresher snapshot by). */
function reachesPosition(rows: readonly LedgerRow[], pos: number): boolean {
	return (rows.at(-1)?.pos ?? -1) >= pos;
}

/** The rows a past view draws, and how they were chosen. */
export interface PastRows {
	kind: "live" | "answered" | "snapshot" | "held";
	rows: LedgerRow[];
}

/**
 * The vault a thing comes from, as one key: the server process (`boot`) and the reload count within it (`epoch`, which
 * restarts at 0 in every process). Null unless the boot is a non-empty string and the epoch a non-negative safe
 * integer: an older server sends no boot, and a key that is not known never matches another.
 */
export function vaultKey(boot: unknown, epoch: unknown): string | null {
	if (typeof boot !== "string" || boot === "") return null;
	if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) return null;
	return `${boot}:${epoch}`;
}

/** Two vault keys name the same vault only when both are known and equal. */
function sameVault(a: string | null, b: string | null): boolean {
	return a !== null && b !== null && a === b;
}

/**
 * The rows a past view draws, paired with the answer by the epoch of the vault they come from (the counter `/api/at`
 * reports and `/api/events` repeats, with the server's `boot`), whichever of a reload's rows and answer lands first.
 * - Live: the page's rows.
 * - None (held) unless the snapshot the answer was read against (`view.rows`) is the answer's vault and reaches the
 *   answered position. Either no rows of the answer's vault to read its statuses against are held yet (the answer came
 *   first, a request was sent while a resync was on its way, an unrelated reload landed in between, or the server
 *   sends no epoch), or the answer overtook the live stream. The re-read that the resync, or the next summary, asks
 *   for brings them. Nothing is drawn rather than rows the answer cannot speak for.
 * - The page's rows are the answer's vault too: the page's rows, with each row's status as the answer was read
 *   (`rowsAsAnswered`).
 * - Otherwise the snapshot itself (the rows came first).
 */
export function pastRows(
	rows: LedgerRow[],
	liveVault: string | null,
	view: { rows: readonly LedgerRow[] | null; rowsVault: string | null },
	at: AtPayload | null,
): PastRows {
	if (at === null) return { kind: "live", rows };
	const answerVault = vaultKey(at.boot, at.epoch);
	const snapshot = view.rows !== null && sameVault(view.rowsVault, answerVault) ? view.rows : null;
	// Only rows that reach the answered position are read as the answer. A snapshot that ends before it (the answer
	// overtook the live stream) lacks the records in between and what they did to earlier rows, and the page's rows gain
	// later records' changes, which the answer, read before they existed, has no `statusAt` for. So the view is held
	// until a re-read sent with rows that reach the position lands (every summary asks for one).
	if (snapshot === null || !reachesPosition(snapshot, at.pos)) return { kind: "held", rows: [] };
	if (sameVault(liveVault, answerVault))
		return { kind: "answered", rows: rowsAsAnswered(rows, snapshot, at) };
	return { kind: "snapshot", rows: [...snapshot] };
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
