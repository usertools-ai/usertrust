// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The desk's colours, fixed for the session. A category keeps the colour it was given in every view, whatever the
 * filter, the range or the position: the map is built once per dimension from every record, and a key first seen on
 * the live tail takes the next free slot without repainting any other.
 */

import { isHeaderSpend } from "../../shared/aggregate.js";
import { type Dimension, keyOf } from "../../shared/breakdown.js";
import { type ColorMap, rankColors } from "../../shared/colors.js";
import type { LedgerRow } from "../../shared/rows.js";

interface Entry {
	map: ColorMap;
	/** How many rows have been looked at, so the next `observe` reads only the ones appended since. */
	scanned: number;
	seen: Set<string>;
}

export class ColorBook {
	private readonly entries = new Map<Dimension, Entry>();

	/**
	 * The colour map for `dim`. Until the vault has loaded it is an empty, throwaway map: building the real one from a
	 * partial snapshot would rank by the wrong totals and then be kept for ever. After that it is built once from
	 * `allRows` and the same instance comes back every time.
	 */
	mapFor(dim: Dimension, allRows: readonly LedgerRow[], loaded: boolean): ColorMap {
		const have = this.entries.get(dim);
		if (have !== undefined) return have.map;
		if (!loaded) return rankColors([], dim);
		const map = rankColors([...allRows], dim);
		this.entries.set(dim, { map, scanned: allRows.length, seen: keysOf(dim, allRows, 0) });
		return map;
	}

	/**
	 * Give every key first seen in the rows appended since the last call its colour. A shrunk array (a resync) is read
	 * again from the start. Only records that carry spend count, as in the ranking: a key that never appears in a
	 * breakdown does not use up a slot. A colour already given never changes.
	 */
	observe(dim: Dimension, allRows: readonly LedgerRow[]): void {
		const e = this.entries.get(dim);
		if (e === undefined) return;
		const from = allRows.length < e.scanned ? 0 : e.scanned;
		for (let i = from; i < allRows.length; i++) {
			const row = allRows[i] as LedgerRow;
			if (!isHeaderSpend(row.kind, row.costUt)) continue;
			const key = keyOf(dim, row);
			if (e.seen.has(key)) continue;
			e.seen.add(key);
			e.map.add(key);
		}
		e.scanned = allRows.length;
	}
}

/** The keys of the spend-bearing rows from `from` on. */
function keysOf(dim: Dimension, rows: readonly LedgerRow[], from: number): Set<string> {
	const out = new Set<string>();
	for (let i = from; i < rows.length; i++) {
		const row = rows[i] as LedgerRow;
		if (isHeaderSpend(row.kind, row.costUt)) out.add(keyOf(dim, row));
	}
	return out;
}
