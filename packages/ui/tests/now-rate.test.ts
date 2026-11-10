// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	NOW_COPY,
	weekPaceWords,
	wholeVaultProjection,
	youngPaceWords,
} from "../src/shared/now-copy.js";
import {
	HOUR_MS,
	RANGE_REACH_MS,
	RATE_HOURS,
	rateNow,
	rateWords,
	reachesBack,
} from "../src/shared/now-rate.js";
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
		const uneven = steady(48, 0).map((r, i) => ({ ...r, costUt: i % 2 === 0 ? 500 : 1500 }));
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

	it("the last hour is read against the 24 hours before it, not the whole week", () => {
		// Six days of 500 and 1,500 by turns, then a quiet day of 100 an hour.
		const rows = steady(RATE_HOURS, 0).map((r, i) => ({
			...r,
			costUt: i <= 24 ? 100 : i % 2 === 0 ? 500 : 1500,
		}));
		// Against the whole week the range would reach past 1,500, and 300 would read as normal.
		const v = rateNow(withLastHour(rows, 300), END);
		expect(v.known).toBe(true);
		expect(v.band.lo[LAST]).toBe(100);
		expect(v.band.mid[LAST]).toBe(100);
		expect(v.band.hi[LAST]).toBe(100);
		expect(v.unusual).toBe(true);
		expect(rateWords(v)).toBe(NOW_COPY.rateUnusual);
		expect(rateNow(rows, END).unusual).toBe(false);
		// The reverse: a quiet week, then a day of 500 and 1,500 by turns. 1,400 is inside that day's range.
		const busy = steady(RATE_HOURS, 0).map((r, i) => ({
			...r,
			costUt: i > 24 ? 100 : i % 2 === 0 ? 500 : 1500,
		}));
		const w = rateNow(withLastHour(busy, 1400), END);
		expect(w.band.mid[LAST]).toBe(1000);
		expect(w.band.hi[LAST]).toBe(2000);
		expect(w.unusual).toBe(false);
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

describe("reachesBack", () => {
	it("holds from a record exactly the span before the end, and not from one a millisecond after", () => {
		expect(RANGE_REACH_MS).toBe(25 * HOUR_MS);
		expect(reachesBack([llm(END - RANGE_REACH_MS, 1)], END, RANGE_REACH_MS)).toBe(true);
		expect(reachesBack([llm(END - RANGE_REACH_MS + 1, 1)], END, RANGE_REACH_MS)).toBe(false);
		expect(reachesBack([llm(END - HOUR_MS, 1), llm(END - 3 * HOUR_MS, 1)], END, 2 * HOUR_MS)).toBe(
			true,
		);
	});

	it("reads the oldest record of any kind, and is false with none or none readable", () => {
		expect(
			reachesBack(
				[llm(END - HOUR_MS, 1), llm(END - 9 * HOUR_MS, 0, { kind: "tool_use" })],
				END,
				5 * HOUR_MS,
			),
		).toBe(true);
		expect(reachesBack([], END, HOUR_MS)).toBe(false);
		expect(reachesBack([llm(END - 9 * HOUR_MS, 1, { ts: "not a time" })], END, HOUR_MS)).toBe(
			false,
		);
	});
});

describe("rateNow on a cut vault", () => {
	// 40 steady hours, then the last hour 50 times larger: far above the usual range, where one is known.
	const rows = withLastHour(steady(40, 1000), 50_000);

	it("gives no usual range when the rows do not reach back over the hours it reads, whatever they hold", () => {
		const v = rateNow(rows, END, false);
		expect(v.known).toBe(false);
		expect(v.unusual).toBe(false);
		expect(rateWords(v)).toBe(NOW_COPY.rateUnknown);
		for (const a of [v.band.mid, v.band.lo, v.band.hi]) expect(a.every(Number.isNaN)).toBe(true);
		// The hours themselves are the rows' own.
		expect(v.ratePerHourUt).toBe(50_000);
		expect(v.hours).toEqual(rateNow(rows, END).hours);
	});

	it("reads the range as before when they do, or when nothing says they are cut", () => {
		const v = rateNow(rows, END);
		expect(v.known).toBe(true);
		expect(v.unusual).toBe(true);
		expect(rateNow(rows, END, true)).toEqual(v);
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
			scopeFilteredHeld: "llm calls · filtered, rows held only",
			scopeFilteredHeldPast: "llm calls · filtered, rows held only, up to this point",
			rateHeading: "Rate now",
			rateHeadingFiltered: "Rate now · filtered",
			rateUnknown: "too little history to call",
			rateUnusual: "unusual spend rate",
			rateNormal: "normal rate",
			rateTip: "The last hour's spend against the usual range of the 24 hours before",
			rateBandNote: "The shaded band is the usual range for those hours.",
			projectionLead: "Projection:",
			projectionLeadFiltered: "Projection, whole vault:",
			projectionUsed: "Projection: the budget is already used",
			projectionIdle: "Projection: no spend in the past week, so no date",
			projectionPaceWeek: "the past week's pace",
			projectionPaceYoung: "the pace so far",
			lastRecord: "Last record",
			lastRecordFiltered: "Last record · filtered",
			integrityIntact: "hash links intact",
			integrityMonitor: "The dashboard is a monitor: usertrust verify is the authoritative check.",
			statusEmpty: "no records in this view",
		});
	});

	it("names a young vault's average by the vault's age", () => {
		expect(youngPaceWords("$0.24/day", 3)).toBe(
			"the average of $0.24/day since the first spend record, 3.0 days ago,",
		);
		expect(youngPaceWords("$1.00/day", 6.96)).toContain("7.0 days ago");
		expect(youngPaceWords("$1.00/day", 1)).toContain("1.0 days ago");
		expect(youngPaceWords("$1.00/day", 0.999)).toBe(
			"the average of $1.00/day since the first spend record, under a day ago,",
		);
		expect(weekPaceWords("$0.24/day")).toBe("the past 7 days' average of $0.24/day");
	});

	it("a projection's sentence opens by saying it is the whole vault's when the figures beside it are a filter's", () => {
		for (const sentence of [NOW_COPY.projectionUsed, NOW_COPY.projectionIdle]) {
			expect(sentence.startsWith(`${NOW_COPY.projectionLead} `)).toBe(true);
			expect(wholeVaultProjection(sentence)).toBe(
				sentence.replace("Projection:", "Projection, whole vault:"),
			);
		}
		expect(wholeVaultProjection("Projection: reaches $10.00 on 11-18 at the pace so far")).toBe(
			"Projection, whole vault: reaches $10.00 on 11-18 at the pace so far",
		);
	});

	it("the word held is said of rows only: the two labels of a filtered sum in a vault the list does not hold whole", () => {
		const held = Object.entries(NOW_COPY).filter(([, value]) => /held/i.test(value));
		expect(held.map(([key]) => key)).toEqual(["scopeFilteredHeld", "scopeFilteredHeldPast"]);
		for (const [, value] of held) {
			expect(value.split("rows held only").length - 1).toBe(1);
			expect(value.replace("rows held only", "")).not.toMatch(/held/i);
		}
		for (const value of Object.values(NOW_COPY)) expect(value).not.toMatch(/this month/i);
	});

	it("claims no cause and no check it has not made", () => {
		for (const value of Object.values(NOW_COPY))
			expect(value).not.toMatch(/runaway|loop|anomal|governor|verified|tamper-proof/i);
	});
});
