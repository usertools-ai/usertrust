// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Pixel and time mapping for a chart's plot box, and the nearest-record lookup a crosshair snaps with. Pure.
 */

import type { SpendWindow } from "./breakdown.js";

const HOUR_MS = 3_600_000;

/**
 * The index in `xs` (ascending) nearest to `x`: 0 before the first, the last after the end, the earlier one on a tie.
 * -1 for an empty list or a NaN.
 */
export function nearestIndex(xs: ArrayLike<number>, x: number): number {
	const n = xs.length;
	if (n === 0 || Number.isNaN(x)) return -1;
	let lo = 0;
	let hi = n - 1;
	if (x <= (xs[0] as number)) return 0;
	if (x >= (xs[hi] as number)) return hi;
	// Invariant: xs[lo] <= x < xs[hi].
	while (hi - lo > 1) {
		const mid = (lo + hi) >>> 1;
		if ((xs[mid] as number) <= x) lo = mid;
		else hi = mid;
	}
	return x - (xs[lo] as number) <= (xs[hi] as number) - x ? lo : hi;
}

/** The time at plot x, clamped to the window. A zero-width box reads as the window's start. `x` must not be NaN. */
export function xToMs(x: number, win: SpendWindow, w: number): number {
	if (!(w > 0)) return win.startMs;
	const f = Math.min(1, Math.max(0, x / w));
	return win.startMs + f * (win.endMs - win.startMs);
}

/** The plot x of a time, clamped to `[0, w]`. An empty window reads as 0. `ms` must not be NaN. */
export function msToX(ms: number, win: SpendWindow, w: number): number {
	const span = win.endMs - win.startMs;
	if (!(span > 0) || !(w > 0)) return 0;
	return Math.min(w, Math.max(0, ((ms - win.startMs) / span) * w));
}

/** The nearest device pixel to `x`, so a 1px line is crisp at any pixel ratio. */
export function snapPx(x: number, dpr: number): number {
	return Math.round(x * dpr) / dpr;
}

/**
 * The UTC hour containing `ms`, half-open at the end. This is the span a hover publishes, never the line's own bucket:
 * a list that marks time marks whole hours.
 */
export function hourSpanOf(ms: number): [number, number] {
	const a = Math.floor(ms / HOUR_MS) * HOUR_MS;
	return [a, a + HOUR_MS];
}

/**
 * Whether a pointer move should move the crosshair. A mouse hovers, so it always does. A finger or a pen has no hover
 * a reader means: it only reads the line while pressed, so a tap elsewhere never leaves a crosshair behind.
 */
export function shouldTrack(pointerType: string, touchDown: boolean): boolean {
	return pointerType === "mouse" || touchDown;
}

/**
 * Whether a press should capture the pointer, so a drag keeps reading the line after it leaves the plot. Never a
 * mouse (its click must land where it is) and never a press on a ring (the ring keeps its own press).
 */
export function shouldCapture(pointerType: string, onRing: boolean): boolean {
	return pointerType !== "mouse" && !onRing;
}
