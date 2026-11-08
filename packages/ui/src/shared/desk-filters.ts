// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The desk's filter rules, pure: which filter field a category click writes, the window the breakdown reads, and the
 * order the chips show in. The selection is the filter, so a click on a slice, a legend row or a lane is one call to
 * `toggleCategory` and every window reads the result.
 */

import type { Dimension, SpendWindow } from "./breakdown.js";
import type { FilterState } from "./filters.js";
import { type RangeId, rangeWindow } from "./spend-series.js";

type FacetField = "actors" | "jobTypes" | "models" | "kinds" | "providers";

/** The filter field each dimension's categories are written to. */
export const FACET_FIELD: Record<Dimension, FacetField> = {
	lane: "actors",
	role: "jobTypes",
	model: "models",
	kind: "kinds",
	provider: "providers",
};

/** The categories of `dim` that the filter holds. */
export function selectedKeys(f: FilterState, dim: Dimension): ReadonlySet<string> {
	return new Set(f[FACET_FIELD[dim]]);
}

/**
 * The filter without the dimension's own field, for the rows a breakdown of that dimension reads: a slice is still
 * drawn when another is selected, and its number is the one it had before the click.
 */
export function withoutDimension(f: FilterState, dim: Dimension): FilterState {
	return { ...f, [FACET_FIELD[dim]]: [] };
}

/**
 * A click on a category. Plain: it becomes the only one, or clears when it already is the only one. Additive (shift or
 * command): it joins the selection or leaves it. Only that dimension's field changes.
 */
export function toggleCategory(
	f: FilterState,
	dim: Dimension,
	key: string,
	additive: boolean,
): FilterState {
	const field = FACET_FIELD[dim];
	const cur = f[field];
	const has = cur.includes(key);
	let next: string[];
	if (additive) next = has ? cur.filter((k) => k !== key) : [...cur, key];
	else next = has && cur.length === 1 ? [] : [key];
	return { ...f, [field]: next };
}

const MINUTE_MS = 60_000;

/**
 * The window the breakdown reads. Live, it ends at the end of the current minute, so a record stamped inside this
 * minute counts. At a position it ends one millisecond after the DRAWN answer's `ts`, so the record at the position
 * counts too (a window is half-open). `shown` is the answer the rows come from, never a newer position mid-drag.
 */
export function deskWindow(
	range: RangeId,
	shown: { ts: string } | null,
	nowMs: number,
): SpendWindow {
	const at = shown === null ? Number.NaN : Date.parse(shown.ts);
	const endMs = Number.isFinite(at)
		? at + 1
		: Math.floor(nowMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
	return rangeWindow(range, endMs);
}

/** The chip order of the filter bar. */
const LIST_FIELDS = [
	"kinds",
	"models",
	"actors",
	"statuses",
	"jobTypes",
	"typeSources",
	"providers",
] as const;

function tokensOf(f: FilterState): string[] {
	const out: string[] = [];
	const q = f.search.trim();
	if (q !== "") out.push(`search:${q}`);
	for (const field of LIST_FIELDS) for (const v of f[field]) out.push(`${field}:${v}`);
	if (f.from !== undefined) out.push(`from:${f.from}`);
	if (f.to !== undefined) out.push(`to:${f.to}`);
	if (f.costMin !== undefined) out.push(`costMin:${f.costMin}`);
	if (f.costMax !== undefined) out.push(`costMax:${f.costMax}`);
	return out;
}

/**
 * The active filters as `"<field>:<value>"` tokens, the newest last: tokens still present keep their place from
 * `prev`, new ones follow in chip order.
 */
export function orderFilters(prev: readonly string[], f: FilterState): string[] {
	const now = tokensOf(f);
	const live = new Set(now);
	const kept = prev.filter((t) => live.has(t));
	const keptSet = new Set(kept);
	return [...kept, ...now.filter((t) => !keptSet.has(t))];
}

/** The filter without one token. A token this does not know leaves the state as it is. */
export function removeFilterToken(f: FilterState, token: string): FilterState {
	const i = token.indexOf(":");
	if (i < 0) return f;
	const field = token.slice(0, i);
	const value = token.slice(i + 1);
	switch (field) {
		case "search":
			return { ...f, search: "" };
		case "from":
			return { ...f, from: undefined };
		case "to":
			return { ...f, to: undefined };
		case "costMin":
			return { ...f, costMin: undefined };
		case "costMax":
			return { ...f, costMax: undefined };
		case "kinds":
		case "models":
		case "actors":
		case "statuses":
		case "jobTypes":
		case "typeSources":
		case "providers":
			return { ...f, [field]: f[field].filter((v) => v !== value) };
		default:
			return f;
	}
}
