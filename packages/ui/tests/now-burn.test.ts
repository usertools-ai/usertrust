// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import type { SummaryPayload } from "../src/shared/api.js";
import { monthBurn, projectionOf } from "../src/shared/now-burn.js";
import { NOW_COPY } from "../src/shared/now-copy.js";
import type { LedgerRow } from "../src/shared/rows.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const END = Date.UTC(2026, 10, 8, 12);
const MONTH = Date.UTC(2026, 10, 1);

function llm(ts: number, costUt: number, over: Partial<LedgerRow> = {}): LedgerRow {
	return {
		seq: 1,
		pos: 0,
		id: `evt-${ts}-${costUt}`,
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

/** 100 UT on day 1, 200 on day 2 ... 800 on day 8, each at 06:00 UTC, and 5,000 the day before the month. */
const MONTH_ROWS = [
	llm(MONTH - 14 * HOUR, 5000),
	...Array.from({ length: 8 }, (_, i) => llm(MONTH + i * DAY + 6 * HOUR, 100 * (i + 1))),
];

describe("monthBurn", () => {
	it("starts at the vault's spend before the month and ends at the header spend", () => {
		const b = monthBurn(MONTH_ROWS, END, 10_000);
		expect(b.days).toBe(30);
		expect(b.inMonthUt).toBe(3600);
		expect(b.startUt).toBe(6400);
		expect(b.pts).toEqual([6500, 6700, 7000, 7400, 7900, 8500, 9200, 10_000]);
		expect(b.pts).toHaveLength(new Date(END).getUTCDate());
	});

	it("projects the month's end at the past week's pace", () => {
		const b = monthBurn(MONTH_ROWS, END, 10_000);
		// The week is [1 Nov 12:00, 8 Nov 12:00): days 2 to 8, 3,500 UT. 22.5 days are left of the month.
		expect(b.paceUtPerDay).toBe(500);
		expect(b.endUt).toBe(10_000 + 500 * 22.5);
	});

	it("starts at 0 when filtered, and never below 0", () => {
		const filtered = monthBurn(MONTH_ROWS, END, null);
		expect(filtered.startUt).toBe(0);
		expect(filtered.pts).toEqual([100, 300, 600, 1000, 1500, 2100, 2800, 3600]);
		expect(filtered.endUt).toBe(3600 + 500 * 22.5);
		expect(monthBurn(MONTH_ROWS, END, 3599).startUt).toBe(0);
		expect(monthBurn(MONTH_ROWS, END, 3601).startUt).toBe(1);
	});

	it("puts a record on a day's first instant in that day, and one at the end in none", () => {
		const rows = [llm(MONTH - 1, 1), llm(MONTH, 2), llm(MONTH + DAY - 1, 4), llm(MONTH + DAY, 8)];
		const b = monthBurn([...rows, llm(MONTH + 2 * DAY + HOUR, 16)], MONTH + 2 * DAY + HOUR, null);
		expect(b.pts).toEqual([6, 14, 14]);
		expect(b.inMonthUt).toBe(14);
	});

	it("the week's pace is half-open", () => {
		const pace = (ts: number): number => monthBurn([llm(ts, 700)], END, null).paceUtPerDay;
		expect(pace(END - 7 * DAY)).toBe(100);
		expect(pace(END - 7 * DAY - 1)).toBe(0);
		// A record a millisecond old: the vault is under a day old, so the pace is over one day.
		expect(pace(END - 1)).toBe(700);
		expect(pace(END)).toBe(0);
	});

	it("a vault younger than a week is paced over its own age, never under a day", () => {
		const b = (ageMs: number, ut: number) => monthBurn([llm(END - ageMs, ut)], END, null);
		expect(b(DAY, 2400).paceUtPerDay).toBe(2400);
		expect(b(DAY, 2400).endUt).toBe(2400 + 2400 * 22.5);
		expect(b(3 * DAY, 2400).paceUtPerDay).toBe(800);
		expect(b(3 * DAY, 2400).endUt).toBe(2400 + 800 * 22.5);
		expect(b(7 * DAY, 2400).paceUtPerDay).toBe(2400 / 7);
		expect(b(7 * DAY - HOUR, 167).paceUtPerDay).toBeCloseTo(24, 9);
		// Under 24 hours the pace is the spend so far over one day, not over the hours seen.
		expect(b(DAY - 1, 2400).paceUtPerDay).toBe(2400);
		expect(b(HOUR, 2400).paceUtPerDay).toBe(2400);
	});

	it("the vault's age is read from its first spend record, whenever the rest came", () => {
		const first = llm(END - 3 * DAY, 300);
		const later = llm(END - HOUR, 900);
		expect(monthBurn([later, first], END, null).paceUtPerDay).toBe(400);
		// A record that carries no spend, or no readable time, does not age the vault.
		const noSpend = llm(END - 6 * DAY, 0, { kind: "tool_use" });
		const noTime = llm(END - 6 * DAY, 0, { ts: "not a time" });
		expect(monthBurn([noSpend, noTime, later, first], END, null).paceUtPerDay).toBe(400);
		// The same with real spend on the unreadable record, and that record last: the age is still three days.
		const lost = llm(END - 6 * DAY, 50, { ts: "not a time" });
		expect(monthBurn([later, first, lost], END, null).paceUtPerDay).toBe(400);
		// A first record older than the week leaves the week whole.
		expect(monthBurn([llm(END - 30 * DAY, 1), later, first], END, null).paceUtPerDay).toBe(
			1200 / 7,
		);
	});

	it("spend with no readable time, or dated at or after the end, is drawn as spent before the month", () => {
		const noTime = llm(END - DAY, 50, { ts: "not a time" });
		const atEnd = llm(END, 70);
		const b = monthBurn([...MONTH_ROWS, noTime, atEnd], END, 10_120);
		expect(b.inMonthUt).toBe(3600);
		expect(b.startUt).toBe(6520);
		expect(b.pts).toEqual([6620, 6820, 7120, 7520, 8020, 8620, 9320, 10_120]);
	});

	it("has one point per UTC day begun, the day that has only begun included", () => {
		expect(monthBurn(MONTH_ROWS, MONTH, 10_000).pts).toEqual([10_000]);
		const midnight = monthBurn(MONTH_ROWS, MONTH + 7 * DAY, null);
		expect(midnight.pts).toEqual([100, 300, 600, 1000, 1500, 2100, 2800, 2800]);
		expect(monthBurn([], Date.UTC(2026, 10, 30, 23), null).pts).toHaveLength(30);
	});

	it("knows the month's length, and December ends in January", () => {
		expect(monthBurn([], Date.UTC(2027, 1, 10), null).days).toBe(28);
		const end = Date.UTC(2026, 11, 31, 12);
		const dec = monthBurn([llm(end - HOUR, 1400)], end, null);
		expect(dec.days).toBe(31);
		expect(dec.pts).toHaveLength(31);
		// The vault is an hour old: its pace is over one day.
		expect(dec.paceUtPerDay).toBe(1400);
		expect(dec.endUt).toBe(1400 + 1400 * 0.5);
	});

	it("never decreases, and is flat with no spend", () => {
		const b = monthBurn(MONTH_ROWS, END, 10_000);
		for (let i = 1; i < b.pts.length; i++)
			expect(b.pts[i] as number).toBeGreaterThanOrEqual(b.pts[i - 1] as number);
		const idle = monthBurn([], END, 250);
		expect(idle.pts).toEqual(new Array(8).fill(250));
		expect(idle.paceUtPerDay).toBe(0);
		expect(idle.endUt).toBe(250);
	});

	it("only spend-bearing records count", () => {
		const rows = MONTH_ROWS.map((r) => ({ ...r, kind: "tool_use" }));
		expect(monthBurn(rows, END, null)).toMatchObject({ inMonthUt: 0, paceUtPerDay: 0, endUt: 0 });
	});
});

function summary(over: Partial<SummaryPayload> = {}): SummaryPayload {
	return {
		vaultPath: "/v/.usertrust",
		budget: 100_000,
		budgetSource: "config",
		budgetWrittenAt: null,
		budgetProvenance: "from the vault config",
		spentUt: 76_000,
		remainingUt: 24_000,
		chain: { events: 3, valid: true, empty: false, breakIndex: null, errors: [] },
		anchorFile: "absent",
		remote: { kit: false },
		rowCount: 3,
		truncated: false,
		verifiedAt: null,
		...over,
	};
}

/** `ut` a day for the seven days before END, the first exactly a week before it. */
function week(ut: number): LedgerRow[] {
	return Array.from({ length: 7 }, (_, i) => llm(END - (i + 1) * DAY, ut));
}

describe("projectionOf", () => {
	it("100 UT a day against 1,000 UT left reaches the budget in ten days", () => {
		const p = projectionOf(summary({ remainingUt: 1000 }), week(100), END);
		expect(p?.text).toContain("reaches");
		expect(p?.text).toContain("11-18");
	});

	it("names the budget, the day and the pace it assumes", () => {
		expect(projectionOf(summary(), week(2400), END)).toStrictEqual({
			text: "Projection: reaches $10.00 on 11-18 at the past week's pace",
			title:
				"A projection, not a forecast: it assumes the past 7 days' average of $0.24/day holds. Budget: from the vault config",
		});
	});

	it("names a small pace by the day, where an hourly figure would round to nothing", () => {
		// 12 UT a day is half a UT an hour.
		expect(projectionOf(summary(), week(12), END)?.title).toBe(
			"A projection, not a forecast: it assumes the past 7 days' average of $0.0012/day holds. Budget: from the vault config",
		);
	});

	it("a vault a day old reaches the budget at its own pace, not a seventh of it", () => {
		const p = projectionOf(summary({ remainingUt: 24_000 }), [llm(END - DAY, 2400)], END);
		expect(p).toStrictEqual({
			text: "Projection: reaches $10.00 on 11-18 at the pace so far",
			title:
				"A projection, not a forecast: it assumes the average of $0.24/day since the first spend record, 1.0 days ago, holds. Budget: from the vault config",
		});
	});

	it("a vault three days old is paced over three days", () => {
		const rows = [llm(END - 3 * DAY, 3600), llm(END - HOUR, 3600)];
		const p = projectionOf(summary({ remainingUt: 24_000 }), rows, END);
		expect(p?.text).toBe("Projection: reaches $10.00 on 11-18 at the pace so far");
		expect(p?.title).toContain(
			"the average of $0.24/day since the first spend record, 3.0 days ago, holds",
		);
	});

	it("a vault exactly a week old is read as a week", () => {
		const p = projectionOf(summary({ remainingUt: 24_000 }), [llm(END - 7 * DAY, 16_800)], END);
		expect(p?.text).toBe("Projection: reaches $10.00 on 11-18 at the past week's pace");
		expect(p?.title).toContain("the past 7 days' average of $0.24/day holds");
		const younger = projectionOf(summary(), [llm(END - 7 * DAY + 1, 16_800)], END);
		expect(younger?.text).toContain("at the pace so far");
	});

	it("under 24 hours of history gives no line: one day's spend is too little to date a budget by", () => {
		expect(projectionOf(summary(), [llm(END - DAY + 1, 2400)], END)).toBeNull();
		expect(projectionOf(summary(), [llm(END - HOUR, 2400)], END)).toBeNull();
		expect(projectionOf(summary(), [llm(END - DAY, 2400)], END)).not.toBeNull();
		// No spend is said before too little history: a first spend record that cost nothing gives the idle line.
		expect(projectionOf(summary(), [llm(END - HOUR, 0)], END)?.text).toBe(NOW_COPY.projectionIdle);
		// A budget already used is a fact, not a projection: it is said at any age.
		const used = projectionOf(summary({ remainingUt: 0 }), [llm(END - HOUR, 2400)], END);
		expect(used).toStrictEqual({
			text: NOW_COPY.projectionUsed,
			title:
				"A projection, not a forecast: it assumes the average of $0.24/day since the first spend record, under a day ago, holds. Budget: from the vault config",
		});
	});

	it("reads the pace from the week before the end, half-open", () => {
		const rows = [llm(END - 7 * DAY - 1, 99_999), llm(END - 7 * DAY, 16_800), llm(END, 99_999)];
		expect(projectionOf(summary(), rows, END)?.text).toContain("on 11-18");
	});

	it("a budget with nothing left is already used", () => {
		const title =
			"A projection, not a forecast: it assumes the past 7 days' average of $0.24/day holds. Budget: from the vault config";
		for (const remainingUt of [-5, 0])
			expect(projectionOf(summary({ remainingUt }), week(2400), END)).toStrictEqual({
				text: NOW_COPY.projectionUsed,
				title,
			});
		expect(projectionOf(summary({ remainingUt: 1 }), week(2400), END)?.text).toContain("reaches");
	});

	it("a used-up budget says so even with no spend in the past week", () => {
		expect(projectionOf(summary({ remainingUt: 0 }), [], END)?.text).toBe(NOW_COPY.projectionUsed);
		expect(projectionOf(summary({ remainingUt: -5 }), [], END)?.text).toBe(NOW_COPY.projectionUsed);
	});

	it("no spend in the past week gives no date", () => {
		expect(projectionOf(summary(), [llm(END - 8 * DAY, 500)], END)).toStrictEqual({
			text: NOW_COPY.projectionIdle,
			title:
				"A projection, not a forecast: it assumes the past 7 days' average of $0.00/day holds. Budget: from the vault config",
		});
		// A vault with no spend record before the end has no age to name.
		for (const rows of [[], [llm(END, 500)], [llm(END + DAY, 500)]])
			expect(projectionOf(summary(), rows, END)).toStrictEqual({
				text: NOW_COPY.projectionIdle,
				title:
					"A projection, not a forecast: it assumes the past 7 days' average of $0.00/day holds. Budget: from the vault config",
			});
	});

	it("an unknown budget, or no summary, gives no line", () => {
		const unknown = summary({ budget: null, remainingUt: null, budgetSource: "several" });
		expect(projectionOf(unknown, week(2400), END)).toBeNull();
		expect(projectionOf(null, week(2400), END)).toBeNull();
	});

	it("a controller's record gives its age, never the word enforced", () => {
		const s = summary({
			budgetSource: "governor",
			budgetWrittenAt: new Date(END - 12 * 60_000).toISOString(),
			budgetProvenance: "enforced by the controller",
		});
		const p = projectionOf(s, week(2400), END);
		expect(p?.title.endsWith("holds. Budget: recorded 12 min ago")).toBe(true);
		expect(p?.title).not.toContain("enforced");
	});

	it("a date a year or more away carries its year", () => {
		const at = (days: number): string | undefined =>
			projectionOf(summary({ remainingUt: 2400 * days }), week(2400), END)?.text;
		expect(at(364)).toBe("Projection: reaches $10.00 on 11-07 at the past week's pace");
		expect(at(365)).toBe("Projection: reaches $10.00 on 2027-11-08 at the past week's pace");
		expect(at(400)).toContain("on 2027-12-13 at");
	});

	it("a date past the calendar gives no line rather than a wrong one", () => {
		expect(projectionOf(summary({ remainingUt: 1e18 }), week(2400), END)).toBeNull();
	});

	it("no sentence promises or claims a check", () => {
		const all = [
			projectionOf(summary(), week(2400), END),
			projectionOf(summary({ remainingUt: 0 }), week(2400), END),
			projectionOf(summary(), [], END),
		];
		for (const p of all) {
			expect(p).not.toBeNull();
			expect(`${p?.text} ${p?.title}`).not.toMatch(/\bwill\b|verified/i);
		}
	});
});
