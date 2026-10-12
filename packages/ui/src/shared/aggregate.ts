// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { type LedgerRow, type RowStatus, statusOf } from "./rows.js";

/**
 * The header's Spend rule: the cost of every `llm_call` record, over the whole vault. ONE predicate, used at load
 * (`state.ts`) and on every live append (`server.ts`), which each carried their own copy. Trends sums every costed
 * record in view instead (an action's cost, an ambiguity's), and is labelled as that, not as Spend.
 */
export function isHeaderSpend(kind: string, cost: unknown): cost is number {
	return kind === "llm_call" && typeof cost === "number";
}

export interface TimeBucket {
	bucket: string;
	costUt: number;
	count: number;
}

export function spendOverTime(rows: LedgerRow[], granularity: "day" | "hour"): TimeBucket[] {
	const buckets = new Map<string, TimeBucket>();
	for (const r of rows) {
		const key =
			granularity === "day" ? r.ts.slice(0, 10) : `${r.ts.slice(0, 10)} ${r.ts.slice(11, 13)}:00`;
		const b = buckets.get(key) ?? { bucket: key, costUt: 0, count: 0 };
		b.costUt += r.costUt ?? 0;
		b.count += 1;
		buckets.set(key, b);
	}
	return [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export interface KeyTotal {
	key: string;
	costUt: number;
	count: number;
}

function totalBy(rows: LedgerRow[], keyOf: (r: LedgerRow) => string | undefined): KeyTotal[] {
	const totals = new Map<string, KeyTotal>();
	for (const r of rows) {
		const key = keyOf(r);
		if (key === undefined) continue;
		const t = totals.get(key) ?? { key, costUt: 0, count: 0 };
		t.costUt += r.costUt ?? 0;
		t.count += 1;
		totals.set(key, t);
	}
	return [...totals.values()].sort((a, b) => b.costUt - a.costUt);
}

export function costByKind(rows: LedgerRow[]): KeyTotal[] {
	return totalBy(rows, (r) => r.kind);
}

export function costByModel(rows: LedgerRow[]): KeyTotal[] {
	return totalBy(rows, (r) => r.model);
}

export interface StatTiles {
	totalCostUt: number;
	calls: number;
	/** Rows with a cost: the denominator of `avgCostUt`, which is NOT `calls`. */
	costed: number;
	avgCostUt: number;
	errorRate: number;
	/** Rows per status, every status present (0 when none): "unknown" and "unrecoverable" are counted, never hidden. */
	byStatus: Record<RowStatus, number>;
}

const ALL_STATUSES: readonly RowStatus[] = [
	"settled",
	"ambiguous",
	"failed",
	"denied",
	"released",
	"unrecoverable",
	"ungoverned",
	"info",
	"unknown",
];

export function statTiles(rows: LedgerRow[]): StatTiles {
	const totalCostUt = rows.reduce((sum, r) => sum + (r.costUt ?? 0), 0);
	const costed = rows.filter((r) => r.costUt !== undefined).length;
	const byStatus = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<RowStatus, number>;
	for (const r of rows) byStatus[statusOf(r)] += 1;
	return {
		totalCostUt,
		calls: rows.length,
		costed,
		avgCostUt: costed > 0 ? totalCostUt / costed : 0,
		errorRate: rows.length > 0 ? byStatus.failed / rows.length : 0,
		byStatus,
	};
}
