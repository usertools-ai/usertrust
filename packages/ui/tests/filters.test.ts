// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { applyFilters, EMPTY_FILTERS, isFiltering, sortRows } from "../src/shared/filters.js";
import type { LedgerRow } from "../src/shared/rows.js";

function row(overrides: Partial<LedgerRow>): LedgerRow {
	return {
		seq: 1,
		id: "id-1",
		ts: "2026-07-27T10:00:00.000Z",
		kind: "llm_call",
		actor: "local",
		hash: "a".repeat(64),
		previousHash: "0".repeat(64),
		integrity: "verified",
		...overrides,
	};
}

const ROWS: LedgerRow[] = [
	row({
		id: "1",
		kind: "llm_call",
		model: "claude-sonnet-4-6",
		costUt: 5,
		settled: true,
		status: "settled",
		transferId: "tx_alpha",
		ts: "2026-07-25T09:00:00.000Z",
	}),
	row({
		id: "2",
		kind: "tool_use",
		actor: "agent-7",
		costUt: 50,
		status: "settled",
		ts: "2026-07-26T09:00:00.000Z",
	}),
	row({
		id: "3",
		kind: "llm_call_failed",
		error: "rate limited",
		costUt: 0,
		status: "failed",
		ts: "2026-07-27T09:00:00.000Z",
	}),
];

describe("applyFilters", () => {
	it("empty filters pass everything; isFiltering false", () => {
		expect(applyFilters(ROWS, EMPTY_FILTERS)).toHaveLength(3);
		expect(isFiltering(EMPTY_FILTERS)).toBe(false);
	});

	it("search matches transferId, model, error, actor (case-insensitive)", () => {
		expect(applyFilters(ROWS, { ...EMPTY_FILTERS, search: "TX_ALPHA" })).toHaveLength(1);
		expect(applyFilters(ROWS, { ...EMPTY_FILTERS, search: "rate lim" })[0]?.id).toBe("3");
		expect(applyFilters(ROWS, { ...EMPTY_FILTERS, search: "agent-7" })[0]?.id).toBe("2");
	});

	it("kind, status, cost range, and date range filters compose", () => {
		expect(applyFilters(ROWS, { ...EMPTY_FILTERS, kinds: ["llm_call"] })).toHaveLength(1);
		expect(applyFilters(ROWS, { ...EMPTY_FILTERS, statuses: ["failed"] })[0]?.id).toBe("3");
		expect(applyFilters(ROWS, { ...EMPTY_FILTERS, costMin: 10 })[0]?.id).toBe("2");
		expect(
			applyFilters(ROWS, { ...EMPTY_FILTERS, from: "2026-07-26", to: "2026-07-26" })[0]?.id,
		).toBe("2");
		expect(isFiltering({ ...EMPTY_FILTERS, kinds: ["llm_call"] })).toBe(true);
	});

	// A denial, a release or an ungoverned call carries no cost: its cost is UNKNOWN, not 0. Read as 0, "max 50 UT"
	// kept every one of them as a cheap call.
	it("red-first (max 50 UT kept every uncosted row): a cost bound keeps only rows WITH a cost in range", () => {
		const rows = [...ROWS, row({ id: "d", kind: "policy_denied", status: "denied" })];
		expect(applyFilters(rows, { ...EMPTY_FILTERS, costMax: 50 }).map((r) => r.id)).toEqual([
			"1",
			"2",
			"3",
		]);
		expect(applyFilters(rows, { ...EMPTY_FILTERS, costMin: 0 }).map((r) => r.id)).toEqual([
			"1",
			"2",
			"3",
		]);
		expect(applyFilters(rows, EMPTY_FILTERS).map((r) => r.id)).toContain("d");
	});

	it("filters on the ungoverned status", () => {
		const rows = [...ROWS, row({ id: "u", kind: "ungoverned_call" })];
		const out = applyFilters(rows, { ...EMPTY_FILTERS, statuses: ["ungoverned"] });
		expect(out.map((r) => r.id)).toEqual(["u"]);
		expect(
			applyFilters(rows, { ...EMPTY_FILTERS, statuses: ["pending"] }).map((r) => r.id),
		).not.toContain("u");
	});
});

describe("sortRows", () => {
	const rows = [
		row({ id: "a", seq: 1, costUt: 5, ts: "2026-07-25T09:00:00.000Z" }),
		row({ id: "u", seq: 2, kind: "policy_denied", ts: "2026-07-26T09:00:00.000Z" }),
		row({ id: "b", seq: 3, costUt: 50, ts: "2026-07-27T09:00:00.000Z" }),
	];

	it("newest first by chain position, by default", () => {
		expect(sortRows(rows, "seq", true).map((r) => r.id)).toEqual(["b", "u", "a"]);
		expect(sortRows(rows, "seq", false).map((r) => r.id)).toEqual(["a", "u", "b"]);
	});

	it("red-first (an uncosted row sorted as 0): rows with no cost sort after every costed row, either way", () => {
		expect(sortRows(rows, "costUt", true).map((r) => r.id)).toEqual(["b", "a", "u"]);
		expect(sortRows(rows, "costUt", false).map((r) => r.id)).toEqual(["a", "b", "u"]);
	});

	it("by a text column: alphabetical, a row without the value first ascending", () => {
		const models = [
			row({ id: "x", model: "gpt-5" }),
			row({ id: "y" }),
			row({ id: "z", model: "claude-sonnet-4-6" }),
		];
		expect(sortRows(models, "model", false).map((r) => r.id)).toEqual(["y", "z", "x"]);
		expect(sortRows(models, "model", true).map((r) => r.id)).toEqual(["x", "z", "y"]);
	});

	it("does not reorder its input", () => {
		const before = rows.map((r) => r.id);
		sortRows(rows, "costUt", true);
		expect(rows.map((r) => r.id)).toEqual(before);
	});
});
