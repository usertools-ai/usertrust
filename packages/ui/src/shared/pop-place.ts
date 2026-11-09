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
	/** When it cannot be drawn whole: no taller than the room it is given (it scrolls inside), and never under its
	 *  floor (`placePop`'s `readable`). Null when it fits whole. */
	maxHeight: number | null;
	/** Pixels from the anchor's top to the popover's top (`up` false), or from the anchor's bottom to the popover's
	 *  bottom (`up` true). Set when it is drawn next to a line inside its anchor (`placePop`'s `line`), or laid over its
	 *  line or anchor when neither side has room to read it. Null when it is drawn next to the anchor itself. */
	offset: number | null;
}

/** How many of its lines a text popover shows at the least: a cap below this many lines leaves it unreadable. */
export const READABLE_LINES = 2;

/** What `readableHeight` reads of a popover's computed style (`getComputedStyle`), in CSS lengths. */
export interface ReadStyle {
	lineHeight: string;
	fontSize: string;
	paddingTop: string;
	paddingBottom: string;
	borderTopWidth: string;
	borderBottomWidth: string;
}

/**
 * The height of `READABLE_LINES` of a text popover's lines, with its padding and its border: its floor, unless all of
 * it is shorter (`placePop`'s `readable`). A line-height of `normal` is read as 1.25 times the font size, and a length
 * that cannot be read as 0.
 */
export function readableHeight(s: ReadStyle): number {
	const line = px(s.lineHeight) || 1.25 * px(s.fontSize);
	return (
		READABLE_LINES * line +
		px(s.paddingTop) +
		px(s.paddingBottom) +
		px(s.borderTopWidth) +
		px(s.borderBottomWidth)
	);
}

/** A computed CSS length in pixels; one that cannot be read is 0. */
function px(v: string): number {
	const n = Number.parseFloat(v);
	return Number.isFinite(n) ? n : 0;
}

/** What `paddingBox` reads of a box's computed style: its border widths, in CSS lengths. */
export interface Borders {
	borderLeftWidth: string;
	borderTopWidth: string;
	borderRightWidth: string;
	borderBottomWidth: string;
}

/**
 * The part of `border` (a box as `getBoundingClientRect` reports it: its border box) inside its borders: its padding
 * box, the box an absolutely positioned popover's top, bottom, left and right are measured from. Placed from the
 * border box, a popover in a box with a border would sit that border's width from where it was placed (no fact has a
 * border today, so the two agreed). A width that cannot be read counts as none.
 */
export function paddingBox(border: Box, s: Borders): Box {
	return {
		left: border.left + px(s.borderLeftWidth),
		top: border.top + px(s.borderTopWidth),
		right: border.right - px(s.borderRightWidth),
		bottom: border.bottom - px(s.borderBottomWidth),
	};
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
 * Whether `anchor` lies wholly outside `box`, past any one of its edges (only touching an edge is outside: none of it
 * shows). An anchor out of its window's view leaves its popover no place that is both next to it and inside the
 * window.
 */
export function outside(anchor: Box, box: Box): boolean {
	return (
		anchor.bottom <= box.top ||
		anchor.top >= box.bottom ||
		anchor.right <= box.left ||
		anchor.left >= box.right
	);
}

/**
 * Where a `w`×`h` popover opens from `anchor` so it stays inside `clip` (the box that would cut it: its window's
 * visible box, already cut to the viewport), `margin` pixels in from its edges, `gap` pixels from the anchor:
 * - across: lined up with the anchor's right edge if that fits (the default); else with its left edge if that fits;
 *   else shifted to start at the box's left edge, and no wider than the box;
 * - down or up: below the anchor if it fits whole there; else above if it fits whole there; else toward the side
 *   with more room, and no taller than that room (it scrolls inside), so no part of it is ever out of the box.
 *
 * `line`, when given, is the part of the anchor the popover belongs to (a cut line inside a fact): the room above and
 * below is measured from it and the popover is drawn next to it, while `anchor` stays the box its offsets are
 * measured in. Measured from a whole fact near the bottom of a short window, the room on both sides could be a few
 * pixels, and the explainer of a line in view was capped to nothing readable.
 *
 * `readable` is its floor (`readableHeight`: two of its lines), or all of it when it is shorter: it is never capped
 * below that. When neither side has that much room, it is laid over its line (or its anchor): from the line's top,
 * pulled up as far as it must be to stay inside the box, and capped at the box's inner height. When even that is under
 * its floor (a sliver of a window), there is no room: null, and nothing is drawn. 0 (the default) is no floor.
 */
export function placePop(
	anchor: Box,
	w: number,
	h: number,
	clip: Box,
	gap = 8,
	margin = 8,
	line: Box | null = null,
	readable = 0,
): PopPlace | null {
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
	const at = line ?? anchor;
	const roomBelow = clip.bottom - margin - (at.bottom + gap);
	const roomAbove = at.top - gap - (clip.top + margin);
	const offset = (up: boolean): number | null =>
		line === null
			? null
			: Math.round(up ? anchor.bottom - line.top + gap : line.bottom - anchor.top + gap);
	if (h <= roomBelow)
		return { side, shift, width, up: false, maxHeight: null, offset: offset(false) };
	if (h <= roomAbove)
		return { side, shift, width, up: true, maxHeight: null, offset: offset(true) };
	const up = roomAbove > roomBelow;
	const cap = Math.max(0, Math.floor(up ? roomAbove : roomBelow));
	// The least it is drawn at: its floor, or all of it.
	const least = Math.floor(Math.min(h, readable));
	if (cap >= least) return { side, shift, width, up, maxHeight: cap, offset: offset(up) };
	// Neither side has room to read it: laid over its line, inside the box.
	const inner = clip.bottom - clip.top - 2 * margin;
	if (Math.floor(inner) < least) return null;
	const drawn = Math.min(h, inner);
	const top = Math.min(Math.max(at.top, clip.top + margin), clip.bottom - margin - drawn);
	return {
		side,
		shift,
		width,
		up: false,
		maxHeight: h <= inner ? null : Math.floor(inner),
		offset: Math.round(top - anchor.top),
	};
}

/**
 * `placePop`, placed by the height the popover has at the width it will be drawn at. One narrowed to fit its box
 * wraps and grows, so its height at its own width would let its last lines leave the box. `heightAt` measures it at a
 * given width; it is asked only when the popover is narrowed. No room at its own width is no room narrowed (narrower,
 * it is no shorter), so it is not measured again.
 */
export function placePopAt(
	anchor: Box,
	w: number,
	h: number,
	clip: Box,
	heightAt: (width: number) => number,
	line: Box | null = null,
	readable = 0,
): PopPlace | null {
	const first = placePop(anchor, w, h, clip, 8, 8, line, readable);
	if (first === null || first.width >= w) return first;
	return placePop(anchor, w, heightAt(first.width), clip, 8, 8, line, readable);
}

/** A target `whenMoved` listens on: the window, for the browser's size, and the document, for every scroll. */
export interface Listens {
	addEventListener(type: string, fn: (e: { target: unknown }) => void, capture?: boolean): void;
	removeEventListener(type: string, fn: (e: { target: unknown }) => void, capture?: boolean): void;
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
 *
 * A scroll for which `own` holds (the popover itself, or anything in it) is not heard: its own scroll moves nothing
 * around it. Heard, every scroll inside a capped explainer placed it again, and each placement measured it.
 */
export function whenMoved(
	watch: readonly Element[],
	place: () => void,
	page: Page,
	own: (target: unknown) => boolean,
): () => void {
	let pending: number | null = null;
	const soon = (): void => {
		if (pending !== null) return;
		pending = page.frame(() => {
			pending = null;
			place();
		});
	};
	const scrolled = (e: { target: unknown }): void => {
		if (!own(e.target)) soon();
	};
	page.view.addEventListener("resize", soon);
	page.doc.addEventListener("scroll", scrolled, true);
	const observer = page.Observer === null ? null : new page.Observer(soon);
	for (const el of watch) observer?.observe(el);
	return () => {
		page.view.removeEventListener("resize", soon);
		page.doc.removeEventListener("scroll", scrolled, true);
		observer?.disconnect();
		if (pending !== null) page.cancelFrame(pending);
		pending = null;
	};
}

/** What `measure` needs of a popover: its inline style, its scroll offset and its box. */
export interface Measured {
	style: { width: string; maxHeight: string };
	scrollTop: number;
	scrollLeft: number;
	getBoundingClientRect(): { width: number; height: number };
}

/**
 * A popover's size as the stylesheet draws it (`width` null) or at `width` pixels (narrowed to fit, it wraps and
 * grows), read with what the last placement set (its width and cap) lifted, then put back with its scroll offset.
 * Laid out uncapped, a scrolled explainer no longer overflows and the browser clamps its offset to the top; putting
 * the cap back does not put the offset back.
 */
export function measure(el: Measured, width: number | null): { width: number; height: number } {
	const s = el.style;
	const was = { width: s.width, maxHeight: s.maxHeight, top: el.scrollTop, left: el.scrollLeft };
	s.width = width === null ? "" : `${width}px`;
	s.maxHeight = "";
	const r = el.getBoundingClientRect();
	s.width = was.width;
	s.maxHeight = was.maxHeight;
	el.scrollTop = was.top;
	el.scrollLeft = was.left;
	return { width: r.width, height: r.height };
}

/** A placement as the popover's inline style. */
export interface PopStyle {
	boxSizing: "border-box";
	left: number | "auto";
	right: number | "auto";
	width: number;
	top?: "auto" | number;
	bottom?: string | number;
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
		...(p.offset !== null
			? p.up
				? { top: "auto" as const, bottom: p.offset }
				: { top: p.offset }
			: p.up
				? { top: "auto" as const, bottom: "calc(100% + 8px)" }
				: {}),
		...(p.maxHeight !== null ? { maxHeight: p.maxHeight } : {}),
	};
}
