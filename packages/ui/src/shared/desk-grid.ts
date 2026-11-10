// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The desk's two rows, counted in steps. Pure: heights in, rows out; nothing here reads the page.
 *
 * A step is 40 px: 24 px of row and the 16 px gap. A window `h` rows tall is `h * 40 - 16` px (its rows and the gaps
 * between them), so two windows and the gap between them are a whole number of steps. The lower row takes the rows
 * the Now window's content needs, so Now never scrolls; the upper row takes the rest and never fewer than nine, for
 * its charts. When the desk is too short for both, the rows run past it and the desk scrolls.
 */

import { DESK_GAP } from "./desk-layout.js";

/** The gap between windows, in CSS px: the desk's own. */
export const GAP = DESK_GAP;
/** One row without its gap, in CSS px. */
export const ROW_PX = 24;
/** One row and its gap: the step the rows are counted in. */
export const ROW_STEP = ROW_PX + GAP;
/** The fewest rows a window is given. */
export const MIN_ROWS = 4;
/** The fewest rows the upper windows are given: their charts need the height. */
export const TOP_MIN_ROWS = 9;

/** The two rows' heights, in rows. */
export interface RowSplit {
	top: number;
	bottom: number;
}

/** The rows a window needs to show `px` of content, its title bar and frame included, without scrolling. */
export function rowsToFit(px: number): number {
	return Math.ceil((px + GAP) / ROW_STEP);
}

/** The rows that fit a desk `deskHeightPx` tall. The desk has no margin of its own, so the last row needs no gap. */
export function rowsFor(deskHeightPx: number): number {
	return Math.floor((deskHeightPx + GAP) / ROW_STEP);
}

/**
 * The two rows of a desk that holds `rows`. `nowRows` is what the Now window's content needs: the lower row takes
 * that, and four at the least. Before it is measured the lower row is 44% of the desk. The upper row takes the rest
 * and never fewer than nine, so on a short desk the two run past it.
 */
export function homeGrid(rows: number, nowRows?: number): RowSplit {
	const desk = Math.max(TOP_MIN_ROWS + MIN_ROWS, rows);
	const bottom = Math.max(MIN_ROWS, nowRows ?? Math.round(desk * 0.44));
	const top = Math.max(TOP_MIN_ROWS, desk - bottom);
	return { top, bottom };
}

/** The two rows as `grid-template-rows`, in CSS px. */
export function gridRowsStyle(g: RowSplit): string {
	return `${g.top * ROW_STEP - GAP}px ${g.bottom * ROW_STEP - GAP}px`;
}
