// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Spend records and the exact cumulative spend at each one. Pure.
 *
 * A record is a spend row (`isHeaderSpend`, the one definition) with a readable time. `cum[i]` is what was spent by
 * record i: `before` (the spend older than the rows held) plus every spend row at or before its position. That is the
 * rule the server's spent-at-position reads, so a pinned record shows the same figure here and there. A spend row
 * whose time cannot be read is not a record (it has no place on a time axis), but its cost is still spent at its
 * position, so it is in `cum` from the next record on and in the sum that sets `before`.
 */

import { isHeaderSpend } from "./aggregate.js";
import type { SpendWindow } from "./breakdown.js";
import type { LedgerRow } from "./rows.js";

export interface SpendRecords {
	n: number;
	/** Each record's position, ascending. */
	pos: Int32Array;
	/** Each record's time, epoch ms, never decreasing: a record written out of order takes the running maximum. */
	t: Float64Array;
	/** Spend up to and including record i, `before` included. */
	cum: Float64Array;
	hash: string[];
	/** Spend older than the rows held: `totalUt` less every spend row held, never below 0; 0 with no total. */
	before: number;
}

/**
 * The records of `rows`, in position order. `onSpend` (optional) is told each spend row with its parsed time (NaN when
 * unreadable) during the same pass, so a caller can tally spend rows without a second scan.
 */
export function spendRecords(
	rows: readonly LedgerRow[],
	totalUt: number | null,
	onSpend?: (row: LedgerRow, t: number) => void,
): SpendRecords {
	const spend: LedgerRow[] = [];
	const times: number[] = [];
	let sum = 0;
	let readable = 0;
	let ordered = true;
	for (const row of rows) {
		if (!isHeaderSpend(row.kind, row.costUt)) continue;
		const t = Date.parse(row.ts);
		onSpend?.(row, t);
		sum += row.costUt;
		if (!Number.isNaN(t)) readable += 1;
		const prev = spend[spend.length - 1];
		if (prev !== undefined && row.pos < prev.pos) ordered = false;
		spend.push(row);
		times.push(t);
	}
	const order = spend.map((_, j) => j);
	if (!ordered) order.sort((a, b) => (spend[a] as LedgerRow).pos - (spend[b] as LedgerRow).pos);

	const before = totalUt !== null && Number.isFinite(totalUt) ? Math.max(0, totalUt - sum) : 0;
	const pos = new Int32Array(readable);
	const t = new Float64Array(readable);
	const cum = new Float64Array(readable);
	const hash: string[] = new Array(readable);
	let carry = before;
	let maxT = Number.NEGATIVE_INFINITY;
	let i = 0;
	for (const j of order) {
		const row = spend[j] as LedgerRow;
		carry += row.costUt as number;
		const tj = times[j] as number;
		if (Number.isNaN(tj)) continue;
		if (tj > maxT) maxT = tj;
		pos[i] = row.pos;
		t[i] = maxT;
		cum[i] = carry;
		hash[i] = row.hash;
		i += 1;
	}
	return { n: readable, pos, t, cum, hash, before };
}

/** The first index in `[0, n)` where `past(index)` holds, `n` when none; `past` must be monotone. */
function firstWhere(n: number, past: (i: number) => boolean): number {
	let lo = 0;
	let hi = n;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (past(mid)) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/** The last record at or before `ms`, -1 when none. */
export function lastAtOrBefore(s: SpendRecords, ms: number): number {
	if (Number.isNaN(ms)) return -1;
	return firstWhere(s.n, (i) => (s.t[i] as number) > ms) - 1;
}

/** The last record whose position is at or before `pos`, -1 when none. */
export function indexAtPos(s: SpendRecords, pos: number): number {
	if (Number.isNaN(pos)) return -1;
	return firstWhere(s.n, (i) => (s.pos[i] as number) > pos) - 1;
}

/** The records in the half-open window, `startMs <= t < endMs`; `i1 < i0` when none. */
export function inWindow(s: SpendRecords, win: SpendWindow): { i0: number; i1: number } {
	const i0 = firstWhere(s.n, (i) => (s.t[i] as number) >= win.startMs);
	const i1 = firstWhere(s.n, (i) => (s.t[i] as number) >= win.endMs) - 1;
	return { i0, i1 };
}

/** `by` records from `i` in direction `dir`, clamped to the span; -1 when the span has no record. */
export function stepIndex(
	i: number,
	dir: -1 | 1,
	by: number,
	span: { i0: number; i1: number },
): number {
	if (span.i1 < span.i0) return -1;
	const j = i + dir * by;
	const k = Number.isNaN(j) ? i : j;
	return Math.min(span.i1, Math.max(span.i0, k));
}
