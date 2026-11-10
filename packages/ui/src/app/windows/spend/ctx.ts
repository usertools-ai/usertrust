// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Spend chart's context, pure: the y scale the layers may reshape, the key offer, and the `ChartCtx` the layers read.
 * No React here, so it is tested without a render.
 */

import type { SpendWindow } from "../../../shared/breakdown.js";
import type { LedgerRow } from "../../../shared/rows.js";
import type { SpendModel } from "../../../shared/spend-model.js";
import {
	type DrawnSeries,
	type Geometry,
	HEADROOM,
	MIN_TOP,
	niceTicks,
} from "../../../shared/spend-scale.js";
import type { ChartCtx, SpendLayer } from "./layers.js";

/**
 * The knee and the grid ticks: the first layer with a `scale` decides, given the true rates and the top the plain scale
 * would have. That top comes from `peak`, the SMOOTHED peak the line is drawn to (under a filter, the unfiltered
 * line's), not from the largest true rate: the drawn line must fill its band. No such layer is no knee and no ticks
 * (`ticks: null`: the caller then supplies the plain ones). A knee that is not a finite positive number (other than
 * `Infinity`, which means none) is ignored: a layer cannot break the scale.
 */
export function resolveScale(
	layers: readonly SpendLayer[],
	rate: Float64Array,
	peak: number,
): { knee: number; ticks: Array<{ drawn: number; label: number }> | null } {
	const layer = layers.find((l) => l.scale !== undefined);
	if (layer?.scale === undefined) return { knee: Number.POSITIVE_INFINITY, ticks: null };
	const top = Math.max((Number.isFinite(peak) ? Math.max(0, peak) : 0) * HEADROOM, MIN_TOP);
	const out = layer.scale({ rate, top, ticks: (t) => niceTicks(t) });
	const knee =
		out.knee === Number.POSITIVE_INFINITY || (Number.isFinite(out.knee) && out.knee > 0)
			? out.knee
			: Number.POSITIVE_INFINITY;
	return { knee, ticks: out.ticks };
}

/** Offer a key to each layer's `onKey` in order; true as soon as one handles it, false when none does. */
export function dispatchKey(
	layers: readonly SpendLayer[],
	e: { key: string },
	ctx: ChartCtx,
): boolean {
	for (const l of layers) {
		if (l.onKey?.(e, ctx) === true) return true;
	}
	return false;
}

/** The path the base area fill is clipped to: the first layer's that gives one; null when none does. */
export function firstAreaClip(layers: readonly SpendLayer[], ctx: ChartCtx): string | null {
	for (const l of layers) {
		const d = l.areaClip?.(ctx) ?? null;
		if (d !== null) return d;
	}
	return null;
}

/** Whether a layer's ring already marks bucket `k`, so the line's own peak label would only repeat it. */
export function peakRinged(layers: readonly SpendLayer[], k: number, ctx: ChartCtx): boolean {
	return layers.some((l) => l.marksPeak?.(k, ctx) === true);
}

/**
 * The context every layer reads, built once per model (never per cursor move). `rate` is the model's TRUE rates, the
 * same array: a layer's figures read them, never the smoothed values the path is drawn from.
 */
export function buildCtx(a: {
	geo: Geometry;
	series: DrawnSeries;
	model: SpendModel;
	rows: readonly LedgerRow[];
	win: SpendWindow;
	cursor: ChartCtx["cursor"];
	moveTo(k: number): void;
}): ChartCtx {
	const { geo, series, model } = a;
	return {
		w: geo.w,
		h: geo.h,
		nB: model.values.length,
		bucketMs: model.bucketMs,
		win: a.win,
		rows: a.rows,
		rate: model.rates,
		drawn: model.drawn,
		perHour: 3_600_000 / model.bucketMs,
		idx: series.idx,
		x: geo.centerX,
		y: geo.yOf,
		baseY: geo.baseY,
		knee: geo.knee,
		curve: series.curve,
		cursor: a.cursor,
		moveTo: a.moveTo,
	};
}
