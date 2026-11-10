// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * What the Spend chart's tests share: a seeded week of spend records and the geometry, drawn series and context built
 * from it the way the chart builds them. Pure, so the context tests and the frame's render tests read one fixture.
 */

import { buildCtx } from "../../src/app/windows/spend/ctx.js";
import type { ChartCtx } from "../../src/app/windows/spend/layers.js";
import type { SpendWindow } from "../../src/shared/breakdown.js";
import type { LedgerRow } from "../../src/shared/rows.js";
import {
	buildSpendModel,
	LINE_BUCKETS,
	type LineBucket,
	type SpendModel,
} from "../../src/shared/spend-model.js";
import {
	type DrawnSeries,
	drawSeries,
	type Geometry,
	geometry,
	niceTicks,
} from "../../src/shared/spend-scale.js";

export const T0 = Date.UTC(2026, 10, 1);
export const HOUR = 3_600_000;
export const WEEK_WIN: SpendWindow = { startMs: T0, endMs: T0 + 7 * 24 * HOUR };

function seeded(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
		return s / 2 ** 32;
	};
}

export function spendRow(pos: number, overrides: Partial<LedgerRow> = {}): LedgerRow {
	return {
		seq: pos + 1,
		pos,
		id: `evt-${pos}`,
		ts: new Date(T0 + HOUR).toISOString(),
		kind: "llm_call",
		actor: "local",
		hash: `h${pos}`,
		previousHash: `h${pos - 1}`,
		integrity: "verified",
		costUt: 1,
		status: "settled",
		...overrides,
	};
}

/** `n` spend records spread over the week, in time order, costing 1 to 900 UT. */
export function weekRows(n = 600): LedgerRow[] {
	const rand = seeded(11);
	const span = WEEK_WIN.endMs - WEEK_WIN.startMs;
	return Array.from({ length: n }, (_, i) =>
		spendRow(i, {
			ts: new Date(WEEK_WIN.startMs + Math.floor(((i + rand()) / n) * span)).toISOString(),
			costUt: 1 + Math.floor(rand() * 900),
		}),
	);
}

export interface ChartFixture {
	rows: LedgerRow[];
	win: SpendWindow;
	w: number;
	h: number;
	model: SpendModel;
	geo: Geometry;
	series: DrawnSeries;
	ticks: Array<{ drawn: number; label: number }>;
	ctx: ChartCtx;
}

/**
 * The chart's pieces for `rows` over `win` in a `w` by `h` plot, with no knee unless one is given. The bucket is the
 * week's own (the default window is a week) unless one is given.
 */
export function chartFixture(
	o: {
		rows?: LedgerRow[];
		win?: SpendWindow;
		w?: number;
		h?: number;
		knee?: number;
		bucket?: LineBucket;
	} = {},
): ChartFixture {
	const rows = o.rows ?? weekRows();
	const win = o.win ?? WEEK_WIN;
	const w = o.w ?? 700;
	const h = o.h ?? 220;
	const knee = o.knee ?? Number.POSITIVE_INFINITY;
	const model = buildSpendModel(rows, win, o.bucket ?? LINE_BUCKETS["1w"], null);
	const geo = geometry({ w, h, win, bucketMs: model.bucketMs, peakRate: model.peakRate, knee });
	const series = drawSeries(geo, model.rates);
	const ticks = niceTicks(geo.top).map((t) => ({ drawn: t, label: t }));
	const ctx = buildCtx({
		geo,
		series,
		model,
		rows,
		win,
		cursor: { subscribe: () => () => undefined, get: () => null },
		moveTo: () => undefined,
	});
	return { rows, win, w, h, model, geo, series, ticks, ctx };
}
