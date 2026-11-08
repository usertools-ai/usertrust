// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Spend and calls per key over EVERY record of the vault, for each dimension. The page holds only some of the rows,
 * so a ranking of the rows it holds can miss a category whose spend is all in older records; this index sees them all.
 *
 * It counts by the breakdown's own rules, not a copy of them: a record is spend only where `spendInWindow` says so
 * over the whole vault (header spend with a time that parses), and its keys come only from `keyOf`.
 */

import type { KeyTotal, TotalsPayload } from "./api.js";
import { byTotalDesc, type Dimension, keyOf, spendInWindow, WHOLE_VAULT } from "./breakdown.js";
import type { SpendFacts } from "./rows.js";

/** The most keys per dimension a response carries; `more` counts the rest. The index itself keeps every key. */
export const TOTALS_KEYS_MAX = 100;

const DIMENSIONS: readonly Dimension[] = ["lane", "role", "model", "kind", "provider"];

type Entry = { spendUt: number; calls: number };

export class TotalsIndex {
	private readonly byDim: Record<Dimension, Map<string, Entry>> = {
		lane: new Map(),
		role: new Map(),
		model: new Map(),
		kind: new Map(),
		provider: new Map(),
	};
	private folded = 0;

	/** Fold one record in. Every record counts toward `records`; only spend adds to a key. */
	add(f: SpendFacts): void {
		this.folded += 1;
		const cost = spendInWindow(f, WHOLE_VAULT);
		if (cost === undefined) return;
		for (const dim of DIMENSIONS) {
			const map = this.byDim[dim];
			const key = keyOf(dim, f);
			const entry = map.get(key);
			if (entry === undefined) map.set(key, { spendUt: cost, calls: 1 });
			else {
				entry.spendUt += cost;
				entry.calls += 1;
			}
		}
	}

	/** Every record folded, spend or not. */
	get records(): number {
		return this.folded;
	}

	/** Each dimension's keys ranked as `breakdown` ranks them, cut at `TOTALS_KEYS_MAX`. New arrays every call. */
	payload(epoch: number): TotalsPayload {
		const dims = {} as Record<Dimension, KeyTotal[]>;
		const more = {} as Record<Dimension, number>;
		for (const dim of DIMENSIONS) {
			const map = this.byDim[dim];
			const spend = new Map<string, number>();
			for (const [key, entry] of map) spend.set(key, entry.spendUt);
			const ranked = byTotalDesc(spend);
			dims[dim] = ranked.slice(0, TOTALS_KEYS_MAX).map((key) => {
				const entry = map.get(key) as Entry;
				return { key, spendUt: entry.spendUt, calls: entry.calls };
			});
			more[dim] = Math.max(0, ranked.length - TOTALS_KEYS_MAX);
		}
		return { epoch, records: this.folded, dims, more };
	}
}

/** A dimension's keys in payload order, ready for `colorsFromRanking(dim, keys)`. */
export function rankingFrom(p: TotalsPayload, dim: Dimension): string[] {
	return p.dims[dim].map((k) => k.key);
}
