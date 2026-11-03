// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Keyboard movement through the audit list, and what a screen reader says for a row. Pure: the list component only
 * wires these to the page.
 */

import { costView } from "./display.js";
import { formatUtc } from "./format.js";
import { type LedgerRow, statusOf } from "./rows.js";

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
		statusOf(row),
	];
	if (row.integrity !== "verified") parts.push("after break");
	return parts.join(", ");
}
