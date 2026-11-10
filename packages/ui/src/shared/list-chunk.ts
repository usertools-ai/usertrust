// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * How many rows the ledger list draws. It draws one chunk at first and more as the reader scrolls, and before any
 * move to a row it does not yet draw it grows far enough to hold that row. Pure: the state is a value the list
 * component keeps, and every function here returns the state it was given, the same object, when nothing changes.
 */

/** The rows drawn at first, and the rows each further step adds. */
export const CHUNK = 150;
/** The height of one dense row, in px. */
export const DENSE_ROW_PX = 30;

export interface ChunkState {
	/** What the list is a list of: its sort and its filters, as one string. A new key is a new list. */
	key: string;
	/** The most rows drawn. It can stand above the row count (the list got shorter): `shownCount` is what is drawn. */
	limit: number;
}

/** A row count as a whole number of rows: none for a value that is not a usable count. */
function countOf(total: number): number {
	return Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
}

/** The state of a list first drawn: one chunk, or all of a shorter list. */
export function chunkInit(key: string, total: number): ChunkState {
	return { key, limit: Math.min(CHUNK, countOf(total)) };
}

/**
 * The state for the list as it is now. A different `key` (a new sort or filter) starts again at the first chunk.
 * The same key keeps the state: a record arriving live never takes the list back to its first chunk. The one
 * change under the same key is a first chunk that was not full (the list was empty or short when first drawn):
 * it fills as records arrive, or a list drawn before its records loaded would stay empty.
 */
export function chunkSync(s: ChunkState, key: string, total: number): ChunkState {
	if (s.key !== key) return chunkInit(key, total);
	const first = Math.min(CHUNK, countOf(total));
	return first > s.limit ? { key, limit: first } : s;
}

/** One more chunk, never above `total`, and never fewer rows than before. */
export function chunkGrow(s: ChunkState, total: number): ChunkState {
	const limit = Math.min(s.limit + CHUNK, countOf(total));
	return limit > s.limit ? { key: s.key, limit } : s;
}

/**
 * Enough chunks to draw the row at `index` (0-based): the smallest whole number of chunks that holds it, never
 * above `total`, and never fewer rows than before. An index that is not a row of the list changes nothing.
 */
export function chunkReveal(s: ChunkState, index: number, total: number): ChunkState {
	const count = countOf(total);
	if (!Number.isInteger(index) || index < 0 || index >= count) return s;
	const limit = Math.min((Math.floor(index / CHUNK) + 1) * CHUNK, count);
	return limit > s.limit ? { key: s.key, limit } : s;
}

/** The rows drawn: the limit, or every row of a shorter list. */
export function shownCount(s: ChunkState, total: number): number {
	return Math.min(s.limit, countOf(total));
}

/**
 * How many rows a PageUp or PageDown moves in a list of rows of one height: the rows that fit in the viewport, less
 * one so the row at the edge stays in view. At least 1.
 */
export function pageSizeForRows(viewportPx: number, rowPx: number = DENSE_ROW_PX): number {
	const fit = Math.floor(viewportPx / rowPx);
	return Number.isFinite(fit) ? Math.max(1, fit - 1) : 1;
}
