// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	costByKind,
	costByModel,
	isHeaderSpend,
	spendOverTime,
	statTiles,
	timeWindow,
} from "../src/shared/aggregate.js";
import type { LedgerRow } from "../src/shared/rows.js";

function row(overrides: Partial<LedgerRow>): LedgerRow {
	return {
		seq: 1,
		id: Math.random().toString(36),
		ts: "2026-07-27T10:30:00.000Z",
		kind: "llm_call",
		actor: "local",
		hash: "a".repeat(64),
		previousHash: "0".repeat(64),
		integrity: "verified",
		...overrides,
	};
}

const ROWS: LedgerRow[] = [
	row({ ts: "2026-07-26T09:00:00.000Z", costUt: 5, model: "claude-sonnet-4-6", status: "settled" }),
	row({
		ts: "2026-07-26T15:00:00.000Z",
		costUt: 10,
		model: "claude-sonnet-4-6",
		status: "settled",
	}),
	row({ ts: "2026-07-27T10:00:00.000Z", costUt: 20, kind: "tool_use", status: "settled" }),
	row({
		ts: "2026-07-27T11:00:00.000Z",
		kind: "llm_call_failed",
		error: "boom",
		costUt: 0,
		status: "failed",
	}),
];

describe("aggregate", () => {
	it("buckets spend by day (sorted ascending)", () => {
		expect(spendOverTime(ROWS, "day")).toEqual([
			{ bucket: "2026-07-26", costUt: 15, count: 2 },
			{ bucket: "2026-07-27", costUt: 20, count: 2 },
		]);
	});

	it("buckets spend by hour", () => {
		const hours = spendOverTime(ROWS, "hour");
		expect(hours).toHaveLength(4);
		expect(hours[0]).toEqual({ bucket: "2026-07-26 09:00", costUt: 5, count: 1 });
	});

	it("totals cost by kind and model, sorted by cost desc", () => {
		expect(costByKind(ROWS)[0]).toEqual({ key: "tool_use", costUt: 20, count: 1 });
		expect(costByModel(ROWS)).toEqual([{ key: "claude-sonnet-4-6", costUt: 15, count: 2 }]);
	});

	it("stat tiles: totals, avg over costed rows, error rate", () => {
		expect(statTiles(ROWS)).toMatchObject({
			totalCostUt: 35,
			calls: 4,
			costed: 4,
			avgCostUt: 8.75,
			errorRate: 0.25,
		});
		// the average's denominator is the COSTED rows, which the tile names: a row with no cost is not a free call
		expect(statTiles([...ROWS, row({ kind: "policy_denied", status: "denied" })])).toMatchObject({
			calls: 5,
			costed: 4,
			avgCostUt: 8.75,
		});
	});

	it("counts EVERY status, unknown and unrecoverable included: never hidden, never folded into another", () => {
		const tiles = statTiles([
			...ROWS,
			row({ kind: "settlement_unrecoverable", status: "unrecoverable" }),
			row({ kind: "anomaly_detected", status: "info" }),
			row({ kind: "something_new", status: "unknown" }),
			row({ kind: "llm_call", status: "ambiguous" }),
		]);
		expect(tiles.byStatus).toEqual({
			settled: 3,
			ambiguous: 1,
			failed: 1,
			denied: 0,
			released: 0,
			unrecoverable: 1,
			ungoverned: 0,
			info: 1,
			unknown: 1,
		});
		// the error rate is FAILED rows only: an unrecoverable settle is a money state, not an error
		expect(tiles.errorRate).toBeCloseTo(1 / 8);
	});
});

// The chart and its footer are labelled UTC. An offset timestamp sliced as a string lands on its LOCAL day and hour,
// and string comparison orders it by its local clock: both now go through the UTC instant.
describe("Trends in UTC", () => {
	const offset = row({ ts: "2026-10-13T01:30:00+02:00", costUt: 7 }); // 2026-10-12 23:30Z
	const later = row({ ts: "2026-10-13T00:10:00.000Z", costUt: 3 });

	it("red-first (sliced to its local day): an offset timestamp is bucketed at its UTC day and hour", () => {
		expect(spendOverTime([offset], "day")).toEqual([{ bucket: "2026-10-12", costUt: 7, count: 1 }]);
		expect(spendOverTime([offset], "hour")).toEqual([
			{ bucket: "2026-10-12 23:00", costUt: 7, count: 1 },
		]);
	});

	it("red-first (ordered as strings): the window's first and last are by instant, in UTC", () => {
		expect(timeWindow([later, offset])).toEqual({
			first: "2026-10-12T23:30:00.000Z",
			last: "2026-10-13T00:10:00.000Z",
		});
		expect(timeWindow([row({ ts: "not a time" })])).toBeUndefined();
	});
});

describe("isHeaderSpend", () => {
	it("the header's Spend: an llm_call's numeric cost, nothing else", () => {
		expect(isHeaderSpend("llm_call", 5)).toBe(true);
		expect(isHeaderSpend("llm_call", undefined)).toBe(false);
		expect(isHeaderSpend("llm_call", "5")).toBe(false);
		expect(isHeaderSpend("tool_use", 5)).toBe(false);
		expect(isHeaderSpend("settlement_ambiguous", 5)).toBe(false);
	});
});
