// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { isHeaderSpend } from "../src/shared/aggregate.js";
import { type Breakdown, breakdown, type Dimension, keyOf } from "../src/shared/breakdown.js";
import type { LedgerRow } from "../src/shared/rows.js";

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
