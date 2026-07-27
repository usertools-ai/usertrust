// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { EMPTY_FILTERS, applyFilters, isFiltering } from "../src/shared/filters.js";
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
		transferId: "tx_alpha",
		ts: "2026-07-25T09:00:00.000Z",
	}),
	row({ id: "2", kind: "tool_use", actor: "agent-7", costUt: 50, ts: "2026-07-26T09:00:00.000Z" }),
	row({
		id: "3",
		kind: "llm_call_failed",
		error: "rate limited",
		costUt: 0,
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
});
