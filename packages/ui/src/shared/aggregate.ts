// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { type LedgerRow, statusOf } from "./rows.js";

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
	avgCostUt: number;
	errorRate: number;
}

export function statTiles(rows: LedgerRow[]): StatTiles {
	const totalCostUt = rows.reduce((sum, r) => sum + (r.costUt ?? 0), 0);
	const costed = rows.filter((r) => r.costUt !== undefined).length;
	const failed = rows.filter((r) => statusOf(r) === "failed").length;
	return {
		totalCostUt,
		calls: rows.length,
		avgCostUt: costed > 0 ? totalCostUt / costed : 0,
		errorRate: rows.length > 0 ? failed / rows.length : 0,
	};
}
