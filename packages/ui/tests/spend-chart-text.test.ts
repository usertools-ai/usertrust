// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/** The Spend chart's words and key arithmetic, pure. */

import { describe, expect, it } from "vitest";
import {
	bucketOf,
	drawnCursor,
	escapeTarget,
	frameKey,
	keyAction,
	movedTime,
	reconcileCursor,
	stepBucket,
	toggleTarget,
} from "../src/app/windows/spend/chart-keys.js";
import {
	brokenFrom,
	headLabel,
	newText,
	plotLabel,
	recordNumber,
	subLine,
	valueText,
	whenLine,
} from "../src/app/windows/spend/chart-text.js";
import type { CursorValue } from "../src/shared/cursor-store.js";
import { LINE_BUCKETS } from "../src/shared/spend-model.js";

const T = Date.UTC(2026, 10, 7, 18, 0, 5);
const NO_MODS = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };

describe("headLabel", () => {
	it("names spend at rest, by then with a cursor or pin, and in this view under a filter", () => {
		expect(headLabel({ shown: false, filtered: false })).toBe("Spend");
		expect(headLabel({ shown: true, filtered: false })).toBe("Spend by then");
		expect(headLabel({ shown: false, filtered: true })).toBe("Spend in this view");
		expect(headLabel({ shown: true, filtered: true })).toBe("Spend by then in this view");
	});
});

describe("subLine", () => {
	const base = {
		empty: false,
		rangeUt: 1_234_500,
		peakRate: 40_000,
		bucket: LINE_BUCKETS["1w"],
		shownUt: null,
		filtered: false,
		truncated: false,
	};
	it("reads the range and its peak per bucket at rest", () => {
		expect(subLine(base)).toBe("+$123.45 in this range · peak $4.00/h");
	});
	it("shows the peak as one bucket's spend at 1D", () => {
		// 40_000 UT/h over a 5 min bucket is 3_333.33 UT.
		expect(subLine({ ...base, bucket: LINE_BUCKETS["1d"] })).toBe(
			"+$123.45 in this range · peak $0.33/5 min",
		);
	});
	it("reads the shown bucket with its phrase", () => {
		expect(subLine({ ...base, shownUt: 25_000 })).toBe("+$123.45 in this range · $2.50 this hour");
		// A quiet bucket spends nothing and still reads as that bucket, not as the peak.
		expect(subLine({ ...base, shownUt: 0 })).toBe("+$123.45 in this range · $0.00 this hour");
		expect(subLine({ ...base, shownUt: 25_000, bucket: LINE_BUCKETS["3m"] })).toBe(
			"+$123.45 in this range · $2.50 these 6 h",
		);
	});
	it("says the range starts at the oldest record held only when filtered and truncated", () => {
		expect(subLine({ ...base, filtered: true, truncated: true })).toBe(
			"+$123.45 in this range · peak $4.00/h · since the oldest record held",
		);
		expect(subLine({ ...base, filtered: false, truncated: true })).not.toContain("oldest");
		expect(subLine({ ...base, filtered: true, truncated: false })).not.toContain("oldest");
	});
	it("says there is no spend when the window has none", () => {
		expect(subLine({ ...base, empty: true })).toBe("No spend recorded in this range");
	});
});

describe("whenLine", () => {
	it("names the pinned record by its time and vault number", () => {
		expect(
			whenLine({
				shown: { t: T, pos: 17_951, pinned: true },
				pinnedNoRecord: false,
				lastT: T,
				spent: true,
			}),
		).toBe("Pinned · 11-07 18:00:05Z · record 17,952");
	});
	it("names a hovered record without the pin's word", () => {
		expect(
			whenLine({
				shown: { t: T, pos: 4, pinned: false },
				pinnedNoRecord: false,
				lastT: T,
				spent: true,
			}),
		).toBe("11-07 18:00:05Z · record 5");
	});
	it("is live at rest", () => {
		expect(whenLine({ shown: null, pinnedNoRecord: false, lastT: T, spent: true })).toBe(
			"Live · last spend 11-07 18:00:05Z",
		);
		expect(whenLine({ shown: null, pinnedNoRecord: false, lastT: null, spent: false })).toBe(
			"Live · no spend recorded yet",
		);
	});
	it("says so for a pin with no spend at or before it", () => {
		expect(whenLine({ shown: null, pinnedNoRecord: true, lastT: T, spent: true })).toBe(
			"Pinned · no spend recorded by then",
		);
	});
});

describe("brokenFrom", () => {
	it("holds at and after the break, never before it or with no break", () => {
		expect(brokenFrom(5, 5)).toBe(true);
		expect(brokenFrom(6, 5)).toBe(true);
		expect(brokenFrom(4, 5)).toBe(false);
		expect(brokenFrom(6, null)).toBe(false);
		expect(brokenFrom(null, 5)).toBe(false);
	});
});

describe("valueText", () => {
	it("reads the shown record of the vault, and says pinned on the pin", () => {
		const shown = { t: T, pos: 4, pinned: true };
		expect(
			valueText({ empty: false, shown, pinnedNoRecord: false, head: 11, cumUt: 1_234_500 }),
		).toBe("Record 5 of 12 · $123.45 spent by 11-07 18:00:05Z · pinned");
		expect(
			valueText({
				empty: false,
				shown: { ...shown, pinned: false },
				pinnedNoRecord: false,
				head: 11,
				cumUt: 1_234_500,
			}),
		).toBe("Record 5 of 12 · $123.45 spent by 11-07 18:00:05Z");
	});
	it("is the live figure at rest, and says when there is no spend", () => {
		expect(
			valueText({ empty: false, shown: null, pinnedNoRecord: false, head: 11, cumUt: 100 }),
		).toBe("Live · $0.01 spent");
		expect(valueText({ empty: true, shown: null, pinnedNoRecord: false, head: -1, cumUt: 0 })).toBe(
			"No spend recorded",
		);
		expect(valueText({ empty: false, shown: null, pinnedNoRecord: true, head: 11, cumUt: 0 })).toBe(
			"Pinned · $0.00 spent",
		);
	});
});

describe("valueText and whenLine with a pin that has no record", () => {
	const nan = { t: Number.NaN, pos: 4, pinned: true };
	it("never reads the time of a pin with no spend record at or before it", () => {
		const v = { empty: false, shown: nan, pinnedNoRecord: true, head: 11, cumUt: 0 };
		expect(valueText(v)).toBe("Pinned · $0.00 spent");
		expect(whenLine({ shown: nan, pinnedNoRecord: true, lastT: T, spent: true })).toBe(
			"Pinned · no spend recorded by then",
		);
	});
	it("puts the pin before the empty window", () => {
		expect(valueText({ empty: true, shown: null, pinnedNoRecord: true, head: 11, cumUt: 0 })).toBe(
			"Pinned · $0.00 spent",
		);
	});
	it("groups the vault's size in thousands", () => {
		const shown = { t: T, pos: 4, pinned: false };
		expect(
			valueText({ empty: false, shown, pinnedNoRecord: false, head: 1199, cumUt: 100 }),
		).toContain("of 1,200");
	});
});

describe("words with a time that is not one, and a record past the stale head", () => {
	it("never throws on a NaN time, with or without the no-record flag", () => {
		const nan = { t: Number.NaN, pos: 4, pinned: false };
		expect(whenLine({ shown: nan, pinnedNoRecord: false, lastT: T, spent: true })).toBe(
			"unknown time · record 5",
		);
		expect(whenLine({ shown: null, pinnedNoRecord: false, lastT: Number.NaN, spent: true })).toBe(
			"Live · last spend unknown time",
		);
		expect(
			valueText({ empty: false, shown: nan, pinnedNoRecord: false, head: 11, cumUt: 100 }),
		).toContain("spent by unknown time");
	});
	it("never says a record is past the vault's size", () => {
		const shown = { t: T, pos: 11, pinned: false };
		expect(
			valueText({ empty: false, shown, pinnedNoRecord: false, head: 9, cumUt: 100 }),
		).toContain("Record 12 of 12");
	});
});

describe("newText and plotLabel", () => {
	it("counts records added since the pin, and nothing when none were", () => {
		expect(newText(0)).toBe("");
		expect(newText(1)).toBe(" +1 new");
		expect(newText(3)).toBe(" +3 new");
		expect(newText(1_200)).toBe(" +1,200 new");
	});
	it("names the plot in its bucket", () => {
		expect(plotLabel("5 min")).toBe(
			"Spend per 5 min over time: hover to preview, click to pin a record, click again for now",
		);
	});
	it("groups a record number the same everywhere", () => {
		expect(recordNumber(999)).toBe("1,000");
	});
});

describe("keyAction", () => {
	it("maps each key, with Shift's larger steps", () => {
		expect(keyAction({ ...NO_MODS, key: "ArrowLeft" })).toEqual({ type: "bucket", by: -1 });
		expect(keyAction({ ...NO_MODS, key: "ArrowRight" })).toEqual({ type: "bucket", by: 1 });
		expect(keyAction({ ...NO_MODS, key: "ArrowDown" })).toEqual({ type: "record", by: -1 });
		expect(keyAction({ ...NO_MODS, key: "ArrowRight", shiftKey: true })).toEqual({
			type: "bucket",
			by: 10,
		});
		expect(keyAction({ ...NO_MODS, key: "ArrowLeft", shiftKey: true })).toEqual({
			type: "bucket",
			by: -10,
		});
		expect(keyAction({ ...NO_MODS, key: "ArrowUp" })).toEqual({ type: "record", by: 1 });
		expect(keyAction({ ...NO_MODS, key: "ArrowDown", shiftKey: true })).toEqual({
			type: "record",
			by: -100,
		});
		expect(keyAction({ ...NO_MODS, key: "ArrowUp", shiftKey: true })).toEqual({
			type: "record",
			by: 100,
		});
		expect(keyAction({ ...NO_MODS, key: "Home" })).toEqual({ type: "home" });
		expect(keyAction({ ...NO_MODS, key: "End" })).toEqual({ type: "end" });
		expect(keyAction({ ...NO_MODS, key: "Enter" })).toEqual({ type: "toggle" });
		expect(keyAction({ ...NO_MODS, key: " " })).toEqual({ type: "toggle" });
		expect(keyAction({ ...NO_MODS, key: "Escape" })).toEqual({ type: "escape" });
	});
	it("leaves other keys and the page's shortcuts alone", () => {
		expect(keyAction({ ...NO_MODS, key: "a" })).toBeNull();
		expect(keyAction({ ...NO_MODS, key: "]" })).toBeNull();
		expect(keyAction({ ...NO_MODS, key: "ArrowLeft", metaKey: true })).toBeNull();
		expect(keyAction({ ...NO_MODS, key: "ArrowLeft", ctrlKey: true })).toBeNull();
		expect(keyAction({ ...NO_MODS, key: "ArrowLeft", altKey: true })).toBeNull();
	});
});

describe("stepBucket and bucketOf", () => {
	it("steps and keeps to the line", () => {
		expect(stepBucket(5, 1, 168)).toBe(6);
		expect(stepBucket(5, -10, 168)).toBe(0);
		expect(stepBucket(165, 10, 168)).toBe(167);
		expect(stepBucket(5, 1, 0)).toBe(-1);
		expect(stepBucket(5, 1, Number.NaN)).toBe(-1);
	});
	it("lands on the first bucket when the current one is not finite", () => {
		expect(stepBucket(Number.NaN, 1, 10)).toBe(0);
		expect(stepBucket(Number.POSITIVE_INFINITY, -1, 10)).toBe(0);
	});
	it("puts a time in its bucket and the window's end in the last", () => {
		expect(bucketOf(0, 0, 10, 5)).toBe(0);
		expect(bucketOf(19, 0, 10, 5)).toBe(1);
		expect(bucketOf(50, 0, 10, 5)).toBe(4);
		expect(bucketOf(-5, 0, 10, 5)).toBe(0);
		expect(bucketOf(Number.NaN, 0, 10, 5)).toBe(0);
		// The window's start is where bucket 0 begins.
		expect(bucketOf(25, 20, 10, 5)).toBe(0);
		expect(bucketOf(45, 20, 10, 5)).toBe(2);
		// A line with no buckets reads bucket 0, not -1.
		expect(bucketOf(30, 0, 10, 0)).toBe(0);
	});
});

describe("drawnCursor", () => {
	const pointer: CursorValue = { k: 1, via: "pointer", i: 1 };
	const key: CursorValue = { k: 2, via: "key", i: 2 };
	const sync: CursorValue = { k: 3, via: "sync", i: 3 };
	const pin: CursorValue = { k: 4, via: "pin", i: 4 };
	it("draws the live cursor, then another window's moment, then the pin", () => {
		expect(drawnCursor(pointer, sync, pin)).toBe(pointer);
		expect(drawnCursor(key, sync, pin)).toBe(key);
		expect(drawnCursor(null, sync, pin)).toBe(sync);
		expect(drawnCursor(null, null, pin)).toBe(pin);
		expect(drawnCursor(null, null, null)).toBeNull();
	});
	it("never takes a stored sync or pin as the live cursor", () => {
		expect(drawnCursor(sync, null, pin)).toBe(pin);
	});
});

describe("toggleTarget and escapeTarget", () => {
	it("pins the record under a live cursor, or goes live when it is the pinned one", () => {
		expect(toggleTarget(3, -1, false)).toBe("pin");
		// The first record in the window is pinnable, and a record equal to a stale pin index is not the pin.
		expect(toggleTarget(0, -1, false)).toBe("pin");
		expect(toggleTarget(5, 5, false)).toBe("pin");
		expect(toggleTarget(3, 5, true)).toBe("pin");
		expect(toggleTarget(5, 5, true)).toBe("live");
		expect(toggleTarget(-1, 5, true)).toBe("none");
	});
	it("goes live when pinned, clears a key cursor, and leaves Escape to the page otherwise", () => {
		expect(escapeTarget(true, null)).toBe("live");
		expect(escapeTarget(true, "key")).toBe("live");
		expect(escapeTarget(false, "key")).toBe("clear");
		expect(escapeTarget(false, "pointer")).toBe("none");
		expect(escapeTarget(false, null)).toBe("none");
	});
});

describe("frameKey", () => {
	it("changes with the filters and with the move to or from no rows, and with nothing else", () => {
		expect(frameKey('{"actors":["a"]}', false)).not.toBe(frameKey('{"actors":["b"]}', false));
		expect(frameKey("{}", false)).not.toBe(frameKey("{}", true));
		expect(frameKey("{}", false)).toBe(frameKey("{}", false));
	});
});

describe("reconcileCursor", () => {
	const rows = [0, 1, 2, 3, 4].map((i) => ({ t: T + i * 600_000, pos: 10 + i }));
	const records = {
		n: rows.length,
		pos: Int32Array.from(rows.map((r) => r.pos)),
		t: Float64Array.from(rows.map((r) => r.t)),
		cum: Float64Array.from([1, 2, 3, 4, 5]),
		hash: rows.map((r) => `h${r.pos}`),
		before: 0,
		total: 5,
		rows: 5,
		lastUndated: false,
	};
	const bucketAt = (start: number) => (t: number) => Math.floor((t - start) / 3_600_000);
	const live = (i: number, k: number): CursorValue => ({ k, via: "pointer", i });
	const next = (span = { i0: 0, i1: 4 }, start = T) => ({
		records,
		span,
		bucketOf: bucketAt(start),
	});
	it("keeps the record by position and puts it in its bucket on the new line", () => {
		// The record at position 12 was index 1 in the old model and is index 2 here.
		expect(reconcileCursor(live(1, 0), 12, next())).toEqual({ k: 0, via: "pointer", i: 2 });
	});
	it("reads the bucket against the new window, one bucket on", () => {
		// Position 14 is 40 minutes in: bucket 0 of a window starting at T, bucket 1 when it starts an hour earlier.
		expect(reconcileCursor(live(4, 0), 14, next({ i0: 0, i1: 4 }, T))?.k).toBe(0);
		expect(reconcileCursor(live(4, 0), 14, next({ i0: 0, i1: 4 }, T - 3_600_000))?.k).toBe(1);
		expect(reconcileCursor(live(4, 0), 14, next({ i0: 0, i1: 4 }, T - 7_200_000))?.k).toBe(2);
	});
	it("keeps a record sitting exactly at the span's first index", () => {
		expect(reconcileCursor(live(3, 0), 10, next({ i0: 0, i1: 4 }))).toEqual({
			k: 0,
			via: "pointer",
			i: 0,
		});
		expect(reconcileCursor(live(3, 0), 12, next({ i0: 2, i1: 4 }))?.i).toBe(2);
		expect(reconcileCursor(live(3, 0), 14, next({ i0: 4, i1: 4 }))?.i).toBe(4);
	});
	it("reads the bucket of the record itself, not of its neighbour", () => {
		// Records are ten minutes apart; with 15-minute buckets record 2 (20 min) is in bucket 1, record 1 in bucket 0.
		const quarter = { ...next(), bucketOf: (t: number) => Math.floor((t - T) / 900_000) };
		expect(reconcileCursor(live(0, 0), 12, quarter)?.k).toBe(1);
		expect(reconcileCursor(live(0, 0), 11, quarter)?.k).toBe(0);
		expect(reconcileCursor(live(0, 0), 14, quarter)?.k).toBe(2);
	});
	it("keeps the way the cursor was set", () => {
		expect(reconcileCursor({ k: 0, via: "key", i: 1 }, 11, next())?.via).toBe("key");
	});
	it("drops the cursor when its record is gone or outside the span", () => {
		expect(reconcileCursor(live(1, 0), 99, next())).toBeNull();
		expect(reconcileCursor(live(1, 0), 12, next({ i0: 3, i1: 4 }))).toBeNull();
		expect(reconcileCursor(live(1, 0), 12, next({ i0: 0, i1: 1 }))).toBeNull();
		expect(reconcileCursor(live(1, 0), 5, next())).toBeNull();
		expect(reconcileCursor(live(1, 0), undefined, next())).toBeNull();
	});
	it("has nothing to keep when the cursor is not a live one", () => {
		expect(reconcileCursor(null, 12, next())).toBeNull();
		expect(reconcileCursor({ k: 0, via: "pin", i: 1 }, 12, next())).toBeNull();
	});
});

describe("whenLine at rest with spend the time cannot name", () => {
	it("says the time is unknown when spend exists but no dated row names it", () => {
		expect(whenLine({ shown: null, pinnedNoRecord: false, lastT: null, spent: true })).toBe(
			"Live · last spend time unknown",
		);
	});
	it("says no spend only when there is none, and names a dated last spend otherwise", () => {
		expect(whenLine({ shown: null, pinnedNoRecord: false, lastT: null, spent: false })).toBe(
			"Live · no spend recorded yet",
		);
		expect(whenLine({ shown: null, pinnedNoRecord: false, lastT: T, spent: true })).toBe(
			"Live · last spend 11-07 18:00:05Z",
		);
	});
});

describe("movedTime", () => {
	it("is the new time when a kept record's time changed, null when it did not", () => {
		expect(movedTime(100, 200)).toBe(200);
		expect(movedTime(100, 100)).toBeNull();
		expect(movedTime(undefined, 200)).toBe(200);
	});
	it("is null with no readable new time", () => {
		expect(movedTime(100, undefined)).toBeNull();
		expect(movedTime(100, Number.NaN)).toBeNull();
	});
});
