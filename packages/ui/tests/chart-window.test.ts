// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { chartWindow, LINE_BUCKETS } from "../src/shared/chart-window.js";
import { bucketCount, LANE_BUCKET_MS } from "../src/shared/spend-series.js";

const iso = (ms: number): string => new Date(ms).toISOString();
const at = (s: string): number => Date.parse(s);

describe("LINE_BUCKETS", () => {
	it("is 5 min, 1 h, 4 h, then 6 h at every range", () => {
		const MIN = 60_000;
		expect(LINE_BUCKETS).toEqual({
			"1d": 5 * MIN,
			"1w": 60 * MIN,
			"1m": 240 * MIN,
			"3m": 360 * MIN,
			ytd: 360 * MIN,
			"1y": 360 * MIN,
		});
	});

	it("is not the lanes' bucket", () => {
		expect(LINE_BUCKETS["1w"]).not.toBe(LANE_BUCKET_MS["1w"]);
		expect(LINE_BUCKETS["1d"]).not.toBe(LANE_BUCKET_MS["1d"]);
	});
});

describe("chartWindow", () => {
	const now = at("2026-11-10T08:48:30Z");

	it("ends at the end of the current minute and starts on a bucket mark: 1W is 169 buckets", () => {
		const w = chartWindow("1w", now, null);
		expect(iso(w.startMs)).toBe("2026-11-03T08:00:00.000Z");
		expect(iso(w.endMs)).toBe("2026-11-10T08:49:00.000Z");
		expect(bucketCount(w, LINE_BUCKETS["1w"])).toBe(169);
	});

	it("starts at the first held record's bucket when the range opens before it", () => {
		const w = chartWindow("1w", now, at("2026-11-08T10:20:00Z"));
		expect(iso(w.startMs)).toBe("2026-11-08T10:00:00.000Z");
	});

	it("ignores a first record that is older than the range's start", () => {
		const w = chartWindow("1w", now, at("2026-01-01T00:00:00Z"));
		expect(iso(w.startMs)).toBe("2026-11-03T08:00:00.000Z");
	});

	it("treats a first time that is not a number as none", () => {
		expect(chartWindow("1w", now, Number.NaN)).toEqual(chartWindow("1w", now, null));
		expect(chartWindow("1w", now, Number.POSITIVE_INFINITY)).toEqual(chartWindow("1w", now, null));
	});

	it("on the hour: 168 whole buckets and one of a minute", () => {
		const w = chartWindow("1w", at("2026-11-10T09:00:00Z"), null);
		expect(iso(w.endMs)).toBe("2026-11-10T09:01:00.000Z");
		expect(bucketCount(w, LINE_BUCKETS["1w"])).toBe(169);
		expect((w.endMs - w.startMs) % LINE_BUCKETS["1w"]).toBe(60_000);
	});

	it("1D starts on a 5-minute mark; every range starts on its own bucket mark", () => {
		const d = chartWindow("1d", now, null);
		expect(d.startMs % (5 * 60_000)).toBe(0);
		expect(iso(d.startMs)).toBe("2026-11-09T08:45:00.000Z");
		for (const r of ["1d", "1w", "1m", "3m", "ytd", "1y"] as const)
			expect(chartWindow(r, now, null).startMs % LINE_BUCKETS[r]).toBe(0);
	});

	it("YTD starts on 1 January 00:00 UTC", () => {
		expect(iso(chartWindow("ytd", now, null).startMs)).toBe("2026-01-01T00:00:00.000Z");
	});

	it("measures the span from the end, so 1D in the last minutes before a mark starts a day before the end", () => {
		const w = chartWindow("1d", at("2026-11-10T08:59:30Z"), null);
		expect(iso(w.startMs)).toBe("2026-11-09T09:00:00.000Z");
		expect(iso(w.endMs)).toBe("2026-11-10T09:00:00.000Z");
	});

	it("measures every other range's span from the end, in the last minute before a bucket mark", () => {
		const DAY = 86_400_000;
		const w = (r: "1d" | "1w" | "1m" | "3m" | "1y", days: number) => {
			const win = chartWindow(r, at("2026-11-10T23:59:30Z"), null);
			expect(iso(win.endMs)).toBe("2026-11-11T00:00:00.000Z");
			expect(win.startMs).toBe(win.endMs - days * DAY);
		};
		w("1d", 1);
		w("1w", 7);
		w("1m", 30);
		w("3m", 90);
		w("1y", 365);
	});

	it("YTD in the last minute of the year still starts on 1 January of that year", () => {
		const w = chartWindow("ytd", at("2026-12-31T23:59:30Z"), null);
		expect(iso(w.startMs)).toBe("2026-01-01T00:00:00.000Z");
		expect(iso(w.endMs)).toBe("2027-01-01T00:00:00.000Z");
	});

	it("keeps one bucket when the first record is in the current minute", () => {
		const w = chartWindow("1w", now, now);
		expect(iso(w.startMs)).toBe("2026-11-10T08:00:00.000Z");
		expect(w.startMs).toBeLessThan(w.endMs);
	});

	it("a first record exactly at the end, on a bucket mark, still leaves one bucket", () => {
		const onMark = at("2026-11-10T08:59:30Z");
		const w = chartWindow("1w", onMark, at("2026-11-10T09:00:00Z"));
		expect(iso(w.endMs)).toBe("2026-11-10T09:00:00.000Z");
		expect(iso(w.startMs)).toBe("2026-11-10T08:00:00.000Z");
	});

	it("never gives an empty window: a first record after the end falls back to the last bucket, on its mark", () => {
		const w = chartWindow("1w", now, at("2027-01-01T00:00:00Z"));
		expect(iso(w.startMs)).toBe("2026-11-10T08:00:00.000Z");
		expect(iso(w.endMs)).toBe("2026-11-10T08:49:00.000Z");
		expect(w.startMs % LINE_BUCKETS["1w"]).toBe(0);
	});
});
