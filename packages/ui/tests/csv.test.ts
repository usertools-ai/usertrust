// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { CSV_HEADERS, csvFilename, toCsv } from "../src/shared/csv.js";
import type { LedgerRow } from "../src/shared/rows.js";

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
	return {
		seq: 1,
		id: "evt-1",
		ts: "2026-07-27T13:45:02.000Z",
		kind: "llm_call",
		actor: "code-review",
		model: "claude-sonnet-4-6",
		provider: "anthropic",
		costUt: 336,
		costUsd: 0.0336,
		settled: true,
		transferId: "tx_abc_123",
		hash: "a".repeat(64),
		previousHash: "b".repeat(64),
		integrity: "verified",
		...overrides,
	};
}

describe("toCsv", () => {
	it("emits a header row followed by one line per row", () => {
		const csv = toCsv([row(), row({ id: "evt-2", seq: 2 })]);
		const lines = csv.split("\r\n");
		expect(lines[0]).toBe(CSV_HEADERS.join(","));
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("code-review");
		expect(lines[1]).toContain("claude-sonnet-4-6");
	});

	it("writes numeric cost columns unquoted so spreadsheets sum them", () => {
		const cells = toCsv([row()]).split("\r\n")[1]?.split(",") as string[];
		expect(cells).toContain("336");
		expect(cells).toContain("0.0336");
	});

	it("quotes and escapes values containing commas or quotes", () => {
		const csv = toCsv([row({ actor: 'ops,"night"' })]);
		expect(csv).toContain('"ops,""night"""');
	});

	it("neutralizes spreadsheet formula injection", () => {
		for (const hostile of ["=cmd()", "+1", "-1", "@SUM(A1)"]) {
			const csv = toCsv([row({ actor: hostile })]);
			expect(csv).toContain(`"'${hostile}"`);
		}
	});

	it("renders missing optional fields as empty cells", () => {
		const csv = toCsv([
			row({ model: undefined, provider: undefined, costUt: undefined, costUsd: undefined }),
		]);
		const cells = csv.split("\r\n")[1]?.split(",") as string[];
		expect(cells.filter((c) => c === "").length).toBeGreaterThan(0);
	});

	it("maps status from kind and settled flag", () => {
		expect(toCsv([row()])).toContain("settled");
		expect(toCsv([row({ kind: "llm_call_failed", settled: false })])).toContain("failed");
		expect(toCsv([row({ settled: undefined })])).toContain("pending");
	});

	it("returns just the header for an empty ledger", () => {
		expect(toCsv([])).toBe(CSV_HEADERS.join(","));
	});
});

describe("csvFilename", () => {
	it("stamps the date and marks filtered exports", () => {
		expect(csvFilename(new Date("2026-07-27T10:00:00Z"), false)).toBe(
			"usertrust-ledger-2026-07-27.csv",
		);
		expect(csvFilename(new Date("2026-07-27T10:00:00Z"), true)).toBe(
			"usertrust-ledger-2026-07-27-filtered.csv",
		);
	});
});
