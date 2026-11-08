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
import { bucketTotals } from "./spend-series.js";

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

/**
 * Spend per bucket for every key, UNSMOOTHED, in `breakdown().keys` order. Bucketed by `bucketTotals`, the one
 * bucketing the line uses, so a key's row adds up to that key's number in `breakdown` over the same window. The
 * window must be finite: buckets are for drawing, and an unbounded window has none.
 */
export function categoryRows(
	rows: readonly LedgerRow[],
	win: SpendWindow,
	dim: Dimension,
	bucketMs: number,
): Map<string, Float64Array> {
	const out = new Map<string, Float64Array>();
	for (const key of breakdown(rows, win, dim).keys)
		out.set(
			key,
			bucketTotals(rows, win, bucketMs, (r) => keyOf(dim, r) === key),
		);
	return out;
}

/**
 * Stacked bands for drawing: the same keys as `categoryRows`, but each key's SHARE of the bucket is smoothed over
 * `radius` buckets either side, renormalised so the shares add to 1, then multiplied by the exact bucket total. So
 * the bands stack to the line (`bucketTotals`) in every bucket, while the edges between them stay calm.
 *
 * A bucket with no spend has no share: it is zero in every band, and it is left out of its neighbours' averages
 * rather than pulling them toward zero.
 */
export function shareBands(
	rows: readonly LedgerRow[],
	win: SpendWindow,
	dim: Dimension,
	bucketMs: number,
	radius = 3,
): Map<string, Float64Array> {
	const cats = categoryRows(rows, win, dim, bucketMs);
	const out = new Map<string, Float64Array>();
	if (cats.size === 0) return out;
	const keys = [...cats.keys()];
	const totals = bucketTotals(rows, win, bucketMs);
	const n = totals.length;
	const r = Math.max(0, Math.floor(radius));
	const shares = keys.map((k) => {
		const v = cats.get(k) as Float64Array;
		const s = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			const total = totals[i] as number;
			s[i] = total > 0 ? (v[i] as number) / total : 0;
		}
		return s;
	});
	const smooth = keys.map(() => new Float64Array(n));
	for (let i = 0; i < n; i++) {
		if (!((totals[i] as number) > 0)) continue;
		const lo = Math.max(0, i - r);
		const hi = Math.min(n - 1, i + r);
		let used = 0;
		for (let j = lo; j <= hi; j++) if ((totals[j] as number) > 0) used += 1;
		let sum = 0;
		for (let k = 0; k < keys.length; k++) {
			let acc = 0;
			for (let j = lo; j <= hi; j++)
				if ((totals[j] as number) > 0) acc += (shares[k] as Float64Array)[j] as number;
			const value = acc / used;
			(smooth[k] as Float64Array)[i] = value;
			sum += value;
		}
		for (let k = 0; k < keys.length; k++) {
			const band = smooth[k] as Float64Array;
			band[i] = sum > 0 ? ((band[i] as number) / sum) * (totals[i] as number) : 0;
		}
	}
	keys.forEach((k, idx) => {
		out.set(k, smooth[idx] as Float64Array);
	});
	return out;
}
