// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	COMPACT_QUERY,
	DESK_GAP,
	DESK_MIN_WIDTH,
	DOCK_QUERY,
	HOME,
	HOME_ROWS,
	homeInset,
	isDimmed,
	isFilled,
	nextPhase,
	type Phase,
	phaseDone,
	placeStyle,
	WINDOW_IDS,
	type WindowId,
	windowOrder,
} from "../src/shared/desk-layout.js";

describe("the home layout", () => {
	it("lists the four windows in grid order", () => {
		expect([...WINDOW_IDS]).toEqual(["spend", "share", "ledger", "now"]);
	});

	it("places spend and share above, ledger and now below, in 12 columns", () => {
		expect(HOME.spend).toEqual({ col: 1, span: 8, row: 1 });
		expect(HOME.share).toEqual({ col: 9, span: 4, row: 1 });
		expect(HOME.ledger).toEqual({ col: 1, span: 8, row: 2 });
		expect(HOME.now).toEqual({ col: 9, span: 4, row: 2 });
		for (const row of [1, 2] as const) {
			const ids = WINDOW_IDS.filter((id) => HOME[id].row === row);
			expect(ids.reduce((sum, id) => sum + HOME[id].span, 0)).toBe(12);
		}
	});

	it("names the row split, the gap and the dock query", () => {
		expect(HOME_ROWS).toBe("minmax(0, 11fr) minmax(0, 9fr)");
		expect(DESK_GAP).toBe(16);
		expect(DOCK_QUERY).toBe("(min-width: 1100px)");
	});

	it("red-first (a desk squeezed between 901 and 999 px): the desk starts at 1000 px, and under it is the column", () => {
		expect(DESK_MIN_WIDTH).toBe(1000);
		expect(COMPACT_QUERY).toBe("(max-width: 999px)");
		// One number: the query is the last width under the desk's first.
		expect(COMPACT_QUERY).toBe(`(max-width: ${DESK_MIN_WIDTH - 1}px)`);
	});

	it("turns a place into grid properties", () => {
		expect(placeStyle("share")).toEqual({ gridColumn: "9 / span 4", gridRow: "1" });
		expect(placeStyle("ledger")).toEqual({ gridColumn: "1 / span 8", gridRow: "2" });
	});

	it("measures a clip inset from the desk's edges to the window's home slot", () => {
		expect(
			homeInset(
				{ left: 0, top: 0, right: 784, bottom: 480 },
				{ left: 0, top: 0, right: 1200, bottom: 900 },
			),
		).toBe("inset(0px 416px 420px 0px)");
		expect(
			homeInset(
				{ left: 816, top: 20, right: 1216, bottom: 500 },
				{ left: 16, top: 20, right: 1216, bottom: 920 },
			),
		).toBe("inset(0px 0px 420px 800px)");
	});
});

describe("isFilled", () => {
	it("is true only for the filled window on a wide desk", () => {
		expect(isFilled("spend", "spend", false)).toBe(true);
		expect(isFilled("spend", "share", false)).toBe(false);
		expect(isFilled(null, "spend", false)).toBe(false);
	});

	it("ignores fill on a compact window, so none is inert or hidden (a link with fill= on a phone)", () => {
		expect(isFilled("spend", "spend", true)).toBe(false);
		for (const id of WINDOW_IDS as readonly WindowId[]) expect(isFilled(id, id, true)).toBe(false);
	});
});

// A dimmed window is inert and hidden: the window draws nothing modal in it, and Escape does not take a layer that
// lives in it (a record whose panel no one can see).
describe("isDimmed", () => {
	it("is true for every window but the filled one, on a wide desk", () => {
		expect(isDimmed("spend", "ledger", false)).toBe(true);
		expect(isDimmed("spend", "spend", false)).toBe(false);
		expect(isDimmed(null, "ledger", false)).toBe(false);
	});

	it("is never true on a compact window, where fill is ignored", () => {
		for (const fill of WINDOW_IDS as readonly WindowId[])
			for (const id of WINDOW_IDS as readonly WindowId[])
				expect(isDimmed(fill, id, true)).toBe(false);
	});
});

// The order the windows are in the page. On a phone the page keeps its own order: the facts above the list, which
// flows in the page and runs to its end. The DOM follows it, so the Tab order is the order on screen.
describe("windowOrder", () => {
	it("red-first (the facts after a list as long as the vault): on a phone, Now comes first and the Ledger last", () => {
		const phone = windowOrder(true);
		expect(phone).toEqual(["now", "spend", "share", "ledger"]);
		expect(phone.indexOf("now")).toBeLessThan(phone.indexOf("ledger"));
		expect([...phone].sort()).toEqual([...WINDOW_IDS].sort());
	});

	it("is grid order on a wider screen, where each window sits at its home cell anyway", () => {
		expect(windowOrder(false)).toEqual(WINDOW_IDS);
	});
});

describe("the fill phases", () => {
	it("starts a grow or shrink, or jumps when motion is still", () => {
		expect(nextPhase("home", true, false)).toBe("grow");
		expect(nextPhase("home", true, true)).toBe("filled");
		expect(nextPhase("filled", false, false)).toBe("shrink");
		expect(nextPhase("filled", false, true)).toBe("home");
	});

	it("reverses mid-flight and holds when nothing changes", () => {
		expect(nextPhase("grow", false, false)).toBe("shrink");
		expect(nextPhase("shrink", true, false)).toBe("grow");
		expect(nextPhase("filled", true, false)).toBe("filled");
		expect(nextPhase("home", false, false)).toBe("home");
		expect(nextPhase("grow", true, false)).toBe("grow");
		expect(nextPhase("shrink", false, false)).toBe("shrink");
	});

	it("settles a flight at once when motion is still", () => {
		expect(nextPhase("grow", false, true)).toBe("home");
		expect(nextPhase("shrink", true, true)).toBe("filled");
		expect(nextPhase("grow", true, true)).toBe("filled");
		expect(nextPhase("shrink", false, true)).toBe("home");
	});

	it("ends a flight where it was going", () => {
		expect(phaseDone("grow")).toBe("filled");
		expect(phaseDone("shrink")).toBe("home");
		expect(phaseDone("home")).toBe("home");
		expect(phaseDone("filled")).toBe("filled");
	});

	it("covers every phase and target without leaving the four phases", () => {
		const phases: Phase[] = ["home", "grow", "filled", "shrink"];
		for (const p of phases)
			for (const target of [true, false])
				for (const still of [true, false]) expect(phases).toContain(nextPhase(p, target, still));
	});
});
