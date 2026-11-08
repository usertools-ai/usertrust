// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it, vi } from "vitest";
import { isHeaderSpend } from "../src/shared/aggregate.js";
import {
	type Breakdown,
	breakdown,
	categoryRows,
	type Dimension,
	keyOf,
	shareBands,
	spendInWindow,
	WHOLE_VAULT,
} from "../src/shared/breakdown.js";
import type { LedgerRow } from "../src/shared/rows.js";
import { bucketTotals } from "../src/shared/spend-series.js";

const T0 = Date.parse("2026-07-27T00:00:00.000Z");
const HOUR = 3_600_000;
const WIN = { startMs: T0, endMs: T0 + 24 * HOUR };
const DIMS: Dimension[] = ["lane", "role", "model", "kind", "provider"];

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
	return {
		seq: 1,
		pos: 0,
		id: Math.random().toString(36),
		ts: new Date(T0 + HOUR).toISOString(),
		kind: "llm_call",
		actor: "local",
		hash: "a".repeat(64),
		previousHash: "0".repeat(64),
		integrity: "verified",
		costUt: 1,
		...overrides,
	};
}

const ACTORS = ["ana", "bo", "cy", "dee"];
const MODELS = ["claude-sonnet-4-6", "gpt-5", "grok-4.7", "gemini-2", undefined];
const JOB_TYPES = ["feature", "bugfix", undefined];

/** 40 rows inside the window, plus an info row with a cost and a row outside it. */
function fixture(): LedgerRow[] {
	const rows: LedgerRow[] = [];
	for (let i = 0; i < 40; i++) {
		const model = MODELS[i % MODELS.length];
		const jobType = JOB_TYPES[i % JOB_TYPES.length];
		rows.push(
			row({
				pos: i,
				ts: new Date(T0 + (i % 23) * HOUR + 1000 * i).toISOString(),
				actor: ACTORS[i % ACTORS.length] as string,
				costUt: 3 + (i % 7),
				...(model === undefined ? {} : { model }),
				...(jobType === undefined ? {} : { jobType }),
			}),
		);
	}
	rows.push(row({ pos: 40, kind: "info", costUt: 999 }));
	rows.push(row({ pos: 41, ts: new Date(T0 + 30 * HOUR).toISOString(), costUt: 999 }));
	return rows;
}

function sumOf(b: Breakdown): number {
	let s = 0;
	for (const v of b.byKey.values()) s += v.spendUt;
	return s;
}

describe("keyOf", () => {
	it("reads each dimension from the row", () => {
		const r = row({ actor: "ana", jobType: "docs", model: "grok-4.7", kind: "llm_call" });
		expect(keyOf("lane", r)).toBe("ana");
		expect(keyOf("role", r)).toBe("docs");
		expect(keyOf("model", r)).toBe("grok-4.7");
		expect(keyOf("kind", r)).toBe("llm_call");
		expect(keyOf("provider", r)).toBe("xAI");
	});

	it("names a row with no model and no job type", () => {
		const r = row();
		expect(keyOf("model", r)).toBe("unknown");
		expect(keyOf("role", r)).toBe("untyped");
	});
});

describe("breakdown", () => {
	it("is one number per thing: every dimension sums to the same total", () => {
		const rows = fixture();
		const totals = DIMS.map((dim) => {
			const b = breakdown(rows, WIN, dim);
			expect(sumOf(b)).toBe(b.totalUt);
			let calls = 0;
			for (const v of b.byKey.values()) calls += v.calls;
			expect(calls).toBe(b.calls);
			expect([...b.byKey.keys()].sort()).toEqual([...b.keys].sort());
			return b.totalUt;
		});
		expect(totals[0]).toBeGreaterThan(0);
		expect(new Set(totals).size).toBe(1);
		expect(breakdown(rows, WIN, "lane").calls).toBe(40);
	});

	it("counts exactly what the header counts as spend, in the window", () => {
		const rows = fixture();
		const want = rows
			.filter((r) => isHeaderSpend(r.kind, r.costUt))
			.filter((r) => {
				const t = Date.parse(r.ts);
				return t >= WIN.startMs && t < WIN.endMs;
			})
			.reduce((s, r) => s + (r.costUt ?? 0), 0);
		expect(want).toBeGreaterThan(0);
		expect(breakdown(rows, WIN, "model").totalUt).toBe(want);
	});

	it("includes a record exactly at the start and drops the one before it", () => {
		const rows = [
			row({ ts: new Date(WIN.startMs - 1).toISOString(), costUt: 100 }),
			row({ ts: new Date(WIN.startMs).toISOString(), costUt: 7 }),
		];
		const b = breakdown(rows, WIN, "lane");
		expect(b.totalUt).toBe(7);
		expect(b.calls).toBe(1);
	});

	it("drops a record exactly at the end, so an edge record is in one window only", () => {
		const edge = row({ ts: new Date(WIN.endMs).toISOString(), costUt: 5 });
		const next = { startMs: WIN.endMs, endMs: WIN.endMs + 24 * HOUR };
		expect(breakdown([edge], WIN, "lane").totalUt).toBe(0);
		expect(breakdown([edge], next, "lane").totalUt).toBe(5);
	});

	it("orders keys by spend, highest first, and ties A to Z", () => {
		const rows = [
			row({ actor: "zed", costUt: 5 }),
			row({ actor: "amy", costUt: 5 }),
			row({ actor: "mid", costUt: 5 }),
			row({ actor: "big", costUt: 9 }),
		];
		expect(breakdown(rows, WIN, "lane").keys).toEqual(["big", "amy", "mid", "zed"]);
	});

	it("never counts an info record, whatever its cost", () => {
		const rows = [row({ kind: "info", costUt: 50 }), row({ kind: "llm_call", costUt: 2 })];
		const b = breakdown(rows, WIN, "kind");
		expect(b.totalUt).toBe(2);
		expect(b.keys).toEqual(["llm_call"]);
	});

	it("skips a record with no cost or an unreadable time", () => {
		const { costUt: _omit, ...noCost } = row();
		const rows: LedgerRow[] = [noCost, row({ ts: "not a time", costUt: 4 })];
		const b = breakdown(rows, WIN, "lane");
		expect(b.totalUt).toBe(0);
		expect(b.calls).toBe(0);
	});

	it("returns empty structures, never NaN, for a vault with no spend", () => {
		const rows = [row({ kind: "info", costUt: 3 }), row({ kind: "tool_use", costUt: 3 })];
		for (const dim of DIMS) {
			const b = breakdown(rows, WIN, dim);
			expect(b.keys).toEqual([]);
			expect(b.byKey.size).toBe(0);
			expect(b.totalUt).toBe(0);
			expect(b.calls).toBe(0);
		}
		expect(breakdown([], WIN, "lane").totalUt).toBe(0);
	});

	it("takes an unbounded window as the whole vault", () => {
		const all = breakdown(fixture(), { startMs: -Infinity, endMs: Infinity }, "lane");
		expect(all.calls).toBe(41);
	});
});

describe("categoryRows", () => {
	const BUCKET = 4 * HOUR;

	it("sums, for every key in every dimension, to the breakdown's number for that key", () => {
		for (const dim of DIMS) {
			const b = breakdown(fixture(), WIN, dim);
			const rows = categoryRows(fixture(), WIN, dim, BUCKET);
			expect([...rows.keys()]).toEqual(b.keys);
			for (const key of b.keys) {
				let sum = 0;
				for (const v of rows.get(key) as Float64Array) sum += v;
				expect(sum).toBeCloseTo(b.byKey.get(key)?.spendUt ?? Number.NaN, 9);
			}
		}
	});

	it("puts a record on a bucket edge in the later bucket only, unsmoothed", () => {
		const rows = [
			row({ actor: "ana", ts: new Date(T0 + BUCKET).toISOString(), costUt: 7 }),
			row({ actor: "bo", ts: new Date(T0 + BUCKET - 1).toISOString(), costUt: 2 }),
		];
		const out = categoryRows(rows, WIN, "lane", BUCKET);
		expect(Array.from(out.get("ana") as Float64Array)).toEqual([0, 7, 0, 0, 0, 0]);
		expect(Array.from(out.get("bo") as Float64Array)).toEqual([2, 0, 0, 0, 0, 0]);
	});

	it("is empty, never NaN, for a vault with no spend", () => {
		const rows = [row({ kind: "info", costUt: 3 })];
		expect(categoryRows(rows, WIN, "lane", BUCKET).size).toBe(0);
	});

	it("reads each record's time once, however many keys there are", () => {
		const KEYS = 200;
		const rows: LedgerRow[] = [];
		for (let i = 0; i < 2000; i++)
			rows.push(
				row({
					pos: i,
					actor: `lane-${i % KEYS}`,
					ts: new Date(T0 + (i % 23) * HOUR + i).toISOString(),
					costUt: 1 + (i % 5),
				}),
			);
		const spy = vi.spyOn(Date, "parse");
		try {
			const out = categoryRows(rows, WIN, "lane", BUCKET);
			expect(out.size).toBe(KEYS);
			expect(spy.mock.calls.length).toBeLessThanOrEqual(rows.length);
			spy.mockClear();
			shareBands(rows, WIN, "lane", BUCKET);
			expect(spy.mock.calls.length).toBeLessThanOrEqual(rows.length);
		} finally {
			spy.mockRestore();
		}
		const b = breakdown(rows, WIN, "lane");
		const out = categoryRows(rows, WIN, "lane", BUCKET);
		expect([...out.keys()]).toEqual(b.keys);
		for (const key of b.keys) {
			let sum = 0;
			for (const v of out.get(key) as Float64Array) sum += v;
			expect(sum).toBe(b.byKey.get(key)?.spendUt);
		}
	});

	it("keeps a key's row of zeros when the window cannot be bucketed", () => {
		const open = { startMs: -Infinity, endMs: Infinity };
		const out = categoryRows(fixture(), open, "lane", BUCKET);
		expect([...out.keys()]).toEqual(breakdown(fixture(), open, "lane").keys);
		for (const v of out.values()) expect(Array.from(v)).toEqual([0]);
	});
});

describe("shareBands", () => {
	const BUCKET = HOUR;

	function bandSums(dim: Dimension, radius?: number): { sums: Float64Array; totals: Float64Array } {
		const bands =
			radius === undefined
				? shareBands(fixture(), WIN, dim, BUCKET)
				: shareBands(fixture(), WIN, dim, BUCKET, radius);
		const totals = bucketTotals(fixture(), WIN, BUCKET);
		const sums = new Float64Array(totals.length);
		for (const v of bands.values())
			for (let i = 0; i < sums.length; i++) sums[i] = (sums[i] as number) + (v[i] as number);
		return { sums, totals };
	}

	it("adds up, in every bucket, to the exact bucket total (the line)", () => {
		for (const dim of DIMS) {
			for (const radius of [undefined, 0, 1, 6]) {
				const { sums, totals } = bandSums(dim, radius);
				expect(sums.length).toBe(totals.length);
				for (let i = 0; i < totals.length; i++)
					expect(Math.abs((sums[i] as number) - (totals[i] as number))).toBeLessThan(1e-9);
			}
		}
	});

	it("keeps the keys in breakdown order and gives zeros, not NaN, in empty buckets", () => {
		const rows = [
			row({ actor: "ana", ts: new Date(T0 + 2 * HOUR).toISOString(), costUt: 6 }),
			row({ actor: "bo", ts: new Date(T0 + 2 * HOUR + 1).toISOString(), costUt: 2 }),
			row({ actor: "bo", ts: new Date(T0 + 9 * HOUR).toISOString(), costUt: 4 }),
		];
		const bands = shareBands(rows, WIN, "lane", BUCKET, 3);
		expect([...bands.keys()]).toEqual(breakdown(rows, WIN, "lane").keys);
		for (const v of bands.values()) for (const x of v) expect(Number.isNaN(x)).toBe(false);
		for (const i of [0, 1, 3, 4, 10, 23]) for (const v of bands.values()) expect(v[i]).toBe(0);
		expect(
			Math.abs(
				((bands.get("ana") as Float64Array)[2] as number) +
					((bands.get("bo") as Float64Array)[2] as number) -
					8,
			),
		).toBeLessThan(1e-9);
	});

	it("smooths the shares, so a key's band is not its raw row", () => {
		const rows = [
			row({ actor: "ana", ts: new Date(T0 + 2 * HOUR).toISOString(), costUt: 10 }),
			row({ actor: "bo", ts: new Date(T0 + 3 * HOUR).toISOString(), costUt: 10 }),
		];
		const raw = categoryRows(rows, WIN, "lane", BUCKET).get("ana") as Float64Array;
		const smooth = shareBands(rows, WIN, "lane", BUCKET, 3).get("ana") as Float64Array;
		expect(raw[3]).toBe(0);
		expect(smooth[3] as number).toBeGreaterThan(0);
	});

	it("is empty for a vault with no spend", () => {
		expect(shareBands([row({ kind: "info" })], WIN, "lane", BUCKET).size).toBe(0);
	});
});

describe("spendInWindow", () => {
	it("is the rule breakdown counts by", () => {
		const rows = fixture();
		for (const dim of DIMS) {
			let sum = 0;
			for (const r of rows) sum += spendInWindow(r, WIN) ?? 0;
			expect(breakdown(rows, WIN, dim).totalUt).toBe(sum);
		}
	});

	it("counts a row's cost inside the half-open window, and nothing on or past its end", () => {
		expect(spendInWindow(row({ costUt: 4, ts: new Date(WIN.startMs).toISOString() }), WIN)).toBe(4);
		expect(
			spendInWindow(row({ costUt: 4, ts: new Date(WIN.endMs).toISOString() }), WIN),
		).toBeUndefined();
	});

	it("puts a record whose time does not parse in no window, even the whole vault", () => {
		expect(
			spendInWindow({ kind: "llm_call", costUt: 4, ts: "not a time" }, WHOLE_VAULT),
		).toBeUndefined();
		expect(spendInWindow({ kind: "llm_call", costUt: 4, ts: "not a time" }, WIN)).toBeUndefined();
	});

	it("skips what is not header spend", () => {
		expect(
			spendInWindow({ kind: "policy_denied", costUt: 9, ts: row().ts }, WHOLE_VAULT),
		).toBeUndefined();
		expect(
			spendInWindow({ kind: "llm_call_failed", costUt: 9, ts: row().ts }, WHOLE_VAULT),
		).toBeUndefined();
		expect(spendInWindow({ kind: "llm_call", ts: row().ts }, WHOLE_VAULT)).toBeUndefined();
		expect(spendInWindow({ kind: "llm_call", costUt: 9, ts: row().ts }, WHOLE_VAULT)).toBe(9);
	});

	it("a zero cost is spend: it counts as a call", () => {
		expect(spendInWindow({ kind: "llm_call", costUt: 0, ts: row().ts }, WHOLE_VAULT)).toBe(0);
	});
});
