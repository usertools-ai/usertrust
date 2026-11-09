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
import { type Dimension, keyOf, rankOrder, spendInWindow, WHOLE_VAULT } from "./breakdown.js";
import type { SpendFacts } from "./rows.js";

/** The most keys per dimension a response carries; `more` counts the rest. The index itself keeps every key. */
export const TOTALS_KEYS_MAX = 100;

type Entry = { spendUt: number; calls: number };

/** The one list of dimensions: an object literal over `Dimension`, so a sixth one fails to compile until it is here. */
function perDimension<T>(make: (dim: Dimension) => T): Record<Dimension, T> {
	return {
		lane: make("lane"),
		role: make("role"),
		model: make("model"),
		kind: make("kind"),
		provider: make("provider"),
	};
}

/**
 * The first `k` keys of the ranking `byTotalDesc` gives over the same pairs, in that order, in O(n log k): a sorted
 * array of at most `k` pairs, into which a pair that ranks before the current last is inserted by binary search.
 */
export function topKeys(entries: Iterable<readonly [string, number]>, k: number): string[] {
	if (k <= 0) return [];
	const kept: Array<readonly [string, number]> = [];
	for (const pair of entries) {
		if (kept.length === k && rankOrder(pair, kept[k - 1] as readonly [string, number]) >= 0)
			continue;
		let lo = 0;
		let hi = kept.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (rankOrder(kept[mid] as readonly [string, number], pair) <= 0) lo = mid + 1;
			else hi = mid;
		}
		kept.splice(lo, 0, pair);
		if (kept.length > k) kept.pop();
	}
	return kept.map(([key]) => key);
}

export class TotalsIndex {
	private readonly byDim = perDimension((): Map<string, Entry> => new Map());
	private folded = 0;

	/** Fold one record in. Every record counts toward `records`; only spend adds to a key. */
	add(f: SpendFacts): void {
		this.folded += 1;
		const cost = spendInWindow(f, WHOLE_VAULT);
		if (cost === undefined) return;
		for (const dim of Object.keys(this.byDim) as Dimension[]) {
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

	/**
	 * Each dimension's keys ranked as `breakdown` ranks them, cut at `TOTALS_KEYS_MAX`. New arrays every call. The
	 * work is a bounded selection per dimension, not a sort of every key: with one lane per session the keys are many
	 * and the response is not.
	 */
	payload(epoch: number): TotalsPayload {
		const dims = perDimension((dim): KeyTotal[] => {
			const map = this.byDim[dim];
			const spend = (function* () {
				for (const [key, entry] of map) yield [key, entry.spendUt] as const;
			})();
			return topKeys(spend, TOTALS_KEYS_MAX).map((key) => {
				const entry = map.get(key) as Entry;
				return { key, spendUt: entry.spendUt, calls: entry.calls };
			});
		});
		const more = perDimension((dim) => Math.max(0, this.byDim[dim].size - TOTALS_KEYS_MAX));
		return { epoch, records: this.folded, dims, more };
	}
}

/** A dimension's keys in payload order, ready for `colorsFromRanking(dim, keys)`. */
export function rankingFrom(p: TotalsPayload, dim: Dimension): string[] {
	return p.dims[dim].map((k) => k.key);
}
