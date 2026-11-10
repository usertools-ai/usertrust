// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { breakdown } from "../src/shared/breakdown.js";
import { type NowStatusLine, statusLines } from "../src/shared/now-status.js";
import type { LedgerRow, RowStatus } from "../src/shared/rows.js";
import { statusWord, UNRESOLVED_LINE, UNRESOLVED_TIP } from "../src/shared/status-word.js";

const END = Date.UTC(2026, 10, 8, 12);
const HOUR = 3_600_000;
const WIN = { startMs: END - 7 * 24 * HOUR, endMs: END };

function row(over: Partial<LedgerRow> = {}): LedgerRow {
	return {
		seq: 1,
		pos: 0,
		id: Math.random().toString(36),
		ts: new Date(END - HOUR).toISOString(),
		kind: "llm_call",
		actor: "local",
		hash: "a".repeat(64),
		previousHash: "0".repeat(64),
		integrity: "verified",
		costUt: 1,
		status: "settled",
		...over,
	};
}

function line(out: NowStatusLine[], status: string): NowStatusLine | undefined {
	return out.find((l) => l.status === status);
}

const UNRESOLVED_LABEL = `unresolved · ${UNRESOLVED_LINE}`;

describe("statusLines", () => {
	it("unresolved is counted with its dollars and no held line", () => {
		const out = statusLines([row({ status: "ambiguous", costUt: 500 }), row({ costUt: 40 })], WIN);
		expect(line(out, "unresolved")).toStrictEqual({
			status: "unresolved",
			label: UNRESOLVED_LABEL,
			count: 1,
			spendUt: 500,
			tip: UNRESOLVED_TIP,
		});
		expect(line(out, "settled")).toStrictEqual({
			status: "settled",
			label: "settled",
			count: 1,
			spendUt: 40,
		});
		expect(line(out, "held")).toBeUndefined();
		expect(["ambiguous", "held", "settled"]).not.toContain(line(out, "unresolved")?.label);
	});

	it("every label is the shared word", () => {
		const statuses: RowStatus[] = [
			"settled",
			"ambiguous",
			"denied",
			"failed",
			"released",
			"unrecoverable",
			"unknown",
		];
		const out = statusLines(
			statuses.map((status) => row({ status })),
			WIN,
		);
		expect(out).toHaveLength(statuses.length);
		for (const l of out) {
			const stored = (l.status === "unresolved" ? "ambiguous" : l.status) as RowStatus;
			if (l.status === "unresolved")
				expect(l.label).toBe(`${statusWord(stored)} · ${UNRESOLVED_LINE}`);
			else expect(l.label).toBe(statusWord(stored));
			expect(l.label).not.toContain("ambiguous");
		}
	});

	it("the line spends sum to the breakdown total", () => {
		const rows = [
			row({ costUt: 30 }),
			row({ costUt: 12 }),
			row({ status: "ambiguous", costUt: 500 }),
			row({ status: "denied", kind: "policy_denied", costUt: 9 }),
		];
		const sum = statusLines(rows, WIN).reduce((s, l) => s + (l.spendUt ?? 0), 0);
		expect(sum).toBe(542);
		expect(sum).toBe(breakdown(rows, WIN, "kind").totalUt);
	});

	it("settled, denied and unresolved are listed on an empty input", () => {
		expect(statusLines([], WIN)).toStrictEqual([
			{ status: "settled", label: "settled", count: 0, spendUt: null },
			{ status: "denied", label: "denied", count: 0, spendUt: null },
			{
				status: "unresolved",
				label: UNRESOLVED_LABEL,
				count: 0,
				spendUt: null,
				tip: UNRESOLVED_TIP,
			},
		]);
	});

	it("settled carries its spend, and no figure when it has none", () => {
		const out = statusLines([row({ costUt: 300 }), row({ costUt: 200 })], WIN);
		expect(line(out, "settled")).toMatchObject({ count: 2, spendUt: 500 });
		const free = statusLines([row({ costUt: 0 })], WIN);
		expect(line(free, "settled")).toMatchObject({ count: 1, spendUt: null });
	});

	it("a hold record is listed as held", () => {
		const out = statusLines([row({ status: "held" as never, costUt: 70 })], WIN);
		expect(out.map((l) => l.status)).toEqual(["settled", "held", "denied", "unresolved"]);
		expect(out[1]).toStrictEqual({ status: "held", label: "held", count: 1, spendUt: 70 });
	});

	it("unrecoverable and unknown keep their notes", () => {
		const out = statusLines(
			[row({ status: "unrecoverable" }), row({ status: "unknown" }), row({ status: "failed" })],
			WIN,
		);
		expect(line(out, "unrecoverable")).toStrictEqual({
			status: "unrecoverable",
			label: "unrecoverable",
			count: 1,
			spendUt: 1,
			note: "ran and recorded, not charged",
		});
		expect(line(out, "unknown")).toStrictEqual({
			status: "unknown",
			label: "unknown",
			count: 1,
			spendUt: 1,
			note: "no outcome recorded",
		});
		expect(line(out, "failed")).toStrictEqual({
			status: "failed",
			label: "failed",
			count: 1,
			spendUt: 1,
		});
	});

	it("the window is half-open", () => {
		const at = (ms: number): number =>
			line(statusLines([row({ ts: new Date(ms).toISOString() })], WIN), "settled")?.count ?? -1;
		expect(at(WIN.startMs)).toBe(1);
		expect(at(WIN.startMs - 1)).toBe(0);
		expect(at(END - 1)).toBe(1);
		expect(at(END)).toBe(0);
	});
});
