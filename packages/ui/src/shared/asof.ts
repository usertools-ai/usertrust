// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The row window as recorded at a past position. The server answers `/api/at` with the totals at that position and
 * the status each held row had there; this module cuts the rows the page already holds to match. Pure.
 */

import type { AtPayload, SummaryPayload } from "./api.js";
import { windowNotice } from "./display.js";
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

/**
 * The note for a position before the first row held, or null. A position inside the window says nothing here; a
 * truncated window is then described by `windowNotice` as it is when live.
 */
export function windowNoteAt(at: AtPayload): string | null {
	if (at.pos >= at.windowStartPos) return null;
	return `The list holds records from position ${at.windowStartPos}; earlier records still count in the totals above.`;
}

/** The one note about the list's window: the position's own when it applies, else the live truncation notice. */
export function windowNote(summary: SummaryPayload, at: AtPayload | null): string | null {
	return (at !== null ? windowNoteAt(at) : null) ?? windowNotice(summary);
}
