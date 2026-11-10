// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { PersistedAuditEvent } from "usertrust";
import { describe, expect, it } from "vitest";
import { TransferIndex } from "../src/server/verdicts.js";
import { breakdown } from "../src/shared/breakdown.js";
import { inWindow } from "../src/shared/cumulative.js";
import { formatUsdTotal } from "../src/shared/format.js";
import { type LedgerRow, type RowStatus, toLedgerRows } from "../src/shared/rows.js";
import { smoothRate } from "../src/shared/smooth-rate.js";
import {
	bucketPhrase,
	buildSpendModel,
	LINE_BUCKETS,
	type LineBucket,
	perShort,
	type SpendModel,
	toBucket,
} from "../src/shared/spend-model.js";
import { bucketCount, bucketSpanMs, rateOf } from "../src/shared/spend-scale.js";
import { type RangeId, rangeWindow } from "../src/shared/spend-series.js";
import { tallyStatus } from "../src/shared/status-tally.js";

const T0 = Date.UTC(2026, 10, 1);
const MIN = 60_000;
const HOUR = 3_600_000;
const WIN = { startMs: T0, endMs: T0 + 24 * HOUR };
/** The day window's own bucket. */
const DAY_B = LINE_BUCKETS["1d"];
const HOUR_B = LINE_BUCKETS["1w"];

let nextPos = 0;
function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
	const pos = nextPos++;
	return {
		seq: pos + 1,
		pos,
		id: `evt-${pos}`,
		ts: new Date(T0 + HOUR).toISOString(),
		kind: "llm_call",
		actor: "local",
		hash: `h${pos}`,
		previousHash: `h${pos - 1}`,
		integrity: "verified",
		costUt: 1,
		status: "settled",
		...overrides,
	};
}

/** A small seeded generator, so the fixture is the same on every run. */
function seeded(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
		return s / 2 ** 32;
	};
}

/** 40 rows: spend in and out of the window, annotations with a cost, a denial, mixed lanes. */
function forty(): LedgerRow[] {
	const rand = seeded(7);
	const kinds = [
		"llm_call",
		"llm_call",
		"llm_call",
		"usage_implausible",
		"tool_use",
		"policy_denied",
	];
	const out: LedgerRow[] = [];
	for (let i = 0; i < 40; i++) {
		const t = WIN.startMs - 2 * HOUR + Math.floor(rand() * 28 * HOUR);
		const kind = kinds[Math.floor(rand() * kinds.length)] as string;
		out.push(
			row({
				ts: new Date(t).toISOString(),
				kind,
				actor: `lane-${i % 3}`,
				costUt: 1 + Math.floor(rand() * 900),
			}),
		);
	}
	return out;
}

const sum = (a: ArrayLike<number>): number => {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] as number;
	return s;
};

function expectNoNaN(m: SpendModel): void {
	const nums = [
		m.bucketMs,
		m.rangeUt,
		m.peakRate,
		m.peakAt,
		m.drawnPeak,
		m.records.before,
		m.span.i0,
		m.span.i1,
		m.byStatus.settledUt,
		m.byStatus.unresolvedUt,
		m.byStatus.heldUt,
		m.byStatus.otherUt,
		...m.values,
		...m.rates,
		...m.drawn,
		...m.records.cum,
		...m.records.t,
	];
	for (const v of nums) expect(Number.isFinite(v)).toBe(true);
}

describe("buildSpendModel", () => {
	it("the buckets add up to the breakdown's total: one number", () => {
		const rows = forty();
		const m = buildSpendModel(rows, WIN, DAY_B, null);
		const total = breakdown(rows, WIN, "lane").totalUt;
		expect(total).toBeGreaterThan(0);
		expect(sum(m.values)).toBe(total);
		expect(m.rangeUt).toBe(total);
		expect(m.values.length).toBe(bucketCount(WIN, m.bucketMs));
		expect(m.bucketMs).toBe(DAY_B.ms);
		expect(m.span).toEqual(inWindow(m.records, WIN));
	});

	it("a record on startMs is counted once, a record on endMs not at all", () => {
		const rows = forty();
		const base = buildSpendModel(rows, WIN, DAY_B, null).rangeUt;
		const edged = [
			...rows,
			row({ ts: new Date(WIN.startMs).toISOString(), costUt: 10_000 }),
			row({ ts: new Date(WIN.endMs).toISOString(), costUt: 50_000 }),
		];
		const m = buildSpendModel(edged, WIN, DAY_B, null);
		expect(m.rangeUt).toBe(base + 10_000);
		expect(sum(m.values)).toBe(breakdown(edged, WIN, "lane").totalUt);
		expect(m.values[0] as number).toBeGreaterThanOrEqual(10_000);
		// The startMs record is in the span, the endMs one is not.
		expect(m.records.t[m.span.i0]).toBeGreaterThanOrEqual(WIN.startMs);
		expect(m.records.t[m.span.i1]).toBeLessThan(WIN.endMs);
	});

	it("a partial last bucket's rate divides by its real span, not the bucket", () => {
		const win = { startMs: T0, endMs: T0 + 100 * MIN };
		const rows = [
			row({ ts: new Date(T0 + 5 * MIN).toISOString(), costUt: 300 }),
			row({ ts: new Date(T0 + 90 * MIN).toISOString(), costUt: 640 }),
		];
		const m = buildSpendModel(rows, win, HOUR_B, null);
		expect(m.bucketMs).toBe(HOUR);
		expect(m.values.length).toBe(2);
		const last = m.values.length - 1;
		expect(bucketSpanMs(last, win, m.bucketMs)).toBe(40 * MIN);
		expect(m.values[last]).toBe(640);
		expect(m.rates[last]).toBe(rateOf(640, 40 * MIN));
		expect(m.rates[last]).not.toBe(rateOf(640, m.bucketMs));
		expect(m.rates[0]).toBe(rateOf(300, HOUR));
		expect(m.peakAt).toBe(last);
		expect(m.peakRate).toBe(m.rates[last]);
	});

	it("zero spend rows: all zeros, no NaN anywhere", () => {
		const rows = [
			row({ kind: "usage_implausible", costUt: 50, status: "info" }),
			row({ kind: "policy_denied", status: "denied" }),
		];
		for (const input of [rows, []]) {
			const m = buildSpendModel(input, WIN, DAY_B, null);
			expect(m.values.every((v) => v === 0)).toBe(true);
			expect(m.rates.every((v) => v === 0)).toBe(true);
			expect(m.drawn.every((v) => v === 0)).toBe(true);
			expect(m.drawnPeak).toBe(0);
			expect(m.peakRate).toBe(0);
			expect(m.peakAt).toBe(0);
			expect(m.rangeUt).toBe(0);
			expect(m.records.n).toBe(0);
			expect(m.span.i1).toBeLessThan(m.span.i0);
			expect(m.byStatus).toEqual({ settledUt: 0, unresolvedUt: 0, heldUt: 0, otherUt: 0 });
			expectNoNaN(m);
		}
	});

	it("one record: one record, the peak is its bucket", () => {
		const t = T0 + 13 * HOUR + 7 * MIN;
		const m = buildSpendModel(
			[row({ ts: new Date(t).toISOString(), costUt: 77 })],
			WIN,
			DAY_B,
			null,
		);
		expect(m.records.n).toBe(1);
		const k = Math.floor((t - WIN.startMs) / m.bucketMs);
		expect(m.peakAt).toBe(k);
		expect(m.peakRate).toBe(rateOf(77, bucketSpanMs(k, WIN, m.bucketMs)));
		expect(m.span).toEqual({ i0: 0, i1: 0 });
		expectNoNaN(m);
	});

	it("an unreadable time is not a record, is not in the range, and still feeds `before`", () => {
		const rows = [
			row({ ts: new Date(T0 + HOUR).toISOString(), costUt: 10 }),
			row({ ts: "not a date", costUt: 20 }),
		];
		const m = buildSpendModel(rows, WIN, DAY_B, 1000);
		expect(m.records.n).toBe(1);
		expect(m.records.before).toBe(1000 - 30);
		expect(m.rangeUt).toBe(10);
		expect(m.byStatus.settledUt).toBe(10);
	});
});

describe("the line's fixed buckets", () => {
	it("LINE_BUCKETS is the table: 5 min at 1D, an hour at 1W, 4 h at 1M, 6 h above", () => {
		const expected: Record<RangeId, LineBucket> = {
			"1d": { ms: 5 * MIN, per: "5 min" },
			"1w": { ms: HOUR, per: "hour" },
			"1m": { ms: 4 * HOUR, per: "4 h" },
			"3m": { ms: 6 * HOUR, per: "6 h" },
			ytd: { ms: 6 * HOUR, per: "6 h" },
			"1y": { ms: 6 * HOUR, per: "6 h" },
		};
		expect(LINE_BUCKETS).toEqual(expected);
	});

	it("a week of exactly 7 days is 168 hour buckets, whatever the plot's width", () => {
		const week = { startMs: T0, endMs: T0 + 7 * 24 * HOUR };
		const m = buildSpendModel(forty(), week, LINE_BUCKETS["1w"], null);
		expect(m.bucketMs).toBe(3_600_000);
		expect(m.values.length).toBe(168);
		expect(m.rates.length).toBe(168);
		expect(m.drawn.length).toBe(168);
	});

	it("each range's window, ending now, has the bucket count its span gives", () => {
		const now = Date.UTC(2026, 10, 9, 12);
		const counts: Array<[RangeId, number]> = [
			["1d", 288],
			["1w", 168],
			["1m", 180],
			["3m", 360],
			["1y", 1460],
		];
		for (const [range, n] of counts) {
			const m = buildSpendModel([], rangeWindow(range, now), LINE_BUCKETS[range], null);
			expect(m.bucketMs).toBe(LINE_BUCKETS[range].ms);
			expect(m.values.length).toBe(n);
		}
	});

	it("YTD's last bucket is partial and its rate reads its real span", () => {
		const now = Date.UTC(2026, 10, 9, 13, 20);
		const win = rangeWindow("ytd", now);
		const ts = new Date(now - 10 * MIN).toISOString();
		const m = buildSpendModel([row({ ts, costUt: 600 })], win, LINE_BUCKETS.ytd, null);
		const last = m.values.length - 1;
		expect(bucketSpanMs(last, win, m.bucketMs)).toBe(HOUR + 20 * MIN);
		expect(m.rates[last]).toBe(rateOf(600, HOUR + 20 * MIN));
	});

	it("toBucket turns a per-hour rate into the bucket's own spend", () => {
		expect(toBucket(120_000, LINE_BUCKETS["1d"])).toBe(10_000);
		for (const r of [0, 1, 37.5, 120_000]) expect(toBucket(r, LINE_BUCKETS["1w"])).toBe(r);
		expect(toBucket(100, LINE_BUCKETS["1m"])).toBe(400);
		expect(toBucket(100, LINE_BUCKETS["1y"])).toBe(600);
	});

	it("bucketPhrase and perShort word each bucket", () => {
		expect(["hour", "5 min", "4 h", "6 h", "day"].map(bucketPhrase)).toEqual([
			"this hour",
			"these 5 min",
			"these 4 h",
			"these 6 h",
			"this day",
		]);
		expect(["hour", "5 min", "4 h", "6 h"].map(perShort)).toEqual(["/h", "/5 min", "/4 h", "/6 h"]);
	});
});

describe("the drawn line", () => {
	// Five hour buckets, 9 UT in the middle one: rates [0, 0, 9, 0, 0] UT/h.
	const win = { startMs: T0, endMs: T0 + 5 * HOUR };
	const rows = (): LedgerRow[] => [
		row({ ts: new Date(T0 + 2 * HOUR + 30 * MIN).toISOString(), costUt: 9 }),
	];

	it("is the smoothed rates; its peak is the smoothed peak, while the true peak stays the record's", () => {
		const m = buildSpendModel(rows(), win, HOUR_B, null);
		expect([...m.rates]).toEqual([0, 0, 9, 0, 0]);
		expect([...m.drawn]).toEqual([0, 2.25, 4.5, 2.25, 0]);
		expect(m.drawnPeak).toBe(4.5);
		expect(m.peakRate).toBe(9);
		expect(m.peakAt).toBe(2);
	});

	it("smooths with the bucket's own radius: 2 at 5 min and 6 h", () => {
		const m = buildSpendModel(forty(), WIN, DAY_B, null);
		expect([...m.drawn]).toEqual([...smoothRate(m.rates, 2)]);
		const h = buildSpendModel(forty(), WIN, HOUR_B, null);
		expect([...h.drawn]).toEqual([...smoothRate(h.rates, 1)]);
		expect(h.drawnPeak).toBe(Math.max(...h.drawn));
		expect(h.drawnPeak).toBeLessThanOrEqual(h.peakRate);
	});
});

// Unresolved spend stays INSIDE spend: never held, never settled, never dropped.
describe("buildSpendModel status split", () => {
	type Spec = { kind: string; data: Record<string, unknown>; ts: number };

	function eventsOf(specs: readonly Spec[]): PersistedAuditEvent[] {
		return specs.map(
			(s, i) =>
				({
					id: `evt-${i}`,
					kind: s.kind,
					actor: "local",
					timestamp: new Date(s.ts).toISOString(),
					data: s.data,
					hash: `ev${i}`,
					previousHash: `ev${i - 1}`,
					sequence: i + 1,
				}) as unknown as PersistedAuditEvent,
		);
	}

	const AMBIGUOUS_COST = 4321;
	const HELD_COST = 250;

	/** Rows as the server builds them: every status from the transfer's verdict. Plus one held call. */
	function fixture(): { rows: LedgerRow[]; ambiguous: LedgerRow } {
		const at = (m: number): number => T0 + 2 * HOUR + m * MIN;
		const specs: Spec[] = [
			{
				kind: "llm_call",
				data: { transferId: "a", settled: true, model: "m1", cost: 1200 },
				ts: at(0),
			},
			{
				kind: "llm_call",
				data: { transferId: "b", settled: true, model: "m1", cost: 800 },
				ts: at(5),
			},
			// The ambiguity is written first, with the model and cost; then the call, not settled.
			{
				kind: "settlement_ambiguous",
				data: { transferId: "c", model: "m2", cost: AMBIGUOUS_COST, error: "post failed" },
				ts: at(9),
			},
			{
				kind: "llm_call",
				data: { transferId: "c", settled: false, model: "m2", cost: AMBIGUOUS_COST },
				ts: at(10),
			},
			{
				kind: "llm_call",
				data: { transferId: "d", settled: true, model: "m1", cost: 333 },
				ts: at(20),
			},
			// Outside the window: in no figure here.
			{
				kind: "llm_call",
				data: { transferId: "e", settled: true, model: "m1", cost: 99_999 },
				ts: WIN.endMs + HOUR,
			},
		];
		const events = eventsOf(specs);
		const index = new TransferIndex();
		index.add(events, 0);
		const rows = toLedgerRows(events, { valid: true, breakIndex: null }, index.verdictOf, 0);
		const n = rows.length;
		// No producer writes a hold yet; one is shown if it ever arrives (as status-tally reads it).
		const heldRow: LedgerRow = {
			...(rows[0] as LedgerRow),
			pos: n,
			id: `evt-${n}`,
			hash: `ev${n}`,
			ts: new Date(at(30)).toISOString(),
			costUt: HELD_COST,
			status: "held" as unknown as RowStatus,
		};
		// A spend row in no named status: counted in `otherUt`.
		const otherRow: LedgerRow = {
			...(rows[0] as LedgerRow),
			pos: n + 1,
			id: `evt-${n + 1}`,
			hash: `ev${n + 1}`,
			ts: new Date(at(40)).toISOString(),
			costUt: 17,
			status: "unknown",
		};
		const all = [...rows, heldRow, otherRow];
		const ambiguous = all.find((r) => r.kind === "llm_call" && r.settled === false) as LedgerRow;
		return { rows: all, ambiguous };
	}

	it("the fixture's unconfirmed call is classified ambiguous by the real verdict (precondition)", () => {
		const { ambiguous } = fixture();
		expect(ambiguous.status).toBe("ambiguous");
		expect(ambiguous.costUt).toBe(AMBIGUOUS_COST);
	});

	it("settled + unresolved + held + other equals the range, exactly, and to the cent", () => {
		const { rows } = fixture();
		const m = buildSpendModel(rows, WIN, DAY_B, null);
		const b = m.byStatus;
		expect(b.settledUt + b.unresolvedUt + b.heldUt + b.otherUt).toBe(m.rangeUt);
		expect(formatUsdTotal(b.settledUt + b.unresolvedUt + b.heldUt + b.otherUt)).toBe(
			formatUsdTotal(m.rangeUt),
		);
		expect(b.settledUt).toBe(1200 + 800 + 333);
		expect(b.heldUt).toBe(HELD_COST);
		expect(b.otherUt).toBe(17);
		expect(m.rangeUt).toBe(1200 + 800 + 333 + AMBIGUOUS_COST + HELD_COST + 17);
		expect(sum(m.values)).toBe(breakdown(rows, WIN, "lane").totalUt);
	});

	it("unresolved is above zero, is exactly the ambiguous call's cost, and is never held or settled", () => {
		const { rows, ambiguous } = fixture();
		const m = buildSpendModel(rows, WIN, DAY_B, null);
		expect(m.byStatus.unresolvedUt).toBeGreaterThan(0);
		expect(m.byStatus.unresolvedUt).toBe(ambiguous.costUt);
		// The ambiguity record's own cost is not spend (not an llm_call), so it is not counted twice.
		expect(m.byStatus.unresolvedUt).not.toBe(2 * AMBIGUOUS_COST);
		expect(m.byStatus.settledUt).toBe(1200 + 800 + 333);
		expect(m.byStatus.heldUt).toBe(HELD_COST);
	});

	it("dropping the unresolved call takes exactly its cost out of the range: it was inside", () => {
		const { rows, ambiguous } = fixture();
		const withIt = buildSpendModel(rows, WIN, DAY_B, null);
		const without = buildSpendModel(
			rows.filter((r) => r !== ambiguous),
			WIN,
			DAY_B,
			null,
		);
		expect(withIt.rangeUt - without.rangeUt).toBe(AMBIGUOUS_COST);
		expect(withIt.byStatus.unresolvedUt - without.byStatus.unresolvedUt).toBe(AMBIGUOUS_COST);
		expect(without.byStatus.unresolvedUt).toBe(0);
	});

	it("agrees with the status tally, status by status", () => {
		const { rows } = fixture();
		const m = buildSpendModel(rows, WIN, DAY_B, null);
		const tally = new Map(tallyStatus(rows, WIN).map((l) => [l.status as string, l.spendUt]));
		expect(m.byStatus.settledUt).toBe(tally.get("settled"));
		expect(m.byStatus.unresolvedUt).toBe(tally.get("unresolved"));
		expect(m.byStatus.heldUt).toBe(tally.get("held"));
		let rest = 0;
		for (const [s, ut] of tally) if (!["settled", "unresolved", "held"].includes(s)) rest += ut;
		expect(m.byStatus.otherUt).toBe(rest);
	});

	it("with costs that are not whole usertokens, the split still equals the range to the cent", () => {
		const costs = [0.1, 0.2, 0.7, 1234.567, 0.3, 99.99, 0.05];
		const statuses: RowStatus[] = [
			"settled",
			"ambiguous",
			"settled",
			"ambiguous",
			"unknown",
			"settled",
			"ambiguous",
		];
		const rows = costs.map((c, i) =>
			row({
				ts: new Date(T0 + (i + 1) * 7 * MIN).toISOString(),
				costUt: c,
				status: statuses[i] as RowStatus,
			}),
		);
		const m = buildSpendModel(rows, WIN, DAY_B, null);
		const b = m.byStatus;
		const split = b.settledUt + b.unresolvedUt + b.heldUt + b.otherUt;
		expect(formatUsdTotal(split)).toBe(formatUsdTotal(m.rangeUt));
		expect(Math.abs(split - m.rangeUt)).toBeLessThan(1e-9);
		expect(b.unresolvedUt).toBeCloseTo(0.2 + 1234.567 + 0.05, 9);
	});

	it("an unbounded window keeps the identity (no buckets, so nothing in either side)", () => {
		const { rows } = fixture();
		const m = buildSpendModel(rows, { startMs: 0, endMs: Number.POSITIVE_INFINITY }, DAY_B, null);
		const b = m.byStatus;
		expect(b.settledUt + b.unresolvedUt + b.heldUt + b.otherUt).toBe(m.rangeUt);
		expectNoNaN(m);
	});
});

describe("the status split at the window's edges", () => {
	it("counts a row exactly at the start and leaves out one exactly at the end", () => {
		const rows = [
			row({ ts: new Date(WIN.startMs).toISOString(), costUt: 5 }),
			row({ ts: new Date(WIN.endMs).toISOString(), costUt: 7 }),
		];
		const m = buildSpendModel(rows, WIN, DAY_B, null);
		expect(m.byStatus.settledUt).toBe(5);
		expect(m.rangeUt).toBe(5);
	});
});

describe("a spend row with no status, and rows written out of order", () => {
	it("a spend row with no status goes through the fallback and is counted as other, not settled", () => {
		const bare = row({ costUt: 9 });
		delete bare.status;
		const m = buildSpendModel([bare], WIN, DAY_B, null);
		expect(m.byStatus.otherUt).toBe(9);
		expect(m.byStatus.settledUt).toBe(0);
		expect(m.rangeUt).toBe(9);
	});
	it("span is cut on the records' running-maximum time; rangeUt and byStatus use each row's own time", () => {
		const win = { startMs: T0, endMs: T0 + 5 * MIN };
		const rows = [
			row({ ts: new Date(T0 + 10 * MIN).toISOString(), costUt: 4 }),
			row({ ts: new Date(T0 + 3 * MIN).toISOString(), costUt: 7 }),
		];
		const m = buildSpendModel(rows, win, DAY_B, null);
		expect(m.rangeUt).toBe(7);
		expect(m.byStatus.settledUt).toBe(7);
		expect(m.span.i1).toBeLessThan(m.span.i0);
	});
});
