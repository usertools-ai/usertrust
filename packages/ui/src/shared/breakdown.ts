// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * One breakdown of spend by lane, role, model, kind or provider. Every view of a category on the desk (the lanes, the
 * donut, the table, the legend) reads this one sum, so a category has one number wherever it is shown.
 *
 * Spend is exactly what the header counts (`isHeaderSpend`): no second definition. A window is half-open,
 * `startMs <= t < endMs`, so a record on an edge is counted once, in exactly one window.
 */

import { isHeaderSpend } from "./aggregate.js";
import { type ProviderName, providerOf } from "./provider.js";
import { jobTypeOf, type LedgerRow } from "./rows.js";

export type Dimension = "lane" | "role" | "model" | "kind" | "provider";

/** The key a record falls under in a dimension. */
export function keyOf(dim: Dimension, row: LedgerRow): string {
	switch (dim) {
		case "lane":
			return row.actor;
		case "role":
			return jobTypeOf(row);
		case "model":
			return row.model ?? "unknown";
		case "kind":
			return row.kind;
		case "provider": {
			const p: ProviderName = providerOf(row);
			return p;
		}
	}
}

/** Half-open: `startMs <= t < endMs`, where `t` is the record's instant. */
export interface SpendWindow {
	startMs: number;
	endMs: number;
}

export interface Breakdown {
	dim: Dimension;
	/** Ordered by spend, highest first; ties A to Z. */
	keys: string[];
	byKey: Map<string, { spendUt: number; calls: number }>;
	totalUt: number;
	calls: number;
}

/** Spend per key over the window, from spend-bearing records only, in one pass. */
export function breakdown(rows: readonly LedgerRow[], win: SpendWindow, dim: Dimension): Breakdown {
	const byKey = new Map<string, { spendUt: number; calls: number }>();
	let totalUt = 0;
	let calls = 0;
	for (const row of rows) {
		if (!isHeaderSpend(row.kind, row.costUt)) continue;
		const t = Date.parse(row.ts);
		if (!(t >= win.startMs && t < win.endMs)) continue;
		const key = keyOf(dim, row);
		const entry = byKey.get(key);
		if (entry === undefined) byKey.set(key, { spendUt: row.costUt, calls: 1 });
		else {
			entry.spendUt += row.costUt;
			entry.calls += 1;
		}
		totalUt += row.costUt;
		calls += 1;
	}
	const keys = [...byKey.keys()].sort((a, b) => {
		const d = (byKey.get(b)?.spendUt ?? 0) - (byKey.get(a)?.spendUt ?? 0);
		if (d !== 0) return d;
		return a < b ? -1 : a > b ? 1 : 0;
	});
	return { dim, keys, byKey, totalUt, calls };
}
