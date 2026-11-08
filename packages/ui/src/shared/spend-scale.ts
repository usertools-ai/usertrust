// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The geometry of the spend-rate chart: the y scale (with an optional knee), bucket spans, grid ticks and the drawn
 * line. Pure. Every figure a reader sees comes from the records; nothing here is read back off a drawn curve.
 */

import type { SpendWindow } from "./breakdown.js";
import { lttb, type MonotoneCurve, monotone } from "./curve.js";
import { msToX } from "./hit.js";
import { squeeze } from "./knee.js";

export const PAD_T = 16;
export const PAD_B = 6;
/** The y axis runs to the peak times this. */
export const HEADROOM = 1.08;
/** The smallest top, so a quiet range still has a finite scale. */
export const MIN_TOP = 1;
/** Area fill gradient stops: [offset, opacity]. */
export const AREA_STOPS: ReadonlyArray<readonly [number, number]> = [
	[0, 0.13],
	[0.2, 0.08],
	[0.4, 0.04],
	[0.7, 0.012],
	[0.9, 0],
];
/** The area fades over at most this many pixels, and no fewer than AREA_FADE_MIN. */
export const AREA_FADE_MAX = 200;
const AREA_FADE_MIN = 12;
/** One drawn point per this many pixels. */
const PX_PER_POINT = 2.5;

export const LINE_RECIPE = {
	glowW: 3,
	glowOpacity: 0.38,
	glowBlur: 1.2,
	knockW: 3.6,
	knockOpacity: 0.75,
	lineW: 1.6,
} as const;

/** UT per hour for `ut` spent over `spanMs`; 0 for no span. */
export function rateOf(ut: number, spanMs: number): number {
	return spanMs > 0 ? (ut * 3_600_000) / spanMs : 0;
}

/** Buckets in the window: at least one; the last may be partial. */
export function bucketCount(win: SpendWindow, bucketMs: number): number {
	return Math.max(1, Math.ceil((win.endMs - win.startMs) / bucketMs));
}

/** Bucket k's real length: `bucketMs`, except the last, which is the remainder. */
export function bucketSpanMs(k: number, win: SpendWindow, bucketMs: number): number {
	const start = win.startMs + k * bucketMs;
	return Math.max(0, Math.min(win.endMs, start + bucketMs) - start);
}

/** The middle of bucket k's real span. */
export function bucketCenterMs(k: number, win: SpendWindow, bucketMs: number): number {
	return win.startMs + k * bucketMs + bucketSpanMs(k, win, bucketMs) / 2;
}

export interface Geometry {
	w: number;
	h: number;
	baseY: number;
	top: number;
	knee: number;
	/** True rate to y, through the knee. */
	yOf(rate: number): number;
	/** An already-drawn (squeezed) value to y. */
	yOfDrawn(drawn: number): number;
	xOfMs(ms: number): number;
	centerX(k: number): number;
	spanMs(k: number): number;
}

/** `h` must be at least PAD_T + PAD_B; a smaller box has no plot, and the rates passed to `yOf` must be finite. */
export function geometry(a: {
	w: number;
	h: number;
	win: SpendWindow;
	bucketMs: number;
	peakRate: number;
	knee: number;
}): Geometry {
	const { w, h, win, bucketMs, knee } = a;
	const baseY = h - PAD_B;
	const peak = Number.isFinite(a.peakRate) ? Math.max(0, a.peakRate) : 0;
	const top = Math.max(squeeze(peak, knee) * HEADROOM, MIN_TOP);
	const plotH = h - PAD_T - PAD_B;
	const yOfDrawn = (d: number): number => baseY - (d / top) * plotH;
	return {
		w,
		h,
		baseY,
		top,
		knee,
		yOf: (r) => yOfDrawn(squeeze(Math.max(0, r), knee)),
		yOfDrawn,
		xOfMs: (ms) => msToX(ms, win, w),
		centerX: (k) => msToX(bucketCenterMs(k, win, bucketMs), win, w),
		spanMs: (k) => bucketSpanMs(k, win, bucketMs),
	};
}

/** Grid values at 1/2/5 steps: ascending, above 0 and below `top`, about `count` of them. */
export function niceTicks(top: number, count = 4): number[] {
	if (!(top > 0) || !Number.isFinite(top) || !(count > 0)) return [];
	const raw = top / count;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const norm = raw / mag;
	const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
	const out: number[] = [];
	for (let m = 1; ; m++) {
		const v = Number((m * step).toPrecision(12));
		if (!(v < top)) break;
		out.push(v);
	}
	return out;
}

/** Where the area fill reaches full strength: the 95th-percentile rate's y, clamped to 12..200px above the base. */
export function areaFadeTop(
	rates: ArrayLike<number>,
	yOf: (r: number) => number,
	baseY: number,
): number {
	const lo = baseY - AREA_FADE_MAX;
	const hi = baseY - AREA_FADE_MIN;
	const n = rates.length;
	if (n === 0) return hi;
	const sorted = Float64Array.from({ length: n }, (_, i) => rates[i] as number).sort();
	const p95 = sorted[Math.max(0, Math.ceil(n * 0.95) - 1)] as number;
	const y = yOf(p95);
	if (!Number.isFinite(y)) return hi;
	return Math.min(hi, Math.max(lo, y));
}

export interface DrawnSeries {
	d: string;
	area: string;
	idx: number[];
	curve: MonotoneCurve;
	first: number;
	last: number;
}

const fx = (v: number): string => (Math.round(v * 100) / 100).toString();

/**
 * The line: one point per bucket centre, thinned to about one per 2.5px (always keeping the first, the last and the
 * highest), drawn through a monotone curve. `area` closes the same path down to the base.
 */
export function drawSeries(g: Geometry, rates: Float64Array): DrawnSeries {
	const n = rates.length;
	if (n === 0) {
		return { d: "", area: "", idx: [], curve: monotone([], []), first: 0, last: 0 };
	}
	const xs = new Float64Array(n);
	const ys = new Float64Array(n);
	let maxAt = 0;
	for (let k = 0; k < n; k++) {
		xs[k] = g.centerX(k);
		ys[k] = g.yOf(rates[k] as number);
		if ((rates[k] as number) > (rates[maxAt] as number)) maxAt = k;
	}
	const idx = lttb(xs, ys, Math.ceil(g.w / PX_PER_POINT));
	if (!idx.includes(maxAt)) {
		idx.push(maxAt);
		idx.sort((p, q) => p - q);
	}
	const px = idx.map((k) => xs[k] as number);
	const py = idx.map((k) => ys[k] as number);
	const curve = monotone(px, py);
	const d = curve.path();
	const first = px[0] as number;
	const last = px[px.length - 1] as number;
	const area = `${d}L${fx(last)} ${fx(g.baseY)}L${fx(first)} ${fx(g.baseY)}Z`;
	return { d, area, idx, curve, first, last };
}
