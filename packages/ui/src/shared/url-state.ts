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
 *
 * The encoder never writes a link that decodes to something else: `addressHolds` says whether a state survives the
 * trip, and a state that does not (text a link cannot carry, a facet value past the caps, a fragment past the length
 * cap) is not written at all; the page says so instead.
 */

import { EMPTY_FILTERS, type FilterState } from "./filters.js";

export type ViewId = "audit" | "trends";

export const DEFAULT_VIEW: ViewId = "audit";

/** The windows that can fill the desk. */
export type FillId = "spend" | "share" | "ledger" | "now";

export interface UrlState {
	view: ViewId;
	filters: FilterState;
	/** The open record's event hash, or null. */
	open: string | null;
	/** The position the page shows the vault as recorded at, or null for live. */
	at: number | null;
	/** Which window fills the desk, or null for the default. */
	fill: FillId | null;
}

export const EMPTY_URL_STATE: UrlState = {
	view: DEFAULT_VIEW,
	filters: EMPTY_FILTERS,
	open: null,
	at: null,
	fill: null,
};

/** The longest search text kept (UTF-16 code units, as `String.length` and an input's `maxLength` count them). */
export const MAX_SEARCH_LENGTH = 512;
/**
 * A hash longer than this is ignored whole. A real state is a few hundred characters; the cap leaves room for the
 * longest search the box allows in any script: each code unit percent-encodes to at most 9 characters (a 3-byte UTF-8
 * character, `%E3%81%82`), so 512 of them take 4,608.
 */
export const MAX_HASH_LENGTH = 8192;
/** Facet values kept per key and the longest one kept; the search text has its own cap. */
const MAX_VALUES_PER_KEY = 100;
const MAX_VALUE_LENGTH = 256;

const VIEWS: readonly ViewId[] = ["audit", "trends"];
const FILLS: readonly FillId[] = ["spend", "share", "ledger", "now"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Canonical non-negative decimal text: no sign, no leading zeros, no exponent, no trailing zeros in a fraction (`0`,
 * `12`, `1.5`; never `1.50`, `.5`, `1e3` or `-0`). A cost bound is a number the filter bar takes as typed, fractions
 * included.
 */
const DECIMAL = /^(0|[1-9]\d*)(\.\d*[1-9])?$/;
/** Canonical non-negative integer text: no sign, no leading zeros, no fraction or exponent. */
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
	["provider", "providers"],
	["source", "typeSources"],
	["status", "statuses"],
] as const;

function isDay(s: string): boolean {
	if (!DAY.test(s)) return false;
	// A real calendar day: 2026-02-30 matches the shape and is not one.
	const t = Date.parse(`${s}T00:00:00.000Z`);
	return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/**
 * The text for a cost bound, or null when it has none a link can carry: not finite, negative, or a number whose
 * shortest form is not plain decimal (`1e-7`, `1e+21`). Decoding accepts exactly the texts this returns.
 */
function costText(n: number | undefined): string | null {
	if (n === undefined || !Number.isFinite(n) || n < 0) return null;
	const t = String(n);
	return DECIMAL.test(t) ? t : null;
}

/** The position text for `at`, or null when it is not a safe non-negative integer. */
function positionText(n: number | null): string | null {
	return n !== null && Number.isSafeInteger(n) && n >= 0 ? String(n) : null;
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
	const max = costText(f.costMax);
	const min = costText(f.costMin);
	if (max !== null) pairs.push(["max", max]);
	if (min !== null) pairs.push(["min", min]);
	const at = positionText(state.at);
	if (at !== null) pairs.push(["at", at]);
	if (state.fill !== null && FILLS.includes(state.fill)) pairs.push(["fill", state.fill]);
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
			if (v === null || !DECIMAL.test(v)) return undefined;
			// Only the text the encoder would write for the number: `9007199254740993` reads as ...992 and is refused.
			const n = Number(v);
			return costText(n) === v ? n : undefined;
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
		const fills = params.getAll("fill");
		const fillText = fills.length === 1 ? fills[0] : undefined;
		const atTexts = params.getAll("at");
		const atText = atTexts.length === 1 ? atTexts[0] : undefined;
		const at = atText !== undefined && INTEGER.test(atText) ? Number(atText) : null;
		return {
			view: VIEWS.find((v) => v === view) ?? DEFAULT_VIEW,
			filters,
			open: open !== null && EVENT_HASH.test(open) ? open : null,
			at: at !== null && Number.isSafeInteger(at) ? at : null,
			fill: FILLS.find((f) => f === fillText) ?? null,
		};
	} catch {
		return EMPTY_URL_STATE;
	}
}

/** Everything the address can say about a state, before any check: facet values de-duplicated and sorted. */
function described(s: UrlState): string {
	const f = s.filters;
	const opt = (v: string | number | undefined): string | null =>
		v === undefined ? null : String(v);
	return JSON.stringify([
		s.view,
		s.open,
		s.at === null ? null : String(s.at),
		s.fill,
		f.search,
		opt(f.from),
		opt(f.to),
		opt(f.costMin),
		opt(f.costMax),
		FACETS.map(([, field]) => [...new Set(f[field])].sort()),
	]);
}

/**
 * Whether the address can hold this state: its hash is within the cap and decodes back to the same state. False for
 * search text or a facet value with characters a link cannot carry (invisible marks, a lone surrogate), a value past
 * its cap, more facet values than are kept, a cost with no plain decimal form, or a hash past `MAX_HASH_LENGTH`.
 */
export function addressHolds(state: UrlState): boolean {
	const hash = encodeUrlState(state);
	return hash.length <= MAX_HASH_LENGTH && described(decodeUrlState(hash)) === described(state);
}

/**
 * What to do with the address when the state changes from `prev` to `next` while the address reads `currentHash`.
 * Changing the view or the open record, or entering or leaving a position, pushes an entry, so Back returns to the
 * previous view or record; a filter tweak or a move between positions replaces the current one, so typing in the
 * search box or a preview moving along the chart does not flood the back button. Nothing is written when
 * the address already describes `next` (the state came from the address, or a write already landed). A state the
 * address cannot hold (`addressHolds`) writes the empty hash: a reload or a copied link opens a clean page, never a
 * different filter set, and the page tells the user.
 */
export function planHistory(
	prev: UrlState,
	next: UrlState,
	currentHash: string,
): { kind: "push" | "replace" | "none"; hash: string } {
	const hash = addressHolds(next) ? encodeUrlState(next) : "";
	if (encodeUrlState(decodeUrlState(currentHash)) === hash) return { kind: "none", hash };
	// Entering or leaving a position is a navigation; moving between positions (a preview) is not.
	const navigated =
		prev.view !== next.view || prev.open !== next.open || (prev.at === null) !== (next.at === null);
	return { kind: navigated ? "push" : "replace", hash };
}

/**
 * The same state: every field equal, facet values compared as sets. Compared in full, never by the hash they write: the
 * encoder leaves out what it cannot carry (a cost of 1e-7), so two states with the same hash can still differ, and
 * Back or a followed link must not keep a filter the address never held.
 */
export function sameUrlState(a: UrlState, b: UrlState): boolean {
	return described(a) === described(b);
}
