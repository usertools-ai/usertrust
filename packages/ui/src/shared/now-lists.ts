// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Now window's lists: spend by period with its change, the top rows of a breakdown, the latest records. Pure.
 *
 * Spend is `isHeaderSpend`, and every period is half-open, `start <= t < end`, as `breakdown` is: a period's figure
 * equals the breakdown of the same window.
 */

import { isHeaderSpend } from "./aggregate.js";
import type { Breakdown } from "./breakdown.js";
import { formatUsdTotal } from "./format.js";
import { HOUR_MS } from "./now-rate.js";
import type { LedgerRow } from "./rows.js";

export type PeriodId = "hour" | "day" | "three-days" | "month";

export interface Period {
	id: PeriodId;
	label: string;
	spendUt: number;
	/** Spend in the period of the same length just before this one; null for the month, which has none. */
	prevUt: number | null;
}

const SPANS = [
	{ id: "hour", label: "Last hour", ms: HOUR_MS },
	{ id: "day", label: "Last 24 h", ms: 24 * HOUR_MS },
	{ id: "three-days", label: "Last 3 days", ms: 72 * HOUR_MS },
] as const;

/** Spend in the hour, the 24 hours and the 3 days before `endMs`, each with the period before it, and in its UTC month. */
export function periodsOf(rows: readonly LedgerRow[], endMs: number): Period[] {
	const end = new Date(endMs);
	const monthStart = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1);
	const out: Period[] = SPANS.map(({ id, label }) => ({ id, label, spendUt: 0, prevUt: 0 }));
	const month: Period = { id: "month", label: "This month", spendUt: 0, prevUt: null };
	for (const row of rows) {
		if (!isHeaderSpend(row.kind, row.costUt)) continue;
		const t = Date.parse(row.ts);
		if (!(t < endMs)) continue;
		const cost = row.costUt;
		if (t >= monthStart) month.spendUt += cost;
		SPANS.forEach(({ ms }, i) => {
			const p = out[i] as Period;
			if (t >= endMs - ms) p.spendUt += cost;
			else if (t >= endMs - 2 * ms) p.prevUt = (p.prevUt as number) + cost;
		});
	}
	return [...out, month];
}

/** A period's change against the one before it, in whole percent; the title gives the earlier figure. */
export function periodDelta(p: Pick<Period, "spendUt" | "prevUt">): {
	text: string;
	title: string | null;
} {
	if (p.prevUt === null) return { text: "records this month", title: null };
	const title = `the period before: ${formatUsdTotal(p.prevUt)}`;
	if (p.prevUt === 0) return { text: "vs nothing before", title };
	const delta = (p.spendUt - p.prevUt) / p.prevUt;
	const pct = Math.abs(delta * 100).toFixed(0);
	// A drop takes the minus sign, U+2212, not a hyphen.
	return { text: `${delta >= 0 ? "+" : "−"}${pct}% vs before`, title };
}

/** The first `n` keys of a breakdown. `rel` is a key's spend over the largest key's: 0 when the largest is 0. */
export function topRows(
	bd: Breakdown,
	n = 6,
): Array<{ key: string; spendUt: number; rel: number }> {
	const spendOf = (key: string | undefined): number => bd.byKey.get(key ?? "")?.spendUt ?? 0;
	const top = spendOf(bd.keys[0]);
	return bd.keys.slice(0, n).map((key) => {
		const spendUt = spendOf(key);
		return { key, spendUt, rel: top > 0 ? spendUt / top : 0 };
	});
}

/** The `n` records with the greatest position, newest first. */
export function latestRecords(rows: readonly LedgerRow[], n = 20): LedgerRow[] {
	return [...rows].sort((a, b) => b.pos - a.pos).slice(0, n);
}

/** The record with the greatest position, wherever it sits in the array. */
export function lastRecord(rows: readonly LedgerRow[]): LedgerRow | null {
	let last: LedgerRow | null = null;
	for (const row of rows) if (last === null || row.pos > last.pos) last = row;
	return last;
}

/** Spend of the records at or before position `pos`; of every record when `pos` is null. */
export function spendUpTo(rows: readonly LedgerRow[], pos: number | null): number {
	let sum = 0;
	for (const row of rows)
		if (isHeaderSpend(row.kind, row.costUt) && (pos === null || row.pos <= pos)) sum += row.costUt;
	return sum;
}
