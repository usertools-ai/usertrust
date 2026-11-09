// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Where a text popover opens, from where its anchor sits on screen. A popover lined up with one fixed edge of its
 * anchor was cut off whenever the anchor sat on the other side of a narrow box: an explainer that opens to the left,
 * on a fact in a window's first column, ran past the window's edge and the window hid it. Pure (`whenMoved` is handed
 * the page it listens on), so the rules are tested here and the hook that measures the page only feeds them.
 */

/** A box in viewport pixels, as `getBoundingClientRect` reports it. */
export interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface PopPlace {
	/** Lined up with the anchor's right edge, opening leftward (`end`, the default), or with its left edge (`start`). */
	side: "start" | "end";
	/** When neither side fits: the popover's left edge, in pixels from the anchor's left edge, at the box's left edge. */
	shift: number | null;
	/** The width to draw it at: its own, or the box's when the box is narrower. */
	width: number;
	/** Above the anchor: below it would leave the box, and above fits whole or has more room. */
	up: boolean;
	/** When neither side has room for all of it: no taller than the room on the side it opens to (it scrolls inside).
	 *  Null when it fits whole. */
	maxHeight: number | null;
}

/** The part of `a` inside `b`. */
export function intersect(a: Box, b: Box): Box {
	return {
		left: Math.max(a.left, b.left),
		top: Math.max(a.top, b.top),
		right: Math.min(a.right, b.right),
		bottom: Math.min(a.bottom, b.bottom),
	};
}

/**
 * Where a `w`×`h` popover opens from `anchor` so it stays inside `clip` (the box that would cut it: its window's
 * visible box, already cut to the viewport), `margin` pixels in from its edges, `gap` pixels from the anchor:
 * - across: lined up with the anchor's right edge if that fits (the default); else with its left edge if that fits;
 *   else shifted to start at the box's left edge, and no wider than the box;
 * - down or up: below the anchor if it fits whole there; else above if it fits whole there; else toward the side
 *   with more room, and no taller than that room (it scrolls inside), so no part of it is ever out of the box.
 */
export function placePop(
	anchor: Box,
	w: number,
	h: number,
	clip: Box,
	gap = 8,
	margin = 8,
): PopPlace {
	const lo = clip.left + margin;
	const hi = clip.right - margin;
	const width = Math.min(w, Math.max(0, hi - lo));
	let side: PopPlace["side"] = "end";
	let shift: number | null = null;
	if (anchor.right - width >= lo && anchor.right <= hi) side = "end";
	else if (anchor.left >= lo && anchor.left + width <= hi) side = "start";
	else {
		side = "start";
		shift = Math.min(Math.max(lo, anchor.left), hi - width) - anchor.left;
	}
	const roomBelow = clip.bottom - margin - (anchor.bottom + gap);
	const roomAbove = anchor.top - gap - (clip.top + margin);
	if (h <= roomBelow) return { side, shift, width, up: false, maxHeight: null };
	if (h <= roomAbove) return { side, shift, width, up: true, maxHeight: null };
	const up = roomAbove > roomBelow;
	return { side, shift, width, up, maxHeight: Math.max(0, Math.floor(up ? roomAbove : roomBelow)) };
}

/**
 * `placePop`, placed by the height the popover has at the width it will be drawn at. One narrowed to fit its box
 * wraps and grows, so its height at its own width would let its last lines leave the box. `heightAt` measures it at a
 * given width; it is asked only when the popover is narrowed.
 */
export function placePopAt(
	anchor: Box,
	w: number,
	h: number,
	clip: Box,
	heightAt: (width: number) => number,
): PopPlace {
	const first = placePop(anchor, w, h, clip);
	return first.width < w ? placePop(anchor, w, heightAt(first.width), clip) : first;
}

/** A target `whenMoved` listens on: the window, for the browser's size, and the document, for every scroll. */
export interface Listens {
	addEventListener(type: string, fn: () => void, capture?: boolean): void;
	removeEventListener(type: string, fn: () => void, capture?: boolean): void;
}

/** What `whenMoved` needs of a size observer: the browser's ResizeObserver. */
export type SizeObserver = new (
	changed: () => void,
) => { observe(el: Element): void; disconnect(): void };

/** The page as `whenMoved` uses it: handed in, so the rule is tested without a browser. */
export interface Page {
	view: Listens;
	doc: Listens;
	frame(run: () => void): number;
	cancelFrame(id: number): void;
	/** Null in a browser without one: then a resize or a scroll still places it again. */
	Observer: SizeObserver | null;
}

/**
 * Calls `place` again, at most once a frame, whenever the box around an open popover may have moved or changed size: a
 * scroll of any scroller (heard in the capture phase, as a window body's scroll does not bubble), the browser's size,
 * or the size of any of `watch` (its window, the window's body, its anchor: a window filling the desk or giving it
 * back). Placed only when it opened, a popover kept the side, width and cap of a box that was no longer there. Returns
 * the function that stops it.
 */
export function whenMoved(watch: readonly Element[], place: () => void, page: Page): () => void {
	let pending: number | null = null;
	const soon = (): void => {
		if (pending !== null) return;
		pending = page.frame(() => {
			pending = null;
			place();
		});
	};
	page.view.addEventListener("resize", soon);
	page.doc.addEventListener("scroll", soon, true);
	const observer = page.Observer === null ? null : new page.Observer(soon);
	for (const el of watch) observer?.observe(el);
	return () => {
		page.view.removeEventListener("resize", soon);
		page.doc.removeEventListener("scroll", soon, true);
		observer?.disconnect();
		if (pending !== null) page.cancelFrame(pending);
		pending = null;
	};
}

/** A placement as the popover's inline style. */
export interface PopStyle {
	boxSizing: "border-box";
	left: number | "auto";
	right: number | "auto";
	width: number;
	top?: "auto";
	bottom?: string;
	maxHeight?: number;
}

/**
 * A placement as the popover's inline style, in border-box pixels, the units `placePop` measures in (a box's
 * `getBoundingClientRect`). Written as a content width, a popover with padding and a border would be drawn wider than
 * it was placed; the page's base layer sets border-box everywhere today, and this does not depend on it.
 */
export function popStyle(p: PopPlace): PopStyle {
	return {
		boxSizing: "border-box",
		...(p.shift !== null
			? { left: p.shift, right: "auto" as const }
			: p.side === "start"
				? { left: 0, right: "auto" as const }
				: { left: "auto" as const, right: 0 }),
		width: p.width,
		...(p.up ? { top: "auto" as const, bottom: "calc(100% + 8px)" } : {}),
		...(p.maxHeight !== null ? { maxHeight: p.maxHeight } : {}),
	};
}
