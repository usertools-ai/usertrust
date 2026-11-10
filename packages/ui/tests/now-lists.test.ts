// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { breakdown } from "../src/shared/breakdown.js";
import {
	lastRecord,
	latestRecords,
	periodDelta,
	periodsOf,
	spendUpTo,
	topRows,
} from "../src/shared/now-lists.js";
import type { LedgerRow } from "../src/shared/rows.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const END = Date.UTC(2026, 10, 8, 12);
const MONTH = Date.UTC(2026, 10, 1);
const ALL = { startMs: -Infinity, endMs: Infinity };

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

/** One record on each edge of every period, each with its own power of two, so a sum names its records. */
const EDGES = [
	llm(END, 1),
	llm(END - 1, 2),
	llm(END - HOUR, 4),
	llm(END - HOUR - 1, 8),
	llm(END - 2 * HOUR, 16),
	llm(END - 2 * HOUR - 1, 32),
	llm(END - DAY, 64),
	llm(END - DAY - 1, 128),
	llm(END - 2 * DAY, 256),
	llm(END - 2 * DAY - 1, 512),
	llm(END - 3 * DAY, 1024),
	llm(END - 3 * DAY - 1, 2048),
	llm(END - 6 * DAY, 4096),
	llm(END - 6 * DAY - 1, 8192),
	llm(MONTH, 16_384),
	llm(MONTH - 1, 32_768),
];

describe("periodsOf", () => {
	it("names four periods, in order", () => {
		expect(periodsOf([], END)).toStrictEqual([
			{ id: "hour", label: "Last hour", spendUt: 0, prevUt: 0 },
			{ id: "day", label: "Last 24 h", spendUt: 0, prevUt: 0 },
			{ id: "three-days", label: "Last 3 days", spendUt: 0, prevUt: 0 },
			{ id: "month", label: "This month", spendUt: 0, prevUt: null },
		]);
	});

	it("every period and the period before it are half-open at both ends", () => {
		const [hour, day, three, month] = periodsOf(EDGES, END);
		expect(hour).toMatchObject({ spendUt: 2 + 4, prevUt: 8 + 16 });
		expect(day).toMatchObject({ spendUt: 126, prevUt: 128 + 256 });
		expect(three).toMatchObject({ spendUt: 2046, prevUt: 2048 + 4096 });
		// The month: its first instant counts, the millisecond before does not, and neither does a record at the end.
		expect(month).toMatchObject({ spendUt: 16_382 + 16_384, prevUt: null });
	});

	it("the day period equals the breakdown of the same window", () => {
		const day = periodsOf(EDGES, END)[1];
		expect(day?.spendUt).toBe(breakdown(EDGES, { startMs: END - DAY, endMs: END }, "kind").totalUt);
	});

	it("the month is the UTC month of the end", () => {
		const end = Date.UTC(2027, 0, 1, 2);
		const rows = [llm(Date.UTC(2027, 0, 1, 1), 5), llm(Date.UTC(2026, 11, 31, 23), 70)];
		expect(periodsOf(rows, end)[3]?.spendUt).toBe(5);
	});

	it("only spend-bearing records with a readable time count", () => {
		const rows = [
			llm(END - 1, 5, { kind: "tool_use" }),
			llm(END - 1, 5, { ts: "not a time" }),
			{ ...llm(END - 1, 0), costUt: undefined } as unknown as LedgerRow,
		];
		for (const p of periodsOf(rows, END)) expect(p.spendUt).toBe(0);
	});
});

describe("periodDelta", () => {
	it("a rise is a plus and a whole percent, with the period before in its title", () => {
		expect(periodDelta({ spendUt: 150, prevUt: 100 })).toStrictEqual({
			text: "+50% vs before",
			title: "the period before: $0.01",
		});
		expect(periodDelta({ spendUt: 400, prevUt: 300 }).text).toBe("+33% vs before");
	});

	it("a drop is a minus sign, not a hyphen", () => {
		const minus = String.fromCharCode(0x2212);
		expect(periodDelta({ spendUt: 50, prevUt: 100 }).text).toBe(`${minus}50% vs before`);
		expect(periodDelta({ spendUt: 0, prevUt: 100 }).text).toBe(`${minus}100% vs before`);
	});

	it("a change that rounds to 0 carries no sign, in either direction", () => {
		expect(periodDelta({ spendUt: 100, prevUt: 100 }).text).toBe("0% vs before");
		expect(periodDelta({ spendUt: 996, prevUt: 1000 }).text).toBe("0% vs before");
		expect(periodDelta({ spendUt: 1004, prevUt: 1000 }).text).toBe("0% vs before");
		expect(periodDelta({ spendUt: 990, prevUt: 1000 }).text).toBe(
			`${String.fromCharCode(0x2212)}1% vs before`,
		);
		expect(periodDelta({ spendUt: 1010, prevUt: 1000 }).text).toBe("+1% vs before");
	});

	it("nothing before has no percent", () => {
		expect(periodDelta({ spendUt: 150, prevUt: 0 })).toStrictEqual({
			text: "vs nothing before",
			title: "the period before: $0.00",
		});
	});

	it("the month has no period before", () => {
		expect(periodDelta({ spendUt: 150, prevUt: null })).toStrictEqual({
			text: "records this month",
			title: null,
		});
	});
});

describe("topRows", () => {
	const lanes = (costs: number[]): LedgerRow[] =>
		costs.map((c, i) => llm(END - 1, c, { actor: `lane-${i}` }));

	it("rel is 1 for the first and at most 1", () => {
		const out = topRows(breakdown(lanes([150, 300, 75]), ALL, "lane"));
		expect(out).toStrictEqual([
			{ key: "lane-1", spendUt: 300, rel: 1 },
			{ key: "lane-0", spendUt: 150, rel: 0.5 },
			{ key: "lane-2", spendUt: 75, rel: 0.25 },
		]);
	});

	it("keeps six rows unless told otherwise", () => {
		const bd = breakdown(lanes([8, 7, 6, 5, 4, 3, 2]), ALL, "lane");
		expect(topRows(bd).map((r) => r.spendUt)).toEqual([8, 7, 6, 5, 4, 3]);
		expect(topRows(bd, 2).map((r) => r.spendUt)).toEqual([8, 7]);
	});

	it("an empty breakdown gives [], and rel is 0 when the largest is 0", () => {
		expect(topRows(breakdown([], ALL, "lane"))).toEqual([]);
		expect(topRows(breakdown(lanes([0, 0]), ALL, "lane"))).toStrictEqual([
			{ key: "lane-0", spendUt: 0, rel: 0 },
			{ key: "lane-1", spendUt: 0, rel: 0 },
		]);
	});
});

describe("latestRecords and lastRecord", () => {
	/** 25 records whose array order is not their position order. */
	const rows = Array.from({ length: 25 }, (_, i) => llm(END - i, 1, { pos: (i * 7) % 25 }));

	it("latestRecords is newest first and capped at 20", () => {
		const before = rows.map((r) => r.pos);
		const out = latestRecords(rows);
		expect(out.map((r) => r.pos)).toEqual(Array.from({ length: 20 }, (_, i) => 24 - i));
		expect(latestRecords(rows, 3).map((r) => r.pos)).toEqual([24, 23, 22]);
		expect(rows.map((r) => r.pos)).toEqual(before);
		expect(latestRecords([])).toEqual([]);
	});

	it("lastRecord picks the greatest pos, not the last in the array", () => {
		expect(lastRecord(rows)?.pos).toBe(24);
		expect(rows[rows.length - 1]?.pos).not.toBe(24);
		expect(rows[0]?.pos).not.toBe(24);
		expect(lastRecord([])).toBeNull();
	});
});

describe("spendUpTo", () => {
	const rows = [
		llm(END - 3, 1, { pos: 4 }),
		llm(END - 2, 2, { pos: 5 }),
		llm(END - 1, 4, { pos: 6 }),
		llm(END - 2, 64, { pos: 5, kind: "tool_use" }),
	];

	it("counts the record at the position and those before it", () => {
		expect(spendUpTo(rows, 5)).toBe(3);
		expect(spendUpTo(rows, 3)).toBe(0);
	});

	it("counts every spend record when there is no position", () => {
		expect(spendUpTo(rows, null)).toBe(7);
		expect(spendUpTo([], null)).toBe(0);
	});
});
