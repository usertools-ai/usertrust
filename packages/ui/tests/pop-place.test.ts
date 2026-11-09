// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	intersect,
	type Page,
	placePop,
	placePopAt,
	popStyle,
	whenMoved,
} from "../src/shared/pop-place.js";

const BOX = { left: 0, top: 0, right: 400, bottom: 800 };
const at = (left: number, top: number, w = 40, h = 16) => ({
	left,
	top,
	right: left + w,
	bottom: top + h,
});

describe("placePop", () => {
	it("red-first (an explainer cut off by its window): an anchor with no room to its left opens to the right", () => {
		// A fact in a window's first column: lined up with the anchor's right edge, a 300px explainer would start 240px
		// left of the window and the window would hide most of it.
		const p = placePop(at(20, 100), 300, 150, BOX);
		expect(p).toEqual({ side: "start", shift: null, width: 300, up: false, maxHeight: null });
	});

	it("keeps the default, lined up with the anchor's right edge, when that fits", () => {
		expect(placePop(at(340, 100), 300, 150, BOX).side).toBe("end");
	});

	it("when neither side fits, starts at the box's left edge and is no wider than the box", () => {
		const narrow = { left: 0, top: 0, right: 250, bottom: 800 };
		const p = placePop(at(100, 100), 300, 150, narrow);
		expect(p.width).toBe(234);
		expect(p.shift).toBe(-92);
		// Its left edge (anchor's left + shift) is 8px in, its right edge (left + width) 8px in from the right.
		expect(100 + (p.shift ?? 0)).toBe(8);
		expect(100 + (p.shift ?? 0) + p.width).toBe(242);
	});

	it("opens above the anchor when below would leave the box and above fits", () => {
		expect(placePop(at(340, 700), 300, 150, BOX)).toMatchObject({ up: true, maxHeight: null });
		expect(placePop(at(340, 100), 300, 150, BOX)).toMatchObject({ up: false, maxHeight: null });
	});

	it("red-first (an explainer taller than the room on either side): opens toward the larger room, no taller than it", () => {
		// A short window: 200px of room above the anchor, 100px below, and a 260px explainer. It used to open below and
		// run 160px past the window's bottom, where the window hid it.
		const shortBox = { left: 0, top: 0, right: 400, bottom: 340 };
		const p = placePop(at(340, 216), 300, 260, shortBox);
		expect(p.up).toBe(true);
		// Room above: the anchor's top (216) less the gap (8) less the box's top and margin (0 + 8).
		expect(p.maxHeight).toBe(200);
		const below = placePop(at(340, 60), 300, 260, shortBox);
		expect(below.up).toBe(false);
		// Room below: the box's bottom less the margin (340 - 8) less the anchor's bottom (76) and the gap.
		expect(below.maxHeight).toBe(248);
	});
});

describe("placePopAt", () => {
	it("red-first (a stale height): a popover narrowed to fit is placed by the height it has at that width", () => {
		// A 300px popover, 150px tall, in a 250px-wide box: it is drawn 234px wide, wraps, and grows to 192px. The room
		// above its anchor is 180px. By its height at 300px it would fit above whole; at 234px it does not, so it needs a
		// cap or its last lines would leave the box.
		const box = { left: 0, top: 0, right: 250, bottom: 260 };
		const anchor = at(100, 196);
		const heightAt = (w: number): number => Math.round((150 * 300) / w);
		expect(placePop(anchor, 300, 150, box)).toMatchObject({
			width: 234,
			up: true,
			maxHeight: null,
		});
		expect(placePopAt(anchor, 300, 150, box, heightAt)).toMatchObject({
			width: 234,
			up: true,
			maxHeight: 180,
		});
	});

	it("measures nothing again when the popover keeps its own width", () => {
		let calls = 0;
		const p = placePopAt(at(340, 100), 300, 150, BOX, () => {
			calls++;
			return 999;
		});
		expect(calls).toBe(0);
		expect(p).toMatchObject({ side: "end", up: false, maxHeight: null });
	});
});

describe("popStyle", () => {
	it("red-first (a width in the wrong units): always says border-box, the units placePop measures in", () => {
		// placePop works in border-box pixels (getBoundingClientRect). Written as a content width, a popover with padding
		// and a border would be drawn wider than it was placed; the page's base layer happens to set border-box today,
		// but the placed style must not depend on that.
		for (const p of [
			placePop(at(340, 100), 300, 150, BOX),
			placePop(at(20, 100), 300, 150, BOX),
			placePop(at(100, 100), 300, 150, { left: 0, top: 0, right: 250, bottom: 800 }),
			placePop(at(340, 216), 300, 260, { left: 0, top: 0, right: 400, bottom: 340 }),
		])
			expect(popStyle(p).boxSizing).toBe("border-box");
	});

	it("writes the side, the shift, the width, the side above or below, and the cap", () => {
		expect(popStyle({ side: "end", shift: null, width: 300, up: false, maxHeight: null })).toEqual({
			boxSizing: "border-box",
			left: "auto",
			right: 0,
			width: 300,
		});
		expect(
			popStyle({ side: "start", shift: null, width: 300, up: false, maxHeight: null }),
		).toEqual({
			boxSizing: "border-box",
			left: 0,
			right: "auto",
			width: 300,
		});
		expect(popStyle({ side: "start", shift: -92, width: 234, up: true, maxHeight: 180 })).toEqual({
			boxSizing: "border-box",
			left: -92,
			right: "auto",
			width: 234,
			top: "auto",
			bottom: "calc(100% + 8px)",
			maxHeight: 180,
		});
	});
});

/** A page with nothing in it but what `whenMoved` uses: its listeners, its size observer and its frames. */
function fakePage(withObserver = true) {
	const on = new Map<string, Set<() => void>>();
	const key = (who: string, type: string, capture?: boolean): string =>
		`${who} ${type} ${capture === true ? "capture" : "bubble"}`;
	const target = (who: string) => ({
		addEventListener(type: string, fn: () => void, capture?: boolean): void {
			const k = key(who, type, capture);
			on.set(k, (on.get(k) ?? new Set()).add(fn));
		},
		removeEventListener(type: string, fn: () => void, capture?: boolean): void {
			on.get(key(who, type, capture))?.delete(fn);
		},
	});
	const frames = new Map<number, () => void>();
	let nextFrame = 1;
	const observed: unknown[] = [];
	let sized: (() => void) | null = null;
	let disconnected = false;
	class Observer {
		constructor(changed: () => void) {
			sized = changed;
		}
		observe(el: unknown): void {
			observed.push(el);
		}
		disconnect(): void {
			disconnected = true;
		}
	}
	const page: Page = {
		view: target("window"),
		doc: target("document"),
		frame(run: () => void): number {
			frames.set(nextFrame, run);
			return nextFrame++;
		},
		cancelFrame(id: number): void {
			frames.delete(id);
		},
		Observer: withObserver ? Observer : null,
	};
	return {
		page,
		fire(who: string, type: string, capture?: boolean): void {
			for (const fn of on.get(key(who, type, capture)) ?? []) fn();
		},
		resized(): void {
			sized?.();
		},
		runFrames(): void {
			const due = [...frames.values()];
			frames.clear();
			for (const run of due) run();
		},
		pending: (): number => frames.size,
		listening: (): string[] =>
			[...on.entries()]
				.filter(([, fns]) => fns.size > 0)
				.map(([k]) => k)
				.sort(),
		observed,
		disconnected: (): boolean => disconnected,
	};
}

const WIN = { id: "window" } as unknown as Element;
const BODY = { id: "body" } as unknown as Element;
const ANCHOR = { id: "anchor" } as unknown as Element;

describe("whenMoved", () => {
	it("red-first (an explainer placed once, for the box it opened in): a resize, a scroll and a change of size each place it again, on the next frame", () => {
		// Placed only when it opened, a restored window's explainer kept the side and width it had in the filled window
		// and ran past the home window's edge; a narrower browser left it wider than its window.
		const f = fakePage();
		let placed = 0;
		whenMoved([BODY, WIN, ANCHOR], () => placed++, f.page);
		f.fire("window", "resize");
		expect(placed).toBe(0);
		f.runFrames();
		expect(placed).toBe(1);
		f.fire("document", "scroll", true);
		f.runFrames();
		expect(placed).toBe(2);
		f.resized();
		f.runFrames();
		expect(placed).toBe(3);
	});

	it("places it once a frame, however many changes arrive in that frame", () => {
		const f = fakePage();
		let placed = 0;
		whenMoved([BODY], () => placed++, f.page);
		f.fire("window", "resize");
		f.fire("document", "scroll", true);
		f.fire("document", "scroll", true);
		f.resized();
		expect(f.pending()).toBe(1);
		f.runFrames();
		expect(placed).toBe(1);
	});

	it("hears a scroll of any scroller, in the capture phase (a window body's scroll does not bubble), and the browser's size", () => {
		const f = fakePage();
		whenMoved([BODY], () => {}, f.page);
		expect(f.listening()).toEqual(["document scroll capture", "window resize bubble"]);
	});

	it("watches the size of every box it is given: its window, the window's body, its anchor", () => {
		const f = fakePage();
		whenMoved([BODY, WIN, ANCHOR], () => {}, f.page);
		expect(f.observed).toEqual([BODY, WIN, ANCHOR]);
	});

	it("stops: no listener left, the observer disconnected, and a frame not yet run cancelled", () => {
		const f = fakePage();
		let placed = 0;
		const stop = whenMoved([BODY], () => placed++, f.page);
		f.fire("window", "resize");
		expect(f.pending()).toBe(1);
		stop();
		expect(f.listening()).toEqual([]);
		expect(f.disconnected()).toBe(true);
		expect(f.pending()).toBe(0);
		f.runFrames();
		expect(placed).toBe(0);
	});

	it("in a browser with no size observer, still places it again after a resize or a scroll", () => {
		const f = fakePage(false);
		let placed = 0;
		whenMoved([BODY], () => placed++, f.page);
		f.fire("window", "resize");
		f.runFrames();
		f.fire("document", "scroll", true);
		f.runFrames();
		expect(placed).toBe(2);
	});
});

describe("intersect", () => {
	it("is the part of the first box inside the second", () => {
		expect(intersect({ left: -10, top: 5, right: 500, bottom: 900 }, BOX)).toEqual({
			left: 0,
			top: 5,
			right: 400,
			bottom: 800,
		});
	});
});
