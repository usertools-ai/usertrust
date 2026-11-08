// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { breakdown } from "../src/shared/breakdown.js";
import type { LedgerRow, RowStatus } from "../src/shared/rows.js";
import { type DeskStatus, tallyStatus } from "../src/shared/status-tally.js";

const T0 = Date.parse("2026-07-27T00:00:00.000Z");
const HOUR = 3_600_000;
const WIN = { startMs: T0, endMs: T0 + 24 * HOUR };

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
		status: "settled",
		...overrides,
	};
}

/** A status no producer writes today: a hold placed. The tally must still show it if one ever arrives. */
function held(overrides: Partial<LedgerRow> = {}): LedgerRow {
	return row({ status: "held" as unknown as RowStatus, ...overrides });
}

function entry(
	out: ReturnType<typeof tallyStatus>,
	status: DeskStatus,
): { status: DeskStatus; count: number; spendUt: number } | undefined {
	return out.find((e) => e.status === status);
}

function sumSpend(out: ReturnType<typeof tallyStatus>): number {
	return out.reduce((s, e) => s + e.spendUt, 0);
}

describe("tallyStatus", () => {
	it("keeps an unconfirmed charge inside spend as its own line, never settled or held", () => {
		const rows = [row({ status: "ambiguous", costUt: 500 })];
		const out = tallyStatus(rows, WIN);
		expect(entry(out, "unresolved")).toEqual({ status: "unresolved", count: 1, spendUt: 500 });
		expect(entry(out, "settled")).toEqual({ status: "settled", count: 0, spendUt: 0 });
		expect(entry(out, "held")).toBeUndefined();
		expect(out.some((e) => (e.status as string) === "ambiguous")).toBe(false);
	});

	it("sums to the spend total: settled + unresolved (+ held) == the breakdown's total", () => {
		const rows = [
			row({ status: "settled", costUt: 30 }),
			row({ status: "settled", costUt: 12 }),
			row({ status: "ambiguous", costUt: 500 }),
			row({ status: "denied", kind: "policy_denied", costUt: 0 }),
			row({ status: "info", kind: "anomaly_detected", costUt: 77 }),
			held({ costUt: 9 }),
		];
		const out = tallyStatus(rows, WIN);
		const total = breakdown(rows, WIN, "lane").totalUt;
		expect(total).toBe(30 + 12 + 500 + 9);
		expect(sumSpend(out)).toBe(total);
		expect(entry(out, "settled")?.spendUt).toBe(42);
		expect(entry(out, "unresolved")?.spendUt).toBe(500);
		expect(entry(out, "held")?.spendUt).toBe(9);
	});

	it("lists settled, denied and unresolved on an empty input, zeros included", () => {
		const out = tallyStatus([], WIN);
		expect(out).toEqual([
			{ status: "settled", count: 0, spendUt: 0 },
			{ status: "denied", count: 0, spendUt: 0 },
			{ status: "unresolved", count: 0, spendUt: 0 },
		]);
	});

	it("adds held only when some record is a hold, and puts it second", () => {
		const out = tallyStatus([held({ costUt: 4 }), row()], WIN);
		expect(out.map((e) => e.status)).toEqual(["settled", "held", "denied", "unresolved"]);
		expect(entry(out, "held")).toEqual({ status: "held", count: 1, spendUt: 4 });
	});

	it("orders settled, held, denied, unresolved, then the rest A to Z", () => {
		const rows = [
			row({ status: "unknown", kind: "x" }),
			row({ status: "failed", kind: "llm_call_failed" }),
			row({ status: "ambiguous" }),
			row({ status: "denied", kind: "policy_denied" }),
			held(),
			row({ status: "info", kind: "anomaly_detected" }),
			row({ status: "released", kind: "hold_released" }),
			row(),
		];
		expect(tallyStatus(rows, WIN).map((e) => e.status)).toEqual([
			"settled",
			"held",
			"denied",
			"unresolved",
			"failed",
			"info",
			"released",
			"unknown",
		]);
	});

	it("counts a record on the start edge, drops the one on the end edge", () => {
		const rows = [
			row({ ts: new Date(WIN.startMs - 1).toISOString(), costUt: 100 }),
			row({ ts: new Date(WIN.startMs).toISOString(), costUt: 7 }),
			row({ ts: new Date(WIN.endMs).toISOString(), costUt: 50 }),
		];
		const out = tallyStatus(rows, WIN);
		expect(entry(out, "settled")).toEqual({ status: "settled", count: 1, spendUt: 7 });
	});

	it("counts a non-spend record by status but carries no spend for it", () => {
		const rows = [row({ status: "info", kind: "anomaly_detected", costUt: 40 })];
		const out = tallyStatus(rows, WIN);
		expect(entry(out, "info")).toEqual({ status: "info", count: 1, spendUt: 0 });
		expect(sumSpend(out)).toBe(breakdown(rows, WIN, "lane").totalUt);
	});

	it("skips a record with an unreadable time", () => {
		const out = tallyStatus([row({ ts: "not a time", costUt: 4 })], WIN);
		expect(sumSpend(out)).toBe(0);
		expect(out.every((e) => e.count === 0)).toBe(true);
	});
});
