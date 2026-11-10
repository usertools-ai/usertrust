// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { NOW_COPY } from "../src/shared/now-copy.js";
import { HOUR_MS, RATE_HOURS, rateNow, rateWords } from "../src/shared/now-rate.js";
import type { LedgerRow } from "../src/shared/rows.js";

const END = Date.UTC(2026, 10, 8, 12);
const LAST = RATE_HOURS - 1;

function llm(ts: number, costUt: number, over: Partial<LedgerRow> = {}): LedgerRow {
	return {
		seq: 1,
		pos: 0,
		id: `evt-${ts}`,
		ts: new Date(ts).toISOString(),
		kind: "llm_call",
		actor: "local",
		hash: "a".repeat(64),
		previousHash: "0".repeat(64),
		integrity: "verified",
		costUt,
		...over,
	};
}

/** One call an hour, at half past, for the `hours` hours before END. The first row is the last hour's. */
function steady(hours: number, ut: number): LedgerRow[] {
	return Array.from({ length: hours }, (_, i) => llm(END - (i + 1) * HOUR_MS + 30 * 60_000, ut));
}

/** The same, with the last hour's call costing `ut`. */
function withLastHour(rows: LedgerRow[], ut: number): LedgerRow[] {
	return [llm(END - 30 * 60_000, ut), ...rows.slice(1)];
}

describe("rateNow", () => {
	it("reads a week of hours", () => {
		expect(HOUR_MS).toBe(3_600_000);
		expect(RATE_HOURS).toBe(168);
		const v = rateNow(steady(48, 1000), END);
		expect(v.hours).toHaveLength(168);
		expect(v.band.mid).toHaveLength(168);
		expect(v.band.lo).toHaveLength(168);
		expect(v.band.hi).toHaveLength(168);
	});

	it("a steady 48 hours is a normal rate", () => {
		const v = rateNow(steady(48, 1000), END);
		expect(v.ratePerHourUt).toBe(1000);
		expect(v.known).toBe(true);
		expect(v.unusual).toBe(false);
		expect(v.band.hi[LAST]).toBe(1000);
		expect(rateWords(v)).toBe(NOW_COPY.rateNormal);
	});

	it("ten times the usual in the last hour is an unusual spend rate", () => {
		const v = rateNow(withLastHour(steady(48, 1000), 10_000), END);
		expect(v.ratePerHourUt).toBe(10_000);
		expect(v.known).toBe(true);
		expect(v.unusual).toBe(true);
		expect(rateWords(v)).toBe(NOW_COPY.rateUnusual);
	});

	it("only a rate above the usual range is unusual, not one on its edge", () => {
		expect(rateNow(withLastHour(steady(48, 1000), 1001), END).unusual).toBe(true);
		expect(rateNow(withLastHour(steady(48, 1000), 1000), END).unusual).toBe(false);
	});

	it("a rate inside a wide usual range is normal: it is read against the upper bound, not the lower", () => {
		// 500 and 1,500 by turns: a mean of 1,000 and a deviation of 500, so the range is 0 to 2,000.
		// 49 hours: the last hour is judged against the 48 before it, 24 of each.
		const uneven = steady(49, 0).map((r, i) => ({ ...r, costUt: i % 2 === 0 ? 500 : 1500 }));
		const inside = rateNow(withLastHour(uneven, 1200), END);
		expect(inside.band.lo[LAST]).toBe(0);
		expect(inside.band.mid[LAST]).toBe(1000);
		expect(inside.band.hi[LAST]).toBe(2000);
		expect(inside.known).toBe(true);
		expect(inside.unusual).toBe(false);
		expect(rateWords(inside)).toBe(NOW_COPY.rateNormal);
		expect(rateNow(withLastHour(uneven, 2000), END).unusual).toBe(false);
		expect(rateNow(withLastHour(uneven, 2001), END).unusual).toBe(true);
	});

	it("the last hour is read against the week, not only the day before it", () => {
		// Six days of 500 and 1,500 by turns, then a quiet day of 100 an hour, then an hour of 300.
		const rows = steady(RATE_HOURS, 0).map((r, i) => ({
			...r,
			costUt: i <= 24 ? 100 : i % 2 === 0 ? 500 : 1500,
		}));
		const v = rateNow(withLastHour(rows, 300), END);
		// Against the day before alone the range would be 100 to 100, and 300 would read as unusual.
		expect(v.known).toBe(true);
		expect(v.band.hi[LAST] as number).toBeGreaterThan(1500);
		expect(v.unusual).toBe(false);
		expect(rateWords(v)).toBe(NOW_COPY.rateNormal);
	});

	it("the week's history starts at the oldest hour of the week and counts all of it", () => {
		const quiet = steady(RATE_HOURS, 0);
		const oldest = quiet.map((r, i) => (i === RATE_HOURS - 1 ? { ...r, costUt: 16_700 } : r));
		// 16,700 in the oldest hour and 166 hours of nothing: a mean of 100 over the 167 hours before the last.
		expect(rateNow(oldest, END).band.mid[LAST]).toBe(100);
	});

	it("a vault 100 hours old is read against its own 99 hours, not a week padded with nothing", () => {
		const v = rateNow(steady(100, 1000), END);
		expect(v.band.mid[LAST]).toBe(1000);
		expect(v.band.hi[LAST]).toBe(1000);
		expect(v.unusual).toBe(false);
		expect(rateNow(withLastHour(steady(100, 1000), 1001), END).unusual).toBe(true);
	});

	it("a vault two hours old is too little history, however big the hour", () => {
		const v = rateNow(withLastHour(steady(2, 1000), 50_000), END);
		expect(v.ratePerHourUt).toBe(50_000);
		expect(v.known).toBe(false);
		expect(v.unusual).toBe(false);
		expect(Number.isNaN(v.band.hi[LAST])).toBe(true);
		expect(rateWords(v)).toBe(NOW_COPY.rateUnknown);
	});

	it("six hours of spend before the last hour is enough history, five is not", () => {
		const six = rateNow(withLastHour(steady(7, 1000), 50_000), END);
		expect(six.known).toBe(true);
		expect(six.unusual).toBe(true);
		const five = rateNow(withLastHour(steady(6, 1000), 50_000), END);
		expect(five.known).toBe(false);
		expect(five.unusual).toBe(false);
	});

	it("quiet hours after the first spend are history; the hours before it are not", () => {
		// Spend began more than a week ago, then nothing until the last hour: a week of real zeros.
		const old = rateNow([llm(END - 200 * HOUR_MS, 700), llm(END - 30 * 60_000, 500)], END);
		expect(old.known).toBe(true);
		expect(old.unusual).toBe(true);
		// Spend began seven hours ago, then nothing until the last hour: six real hours.
		const young = rateNow([llm(END - 7 * HOUR_MS + 1, 700), llm(END - 30 * 60_000, 500)], END);
		expect(young.known).toBe(true);
		// The first spend exactly on an hour's first instant is in that hour: still six real hours.
		const onTheHour = rateNow([llm(END - 7 * HOUR_MS, 700), llm(END - 30 * 60_000, 500)], END);
		expect(onTheHour.known).toBe(true);
		const younger = rateNow([llm(END - 6 * HOUR_MS, 700), llm(END - 30 * 60_000, 500)], END);
		expect(younger.known).toBe(false);
	});

	it("a record whose time cannot be read does not stand in for history", () => {
		const rows = [...withLastHour(steady(2, 1000), 50_000), llm(END, 9, { ts: "not a time" })];
		const v = rateNow(rows, END);
		expect(v.known).toBe(false);
		expect(v.ratePerHourUt).toBe(50_000);
	});

	it("no spend gives zero, never NaN", () => {
		const v = rateNow([], END);
		expect(v.ratePerHourUt).toBe(0);
		expect([...v.hours].every((h) => h === 0)).toBe(true);
		expect(v.known).toBe(false);
		expect(v.unusual).toBe(false);
		expect(rateWords(v)).toBe(NOW_COPY.rateUnknown);
	});

	it("the window is half-open", () => {
		const at = (ts: number): Float64Array => rateNow([llm(ts, 7)], END).hours;
		expect(at(END - HOUR_MS)[LAST]).toBe(7);
		expect(at(END - 1)[LAST]).toBe(7);
		expect([...at(END)].every((h) => h === 0)).toBe(true);
		expect(at(END - RATE_HOURS * HOUR_MS)[0]).toBe(7);
		expect([...at(END - RATE_HOURS * HOUR_MS - 1)].every((h) => h === 0)).toBe(true);
	});

	it("only spend-bearing rows count", () => {
		const other = steady(48, 1000).map((r) => ({ ...r, kind: "usage_implausible" }));
		const v = rateNow(other, END);
		expect(v.ratePerHourUt).toBe(0);
		expect([...v.hours].every((h) => h === 0)).toBe(true);
		expect(v.known).toBe(false);
	});
});

describe("rateWords", () => {
	const view = (known: boolean, unusual: boolean) => ({ ...rateNow([], END), known, unusual });

	it("says too little history before anything else", () => {
		expect(rateWords(view(false, true))).toBe("too little history to call");
		expect(rateWords(view(true, true))).toBe("unusual spend rate");
		expect(rateWords(view(true, false))).toBe("normal rate");
	});
});

describe("NOW_COPY", () => {
	it("holds the window's sentences, word for word", () => {
		expect(NOW_COPY).toStrictEqual({
			scopeVault: "whole vault",
			scopeFiltered: "llm calls · filtered",
			scopeFilteredPast: "llm calls · filtered, up to this point",
			rateUnknown: "too little history to call",
			rateUnusual: "unusual spend rate",
			rateNormal: "normal rate",
			rateTip: "The last hour's spend against the usual range of the past week",
			rateBandNote: "The shaded band is the usual range for those hours.",
			projectionUsed: "Projection: the budget is already used",
			projectionIdle: "Projection: no spend in the past week, so no date",
			integrityIntact: "hash links intact",
			integrityMonitor: "The dashboard is a monitor: usertrust verify is the authoritative check.",
			statusEmpty: "no records in this view",
		});
	});

	it("claims no cause and no check it has not made", () => {
		for (const value of Object.values(NOW_COPY))
			expect(value).not.toMatch(/runaway|loop|anomal|governor|verified|tamper-proof/i);
	});
});
