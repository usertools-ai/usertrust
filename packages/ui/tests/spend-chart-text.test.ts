// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/** The Spend chart's words and key arithmetic, pure. */

import { describe, expect, it } from "vitest";
import {
	bucketOf,
	drawnCursor,
	escapeTarget,
	keyAction,
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
			whenLine({ shown: { t: T, pos: 17_951, pinned: true }, pinnedNoRecord: false, lastT: T }),
		).toBe("Pinned · 11-07 18:00:05Z · record 17,952");
	});
	it("names a hovered record without the pin's word", () => {
		expect(
			whenLine({ shown: { t: T, pos: 4, pinned: false }, pinnedNoRecord: false, lastT: T }),
		).toBe("11-07 18:00:05Z · record 5");
	});
	it("is live at rest", () => {
		expect(whenLine({ shown: null, pinnedNoRecord: false, lastT: T })).toBe(
			"Live · last spend 11-07 18:00:05Z",
		);
		expect(whenLine({ shown: null, pinnedNoRecord: false, lastT: null })).toBe(
			"Live · no spend recorded yet",
		);
	});
	it("says so for a pin with no spend at or before it", () => {
		expect(whenLine({ shown: null, pinnedNoRecord: true, lastT: T })).toBe(
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

describe("newText and plotLabel", () => {
	it("counts records added since the pin, and nothing when none were", () => {
		expect(newText(0)).toBe("");
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
