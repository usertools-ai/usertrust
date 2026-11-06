// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import type { AtPayload, SummaryPayload } from "../src/shared/api.js";
import { cutRows, windowNote, windowNoteAt } from "../src/shared/asof.js";
import type { LedgerRow } from "../src/shared/rows.js";

function row(pos: number, overrides: Partial<LedgerRow> = {}): LedgerRow {
	return {
		seq: pos,
		pos,
		id: `id-${pos}`,
		ts: "2026-10-12T17:59:02.770Z",
		kind: "llm_call",
		actor: "local",
		hash: pos.toString(16).padStart(64, "0"),
		previousHash: "0".repeat(64),
		integrity: "verified",
		status: "settled",
		...overrides,
	};
}

function at(overrides: Partial<AtPayload> = {}): AtPayload {
	return {
		pos: 2,
		ts: "2026-10-12T17:59:02.770Z",
		head: 4,
		clamped: false,
		epoch: 0,
		spentUt: 0,
		counts: { llm_call: 0, denied: 0, other: 0 },
		chain: { valid: true, breakIndex: null },
		budget: { ut: null, note: "" },
		plan: null,
		windowStartPos: 0,
		statusAt: {},
		...overrides,
	};
}

const ROWS = [row(0), row(1), row(2), row(3), row(4)];

describe("cutRows", () => {
	it("cut keeps pos <= at.pos and identity of untouched rows", () => {
		const out = cutRows(ROWS, at({ pos: 2 }));
		expect(out.map((r) => r.pos)).toEqual([0, 1, 2]);
		expect(out[0]).toBe(ROWS[0]);
		expect(out[2]).toBe(ROWS[2]);
	});

	it("cut applies statusAt", () => {
		const out = cutRows(ROWS, at({ pos: 2, statusAt: { [ROWS[1]?.hash ?? ""]: "pending" } }));
		expect(out[1]?.status).toBe("pending");
		expect(out[1]).not.toBe(ROWS[1]);
		expect(ROWS[1]?.status).toBe("settled");
		expect(out[0]).toBe(ROWS[0]);
		expect(out[2]).toBe(ROWS[2]);
	});

	it("cut before the window", () => {
		const held = [row(100), row(101)];
		const payload = at({ pos: 40, head: 101, windowStartPos: 100 });
		expect(cutRows(held, payload)).toEqual([]);
		expect(windowNoteAt(payload)).toBe(
			"The list holds records from position 100; earlier records still count in the totals above.",
		);
	});

	it("cut at head is the input", () => {
		const out = cutRows(ROWS, at({ pos: 4, head: 4 }));
		expect(out).toHaveLength(ROWS.length);
		out.forEach((r, i) => {
			expect(r).toBe(ROWS[i]);
		});
	});
});

describe("windowNoteAt", () => {
	it("is null when the position is inside the window", () => {
		expect(windowNoteAt(at({ pos: 100, windowStartPos: 100 }))).toBeNull();
		expect(windowNoteAt(at({ pos: 2, windowStartPos: 0 }))).toBeNull();
	});
});

describe("cutRows edge cases", () => {
	it("a statusAt key whose row is past the cut leaves the row out", () => {
		const out = cutRows(ROWS, at({ pos: 1, statusAt: { [ROWS[3]?.hash ?? ""]: "pending" } }));
		expect(out.map((r) => r.pos)).toEqual([0, 1]);
	});

	it("a statusAt value equal to the current status keeps the same object", () => {
		const out = cutRows(ROWS, at({ pos: 2, statusAt: { [ROWS[1]?.hash ?? ""]: "settled" } }));
		expect(out[1]).toBe(ROWS[1]);
	});

	it("a __proto__ key is ignored", () => {
		const statusAt = JSON.parse('{"__proto__":"pending"}') as AtPayload["statusAt"];
		const protoRow = row(0, { hash: "__proto__" });
		const out = cutRows([protoRow], at({ pos: 0, statusAt: {} }));
		expect(out[0]).toBe(protoRow);
		const out2 = cutRows(ROWS, at({ pos: 4, statusAt }));
		out2.forEach((r, i) => {
			expect(r).toBe(ROWS[i]);
		});
	});

	it("pos one before the window start returns the note", () => {
		expect(windowNoteAt(at({ pos: 99, windowStartPos: 100 }))).not.toBeNull();
	});
});

describe("windowNote", () => {
	const summary = (truncated: boolean): SummaryPayload =>
		({ truncated, rowCount: 5, chain: { events: 50 } }) as unknown as SummaryPayload;

	it("before the window: only the position's note", () => {
		const n = windowNote(summary(true), at({ pos: 40, windowStartPos: 100 }));
		expect(n).toBe(windowNoteAt(at({ pos: 40, windowStartPos: 100 })));
	});

	it("inside a truncated window: only the live notice", () => {
		const n = windowNote(summary(true), at({ pos: 120, windowStartPos: 100 }));
		expect(n).toMatch(/^Showing the newest 5 of 50 events/);
	});

	it("live and untruncated: null", () => {
		expect(windowNote(summary(false), null)).toBeNull();
		expect(windowNote(summary(false), at({ pos: 120, windowStartPos: 100 }))).toBeNull();
	});
});
