// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The page address as the dashboard's state: the view, every filter and the open record, written into the URL
 * fragment (`#view=trends&status=failed&status=denied&q=gpt&from=2026-11-01&open=<hash>`) so a reload keeps them and a
 * link shares them. The fragment is never sent to a server and nothing is fetched because of it.
 *
 * Pure: no `window`, no `history`. The encoding is canonical (sorted keys, sorted de-duplicated values, defaults
 * omitted, so a clean page has an empty hash). Decoding reads UNTRUSTED input (a pasted link), so it never throws and
 * checks every value against the domain the filters use; anything outside it is dropped, never repaired.
 */

import { EMPTY_FILTERS, type FilterState } from "./filters.js";

export type ViewId = "audit" | "trends";

export const DEFAULT_VIEW: ViewId = "audit";

export interface UrlState {
	view: ViewId;
	filters: FilterState;
	/** The open record's event hash, or null. */
	open: string | null;
}

export const EMPTY_URL_STATE: UrlState = { view: DEFAULT_VIEW, filters: EMPTY_FILTERS, open: null };

/** A hash longer than this is ignored whole: a real state is a few hundred characters. */
export const MAX_HASH_LENGTH = 4096;
/** Facet values kept per key and the longest one kept; the search text has its own cap. */
const MAX_VALUES_PER_KEY = 100;
const MAX_VALUE_LENGTH = 256;
const MAX_SEARCH_LENGTH = 512;

const VIEWS: readonly ViewId[] = ["audit", "trends"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Canonical non-negative integer text: no sign, no leading zeros, no exponent, no fraction. */
const INTEGER = /^(0|[1-9]\d*)$/;
const EVENT_HASH = /^[0-9a-f]{64}$/;
/** Control, format (zero-width and bidirectional marks) and line/paragraph separator characters. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** The facet fields: URL key -> filter field. Sorted by key, which is the order they are written in. */
const FACETS = [
	["actor", "actors"],
	["job", "jobTypes"],
	["kind", "kinds"],
	["model", "models"],
	["source", "typeSources"],
	["status", "statuses"],
] as const;

function isDay(s: string): boolean {
	if (!DAY.test(s)) return false;
	// A real calendar day: 2026-02-30 matches the shape and is not one.
	const t = Date.parse(`${s}T00:00:00.000Z`);
	return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

function isCost(n: number | undefined): n is number {
	return n !== undefined && Number.isSafeInteger(n) && n >= 0;
}

function cleanText(s: string, max: number): string | null {
	return s.length > 0 && s.length <= max && !INVISIBLE.test(s) ? s : null;
}

/** The canonical hash for a state: `""` for the defaults, otherwise `#` and the sorted pairs. */
export function encodeUrlState(state: UrlState): string {
	const f = state.filters;
	const pairs: Array<[string, string]> = [];
	for (const [key, field] of FACETS) {
		for (const v of [...new Set(f[field])].sort()) pairs.push([key, v]);
	}
	if (f.from !== undefined && isDay(f.from)) pairs.push(["from", f.from]);
	if (f.to !== undefined && isDay(f.to)) pairs.push(["to", f.to]);
	if (isCost(f.costMax)) pairs.push(["max", String(f.costMax)]);
	if (isCost(f.costMin)) pairs.push(["min", String(f.costMin)]);
	if (state.open !== null && EVENT_HASH.test(state.open)) pairs.push(["open", state.open]);
	if (f.search !== "") pairs.push(["q", f.search]);
	if (state.view !== DEFAULT_VIEW) pairs.push(["view", state.view]);
	// Sorted by key (then value): the same state always gives the same hash, whatever order it was built in.
	pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
	if (pairs.length === 0) return "";
	const params = new URLSearchParams();
	for (const [k, v] of pairs) params.append(k, v);
	return `#${params.toString()}`;
}

/**
 * The state a hash describes, with defaults for everything absent or invalid. Never throws. A facet value is kept as a
 * string and only ever compared against rows; it is never rendered as markup by this module.
 */
export function decodeUrlState(hash: string): UrlState {
	try {
		if (typeof hash !== "string" || hash.length > MAX_HASH_LENGTH) return EMPTY_URL_STATE;
		const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);

		const facet = (key: string): string[] => {
			const kept = new Set<string>();
			for (const v of params.getAll(key)) {
				const ok = cleanText(v, MAX_VALUE_LENGTH);
				if (ok !== null && kept.size < MAX_VALUES_PER_KEY) kept.add(ok);
			}
			return [...kept].sort();
		};
		const day = (key: string): string | undefined => {
			const v = params.get(key);
			return v !== null && isDay(v) ? v : undefined;
		};
		const cost = (key: string): number | undefined => {
			const v = params.get(key);
			if (v === null || !INTEGER.test(v)) return undefined;
			const n = Number(v);
			return isCost(n) ? n : undefined;
		};

		const filters: FilterState = {
			...EMPTY_FILTERS,
			search: cleanText(params.get("q") ?? "", MAX_SEARCH_LENGTH) ?? "",
		};
		for (const [key, field] of FACETS) filters[field] = facet(key);
		const from = day("from");
		const to = day("to");
		const costMin = cost("min");
		const costMax = cost("max");
		if (from !== undefined) filters.from = from;
		if (to !== undefined) filters.to = to;
		if (costMin !== undefined) filters.costMin = costMin;
		if (costMax !== undefined) filters.costMax = costMax;

		const view = params.get("view");
		const open = params.get("open");
		return {
			view: VIEWS.find((v) => v === view) ?? DEFAULT_VIEW,
			filters,
			open: open !== null && EVENT_HASH.test(open) ? open : null,
		};
	} catch {
		return EMPTY_URL_STATE;
	}
}

/**
 * What to do with the address when the state changes from `prev` to `next` while the address reads `currentHash`.
 * Changing the view or the open record pushes an entry, so Back returns to the previous view or record; a filter
 * tweak replaces the current one, so typing in the search box does not flood the back button. Nothing is written when
 * the address already describes `next` (the state came from the address, or a write already landed).
 */
export function planHistory(
	prev: UrlState,
	next: UrlState,
	currentHash: string,
): { kind: "push" | "replace" | "none"; hash: string } {
	const hash = encodeUrlState(next);
	if (encodeUrlState(decodeUrlState(currentHash)) === hash) return { kind: "none", hash };
	const navigated = prev.view !== next.view || prev.open !== next.open;
	return { kind: navigated ? "push" : "replace", hash };
}

/** Two states that write the same hash are the same state. */
export function sameUrlState(a: UrlState, b: UrlState): boolean {
	return encodeUrlState(a) === encodeUrlState(b);
}
