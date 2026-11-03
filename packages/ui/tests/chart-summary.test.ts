// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Trends cost chart's text alternative: the sentence for its `aria-label` and the rows of the hidden table,
 * built by a pure function so what a screen reader is told is tested, not assumed.
 */

import { describe, expect, it, vi } from "vitest";
import { chartSummary, SUMMARY_ROW_CAP } from "../src/shared/chart-summary.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");

/** The tooltip's naming, as the component passes it. */
const dayLabel = (t: number): string => `${new Date(t).toISOString().slice(0, 10)} (UTC)`;
const hourLabel = (t: number): string =>
	`${new Date(t).toISOString().slice(0, 13).replace("T", " ")}:00Z`;

describe("chartSummary: the sentence", () => {
	it("per day: names the series, the highest bucket in dollars then UT, and its day", () => {
		const s = chartSummary(
			[
				{ t: T0, costUt: 1_500 },
				{ t: T0 + DAY, costUt: 28_000 },
				{ t: T0 + 2 * DAY, costUt: 9_000 },
			],
			"day",
			dayLabel,
		);
		expect(s.label).toBe(
			"Cost per day, 3 days with records, highest $2.8000 (28,000 UT) on 2026-11-02 (UTC)",
		);
	});

	it("per hour: says hours, and names the hour", () => {
		const s = chartSummary(
			[
				{ t: T0, costUt: 100 },
				{ t: T0 + HOUR, costUt: 700 },
			],
			"hour",
			hourLabel,
		);
		expect(s.label).toBe(
			"Cost per hour, 2 hours with records, highest $0.0700 (700 UT) on 2026-11-01 01:00Z",
		);
	});

	it("red-first ('over 60 hours' for a sparse series): it counts the buckets with records, never claims a span", () => {
		// two hours with records, five hours apart: the series has no rows for the empty hours between them
		const s = chartSummary(
			[
				{ t: T0, costUt: 100 },
				{ t: T0 + 5 * HOUR, costUt: 700 },
			],
			"hour",
			hourLabel,
		);
		expect(s.label).toBe(
			"Cost per hour, 2 hours with records, highest $0.0700 (700 UT) on 2026-11-01 05:00Z",
		);
		expect(s.label).not.toMatch(/\bover \d/);
	});

	it("one bucket reads in the singular", () => {
		const s = chartSummary([{ t: T0, costUt: 10 }], "day", dayLabel);
		expect(s.label).toBe(
			"Cost per day, 1 day with records, highest $0.0010 (10 UT) on 2026-11-01 (UTC)",
		);
	});

	it("dollars come before UT, in the sentence and in each row", () => {
		const s = chartSummary([{ t: T0, costUt: 12_345 }], "day", dayLabel);
		expect(s.label.indexOf("$1.2345")).toBeGreaterThan(-1);
		expect(s.label.indexOf("$1.2345")).toBeLessThan(s.label.indexOf("12,345 UT"));
		expect(s.rows[0]).toMatchObject({ usd: "$1.2345", ut: "12,345 UT" });
	});

	it("a tie for highest names the earliest bucket", () => {
		const s = chartSummary(
			[
				{ t: T0, costUt: 100 },
				{ t: T0 + DAY, costUt: 500 },
				{ t: T0 + 2 * DAY, costUt: 500 },
			],
			"day",
			dayLabel,
		);
		expect(s.label).toContain("on 2026-11-02 (UTC)");
		expect(s.label).not.toContain("2026-11-03");
	});

	it("an empty series reads 'No cost in view', with no rows", () => {
		const s = chartSummary([], "day", dayLabel);
		expect(s.label).toBe("No cost in view");
		expect(s.rows).toEqual([]);
		expect(s.capped).toBe(false);
		expect(s.total).toBe(0);
	});

	it("a series whose buckets all cost nothing reads 'No cost in view' too", () => {
		const s = chartSummary([{ t: T0, costUt: 0 }], "day", dayLabel);
		expect(s.label).toBe("No cost in view");
		expect(s.rows).toHaveLength(1);
	});
});

describe("chartSummary: the rows and the cap", () => {
	it("one row per bucket, oldest first, each named as the tooltip names it", () => {
		const s = chartSummary(
			[
				{ t: T0, costUt: 1 },
				{ t: T0 + DAY, costUt: 2 },
			],
			"day",
			dayLabel,
		);
		expect(s.rows.map((r) => r.label)).toEqual(["2026-11-01 (UTC)", "2026-11-02 (UTC)"]);
		expect(s.rows.map((r) => r.costUt)).toEqual([1, 2]);
		expect(s.capped).toBe(false);
		expect(s.caption).toBe("Cost per day, UTC");
	});

	it("at the cap exactly: nothing is cut and no 'newest' caption", () => {
		const series = Array.from({ length: SUMMARY_ROW_CAP }, (_, i) => ({
			t: T0 + i * HOUR,
			costUt: i + 1,
		}));
		const s = chartSummary(series, "hour", hourLabel);
		expect(s.rows).toHaveLength(SUMMARY_ROW_CAP);
		expect(s.capped).toBe(false);
		expect(s.caption).not.toContain("newest");
	});

	it("past the cap: the newest 90 are listed, the caption says 'newest 90 of N', and the sentence still covers all", () => {
		const n = 100;
		const series = Array.from({ length: n }, (_, i) => ({
			t: T0 + i * HOUR,
			// the highest bucket is among the OLDEST 10, which the table drops: the sentence must still name it
			costUt: i === 3 ? 9_999 : i + 1,
		}));
		const s = chartSummary(series, "hour", hourLabel);
		expect(SUMMARY_ROW_CAP).toBe(90);
		expect(s.rows).toHaveLength(90);
		expect(s.capped).toBe(true);
		expect(s.total).toBe(100);
		expect(s.rows[0]?.label).toBe(hourLabel(T0 + 10 * HOUR));
		expect(s.rows[89]?.label).toBe(hourLabel(T0 + 99 * HOUR));
		expect(s.caption).toBe("Cost per hour, UTC (newest 90 of 100)");
		expect(s.label).toBe(
			`Cost per hour, 100 hours with records, highest $0.9999 (9,999 UT) on ${hourLabel(T0 + 3 * HOUR)}`,
		);
	});
});

describe("counts print in one fixed locale", () => {
	it("grouped en-US digits whatever the reader's locale (review of #513, P3)", () => {
		// A browser in another locale: a bare toLocaleString() would print its digits. Make that visible.
		const real = Number.prototype.toLocaleString;
		const spy = vi.spyOn(Number.prototype, "toLocaleString").mockImplementation(function (
			this: number,
			...args: Parameters<typeof real>
		) {
			return args[0] === undefined ? "LOCAL" : real.apply(this, args);
		});
		try {
			const series = Array.from({ length: 1_200 }, (_, i) => ({
				t: Date.UTC(2023, 0, 1) + i * 86_400_000,
				costUt: i === 7 ? 50 : 0,
			}));
			const s = chartSummary(series, "day", (t) => new Date(t).toISOString().slice(0, 10));
			expect(s.label).toContain("1,200 days with records");
			expect(s.caption).toBe("Cost per day, UTC (newest 90 of 1,200)");
			expect(s.label).not.toContain("LOCAL days");
		} finally {
			spy.mockRestore();
		}
	});
});
