// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Where the Spend chart meets the layers drawn on it. The types are the one definition both sides write against; the
 * list is empty until a layer is added. This file holds only types, the list and the one selector a layer's ring
 * buttons are found by, so adding a layer never conflicts with a helper here.
 */

import type { ComponentType } from "react";
import type { SpendWindow } from "../../../shared/breakdown.js";
import type { LedgerRow } from "../../../shared/rows.js";

export type LayerZ = "under" | "mid" | "over" | "overlay"; // before area | after area, before line | after line | HTML above the svg
export interface ChartCtx {
	w: number;
	h: number; // plot box, CSS px; the viewBox equals it
	nB: number;
	bucketMs: number;
	win: SpendWindow;
	rows: readonly LedgerRow[]; // the fully filtered rows the line is built from
	rate: Float64Array; // TRUE spend rate per bucket, UT/h (length nB); figures read it
	drawn: Float64Array; // the SMOOTHED rate the line is drawn from and `y` is fit to (length nB); a mark on the line reads it
	perHour: number; // 3_600_000 / bucketMs
	idx: readonly number[]; // the bucket indices the drawn line passes through (lttb)
	x(k: number): number; // bucket k's drawn centre
	y(rate: number): number; // true rate -> px, through the knee when one is set
	baseY: number;
	knee: number; // Infinity: no compression
	curve: { path(): string; at(x: number): number }; // the drawn total line (monotone)
	cursor: {
		subscribe(fn: () => void): () => void;
		get(): { k: number; via: "pointer" | "key" | "pin" | "sync" } | null;
	};
	moveTo(k: number): void; // as the arrow keys do
}
export interface SpendLayer {
	id: "bands" | "unusual" | "knee" | "loupe";
	z: LayerZ;
	Layer: ComponentType<{ ctx: ChartCtx }>;
	scale?(s: { rate: Float64Array; top: number; ticks(top: number): number[] }): {
		knee: number;
		ticks: Array<{ drawn: number; label: number }>;
	}; // the frame calls it before building ctx.y
	onKey?(e: { key: string }, ctx: ChartCtx): boolean; // true: handled (the chart calls preventDefault)
	marksPeak?(k: number, ctx: ChartCtx): boolean; // true: a ring already marks bucket k, so the chart hides its peak label
	Overlay?: ComponentType<{ ctx: ChartCtx }>; // HTML of this layer, in the overlay slot after its Layer
	Note?: ComponentType<{ ctx: ChartCtx }>; // rendered inside the headline's sub-line, after the chart's own text
	areaClip?(ctx: ChartCtx): string | null; // SVG path d: the frame clips the base area fill to the first non-null
}

/** A press on a ring stays the ring's on touch: the plot does not capture a pointer that went down inside one. */
export const RING_SELECTOR = "[data-sp-ring]";

export const LAYERS: readonly SpendLayer[] = [];
