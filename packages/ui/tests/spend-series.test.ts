// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { breakdown } from "../src/shared/breakdown.js";
import type { LedgerRow } from "../src/shared/rows.js";
import {
	bucketCount,
	bucketIndex,
	bucketTotals,
	DEFAULT_RANGE,
	LANE_BUCKET_MS,
	lineBucketMs,
	type RangeId,
	rangeWindow,
} from "../src/shared/spend-series.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-08T12:00:00.000Z");

function row(ms: number, overrides: Partial<LedgerRow> = {}): LedgerRow {
	return {
		seq: 1,
		pos: 0,
		id: Math.random().toString(36),
		ts: new Date(ms).toISOString(),
		kind: "llm_call",
		actor: "local",
		hash: "a".repeat(64),
		previousHash: "0".repeat(64),
		integrity: "verified",
		costUt: 1,
		...overrides,
	};
}

function sum(a: Float64Array): number {
	let s = 0;
	for (const v of a) s += v;
	return s;
}

describe("rangeWindow", () => {
	it("defaults to one week", () => {
		expect(DEFAULT_RANGE).toBe("1w");
	});

	it("ends at now and has the stated length for each fixed range", () => {
		const spans: Array<[RangeId, number]> = [
			["1d", DAY],
			["1w", 7 * DAY],
			["1m", 30 * DAY],
			["3m", 90 * DAY],
			["1y", 365 * DAY],
		];
		for (const [id, span] of spans) {
			const w = rangeWindow(id, NOW);
			expect(w.endMs).toBe(NOW);
			expect(w.endMs - w.startMs).toBe(span);
		}
	});

	it("year to date starts at 1 January 00:00 UTC of now's year", () => {
		expect(rangeWindow("ytd", NOW).startMs).toBe(Date.UTC(2026, 0, 1));
		expect(rangeWindow("ytd", Date.UTC(2027, 0, 1) - 1).startMs).toBe(Date.UTC(2026, 0, 1));
		expect(rangeWindow("ytd", Date.UTC(2027, 0, 1)).startMs).toBe(Date.UTC(2027, 0, 1));
	});
});

describe("bucket sizes", () => {
	it("lanes use 1h, 4h, 12h, 1d and 7d", () => {
		expect(LANE_BUCKET_MS["1d"]).toBe(HOUR);
		expect(LANE_BUCKET_MS["1w"]).toBe(4 * 3600_000);
		expect(LANE_BUCKET_MS["1m"]).toBe(12 * HOUR);
		expect(LANE_BUCKET_MS["3m"]).toBe(DAY);
		expect(LANE_BUCKET_MS.ytd).toBe(7 * DAY);
		expect(LANE_BUCKET_MS["1y"]).toBe(7 * DAY);
	});

	it("the line has about one bucket per pixel, rounded up to a whole minute", () => {
		const win = { startMs: 0, endMs: 7 * DAY };
		const b = lineBucketMs(win, 1000);
		expect(b % 60_000).toBe(0);
		expect(b).toBeGreaterThanOrEqual((7 * DAY) / 1000);
		expect(b - (7 * DAY) / 1000).toBeLessThan(60_000);
		// a span that divides evenly keeps its size
		expect(lineBucketMs({ startMs: 0, endMs: 600 * 60_000 }, 600)).toBe(60_000);
		// a tiny span still gets a whole minute, and a zero width does not divide by zero
		expect(lineBucketMs({ startMs: 0, endMs: 1000 }, 500)).toBe(60_000);
		expect(Number.isFinite(lineBucketMs(win, 0))).toBe(true);
	});
});

describe("bucketTotals", () => {
	const START = Date.UTC(2026, 10, 1);

	it("adds up to the breakdown total over the same window", () => {
		const win = { startMs: START, endMs: START + 7 * DAY };
		const rows: LedgerRow[] = [];
		for (let i = 0; i < 60; i++) {
			rows.push(row(START - 5 * HOUR + i * 3 * HOUR + 1000 * i, { pos: i, costUt: 2 + (i % 5) }));
		}
		rows.push(row(START + HOUR, { kind: "info", costUt: 999 }));
		const total = breakdown(rows, win, "lane").totalUt;
		expect(total).toBeGreaterThan(0);
		for (const bucketMs of [HOUR, 4 * HOUR, DAY, 7 * DAY, 60_000]) {
			expect(sum(bucketTotals(rows, win, bucketMs))).toBe(total);
		}
	});

	it("has exactly ceil(span / bucket) buckets, at least one, keeping a final partial one", () => {
		const week = { startMs: START, endMs: START + 7 * DAY };
		expect(bucketTotals([], week, HOUR).length).toBe(168);
		expect(
			bucketTotals([], { startMs: START, endMs: START + 7 * DAY + 30 * 60_000 }, HOUR).length,
		).toBe(169);
		expect(bucketTotals([], { startMs: START, endMs: START }, HOUR).length).toBe(1);
	});

	it("puts a record in the partial final bucket", () => {
		const win = { startMs: START, endMs: START + 7 * DAY + 30 * 60_000 };
		const out = bucketTotals([row(START + 7 * DAY + 10 * 60_000, { costUt: 7 })], win, HOUR);
		expect(out.length).toBe(169);
		expect(out[168]).toBe(7);
		expect(sum(out)).toBe(7);
	});

	it("puts a record on a bucket boundary in the later bucket only", () => {
		const win = { startMs: START, endMs: START + 4 * HOUR };
		const out = bucketTotals([row(START + HOUR, { costUt: 5 })], win, HOUR);
		expect(Array.from(out)).toEqual([0, 5, 0, 0]);
	});

	it("counts a record at the window start and not one at the window end or before the start", () => {
		const win = { startMs: START, endMs: START + 2 * HOUR };
		const out = bucketTotals(
			[
				row(START - 1, { costUt: 100 }),
				row(START, { costUt: 3 }),
				row(START + 2 * HOUR - 1, { costUt: 4 }),
				row(START + 2 * HOUR, { costUt: 100 }),
			],
			win,
			HOUR,
		);
		expect(Array.from(out)).toEqual([3, 4]);
	});

	it("never counts an info record with a cost", () => {
		const win = { startMs: START, endMs: START + HOUR };
		expect(sum(bucketTotals([row(START + 1, { kind: "info", costUt: 50 })], win, HOUR))).toBe(0);
	});

	it("keeps only the records pick accepts", () => {
		const win = { startMs: START, endMs: START + HOUR };
		const rows = [
			row(START + 1, { actor: "ana", costUt: 2 }),
			row(START + 2, { actor: "bo", costUt: 9 }),
		];
		const out = bucketTotals(rows, win, HOUR, (r) => r.actor === "ana");
		expect(Array.from(out)).toEqual([2]);
	});

	it("returns zeros, never NaN, for a vault with no spend", () => {
		const win = { startMs: START, endMs: START + 3 * HOUR };
		const out = bucketTotals([row(START + 1, { kind: "info", costUt: 5 })], win, HOUR);
		expect(Array.from(out)).toEqual([0, 0, 0]);
		expect(out.every((v) => !Number.isNaN(v))).toBe(true);
	});
});

describe("bucketIndex", () => {
	const START = Date.UTC(2026, 10, 1);
	const win = { startMs: START, endMs: START + 4 * HOUR };
	const n = bucketCount(win, HOUR);

	it("names the bucket bucketTotals puts the record in, half-open at both ends", () => {
		expect(n).toBe(4);
		expect(bucketIndex(row(START - 1), win, HOUR, n)).toBe(-1);
		expect(bucketIndex(row(START), win, HOUR, n)).toBe(0);
		expect(bucketIndex(row(START + HOUR - 1), win, HOUR, n)).toBe(0);
		expect(bucketIndex(row(START + HOUR), win, HOUR, n)).toBe(1);
		expect(bucketIndex(row(START + 4 * HOUR - 1), win, HOUR, n)).toBe(3);
		expect(bucketIndex(row(START + 4 * HOUR), win, HOUR, n)).toBe(-1);
	});

	it("says -1 for what is not spend or has no readable time", () => {
		expect(bucketIndex(row(START + 1, { kind: "info" }), win, HOUR, n)).toBe(-1);
		const { costUt: _omit, ...noCost } = row(START + 1);
		expect(bucketIndex(noCost, win, HOUR, n)).toBe(-1);
		expect(bucketIndex(row(START + 1, { ts: "not a time" }), win, HOUR, n)).toBe(-1);
	});

	it("puts a record in the final partial bucket", () => {
		const partial = { startMs: START, endMs: START + 3 * HOUR + 10 * 60_000 };
		expect(bucketCount(partial, HOUR)).toBe(4);
		expect(bucketIndex(row(START + 3 * HOUR + 5 * 60_000), partial, HOUR, 4)).toBe(3);
	});

	it("counts one bucket for a window that cannot be bucketed", () => {
		expect(bucketCount({ startMs: -Infinity, endMs: Infinity }, HOUR)).toBe(1);
		expect(bucketCount({ startMs: START, endMs: START }, HOUR)).toBe(1);
		expect(bucketCount(win, 0)).toBe(1);
	});
});
