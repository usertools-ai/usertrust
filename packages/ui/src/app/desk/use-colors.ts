// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The desk's colours, fixed for the session. A category keeps the colour it was given in every view, whatever the
 * filter, the range or the position: the map is built once per dimension, and a key first seen on the live tail takes
 * the next free slot without repainting any other. So does a held key the whole-vault ranking lacks: the totals and
 * the ledger load race, and a category whose first records came between the two is held but not ranked.
 *
 * The ranking comes from the server's whole-vault totals when they arrived. The rows the page holds are only the
 * labelled FALLBACK, for a request that failed or timed out: they can miss a category whose spend is all in older
 * records.
 */

import { isHeaderSpend } from "../../shared/aggregate.js";
import type { TotalsPayload } from "../../shared/api.js";
import { type Dimension, keyOf } from "../../shared/breakdown.js";
import { type ColorMap, colorsFromRanking, rankColors } from "../../shared/colors.js";
import type { LedgerRow } from "../../shared/rows.js";
import { rankingFrom } from "../../shared/totals.js";

/** Where the ranking came from: the whole vault, or (the fallback) the rows the page holds. */
export type ColorSource = "whole vault" | "held rows";

/** The outcome of the totals request: not settled yet, failed (null), or the payload. */
export type TotalsOutcome = "pending" | null | TotalsPayload;

interface Entry {
	map: ColorMap;
	/** How many rows have been looked at, so the next `observe` reads only the ones appended since. */
	scanned: number;
	seen: Set<string>;
}

export class ColorBook {
	private readonly entries = new Map<Dimension, Entry>();
	private chosen: { source: ColorSource; totals: TotalsPayload | null } | null = null;

	/** Where the ranking came from; null until the first map is built. Chosen once, for every dimension. */
	get source(): ColorSource | null {
		return this.chosen?.source ?? null;
	}

	/**
	 * The colour map for `dim`. Until the vault has loaded AND the totals request has settled it is an empty,
	 * throwaway map: building the real one from a partial snapshot would rank by the wrong totals and then be kept for
	 * ever. After that it is built once and the same instance comes back every time.
	 *
	 * The source is chosen at the first build and every dimension uses it: with a payload, each map ranks by the
	 * whole vault; with `null`, by `allRows` (the fallback). An answer that arrives later changes nothing.
	 */
	mapFor(
		dim: Dimension,
		allRows: readonly LedgerRow[],
		loaded: boolean,
		totals: TotalsOutcome,
	): ColorMap {
		const have = this.entries.get(dim);
		if (have !== undefined) return have.map;
		if (!loaded || totals === "pending") return rankColors([], dim);
		this.chosen ??=
			totals === null ? { source: "held rows", totals: null } : { source: "whole vault", totals };
		const map =
			this.chosen.totals === null
				? rankColors([...allRows], dim)
				: colorsFromRanking(dim, rankingFrom(this.chosen.totals, dim));
		// Every held key has its colour before it counts as seen: `observe` gives nothing to a key it has seen, so a held
		// key the ranking lacks, marked seen without one, stayed muted for the session.
		const seen = keysOf(dim, allRows, 0);
		for (const key of seen) map.add(key);
		this.entries.set(dim, { map, scanned: allRows.length, seen });
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
