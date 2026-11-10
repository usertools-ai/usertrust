// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Keyboard movement through the audit list, and what a screen reader says for a row. Pure: the list component only
 * wires these to the page.
 */

import { costView } from "./display.js";
import { formatUtc } from "./format.js";
import { type LedgerRow, statusOf } from "./rows.js";
import { statusWord } from "./status-word.js";

/**
 * How many rows a PageUp or PageDown moves: the rows that fit wholly in the list's viewport, measured (each item's
 * start and end as the virtualiser laid it out), less one so the row at the edge stays in view. At least 1. Under
 * 560px a row wraps and is two or three times its desktop height, so a fixed row-height estimate would skip rows.
 */
export function pageSizeFromItems(
	items: readonly { start: number; end: number }[],
	scrollTop: number,
	viewportHeight: number,
): number {
	const bottom = scrollTop + viewportHeight;
	const whole = items.filter((v) => v.start >= scrollTop && v.end <= bottom).length;
	return Math.max(1, whole - 1);
}

/**
 * The index of the active row in the rows as now sorted and filtered. The active row is tracked by hash, so a sort, a
 * filter or a live insert moves its index but not the row; when the row has left the set, the open (selected) row
 * stands in, and failing that the first row. `-1` only for an empty list.
 */
export function resolveActiveIndex(
	rows: readonly { hash: string }[],
	activeHash: string | null,
	selectedHash: string | null | undefined,
): number {
	if (rows.length === 0) return -1;
	const find = (hash: string | null | undefined): number =>
		hash === null || hash === undefined ? -1 : rows.findIndex((r) => r.hash === hash);
	const i = find(activeHash);
	if (i >= 0) return i;
	return Math.max(0, find(selectedHash));
}

/**
 * Where the active row goes for a key, or `null` when the key is not one of the list's movement keys (or the list is
 * empty), so the caller leaves the key alone. A move past either end stays at the end. `current` may be stale or out
 * of range (the rows changed under it) and is clamped first; `pageSize` is how many rows a screenful holds and is
 * at least 1.
 */
export function nextRowIndex(
	current: number,
	key: string,
	count: number,
	pageSize: number,
): number | null {
	if (!Number.isFinite(count) || count <= 0) return null;
	const last = Math.trunc(count) - 1;
	const clamp = (n: number): number => Math.min(Math.max(n, 0), last);
	const from = clamp(Number.isFinite(current) ? Math.trunc(current) : 0);
	const page = Number.isFinite(pageSize) ? Math.max(1, Math.trunc(pageSize)) : 1;
	switch (key) {
		case "ArrowDown":
			return clamp(from + 1);
		case "ArrowUp":
			return clamp(from - 1);
		case "PageDown":
			return clamp(from + page);
		case "PageUp":
			return clamp(from - page);
		case "Home":
			return 0;
		case "End":
			return last;
		default:
			return null;
	}
}

/**
 * What a screen reader announces for a row as the arrows move over it: what it is (the model, or the kind of event
 * where there is none), what it cost, when, and its status. The cost is the row's own figure, as shown; a row with
 * no recorded cost says so, never 0. A row after a chain break says so, as the row does.
 */
export function rowAccessibleName(row: LedgerRow): string {
	const cost = costView(row);
	const parts = [
		row.model ?? row.kind,
		cost === null
			? "no cost recorded"
			: `${cost.ut}, ${cost.usd}${cost.estimated ? ", estimated" : ""}`,
		formatUtc(row.ts),
		// The word the badge shows, so the name and the row say the same thing.
		statusWord(statusOf(row)),
	];
	if (row.integrity !== "verified") parts.push("after break");
	return parts.join(", ");
}

/**
 * Whether an open popover is on the page: a filter's choices or an explainer, each a `.ut-pop` rendered only while open,
 * listening for Escape on the document. That Escape is the popover's: it closes, and the inspector stays. An expanded
 * disclosure that is not a popover (the phone's Details or Filters toggle, `aria-expanded` but handling Escape only
 * while focus is inside it) does not count, or Escape with Details open would close neither it nor the inspector.
 */
export function popoverOwnsEscape(doc: Pick<ParentNode, "querySelector">): boolean {
	return doc.querySelector(".ut-pop") !== null;
}
