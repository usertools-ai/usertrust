// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { intersect, placePop } from "../src/shared/pop-place.js";

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
