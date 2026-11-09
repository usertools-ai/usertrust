// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { PersistedAuditEvent } from "usertrust";
import { describe, expect, it } from "vitest";
import { PositionIndex } from "../src/server/position-index.js";
import { isHeaderSpend } from "../src/shared/aggregate.js";
import {
	breakRecord,
	indexAtPos,
	inWindow,
	lastAtOrBefore,
	spendRecords,
	stepIndex,
} from "../src/shared/cumulative.js";
import type { LedgerRow } from "../src/shared/rows.js";

const T0 = Date.UTC(2026, 10, 1);
const MIN = 60_000;

type Spec = { kind: string; cost?: number; ts: string };

/** The fixture, in position order from `firstPos`. */
const SPECS: readonly Spec[] = [
	{ kind: "llm_call", cost: 100, ts: new Date(T0 + 1 * MIN).toISOString() },
	{ kind: "llm_call", cost: 200, ts: new Date(T0 + 2 * MIN).toISOString() },
	// An annotation with a cost: not spend, so not a record.
	{ kind: "usage_implausible", cost: 999, ts: new Date(T0 + 3 * MIN).toISOString() },
	// Spend whose time cannot be read: not a record, but its cost is spent.
	{ kind: "llm_call", cost: 300, ts: "not a date" },
	{ kind: "llm_call", cost: 400, ts: new Date(T0 + 4 * MIN).toISOString() },
	// Written 30s out of order: earlier than the record before it.
	{ kind: "llm_call", cost: 500, ts: new Date(T0 + 4 * MIN - 30_000).toISOString() },
	{ kind: "llm_call", cost: 600, ts: new Date(T0 + 6 * MIN).toISOString() },
	{ kind: "llm_call", cost: 700, ts: new Date(T0 + 7 * MIN).toISOString() },
];
const SPEND_SUM = 100 + 200 + 300 + 400 + 500 + 600 + 700;

function rowsOf(specs: readonly Spec[], firstPos = 0): LedgerRow[] {
	return specs.map((s, i) => {
		const r: LedgerRow = {
			seq: firstPos + i + 1,
			pos: firstPos + i,
			id: `evt-${firstPos + i}`,
			ts: s.ts,
			kind: s.kind,
			actor: "local",
			hash: `h${firstPos + i}`,
			previousHash: `h${firstPos + i - 1}`,
			integrity: "verified",
		};
		if (s.cost !== undefined) r.costUt = s.cost;
		return r;
	});
}

function eventsOf(specs: readonly Spec[]): PersistedAuditEvent[] {
	return specs.map(
		(s, i) =>
			({
				id: `evt-${i}`,
				kind: s.kind,
				actor: "local",
				timestamp: s.ts,
				data: s.cost === undefined ? {} : { cost: s.cost },
				hash: `h${i}`,
				previousHash: `h${i - 1}`,
				sequence: i + 1,
			}) as unknown as PersistedAuditEvent,
	);
}

const ROWS = rowsOf(SPECS);

describe("spendRecords", () => {
	it("keeps one record per spend row with a readable time, in position order, time never decreasing", () => {
		const s = spendRecords(ROWS, null);
		expect(s.n).toBe(6);
		expect([...s.pos]).toEqual([0, 1, 4, 5, 6, 7]);
		expect(s.hash).toEqual(["h0", "h1", "h4", "h5", "h6", "h7"]);
		// The info row (pos 2) and the unreadable-time row (pos 3) are not records.
		expect([...s.pos]).not.toContain(2);
		expect([...s.pos]).not.toContain(3);
		for (let i = 1; i < s.n; i++)
			expect(s.t[i] as number).toBeGreaterThanOrEqual(s.t[i - 1] as number);
		// The out-of-order record takes the running maximum.
		expect(s.t[3]).toBe(T0 + 4 * MIN);
		expect([s.pos.length, s.t.length, s.cum.length, s.hash.length]).toEqual([6, 6, 6, 6]);
	});

	it("carries the spend older than the rows held in `before`, so the last record reads the vault total", () => {
		const s = spendRecords(ROWS, 1_000_000);
		expect(SPEND_SUM).toBeLessThan(1_000_000);
		expect(s.before).toBe(1_000_000 - SPEND_SUM);
		expect(s.cum[s.n - 1]).toBe(1_000_000);
	});

	it("with no total, `before` is 0 and the last record reads the sum of the spend rows held", () => {
		const s = spendRecords(ROWS, null);
		expect(s.before).toBe(0);
		// The unreadable-time row's cost is spent at its position, so it is in the running sum after it.
		expect(s.cum[s.n - 1]).toBe(SPEND_SUM);
	});

	it("a total smaller than the rows' sum gives `before` 0, never negative", () => {
		expect(spendRecords(ROWS, 10).before).toBe(0);
		expect(spendRecords(ROWS, 0).before).toBe(0);
	});

	it("a total that is not a finite number is treated as none: no NaN in `cum`", () => {
		const s = spendRecords(ROWS, Number.NaN);
		expect(s.before).toBe(0);
		for (const v of s.cum) expect(Number.isFinite(v)).toBe(true);
	});

	it("cumulative at a record is exact: `before` plus every spend row at or before its position", () => {
		for (const total of [null, 1_000_000] as const) {
			const s = spendRecords(ROWS, total);
			for (let i = 0; i < s.n; i++) {
				let naive = s.before;
				for (const r of ROWS)
					if (r.pos <= (s.pos[i] as number) && isHeaderSpend(r.kind, r.costUt)) naive += r.costUt;
				expect(s.cum[i]).toBe(naive);
			}
			// Before the unreadable-time row, that is the first i+1 records' costs.
			expect(s.cum[0]).toBe(s.before + 100);
			expect(s.cum[1]).toBe(s.before + 300);
		}
	});

	it("at a record pinned by position, equals the server's spent-at-position over the whole vault", () => {
		// Three older spend records the rows held do not include, then the fixture.
		const older: Spec[] = [0, 1, 2].map((i) => ({
			kind: "llm_call",
			cost: 1000,
			ts: new Date(T0 - (3 - i) * MIN).toISOString(),
		}));
		const all = [...older, ...SPECS];
		const index = new PositionIndex();
		for (const e of eventsOf(all)) index.add(e);
		const held = rowsOf(SPECS, older.length);
		const s = spendRecords(held, index.spentUtAt(index.length - 1));
		expect(s.before).toBe(3000);
		for (let i = 0; i < s.n; i++) {
			const pos = s.pos[i] as number;
			expect(indexAtPos(s, pos)).toBe(i);
			expect(s.cum[indexAtPos(s, pos)]).toBe(index.spentUtAt(pos));
		}
	});

	it("reads rows given out of position order in position order", () => {
		const shuffled = [5, 0, 7, 3, 1, 6, 2, 4].map((i) => ROWS[i] as LedgerRow);
		const a = spendRecords(ROWS, 1_000_000);
		const b = spendRecords(shuffled, 1_000_000);
		expect([...b.pos]).toEqual([...a.pos]);
		expect([...b.cum]).toEqual([...a.cum]);
		expect([...b.t]).toEqual([...a.t]);
		expect(b.hash).toEqual(a.hash);
	});

	it("no spend rows: no records, `before` is the total, nothing is NaN", () => {
		const info = rowsOf([{ kind: "usage_implausible", cost: 5, ts: SPECS[0]?.ts as string }]);
		const s = spendRecords(info, 40);
		expect(s.n).toBe(0);
		expect(s.before).toBe(40);
		expect(spendRecords([], null)).toMatchObject({ n: 0, before: 0, hash: [] });
	});

	it("tells each spend row, with its parsed time, to the optional visitor, in the same pass", () => {
		const seen: Array<[number, number]> = [];
		spendRecords(ROWS, null, (row, t) => seen.push([row.pos, t]));
		expect(seen.map(([p]) => p)).toEqual([0, 1, 3, 4, 5, 6, 7]);
		expect(Number.isNaN(seen[2]?.[1])).toBe(true);
		expect(seen[0]?.[1]).toBe(T0 + MIN);
	});
});

describe("lookups", () => {
	const s = spendRecords(ROWS, null);

	it("lastAtOrBefore: an exact time is that record; one ms before is the previous; before the first is -1", () => {
		expect(lastAtOrBefore(s, T0 + 6 * MIN)).toBe(4);
		expect(lastAtOrBefore(s, T0 + 6 * MIN - 1)).toBe(3);
		expect(lastAtOrBefore(s, T0 + MIN)).toBe(0);
		expect(lastAtOrBefore(s, T0 + MIN - 1)).toBe(-1);
		expect(lastAtOrBefore(s, T0 + 999 * MIN)).toBe(5);
		expect(lastAtOrBefore(s, Number.NaN)).toBe(-1);
		expect(lastAtOrBefore(spendRecords([], null), T0)).toBe(-1);
	});

	it("indexAtPos: the last record at or before a position; -1 before the first", () => {
		expect(indexAtPos(s, 0)).toBe(0);
		expect(indexAtPos(s, 2)).toBe(1);
		expect(indexAtPos(s, 3)).toBe(1);
		expect(indexAtPos(s, 4)).toBe(2);
		expect(indexAtPos(s, 99)).toBe(5);
		expect(indexAtPos(s, -1)).toBe(-1);
		expect(indexAtPos(s, Number.NaN)).toBe(-1);
	});

	it("inWindow is half-open: a record at startMs is in, one at endMs is out", () => {
		expect(inWindow(s, { startMs: T0 + 2 * MIN, endMs: T0 + 6 * MIN })).toEqual({ i0: 1, i1: 3 });
		const later = { startMs: T0 + 2 * MIN + 1, endMs: T0 + 6 * MIN + 1 };
		expect(inWindow(s, later)).toEqual({ i0: 2, i1: 4 });
		const none = inWindow(s, { startMs: T0 + 100 * MIN, endMs: T0 + 200 * MIN });
		expect(none.i1).toBeLessThan(none.i0);
		const empty = inWindow(spendRecords([], null), { startMs: T0, endMs: T0 + MIN });
		expect(empty.i1).toBeLessThan(empty.i0);
	});

	it("stepIndex on a span of exactly one record stays on it", () => {
		expect(stepIndex(3, 1, 1, { i0: 3, i1: 3 })).toBe(3);
		expect(stepIndex(3, -1, 1, { i0: 3, i1: 3 })).toBe(3);
	});
	it("stepIndex with a NaN step stays where it is", () => {
		expect(stepIndex(2, 1, Number.NaN, { i0: 0, i1: 5 })).toBe(2);
	});
	it("stepIndex from a NaN index reads as the span's first record, in both directions and with a NaN step too", () => {
		const span = { i0: 2, i1: 5 };
		expect(stepIndex(Number.NaN, 1, 1, span)).toBe(2);
		expect(stepIndex(Number.NaN, -1, 1, span)).toBe(2);
		expect(stepIndex(Number.NaN, 1, Number.NaN, span)).toBe(2);
		expect(stepIndex(Number.NaN, -1, Number.NaN, span)).toBe(2);
	});
	it("stepIndex from a NaN index on a span with no record is still -1", () => {
		expect(stepIndex(Number.NaN, 1, 1, { i0: 3, i1: 2 })).toBe(-1);
		expect(stepIndex(Number.NaN, -1, 1, { i0: 3, i1: 2 })).toBe(-1);
	});
	it("stepIndex from an infinite index clamps to the span's end", () => {
		const span = { i0: 2, i1: 5 };
		expect(stepIndex(Number.POSITIVE_INFINITY, 1, 1, span)).toBe(5);
		expect(stepIndex(Number.POSITIVE_INFINITY, -1, 1, span)).toBe(5);
		expect(stepIndex(Number.NEGATIVE_INFINITY, 1, 1, span)).toBe(2);
		expect(stepIndex(Number.NEGATIVE_INFINITY, -1, 1, span)).toBe(2);
	});
	it("stepIndex with a NaN step stays where it is, in both directions", () => {
		const span = { i0: 2, i1: 5 };
		expect(stepIndex(3, 1, Number.NaN, span)).toBe(3);
		expect(stepIndex(3, -1, Number.NaN, span)).toBe(3);
	});
	it("stepIndex clamps to the span", () => {
		const span = { i0: 0, i1: 5 };
		expect(stepIndex(3, 1, 10, span)).toBe(span.i1);
		expect(stepIndex(3, -1, 10, span)).toBe(span.i0);
		expect(stepIndex(3, 1, 1, span)).toBe(4);
		expect(stepIndex(3, -1, 1, span)).toBe(2);
		expect(stepIndex(0, 1, Number.POSITIVE_INFINITY, span)).toBe(5);
		expect(stepIndex(2, 1, 1, { i0: 1, i1: 2 })).toBe(2);
		// No record in the span: nothing to step to.
		expect(stepIndex(0, 1, 1, { i0: 3, i1: 2 })).toBe(-1);
	});
});

describe("breakRecord", () => {
	// Records at positions 0 1 4 5 6 7; position 3 is spend with an unreadable time, position 2 is not spend.
	const s = spendRecords(ROWS, null);
	const all = { startMs: T0, endMs: T0 + 60 * MIN };

	it("a break between two records is the first record after it", () => {
		expect(breakRecord(s, 2, all)).toBe(2);
		expect(s.pos[breakRecord(s, 2, all)]).toBe(4);
	});
	it("a break on a record is that record", () => {
		expect(breakRecord(s, 5, all)).toBe(3);
		expect(breakRecord(s, 0, all)).toBe(0);
		expect(breakRecord(s, 7, all)).toBe(5);
	});
	it("a break on the unreadable-time row between records is the next record", () => {
		expect(breakRecord(s, 3, all)).toBe(2);
	});
	it("a break past the last record is none", () => {
		expect(breakRecord(s, 8, all)).toBe(-1);
		expect(breakRecord(s, 1_000, all)).toBe(-1);
	});
	it("a break whose record is before the window is none", () => {
		const later = { startMs: T0 + 5 * MIN, endMs: T0 + 60 * MIN };
		expect(breakRecord(s, 2, later)).toBe(-1);
		expect(breakRecord(s, 6, later)).toBe(4);
	});
	it("a break whose record is exactly at the window's start is that record", () => {
		const i = breakRecord(s, 2, all);
		const edge = { startMs: s.t[i] as number, endMs: T0 + 60 * MIN };
		expect(breakRecord(s, 2, edge)).toBe(i);
	});
	it("no break, or no records, is none", () => {
		expect(breakRecord(s, null, all)).toBe(-1);
		expect(breakRecord(s, Number.NaN, all)).toBe(-1);
		expect(breakRecord(spendRecords([], null), 0, all)).toBe(-1);
	});
});
