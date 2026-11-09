// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Stable colours. A category keeps one colour in every view, whatever the filter and whatever the time: the colour
 * comes from the category's rank by spend over the records the page holds (at most `ROW_CAP`), never from the filtered
 * view. That held-rows rank is the FALLBACK: the whole-vault ranking comes from the server's totals endpoint
 * (`GET /api/totals`), and the caller should read that first (`colorsFromRanking` takes any ranking of keys, highest
 * first).
 *
 * The top five categories take the series slots in order; the rest, "untyped" and "Other" take the muted tone, and a
 * muted category does not use up a slot. Providers keep a fixed colour each. A key that first appears on the live
 * tail takes the next free slot (or muted when none is left), and no existing key is ever repainted.
 */

import { breakdown, type Dimension, WHOLE_VAULT } from "./breakdown.js";
import type { ProviderName } from "./provider.js";
import type { LedgerRow } from "./rows.js";

/** The fixed colour of each named provider. */
export const PROVIDER_COLOR: Record<Exclude<ProviderName, "Other">, string> = {
	Anthropic: "#BE804D",
	OpenAI: "#5D6775",
	xAI: "#C8CCD3",
	Google: "#7095C1",
};

/** The five series slots, in rank order. */
export const SERIES = ["#BE804D", "#5D6775", "#C8CCD3", "#7095C1", "#E8B54B"] as const;

/** The tone for everything past the fifth, for "untyped" and for "Other". */
export const MUTED = "#8A877F";

export interface ColorMap {
	dim: Dimension;
	/** The key's colour; the muted tone for a key the map has not met. */
	of(key: string): string;
	/** Give a key first seen after the map was built its colour. An existing key keeps the colour it has. */
	add(key: string): string;
}

/** Keys that never take a series slot. */
function isMutedKey(key: string): boolean {
	return key === "untyped" || key === "Other";
}

function isNamedProvider(key: string): key is Exclude<ProviderName, "Other"> {
	return Object.hasOwn(PROVIDER_COLOR, key);
}

/**
 * Rank every key of `dim` by spend over the rows the page holds (`allRows`, at most `ROW_CAP`; ties A to Z) and fix
 * its colour. This is the FALLBACK ranking: the whole-vault ranking comes from the server's totals endpoint
 * (`GET /api/totals`), and the caller should read that first and pass it to `colorsFromRanking`. Pass every held
 * record, never a filtered subset: a map built from a filter would repaint the categories the filter leaves. On a
 * vault larger than the cap, an actor whose spend sits in older records is ranked here only by the records the page
 * holds.
 */
export function rankColors(allRows: readonly LedgerRow[], dim: Dimension): ColorMap {
	const keys = dim === "provider" ? [] : breakdown(allRows, WHOLE_VAULT, dim).keys;
	return colorsFromRanking(dim, keys);
}

/**
 * Fix the colours of a ranking: `keys` ordered by spend, highest first, as `Breakdown.keys` is (from the server's
 * whole-vault totals, or from `rankColors` over the held rows). Providers keep their fixed colours and ignore `keys`.
 */
export function colorsFromRanking(dim: Dimension, keys: readonly string[]): ColorMap {
	const assigned = new Map<string, string>();
	let used = 0;
	const give = (key: string): string => {
		const existing = assigned.get(key);
		if (existing !== undefined) return existing;
		let color = MUTED;
		if (!isMutedKey(key) && used < SERIES.length) {
			color = SERIES[used] as string;
			used += 1;
		}
		assigned.set(key, color);
		return color;
	};

	if (dim !== "provider") for (const key of keys) give(key);

	const providerColor = (key: string): string =>
		isNamedProvider(key) ? PROVIDER_COLOR[key] : MUTED;

	return {
		dim,
		of: (key) => (dim === "provider" ? providerColor(key) : (assigned.get(key) ?? MUTED)),
		add: (key) => (dim === "provider" ? providerColor(key) : give(key)),
	};
}
