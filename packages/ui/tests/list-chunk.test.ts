// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * How many rows the ledger list draws: one chunk at first, more as the reader scrolls, and always enough to hold
 * the row that navigation is about to land on. Pure functions, pinned here; the list component only wires them.
 */

import { describe, expect, it } from "vitest";
import {
	CHUNK,
	type ChunkState,
	chunkGrow,
	chunkInit,
	chunkReveal,
	chunkSync,
	DENSE_ROW_PX,
	pageSizeForRows,
	pinAction,
	pinStep,
	shownCount,
} from "../src/shared/list-chunk.js";

describe("the pinned sizes", () => {
	it("a chunk is 150 rows and a dense row is 30px", () => {
		expect(CHUNK).toBe(150);
		expect(DENSE_ROW_PX).toBe(30);
	});
});

describe("chunkInit: the first chunk", () => {
	it("a short list shows all of itself", () => {
		expect(chunkInit("k", 10)).toEqual({ key: "k", limit: 10 });
	});

	it("a long list shows 150", () => {
		expect(chunkInit("k", 1000).limit).toBe(150);
		expect(chunkInit("k", 150).limit).toBe(150);
		expect(chunkInit("k", 151).limit).toBe(150);
	});

	it("an empty list shows none", () => {
		expect(chunkInit("k", 0).limit).toBe(0);
	});

	it("a count that is not a usable number shows none", () => {
		expect(chunkInit("k", -5).limit).toBe(0);
		expect(chunkInit("k", Number.NaN).limit).toBe(0);
	});
});

describe("chunkGrow: one more chunk", () => {
	it("150 of 1000 becomes 300", () => {
		expect(chunkGrow({ key: "k", limit: 150 }, 1000)).toEqual({ key: "k", limit: 300 });
	});

	it("never above the total: 900 of 1000 becomes 1000", () => {
		expect(chunkGrow({ key: "k", limit: 900 }, 1000).limit).toBe(1000);
	});

	it("a list already shown in full keeps its state, the same object", () => {
		const full: ChunkState = { key: "k", limit: 1000 };
		expect(chunkGrow(full, 1000)).toBe(full);
	});

	it("never shrinks: a limit above a total that fell is kept", () => {
		const s: ChunkState = { key: "k", limit: 300 };
		expect(chunkGrow(s, 120)).toBe(s);
	});
});

describe("chunkReveal: enough chunks to hold a row", () => {
	const at150: ChunkState = { key: "k", limit: 150 };

	it("the last row of the first chunk needs no more", () => {
		expect(chunkReveal(at150, 149, 1000)).toBe(at150);
	});

	it("the first row past it needs the second chunk", () => {
		expect(chunkReveal(at150, 150, 1000)).toEqual({ key: "k", limit: 300 });
	});

	it("a row deep in the list gets every chunk up to its own", () => {
		expect(chunkReveal(at150, 449, 1000).limit).toBe(450);
		expect(chunkReveal(at150, 450, 1000).limit).toBe(600);
	});

	it("never above the total: the last of 1000 gives 1000", () => {
		expect(chunkReveal(at150, 999, 1000).limit).toBe(1000);
	});

	it("never shrinks: a row near the top of a list grown to 300 leaves it at 300", () => {
		const at300: ChunkState = { key: "k", limit: 300 };
		expect(chunkReveal(at300, 5, 1000)).toBe(at300);
	});

	it("an index outside the list leaves the state as it is, the same object", () => {
		expect(chunkReveal(at150, -1, 1000)).toBe(at150);
		expect(chunkReveal(at150, 1000, 1000)).toBe(at150);
		expect(chunkReveal(at150, Number.NaN, 1000)).toBe(at150);
		expect(chunkReveal(at150, 200.5, 1000)).toBe(at150);
		expect(chunkReveal({ key: "k", limit: 0 }, 0, 0)).toEqual({ key: "k", limit: 0 });
	});
});

describe("chunkSync: a new sort or filter resets, a live record does not", () => {
	it("the same key keeps the state, the same object, however long the list has grown", () => {
		const s = chunkInit("k", 1000);
		expect(chunkSync(s, "k", 5000)).toBe(s);
		const deep: ChunkState = { key: "k", limit: 600 };
		expect(chunkSync(deep, "k", 5000)).toBe(deep);
		expect(chunkSync(deep, "k", 601)).toBe(deep);
	});

	it("the same key keeps a deep limit when the list gets shorter", () => {
		const deep: ChunkState = { key: "k", limit: 600 };
		expect(chunkSync(deep, "k", 40)).toBe(deep);
	});

	it("a new key starts again at the first chunk", () => {
		const deep: ChunkState = { key: "k", limit: 600 };
		expect(chunkSync(deep, "other", 5000)).toEqual({ key: "other", limit: 150 });
		expect(chunkSync(deep, "other", 20)).toEqual({ key: "other", limit: 20 });
	});

	it("a list that was empty or short when first drawn fills its first chunk as records arrive", () => {
		// Drawn before any record was loaded: without this, the same key would hold the list at no rows.
		expect(chunkSync(chunkInit("k", 0), "k", 1000)).toEqual({ key: "k", limit: 150 });
		expect(chunkSync(chunkInit("k", 10), "k", 11)).toEqual({ key: "k", limit: 11 });
		expect(chunkSync(chunkInit("k", 10), "k", 400)).toEqual({ key: "k", limit: 150 });
		// Nothing to fill: the same object.
		const ten = chunkInit("k", 10);
		expect(chunkSync(ten, "k", 10)).toBe(ten);
		expect(chunkSync(ten, "k", 4)).toBe(ten);
	});
});

describe("shownCount: the rows drawn", () => {
	it("the limit, or the whole list when it is shorter", () => {
		expect(shownCount({ key: "k", limit: 300 }, 120)).toBe(120);
		expect(shownCount({ key: "k", limit: 300 }, 1000)).toBe(300);
		expect(shownCount({ key: "k", limit: 0 }, 1000)).toBe(0);
	});
});

describe("pinAction: the pinned record is brought into view once per pin", () => {
	const order = [{ hash: "a" }, { hash: "b" }, { hash: "c" }];

	it("no pin: nothing is handled and there is nothing to move to", () => {
		expect(pinAction(null, null, order)).toEqual({ done: null, target: null });
		// The pin was let go: what was handled is forgotten.
		expect(pinAction("b", null, order)).toEqual({ done: null, target: null });
	});

	it("a new pin in the list: it is the target, at its index, and is now handled", () => {
		expect(pinAction(null, "c", order)).toEqual({ done: "c", target: { hash: "c", index: 2 } });
		expect(pinAction("a", "b", order)).toEqual({ done: "b", target: { hash: "b", index: 1 } });
	});

	it("the pin already handled: nothing changes, so the reader's own scrolling is left alone", () => {
		expect(pinAction("b", "b", order)).toEqual({ done: "b", target: null });
		// Even after the row has left the list (a filter): it was handled.
		expect(pinAction("z", "z", order)).toEqual({ done: "z", target: null });
	});

	it("a pin whose record is not in the list yet: it waits, and the pin before it is no longer the handled one", () => {
		expect(pinAction(null, "z", order)).toEqual({ done: null, target: null });
		expect(pinAction("a", "z", order)).toEqual({ done: null, target: null });
		expect(pinAction(null, "a", [])).toEqual({ done: null, target: null });
		// When the record arrives, the same call targets it.
		expect(pinAction("a", "z", [...order, { hash: "z" }])).toEqual({
			done: "z",
			target: { hash: "z", index: 3 },
		});
		const waiting = pinAction("a", "z", order);
		expect(pinAction(waiting.done, "z", [...order, { hash: "z" }])).toEqual({
			done: "z",
			target: { hash: "z", index: 3 },
		});
	});

	it("a pin moved to a record not in the list and back again targets the first record again", () => {
		const toA = { done: "a", target: { hash: "a", index: 0 } };
		const first = pinAction(null, "a", order);
		expect(first).toEqual(toA);
		const away = pinAction(first.done, "z", order);
		expect(away.target).toBeNull();
		expect(pinAction(away.done, "a", order)).toEqual(toA);
		// The same as when the record between was in the list.
		const there = pinAction(first.done, "b", order);
		expect(pinAction(there.done, "a", order)).toEqual(toA);
	});

	it("after the pin is let go, the same pin targets again", () => {
		const first = pinAction(null, "b", order);
		expect(first.target).toEqual({ hash: "b", index: 1 });
		expect(pinAction(first.done, "b", order).target).toBeNull();
		const cleared = pinAction(first.done, null, order);
		expect(cleared.done).toBeNull();
		expect(pinAction(cleared.done, "b", order)).toEqual({
			done: "b",
			target: { hash: "b", index: 1 },
		});
	});
});

describe("pageSizeForRows: what PageUp and PageDown move", () => {
	it("the rows that fit, less one kept in view", () => {
		expect(pageSizeForRows(300)).toBe(9);
		expect(pageSizeForRows(300, 60)).toBe(4);
	});

	it("never below 1", () => {
		expect(pageSizeForRows(10)).toBe(1);
		expect(pageSizeForRows(0)).toBe(1);
		expect(pageSizeForRows(Number.NaN)).toBe(1);
		expect(pageSizeForRows(300, 0)).toBe(1);
	});

	it("a row that only partly fits does not count", () => {
		expect(pageSizeForRows(310)).toBe(9);
		expect(pageSizeForRows(329)).toBe(9);
		expect(pageSizeForRows(59)).toBe(1);
		expect(pageSizeForRows(89)).toBe(1);
		expect(pageSizeForRows(91)).toBe(2);
	});
});

describe("a row count that is not a whole number of rows", () => {
	const at150: ChunkState = { key: "k", limit: 150 };
	const at300: ChunkState = { key: "k", limit: 300 };

	it("a fraction of a row is not a row", () => {
		expect(chunkInit("k", 10.7).limit).toBe(10);
		expect(shownCount(at300, 10.7)).toBe(10);
		expect(chunkGrow(at150, 160.9).limit).toBe(160);
		expect(chunkReveal(at150, 160, 160.9)).toBe(at150);
		expect(chunkSync({ key: "k", limit: 10 }, "k", 11.9).limit).toBe(11);
	});

	it("an endless count is no count", () => {
		expect(chunkInit("k", Number.POSITIVE_INFINITY).limit).toBe(0);
		expect(chunkGrow(at150, Number.POSITIVE_INFINITY)).toBe(at150);
		expect(chunkReveal(at150, 150, Number.POSITIVE_INFINITY)).toBe(at150);
		expect(shownCount(at300, Number.POSITIVE_INFINITY)).toBe(0);
	});

	it("shownCount draws nothing for a count that is not a number or is negative", () => {
		expect(shownCount(at300, Number.NaN)).toBe(0);
		expect(shownCount(at300, -5)).toBe(0);
		expect(shownCount(at300, -0.5)).toBe(0);
	});
});

describe("pinAction: the first row", () => {
	const order = [{ hash: "a" }, { hash: "b" }, { hash: "c" }];

	it("a pinned record that is the first row is brought into view like any other", () => {
		expect(pinAction(null, "a", order)).toEqual({ done: "a", target: { hash: "a", index: 0 } });
		expect(pinAction("b", "a", order)).toEqual({ done: "a", target: { hash: "a", index: 0 } });
	});
});

describe("pinStep: the pinned record is brought into view once for each answer drawn", () => {
	const VIEW = 452;
	const ROW = DENSE_ROW_PX;
	/** The rows of a vault of positions 0..head, cut at a past position, in the sort the list draws. */
	const rowsAt = (head: number, cut: number | null, desc: boolean): { hash: string }[] => {
		const end = cut ?? head;
		const all = Array.from({ length: end + 1 }, (_, pos) => ({ hash: `h${pos}` }));
		return desc ? all.reverse() : all;
	};
	/** Where `showRow(index, "center")` leaves a list of `n` rows (a viewport of 452px), and whether the row is on it. */
	const centred = (index: number, n: number): { top: number; shown: boolean } => {
		const top = Math.min(Math.max(index * ROW - (VIEW - ROW) / 2, 0), Math.max(n * ROW - VIEW, 0));
		return { top, shown: index * ROW >= top && (index + 1) * ROW <= top + VIEW };
	};
	/** The pin decision over a past position's two draws: the rows held while the answer is pending, then the cut rows. */
	const replay = (head: number, b: number, desc: boolean) => {
		const pending = rowsAt(head, null, desc);
		const answered = rowsAt(head, b, desc);
		const first = pinStep({ done: null, answer: undefined }, `h${b}`, pending, "live");
		const second = pinStep(first.state, `h${b}`, answered, String(b));
		return { first, second, answered };
	};

	it("descending: the pinned record becomes the first row when the answer lands, and is scrolled to", () => {
		for (const head of [599, 320]) {
			const { first, second, answered } = replay(head, 300, true);
			// While the answer is pending the record is in the middle of the rows held (head minus its position).
			expect(first.target?.index, `head ${head}`).toBe(head - 300);
			expect(second.target, `head ${head}`).toEqual({ hash: "h300", index: 0 });
			expect(centred(second.target?.index ?? -1, answered.length).shown, `head ${head}`).toBe(true);
			// Once per pin, not once per answer: the old decision did nothing for the same record.
			expect(pinAction(first.state.done, "h300", answered).target).toBeNull();
		}
	});

	it("ascending: the pinned record becomes the last row when the answer lands, and is scrolled to", () => {
		const { first, second, answered } = replay(599, 300, false);
		expect(first.target?.index).toBe(300);
		expect(second.target).toEqual({ hash: "h300", index: 300 });
		const where = centred(300, answered.length);
		expect(where.shown).toBe(true);
		// 301 rows of 30px in a 452px viewport: the end of the list (the measured 8578).
		expect(where.top).toBe(301 * ROW - VIEW);
	});

	it("from one past position to an earlier one: the record is scrolled to again once its answer lands", () => {
		const a = replay(599, 450, true);
		const toB = pinStep(a.second.state, "h300", rowsAt(599, 450, true), "450");
		// B is among A's rows while its answer is pending: the first decision is the old position's rows.
		expect(toB.target?.index).toBe(150);
		const landed = pinStep(toB.state, "h300", rowsAt(599, 300, true), "300");
		expect(landed.target).toEqual({ hash: "h300", index: 0 });
	});

	it("the reader's own scrolling is left alone while the same answer stands, and nothing is pinned for a record filtered out", () => {
		const { second, answered } = replay(599, 300, true);
		// A new row arrives, or the list is redrawn: the same pin and answer, nothing to do.
		expect(pinStep(second.state, "h300", answered, "300").target).toBeNull();
		expect(pinStep(second.state, "h300", [{ hash: "new" }, ...answered], "300").target).toBeNull();
		// The pinned record is outside the filters once the answer lands: no target and nothing handled, so the
		// list's reset key (the answer) is what takes it to the top.
		const filtered = pinStep(second.state, "h300", [{ hash: "x" }, { hash: "y" }], "280");
		expect(filtered).toEqual({ state: { done: null, answer: "280" }, target: null });
	});
});
