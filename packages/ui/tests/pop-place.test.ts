// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	intersect,
	measure,
	outside,
	type Page,
	type PopPlace,
	placePop,
	placePopAt,
	popStyle,
	READABLE_LINES,
	readableHeight,
	whenMoved,
} from "../src/shared/pop-place.js";

const BOX = { left: 0, top: 0, right: 400, bottom: 800 };
const at = (left: number, top: number, w = 40, h = 16) => ({
	left,
	top,
	right: left + w,
	bottom: top + h,
});

/** `placePop` where the box has room for it (null is "no room"): for the tests that read its fields. */
function placed(...args: Parameters<typeof placePop>): PopPlace {
	const p = placePop(...args);
	if (p === null) throw new Error("no room");
	return p;
}

describe("placePop", () => {
	it("red-first (an explainer cut off by its window): an anchor with no room to its left opens to the right", () => {
		// A fact in a window's first column: lined up with the anchor's right edge, a 300px explainer would start 240px
		// left of the window and the window would hide most of it.
		const p = placePop(at(20, 100), 300, 150, BOX);
		expect(p).toEqual({
			side: "start",
			shift: null,
			width: 300,
			up: false,
			maxHeight: null,
			offset: null,
		});
	});

	it("keeps the default, lined up with the anchor's right edge, when that fits", () => {
		expect(placePop(at(340, 100), 300, 150, BOX).side).toBe("end");
	});

	it("when neither side fits, starts at the box's left edge and is no wider than the box", () => {
		const narrow = { left: 0, top: 0, right: 250, bottom: 800 };
		const p = placed(at(100, 100), 300, 150, narrow);
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
		const p = placed(at(340, 216), 300, 260, shortBox);
		expect(p.up).toBe(true);
		// Room above: the anchor's top (216) less the gap (8) less the box's top and margin (0 + 8).
		expect(p.maxHeight).toBe(200);
		const below = placed(at(340, 60), 300, 260, shortBox);
		expect(below.up).toBe(false);
		// Room below: the box's bottom less the margin (340 - 8) less the anchor's bottom (76) and the gap.
		expect(below.maxHeight).toBe(248);
	});
});

describe("placePop from a line inside its anchor", () => {
	it("red-first (a cut line's explainer capped to the room around its whole fact): the room is measured from the line, and the explainer is drawn next to it", () => {
		// 960x700, Now at home: a fact (577-696) near the bottom of Now's visible body (538-700), its cut line at
		// 662-696. From the whole fact the room above was 23px and below none, so the 45px explainer was capped to 23px
		// over a line in view. From the line there are 108px above: it fits whole, drawn just above the line.
		const fact = { left: 20, top: 577, right: 320, bottom: 696 };
		const line = { left: 20, top: 662, right: 320, bottom: 696 };
		const clip = { left: 0, top: 538, right: 940, bottom: 700 };
		expect(placePop(fact, 300, 45, clip, 8, 8, line)).toMatchObject({
			up: true,
			maxHeight: null,
			offset: 696 - 662 + 8,
		});
		// With no line, the room is the whole anchor's, as for an explainer whose button row is its anchor.
		expect(placePop(fact, 300, 45, clip)).toMatchObject({ up: true, maxHeight: 23, offset: null });
	});

	it("below a line, the offset is from its anchor's top", () => {
		const fact = { left: 20, top: 100, right: 320, bottom: 220 };
		const line = { left: 20, top: 120, right: 320, bottom: 140 };
		const p = placePop(fact, 300, 45, { left: 0, top: 0, right: 940, bottom: 800 }, 8, 8, line);
		expect(p).toMatchObject({ up: false, maxHeight: null, offset: 140 - 100 + 8 });
	});

	it("placePopAt hands the line on, also when it measures again at a narrower width", () => {
		const fact = { left: 100, top: 577, right: 340, bottom: 696 };
		const line = { left: 100, top: 662, right: 340, bottom: 696 };
		const narrow = { left: 0, top: 538, right: 250, bottom: 700 };
		const p = placePopAt(fact, 300, 45, narrow, () => 60, line);
		expect(p).toMatchObject({ width: 234, up: true, maxHeight: null, offset: 696 - 662 + 8 });
	});
});

/** A text popover's computed style: 18.75px lines, 6px padding, a 1px border. Two lines with those: 51.5px. */
const STYLE = {
	lineHeight: "18.75px",
	fontSize: "15px",
	paddingTop: "6px",
	paddingBottom: "6px",
	borderTopWidth: "1px",
	borderBottomWidth: "1px",
};

describe("readableHeight", () => {
	it("is READABLE_LINES of a popover's lines, with its padding and its border", () => {
		expect(READABLE_LINES).toBe(2);
		expect(readableHeight(STYLE)).toBe(2 * 18.75 + 6 + 6 + 1 + 1);
	});

	it("reads a line-height of `normal` as 1.25 times the font size, and a length it cannot read as 0", () => {
		expect(readableHeight({ ...STYLE, lineHeight: "normal" })).toBe(2 * 1.25 * 15 + 14);
		const unread = {
			lineHeight: "",
			fontSize: "",
			paddingTop: "",
			paddingBottom: "",
			borderTopWidth: "",
			borderBottomWidth: "",
		};
		expect(readableHeight(unread)).toBe(0);
	});
});

describe("placePop with a floor (the least a text popover is drawn at)", () => {
	/** A 34px cut line in the middle of a clip `tall` px high: the last line of its fact. */
	const middle = (tall: number) => {
		const top = (tall - 34) / 2;
		return {
			clip: { left: 0, top: 0, right: 940, bottom: tall },
			line: { left: 20, top, right: 320, bottom: top + 34 },
			fact: { left: 20, top: top - 40, right: 320, bottom: top + 34 },
		};
	};
	/** `readableHeight(STYLE)`, as its own test shows: two lines with the padding and border. A 45px explainer's floor
	 *  is all of it. */
	const FLOOR = 51.5;

	it("red-first (a cut line's explainer capped to 37, 27 and 17px in 140, 120 and 100px clips): it is laid over its line, whole, inside the clip", () => {
		for (const tall of [140, 120, 100]) {
			const { clip, line, fact } = middle(tall);
			// Without a floor: capped to the room on either side of its line, under its 45px.
			expect(placePop(fact, 300, 45, clip, 8, 8, line)).toMatchObject({
				maxHeight: (tall - 34) / 2 - 16,
			});
			// Over its line, from the line's top: whole, and inside the clip's margins.
			const p = placed(fact, 300, 45, clip, 8, 8, line, FLOOR);
			expect(p).toMatchObject({ up: false, maxHeight: null, offset: line.top - fact.top });
			const top = fact.top + (p.offset ?? Number.NaN);
			expect(top).toBeGreaterThanOrEqual(clip.top + 8);
			expect(top + 45).toBeLessThanOrEqual(clip.bottom - 8);
		}
	});

	it("with room beside its line, it is drawn there as before: whole, or capped no lower than its floor", () => {
		const { clip, line, fact } = middle(162);
		expect(placed(fact, 300, 45, clip, 8, 8, line, FLOOR)).toMatchObject({
			up: false,
			maxHeight: null,
			offset: line.bottom - fact.top + 8,
		});
		// A 400px explainer in a 300px clip, its line at 100-134: 150px below the line, more than its 51px floor, so it is
		// capped beside its line, not laid over it.
		const clip300 = { left: 0, top: 0, right: 940, bottom: 300 };
		const low = { left: 20, top: 100, right: 320, bottom: 134 };
		const lowFact = { left: 20, top: 60, right: 320, bottom: 134 };
		expect(placed(lowFact, 300, 400, clip300, 8, 8, low, FLOOR)).toMatchObject({
			up: false,
			maxHeight: 150,
			offset: 134 - 60 + 8,
		});
	});

	it("is pulled up to stay inside the clip when its line sits low", () => {
		// An 80px clip, the line at 42-76: 26px of room above it, none below. From the line's top (42) it would end at 87,
		// past the clip's bottom margin (72), so it starts at 27.
		const clip = { left: 0, top: 0, right: 940, bottom: 80 };
		const line = { left: 20, top: 42, right: 320, bottom: 76 };
		const fact = { left: 20, top: 2, right: 320, bottom: 76 };
		expect(placed(fact, 300, 45, clip, 8, 8, line, FLOOR)).toMatchObject({
			up: false,
			maxHeight: null,
			offset: 27 - 2,
		});
	});

	it("taller than the clip, it takes the clip's whole inner height, from its top margin", () => {
		// A 300px explainer (floor 51px, two of its lines) in a 100px clip: 84px inside the margins.
		const { clip, line, fact } = middle(100);
		expect(placed(fact, 300, 300, clip, 8, 8, line, FLOOR)).toMatchObject({
			up: false,
			maxHeight: 84,
			offset: 8 - fact.top,
		});
	});

	it("red-first (a sliver of a window): no room when the clip's inner height is under its floor", () => {
		// A 56px clip: 40px inside its margins, under the 45px explainer's floor (all of it). Nothing readable fits.
		const clip = { left: 0, top: 0, right: 940, bottom: 56 };
		const line = { left: 20, top: 11, right: 320, bottom: 45 };
		const fact = { left: 20, top: -29, right: 320, bottom: 45 };
		expect(placePop(fact, 300, 45, clip, 8, 8, line, FLOOR)).toBeNull();
		// 61px: 45px inside, its floor exactly. It fits whole, from the top margin.
		expect(placePop(fact, 300, 45, { ...clip, bottom: 61 }, 8, 8, line, FLOOR)).toMatchObject({
			maxHeight: null,
			offset: 8 - fact.top,
		});
		// A tall explainer's floor is two of its lines, 51px: none in a 66px clip (50 inside), room in a 67px one.
		expect(placePop(fact, 300, 300, { ...clip, bottom: 66 }, 8, 8, line, FLOOR)).toBeNull();
		expect(placePop(fact, 300, 300, { ...clip, bottom: 67 }, 8, 8, line, FLOOR)).toMatchObject({
			maxHeight: 51,
		});
	});

	it("with no floor (the default), it is never laid over its line and always has room", () => {
		const { clip, line, fact } = middle(100);
		expect(placePop(fact, 300, 45, clip, 8, 8, line)).toMatchObject({ maxHeight: 17 });
		expect(placePop(fact, 300, 45, { ...clip, bottom: 20 }, 8, 8, line)).not.toBeNull();
	});

	it("placePopAt hands the floor on, judged by the height at the width it is drawn at", () => {
		// Narrowed from 300 to 234px, a 30px explainer wraps to 60px, and its floor becomes two of its lines (51px).
		const narrow = { left: 0, top: 0, right: 250, bottom: 70 };
		const line = { left: 100, top: 20, right: 240, bottom: 40 };
		const fact = { left: 100, top: 0, right: 240, bottom: 40 };
		// 54px inside the margins: laid over its line from the top margin, capped at 54px.
		expect(placePopAt(fact, 300, 30, narrow, () => 60, line, FLOOR)).toMatchObject({
			width: 234,
			up: false,
			maxHeight: 54,
			offset: 8,
		});
		// 44px inside: room for its 30px at 300px wide, none for its 60px at the 234px it is drawn at.
		expect(placePopAt(fact, 300, 30, { ...narrow, bottom: 60 }, () => 60, line, FLOOR)).toBeNull();
		// No room at its own width is no room narrowed (narrower, it is no shorter): it is not measured again.
		let calls = 0;
		const none = placePopAt(
			fact,
			300,
			60,
			{ ...narrow, bottom: 60 },
			() => {
				calls++;
				return 90;
			},
			line,
			FLOOR,
		);
		expect(none).toBeNull();
		expect(calls).toBe(0);
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
			placed(at(340, 100), 300, 150, BOX),
			placed(at(20, 100), 300, 150, BOX),
			placed(at(100, 100), 300, 150, { left: 0, top: 0, right: 250, bottom: 800 }),
			placed(at(340, 216), 300, 260, { left: 0, top: 0, right: 400, bottom: 340 }),
		])
			expect(popStyle(p).boxSizing).toBe("border-box");
	});

	it("writes the side, the shift, the width, the side above or below, and the cap", () => {
		expect(
			popStyle({ side: "end", shift: null, width: 300, up: false, maxHeight: null, offset: null }),
		).toEqual({
			boxSizing: "border-box",
			left: "auto",
			right: 0,
			width: 300,
		});
		expect(
			popStyle({
				side: "start",
				shift: null,
				width: 300,
				up: false,
				maxHeight: null,
				offset: null,
			}),
		).toEqual({
			boxSizing: "border-box",
			left: 0,
			right: "auto",
			width: 300,
		});
		expect(
			popStyle({ side: "start", shift: -92, width: 234, up: true, maxHeight: 180, offset: null }),
		).toEqual({
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
	type Heard = (e: { target: unknown }) => void;
	const on = new Map<string, Set<Heard>>();
	const key = (who: string, type: string, capture?: boolean): string =>
		`${who} ${type} ${capture === true ? "capture" : "bubble"}`;
	const target = (who: string) => ({
		addEventListener(type: string, fn: Heard, capture?: boolean): void {
			const k = key(who, type, capture);
			on.set(k, (on.get(k) ?? new Set()).add(fn));
		},
		removeEventListener(type: string, fn: Heard, capture?: boolean): void {
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
		fire(who: string, type: string, capture?: boolean, target: unknown = null): void {
			for (const fn of on.get(key(who, type, capture)) ?? []) fn({ target });
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
const POP = { id: "pop" };
/** No scroll is the popover's own. */
const NONE = (): boolean => false;

describe("whenMoved", () => {
	it("red-first (an explainer placed once, for the box it opened in): a resize, a scroll and a change of size each place it again, on the next frame", () => {
		// Placed only when it opened, a restored window's explainer kept the side and width it had in the filled window
		// and ran past the home window's edge; a narrower browser left it wider than its window.
		const f = fakePage();
		let placed = 0;
		whenMoved([BODY, WIN, ANCHOR], () => placed++, f.page, NONE);
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
		whenMoved([BODY], () => placed++, f.page, NONE);
		f.fire("window", "resize");
		f.fire("document", "scroll", true);
		f.fire("document", "scroll", true);
		f.resized();
		expect(f.pending()).toBe(1);
		f.runFrames();
		expect(placed).toBe(1);
	});

	it("red-first (a capped explainer that could not be scrolled): a scroll of the popover itself is not heard", () => {
		// Heard, a reader's scroll inside a capped explainer placed it again, and the reading that placement made threw
		// the reader back to the top. Its own scroll moves nothing around it.
		const f = fakePage();
		let placed = 0;
		whenMoved(
			[BODY],
			() => placed++,
			f.page,
			(t) => t === POP,
		);
		f.fire("document", "scroll", true, POP);
		f.runFrames();
		expect(placed).toBe(0);
		f.fire("document", "scroll", true, BODY);
		f.runFrames();
		expect(placed).toBe(1);
	});

	it("hears a scroll of any scroller, in the capture phase (a window body's scroll does not bubble), and the browser's size", () => {
		const f = fakePage();
		whenMoved([BODY], () => {}, f.page, NONE);
		expect(f.listening()).toEqual(["document scroll capture", "window resize bubble"]);
	});

	it("watches the size of every box it is given: its window, the window's body, its anchor", () => {
		const f = fakePage();
		whenMoved([BODY, WIN, ANCHOR], () => {}, f.page, NONE);
		expect(f.observed).toEqual([BODY, WIN, ANCHOR]);
	});

	it("stops: no listener left, the observer disconnected, and a frame not yet run cancelled", () => {
		const f = fakePage();
		let placed = 0;
		const stop = whenMoved([BODY], () => placed++, f.page, NONE);
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
		whenMoved([BODY], () => placed++, f.page, NONE);
		f.fire("window", "resize");
		f.runFrames();
		f.fire("document", "scroll", true);
		f.runFrames();
		expect(placed).toBe(2);
	});
});

/**
 * A popover as `measure` sees it: 300px wide unless its inline width says otherwise, wrapping taller as it narrows, and
 * capped by its inline max-height or else the stylesheet's 300px. Laying it out clamps its scroll offset to what it can
 * scroll, as a browser does.
 */
function fakePop(width: string, maxHeight: string, scrollTop: number) {
	const style = { width, maxHeight };
	let top = scrollTop;
	const drawn = (): { width: number; height: number; content: number } => {
		const w = style.width === "" ? 300 : Number.parseFloat(style.width);
		const content = Math.round((251 * 300) / w);
		const cap = style.maxHeight === "" ? 300 : Number.parseFloat(style.maxHeight);
		return { width: w, height: Math.min(content, cap), content };
	};
	return {
		style,
		get scrollTop(): number {
			return top;
		},
		set scrollTop(v: number) {
			const d = drawn();
			top = Math.max(0, Math.min(v, d.content - d.height));
		},
		scrollLeft: 0,
		getBoundingClientRect(): { width: number; height: number } {
			const d = drawn();
			top = Math.min(top, d.content - d.height);
			return { width: d.width, height: d.height };
		},
	};
}

describe("measure", () => {
	it("red-first (a capped explainer jumped back to its top): the reading puts back the scroll offset it clamped", () => {
		// Capped at 217px, an explainer 251px tall scrolls 34px; a reader is 30px down it. Read uncapped, it no longer
		// overflows and the browser clamps its offset to 0; putting the cap back did not put the offset back.
		const pop = fakePop("300px", "217px", 30);
		expect(measure(pop, null)).toEqual({ width: 300, height: 251 });
		expect(pop.scrollTop).toBe(30);
		expect(pop.style).toEqual({ width: "300px", maxHeight: "217px" });
	});

	it("reads it at the width it is asked for, then puts back the width and cap the last placement set", () => {
		const pop = fakePop("234px", "180px", 0);
		// At 234px it wraps to 322px, and the stylesheet caps it at 300.
		expect(measure(pop, 234)).toEqual({ width: 234, height: 300 });
		expect(measure(pop, null)).toEqual({ width: 300, height: 251 });
		expect(pop.style).toEqual({ width: "234px", maxHeight: "180px" });
	});
});

describe("outside", () => {
	it("red-first (an explainer cut off with its anchor out of view): an anchor wholly past any edge of the box is outside it", () => {
		// A window gave the desk back, or the browser shrank, and the fact an explainer belongs to now sits below the
		// window's fold. Next to the fact, the explainer ran out of the window's bottom; inside the window, it would sit
		// apart from a fact the reader cannot see.
		expect(outside(at(100, 806, 140, 23), { left: 0, top: 573, right: 400, bottom: 783 })).toBe(
			true,
		);
		expect(outside(at(100, 100), { left: 0, top: 300, right: 400, bottom: 800 })).toBe(true);
		expect(outside(at(-60, 100), BOX)).toBe(true);
		expect(outside(at(420, 100), BOX)).toBe(true);
	});

	it("an anchor partly in the box is not outside it; one that only touches an edge is", () => {
		// 10 of its 16px in view.
		expect(outside(at(100, 790), BOX)).toBe(false);
		// Its top on the box's bottom edge: none of it shows.
		expect(outside(at(100, 800), BOX)).toBe(true);
		expect(outside(at(100, 100), BOX)).toBe(false);
	});

	it("at every edge, an anchor that only touches it is outside and one a pixel in is not", () => {
		// The box is 0 to 400 across and 0 to 800 down; the anchor is 40×16.
		// Its bottom on the box's top edge, then 1px below it.
		expect(outside(at(100, -16), BOX)).toBe(true);
		expect(outside(at(100, -15), BOX)).toBe(false);
		// Its top on the box's bottom edge, then 1px above it.
		expect(outside(at(100, 800), BOX)).toBe(true);
		expect(outside(at(100, 799), BOX)).toBe(false);
		// Its right on the box's left edge, then 1px past it.
		expect(outside(at(-40, 100), BOX)).toBe(true);
		expect(outside(at(-39, 100), BOX)).toBe(false);
		// Its left on the box's right edge, then 1px short of it.
		expect(outside(at(400, 100), BOX)).toBe(true);
		expect(outside(at(399, 100), BOX)).toBe(false);
	});
});

describe("popStyle next to a line", () => {
	it("draws next to the line by a pixel offset from its anchor's top (below) or bottom (above)", () => {
		expect(
			popStyle({ side: "end", shift: null, width: 300, up: true, maxHeight: null, offset: 42 }),
		).toEqual({
			boxSizing: "border-box",
			left: "auto",
			right: 0,
			width: 300,
			top: "auto",
			bottom: 42,
		});
		expect(
			popStyle({ side: "end", shift: null, width: 300, up: false, maxHeight: null, offset: 48 }),
		).toEqual({
			boxSizing: "border-box",
			left: "auto",
			right: 0,
			width: 300,
			top: 48,
		});
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
