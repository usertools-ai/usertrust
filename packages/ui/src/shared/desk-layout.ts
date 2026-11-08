// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Where the desk's four windows sit, and the phases of filling one. Pure: no DOM is read here, so the layout and the
 * fill state machine are tested without a browser.
 *
 * The desk is a 12-column CSS grid. The windows sit at HOME; a filled window takes the whole desk and the others fade.
 * Below the compact width the desk is a scrolling column and fill is ignored, so no window is ever inert or hidden.
 */

/** The windows that can sit on, or fill, the desk, in grid order. */
export const WINDOW_IDS = ["spend", "share", "ledger", "now"] as const;
export type WindowId = (typeof WINDOW_IDS)[number];

/** A window's home slot: its first column (1-based), its column span and its row. */
export interface Place {
	col: number;
	span: number;
	row: 1 | 2;
}

/** Spend 8 and share 4 above, ledger 8 and now 4 below. */
export const HOME: Readonly<Record<WindowId, Place>> = {
	spend: { col: 1, span: 8, row: 1 },
	share: { col: 9, span: 4, row: 1 },
	ledger: { col: 1, span: 8, row: 2 },
	now: { col: 9, span: 4, row: 2 },
};

/** The two grid rows, as `grid-template-rows`. */
export const HOME_ROWS = "minmax(0, 11fr) minmax(0, 9fr)";
/** The gap between windows, in CSS px. */
export const DESK_GAP = 16;
/** At or under this width the desk is a column and fill is ignored. */
export const COMPACT_QUERY = "(max-width: 900px)";
/** At or over this width a filled ledger shows its record panel docked beside it. */
export const DOCK_QUERY = "(min-width: 1100px)";

/** The grid properties for a window's home slot. */
export function placeStyle(id: WindowId): { gridColumn: string; gridRow: string } {
	const p = HOME[id];
	return { gridColumn: `${p.col} / span ${p.span}`, gridRow: String(p.row) };
}

/** A rectangle's edges, in CSS px, as `getBoundingClientRect` reports them. */
export interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/**
 * The `clip-path` that cuts a filled window down to its home slot: how far each edge of the slot sits inside the
 * desk's, in the order `inset()` reads them (top, right, bottom, left).
 */
export function homeInset(slot: Box, desk: Box): string {
	const top = slot.top - desk.top;
	const right = desk.right - slot.right;
	const bottom = desk.bottom - slot.bottom;
	const left = slot.left - desk.left;
	return `inset(${top}px ${right}px ${bottom}px ${left}px)`;
}

/** Whether `id` is the filled window. A compact desk has no filled window, whatever the address says. */
export function isFilled(fill: WindowId | null, id: WindowId, compact: boolean): boolean {
	return !compact && fill === id;
}

/** Where a window is in the fill: at home, growing, filled, or shrinking back. */
export type Phase = "home" | "grow" | "filled" | "shrink";

/**
 * The next phase when the target changes (`target` is true when the window should be filled). With `still`
 * (reduced motion) there is no flight: the window goes straight to where it is headed.
 */
export function nextPhase(from: Phase, target: boolean, still: boolean): Phase {
	if (still) return target ? "filled" : "home";
	if (target) return from === "filled" ? "filled" : "grow";
	return from === "home" ? "home" : "shrink";
}

/** The phase a flight ends in, when its time is up. A phase at rest stays where it is. */
export function phaseDone(p: Phase): Phase {
	if (p === "grow") return "filled";
	if (p === "shrink") return "home";
	return p;
}
