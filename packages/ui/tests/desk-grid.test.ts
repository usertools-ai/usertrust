// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The desk's two rows, counted in steps: the lower row takes the rows the Now window's content needs, the upper row
 * the rest and never fewer than nine, and a desk too short for both is run past, so it scrolls.
 */

import { describe, expect, it } from "vitest";
import {
	GAP,
	gridRowsStyle,
	homeGrid,
	MIN_ROWS,
	ROW_PX,
	ROW_STEP,
	rowsFor,
	rowsToFit,
	TOP_MIN_ROWS,
} from "../src/shared/desk-grid.js";
import { DESK_GAP } from "../src/shared/desk-layout.js";

/** A window `rows` tall, in CSS px: its rows and the gaps between them. */
const windowPx = (rows: number): number => rows * ROW_STEP - GAP;

describe("the row step", () => {
	it("is 24 px of row and the desk's 16 px gap: 40 px", () => {
		expect(GAP).toBe(16);
		expect(GAP).toBe(DESK_GAP);
		expect(ROW_PX).toBe(24);
		expect(ROW_STEP).toBe(40);
		expect(ROW_STEP).toBe(ROW_PX + GAP);
	});

	it("keeps a window at least 4 rows tall, and the upper row at least 9", () => {
		expect(MIN_ROWS).toBe(4);
		expect(TOP_MIN_ROWS).toBe(9);
	});
});

describe("rowsToFit", () => {
	it("red-first (385 px of facts in a 319 px window): gives the Now window the rows its content needs", () => {
		expect(rowsToFit(319)).toBe(9);
		expect(rowsToFit(385)).toBe(11);
	});

	it("takes one more row the pixel after a window is full", () => {
		expect(rowsToFit(0)).toBe(1);
		expect(rowsToFit(24)).toBe(1);
		expect(rowsToFit(25)).toBe(2);
		expect(rowsToFit(64)).toBe(2);
		expect(rowsToFit(65)).toBe(3);
		expect(rowsToFit(344)).toBe(9);
		expect(rowsToFit(345)).toBe(10);
		expect(rowsToFit(424)).toBe(11);
		expect(rowsToFit(425)).toBe(12);
		expect(rowsToFit(454)).toBe(12);
	});

	it("is the fewest rows whose window holds the content, at every height", () => {
		for (let px = 0; px <= 640; px++) {
			const rows = rowsToFit(px);
			expect(Number.isInteger(rows), `${px}px`).toBe(true);
			expect(windowPx(rows), `${px}px fits`).toBeGreaterThanOrEqual(px);
			expect(windowPx(rows - 1), `${px}px needs every row`).toBeLessThan(px);
		}
	});
});

describe("rowsFor", () => {
	it("red-first: a 1000 px desk holds 25 rows", () => {
		expect(rowsFor(1000)).toBe(25);
	});

	it("counts a row only once the whole of it fits", () => {
		expect(rowsFor(0)).toBe(0);
		expect(rowsFor(23)).toBe(0);
		expect(rowsFor(24)).toBe(1);
		expect(rowsFor(63)).toBe(1);
		expect(rowsFor(64)).toBe(2);
		expect(rowsFor(600)).toBe(15);
		expect(rowsFor(984)).toBe(25);
		// More than half a row over is still not a row.
		expect(rowsFor(1010)).toBe(25);
		expect(rowsFor(1023)).toBe(25);
		expect(rowsFor(1024)).toBe(26);
	});

	it("is the most rows that fit the desk, at every height", () => {
		for (let px = 24; px <= 1400; px++) {
			const rows = rowsFor(px);
			expect(Number.isInteger(rows), `${px}px`).toBe(true);
			expect(windowPx(rows), `${px}px holds them`).toBeLessThanOrEqual(px);
			expect(windowPx(rows + 1), `${px}px holds no more`).toBeGreaterThan(px);
		}
	});

	it("undoes rowsToFit: a desk as tall as a window of n rows holds n rows", () => {
		for (let rows = 1; rows <= 40; rows++) {
			expect(rowsFor(windowPx(rows))).toBe(rows);
			expect(rowsToFit(windowPx(rows))).toBe(rows);
		}
	});
});

describe("homeGrid", () => {
	it("red-first (the rows were a fixed 11 to 9): the lower row takes the rows Now needs, the upper row the rest", () => {
		expect(homeGrid(31, 11)).toEqual({ top: 20, bottom: 11 });
		expect(homeGrid(25, 11)).toEqual({ top: 14, bottom: 11 });
		expect(homeGrid(20, 9)).toEqual({ top: 11, bottom: 9 });
	});

	it("red-first: runs past a short desk rather than squeeze the charts or cut Now", () => {
		expect(homeGrid(16, 9)).toEqual({ top: 9, bottom: 9 });
		expect(homeGrid(16, 12)).toEqual({ top: 9, bottom: 12 });
		expect(homeGrid(25, 30)).toEqual({ top: 9, bottom: 30 });
	});

	it("red-first: before Now is measured, the lower row is 44% of the rows, to the nearest row", () => {
		// 14 * 0.44 = 6.16: six rows below, and nine above, one row past a 14-row desk.
		expect(homeGrid(14)).toEqual({ top: 9, bottom: 6 });
		// 8.8 rounds up, 11 is exact, 13.2 rounds down.
		expect(homeGrid(20)).toEqual({ top: 11, bottom: 9 });
		expect(homeGrid(25)).toEqual({ top: 14, bottom: 11 });
		expect(homeGrid(30)).toEqual({ top: 17, bottom: 13 });
		expect(homeGrid(100)).toEqual({ top: 56, bottom: 44 });
	});

	it("counts a desk of fewer than 13 rows as 13: nine above and four below at the least", () => {
		expect(TOP_MIN_ROWS + MIN_ROWS).toBe(13);
		for (const rows of [0, 1, 5, 10, 12, 13]) expect(homeGrid(rows)).toEqual({ top: 9, bottom: 6 });
		expect(homeGrid(5, 4)).toEqual({ top: 9, bottom: 4 });
		expect(homeGrid(13, 4)).toEqual({ top: 9, bottom: 4 });
		expect(homeGrid(14, 4)).toEqual({ top: 10, bottom: 4 });
	});

	it("never gives Now fewer than 4 rows, however little it holds", () => {
		expect(homeGrid(25, 5)).toEqual({ top: 20, bottom: 5 });
		expect(homeGrid(25, 4)).toEqual({ top: 21, bottom: 4 });
		expect(homeGrid(25, 3)).toEqual({ top: 21, bottom: 4 });
		expect(homeGrid(25, 1)).toEqual({ top: 21, bottom: 4 });
		// A measured nothing is a measure: it is not swapped for the unmeasured share.
		expect(homeGrid(25, 0)).toEqual({ top: 21, bottom: 4 });
	});

	it("never gives the upper row fewer than 9 rows: the row where it would is the first that scrolls", () => {
		expect(homeGrid(19, 9)).toEqual({ top: 10, bottom: 9 });
		expect(homeGrid(18, 9)).toEqual({ top: 9, bottom: 9 });
		expect(homeGrid(17, 9)).toEqual({ top: 9, bottom: 9 });
	});

	it("fills the desk exactly when it is tall enough for both, and is whole rows at every size", () => {
		for (let rows = 0; rows <= 60; rows++) {
			for (const now of [undefined, ...Array.from({ length: 41 }, (_, n) => n)]) {
				const g = now === undefined ? homeGrid(rows) : homeGrid(rows, now);
				const label = `${rows} rows, Now ${now ?? "unmeasured"}`;
				expect(Number.isInteger(g.top) && Number.isInteger(g.bottom), label).toBe(true);
				expect(g.top, label).toBeGreaterThanOrEqual(TOP_MIN_ROWS);
				expect(g.bottom, label).toBeGreaterThanOrEqual(MIN_ROWS);
				if (now !== undefined) expect(g.bottom, label).toBe(Math.max(MIN_ROWS, now));
				const desk = Math.max(TOP_MIN_ROWS + MIN_ROWS, rows);
				// Tall enough for both: every row of the desk is used, none over. Too short: the upper row is at its least.
				if (desk - g.bottom >= TOP_MIN_ROWS) expect(g.top + g.bottom, label).toBe(desk);
				else expect(g.top, label).toBe(TOP_MIN_ROWS);
			}
		}
	});
});

describe("gridRowsStyle", () => {
	it("red-first: writes the two rows as pixel heights, the upper first", () => {
		expect(gridRowsStyle({ top: 9, bottom: 9 })).toBe("344px 344px");
		expect(gridRowsStyle({ top: 14, bottom: 11 })).toBe("544px 424px");
		expect(gridRowsStyle({ top: 21, bottom: 4 })).toBe("824px 144px");
		expect(gridRowsStyle({ top: 20, bottom: 11 })).toBe("784px 424px");
	});

	it("gives a window of h rows the height of its rows and the gaps between them", () => {
		for (let top = TOP_MIN_ROWS; top <= 30; top++) {
			for (let bottom = MIN_ROWS; bottom <= 30; bottom++) {
				expect(gridRowsStyle({ top, bottom })).toBe(`${windowPx(top)}px ${windowPx(bottom)}px`);
			}
		}
	});

	it("fits the two rows and the gap between them in a desk tall enough for both, within a row of its height", () => {
		// 704 px is the shortest desk that holds nine rows above and nine below.
		expect(rowsFor(703)).toBe(17);
		for (let px = 704; px <= 1400; px += 7) {
			const g = homeGrid(rowsFor(px), 9);
			const [top, bottom] = gridRowsStyle(g)
				.split(" ")
				.map((row) => Number.parseInt(row, 10));
			const used = (top ?? Number.NaN) + GAP + (bottom ?? Number.NaN);
			expect(used, `${px}px`).toBeLessThanOrEqual(px);
			expect(used, `${px}px`).toBeGreaterThan(px - ROW_STEP);
		}
	});
});
