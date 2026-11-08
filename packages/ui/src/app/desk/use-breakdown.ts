// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The breakdown the desk shares. Every window reads one object, computed once per change and only when somebody asks,
 * so a tree that never shows a breakdown never pays for one.
 */

import {
	type Breakdown,
	breakdown,
	type Dimension,
	type SpendWindow,
} from "../../shared/breakdown.js";
import { withoutDimension } from "../../shared/desk-filters.js";
import { applyFilters, type FilterState } from "../../shared/filters.js";
import type { LedgerRow } from "../../shared/rows.js";

/** A function that runs on the first read and gives the same value to every read after. */
export function memoOnce<T>(fn: () => T): () => T {
	let done = false;
	let value: T;
	return () => {
		if (!done) {
			value = fn();
			done = true;
		}
		return value;
	};
}

/**
 * The breakdown at `level` over `shownRows`, with every filter applied except the level's own field: a slice is still
 * drawn when another is selected, and the selected one keeps the number it had before the click.
 */
export function computeBreakdown(
	shownRows: readonly LedgerRow[],
	f: FilterState,
	win: SpendWindow,
	level: Dimension,
): Breakdown {
	return breakdown(applyFilters([...shownRows], withoutDimension(f, level)), win, level);
}
