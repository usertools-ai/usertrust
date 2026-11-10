// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { BAND_MIN_HISTORY, usualBand } from "../src/shared/band.js";
import { skipBeforeFirstSpend } from "../src/shared/band-skip.js";
import type { LedgerRow } from "../src/shared/rows.js";

const HOUR = 3_600_000;
const START = Date.UTC(2026, 10, 8);
const N = 8;

function llm(ts: number, over: Partial<LedgerRow> = {}): LedgerRow {
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
		costUt: 5,
		...over,
	};
}

/** The buckets left out, as their indices. */
function skipped(rows: LedgerRow[]): number[] {
	const mask = skipBeforeFirstSpend(rows, START, HOUR, N);
	expect(mask).toHaveLength(N);
	return mask.flatMap((s, k) => (s ? [k] : []));
}

describe("skipBeforeFirstSpend", () => {
	it("leaves out the buckets before the one the first spend is in", () => {
		expect(skipped([llm(START + 3 * HOUR + 60_000)])).toEqual([0, 1, 2]);
	});

	it("a first spend on a bucket's first instant is in that bucket", () => {
		expect(skipped([llm(START + 3 * HOUR)])).toEqual([0, 1, 2]);
		expect(skipped([llm(START + 3 * HOUR - 1)])).toEqual([0, 1]);
	});

	it("takes the earliest spend, wherever it sits in the array", () => {
		expect(skipped([llm(START + 5 * HOUR), llm(START + 2 * HOUR), llm(START + 6 * HOUR)])).toEqual([
			0, 1,
		]);
	});

	it("leaves nothing out when spend began at or before the start", () => {
		expect(skipped([llm(START)])).toEqual([]);
		expect(skipped([llm(START - 9 * HOUR), llm(START + 4 * HOUR)])).toEqual([]);
	});

	it("leaves every bucket out when there is no spend, or none before the end", () => {
		const all = [0, 1, 2, 3, 4, 5, 6, 7];
		expect(skipped([])).toEqual(all);
		expect(skipped([llm(START + N * HOUR)])).toEqual(all);
		expect(skipped([llm(START + HOUR, { kind: "tool_use" })])).toEqual(all);
		expect(skipped([{ ...llm(START + HOUR), costUt: undefined } as unknown as LedgerRow])).toEqual(
			all,
		);
	});

	it("a spend of 0 is still the first spend", () => {
		expect(skipped([llm(START + 2 * HOUR, { costUt: 0 })])).toEqual([0, 1]);
	});

	it("a record whose time cannot be read is passed over, first or last", () => {
		const bad = llm(START, { ts: "not a time" });
		expect(skipped([bad, llm(START + 4 * HOUR)])).toEqual([0, 1, 2, 3]);
		expect(skipped([llm(START + 4 * HOUR), bad])).toEqual([0, 1, 2, 3]);
		expect(skipped([bad])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	});

	it("gives the usual range its history rule: that many real buckets, counted after the mask", () => {
		const values = new Float64Array(N).fill(5);
		const last = N - 1;
		const hiAt = (firstBucket: number): number => {
			const skip = skipBeforeFirstSpend([llm(START + firstBucket * HOUR)], START, HOUR, N);
			return usualBand(values, skip).hi[last] as number;
		};
		expect(hiAt(last - BAND_MIN_HISTORY)).toBe(5);
		expect(Number.isNaN(hiAt(last - BAND_MIN_HISTORY + 1))).toBe(true);
	});
});
