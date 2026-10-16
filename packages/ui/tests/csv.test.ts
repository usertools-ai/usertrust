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

	it("writes the row's status; an outcome row the server gave none is unknown, never pending", () => {
		const statusAt = (line: string | undefined) => line?.split(",")[CSV_HEADERS.indexOf("status")];
		expect(statusAt(toCsv([row({ status: "settled" })]).split("\r\n")[1])).toBe("settled");
		expect(toCsv([row({ kind: "llm_call_failed", settled: false, status: "failed" })])).toContain(
			"failed",
		);
		const { status: _s, ...noStatus } = row({ settled: undefined });
		const lines = toCsv([noStatus]).split("\r\n");
		expect(lines[1]?.split(",")[CSV_HEADERS.indexOf("status")]).toBe("unknown");
		expect(toCsv([noStatus])).not.toContain("pending");
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

	it("writes an ungoverned_call's status as ungoverned", () => {
		const { settled: _s, costUt: _c, costUsd: _u, ...base } = row({ kind: "ungoverned_call" });
		const lines = toCsv([base]).split("\r\n");
		const statusIndex = CSV_HEADERS.indexOf("status");
		expect(lines[1]?.split(",")[statusIndex]).toBe("ungoverned");
	});
});

describe("the row window and the usage source in Export", () => {
	it("red-first (no trace of the 100k window): an export of a windowed ledger says so in its filename", () => {
		expect(csvFilename(new Date("2026-07-27T10:00:00Z"), false, 100_000)).toBe(
			"usertrust-ledger-2026-07-27-newest-100000.csv",
		);
		expect(csvFilename(new Date("2026-07-27T10:00:00Z"), true, 100_000)).toBe(
			"usertrust-ledger-2026-07-27-newest-100000-filtered.csv",
		);
		expect(csvFilename(new Date("2026-07-27T10:00:00Z"), false, undefined)).toBe(
			"usertrust-ledger-2026-07-27.csv",
		);
	});

	it("red-first (an estimated cost exported like a reported one): each row says where its usage came from", () => {
		const at = (csv: string) =>
			csv.split("\r\n")[1]?.split(",")[CSV_HEADERS.indexOf("usage_source")];
		expect(CSV_HEADERS.at(-1)).toBe("usage_source");
		expect(at(toCsv([row({ usageSource: "estimated" })]))).toBe("estimated");
		expect(at(toCsv([row({ usageSource: "provider" })]))).toBe("provider");
		expect(at(toCsv([row()]))).toBe("");
	});
});
