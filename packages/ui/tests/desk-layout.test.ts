// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	COMPACT_QUERY,
	DESK_GAP,
	DOCK_QUERY,
	HOME,
	HOME_ROWS,
	homeInset,
	isFilled,
	nextPhase,
	type Phase,
	phaseDone,
	placeStyle,
	WINDOW_IDS,
	type WindowId,
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

	it("names the row split, the gap and the two queries", () => {
		expect(HOME_ROWS).toBe("minmax(0, 11fr) minmax(0, 9fr)");
		expect(DESK_GAP).toBe(16);
		expect(COMPACT_QUERY).toBe("(max-width: 900px)");
		expect(DOCK_QUERY).toBe("(min-width: 1100px)");
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
