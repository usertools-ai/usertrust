// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The audit list's keyboard: where each key moves the active row, and what a screen reader says for a row. The
 * movement is a pure function so every key, both ends and the empty list are pinned here; the list component only
 * wires it to the page (see row-keys.test.ts for the markup).
 */

import type { PersistedAuditEvent } from "usertrust";
import { describe, expect, it } from "vitest";
import { nextRowIndex, resolveActiveIndex, rowAccessibleName } from "../src/shared/row-nav.js";
import { statusOf, toLedgerRows } from "../src/shared/rows.js";

describe("resolveActiveIndex: the active row follows its hash through a sort, a filter or an insert", () => {
	const rows = Array.from({ length: 60 }, (_, i) => ({ hash: `h${i}` }));

	it("the last row stays active when the sort is reversed: its index becomes 0", () => {
		expect(resolveActiveIndex(rows, "h59", null)).toBe(59);
		const reversed = [...rows].reverse();
		expect(resolveActiveIndex(reversed, "h59", null)).toBe(0);
	});

	it("a live insert at the top moves the index, not the row", () => {
		expect(resolveActiveIndex([{ hash: "new" }, ...rows], "h10", null)).toBe(11);
	});

	it("an active row filtered out: the open row stands in, else the first row", () => {
		const filtered = rows.slice(0, 20);
		expect(resolveActiveIndex(filtered, "h59", "h7")).toBe(7);
		expect(resolveActiveIndex(filtered, "h59", "h59")).toBe(0);
		expect(resolveActiveIndex(filtered, "h59", null)).toBe(0);
		expect(resolveActiveIndex(filtered, null, undefined)).toBe(0);
	});

	it("an empty list has no active row", () => {
		expect(resolveActiveIndex([], "h1", "h1")).toBe(-1);
	});
});

describe("nextRowIndex", () => {
	const N = 60;
	const PAGE = 8;
	const go = (cur: number, key: string, count = N, page = PAGE) =>
		nextRowIndex(cur, key, count, page);

	it("ArrowDown and ArrowUp move by one", () => {
		expect(go(10, "ArrowDown")).toBe(11);
		expect(go(10, "ArrowUp")).toBe(9);
	});

	it("stops at both ends and does not wrap", () => {
		expect(go(N - 1, "ArrowDown")).toBe(N - 1);
		expect(go(0, "ArrowUp")).toBe(0);
		expect(go(N - 3, "PageDown")).toBe(N - 1);
		expect(go(3, "PageUp")).toBe(0);
	});

	it("Home and End go to the first and last row, from anywhere", () => {
		expect(go(30, "Home")).toBe(0);
		expect(go(30, "End")).toBe(N - 1);
		expect(go(0, "Home")).toBe(0);
		expect(go(N - 1, "End")).toBe(N - 1);
	});

	it("PageDown and PageUp move by a screenful", () => {
		expect(go(10, "PageDown")).toBe(10 + PAGE);
		expect(go(30, "PageUp")).toBe(30 - PAGE);
		expect(go(10, "PageDown", N, 1)).toBe(11);
	});

	it("a page size under 1, or not a number, moves one row", () => {
		expect(go(10, "PageDown", N, 0)).toBe(11);
		expect(go(10, "PageUp", N, -5)).toBe(9);
		expect(go(10, "PageDown", N, Number.NaN)).toBe(11);
	});

	it("a stale current index is clamped first (the rows changed under it)", () => {
		expect(go(500, "ArrowUp")).toBe(N - 2);
		expect(go(500, "ArrowDown")).toBe(N - 1);
		expect(go(-4, "ArrowDown")).toBe(1);
		expect(go(Number.NaN, "ArrowDown")).toBe(1);
	});

	it("a one-row list stays on its row for every movement key", () => {
		for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"])
			expect(go(0, key, 1)).toBe(0);
	});

	it("an empty list has nowhere to go: null, so the key is left alone", () => {
		for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"])
			expect(go(0, key, 0)).toBeNull();
		expect(go(0, "ArrowDown", -1)).toBeNull();
		expect(go(0, "ArrowDown", Number.NaN)).toBeNull();
	});

	it("any other key is not the list's: null", () => {
		for (const key of ["Enter", " ", "Escape", "Tab", "a", "ArrowLeft", "ArrowRight", ""])
			expect(go(10, key)).toBeNull();
	});
});

function evt(n: number, over: Partial<PersistedAuditEvent> & { data?: Record<string, unknown> }) {
	return {
		id: `id-${n}`,
		timestamp: "2026-07-27T10:15:30.000Z",
		previousHash: "0".repeat(64),
		hash: `${n}`.padStart(64, "a"),
		kind: "llm_call",
		actor: "local",
		data: {},
		sequence: n,
		...over,
	} as PersistedAuditEvent;
}

describe("rowAccessibleName", () => {
	it("says the model, the cost as shown, the time and the status", () => {
		const [row] = toLedgerRows(
			[evt(1, { data: { model: "gpt-5", cost: 1234, provider: "openai" } })],
			{ valid: true, breakIndex: null },
		);
		const name = rowAccessibleName(row as NonNullable<typeof row>);
		expect(name).toContain("gpt-5");
		expect(name).toContain("1,234 UT");
		expect(name).toContain("07-27 10:15:30Z");
		expect(name.endsWith(`, ${statusOf(row as NonNullable<typeof row>)}`)).toBe(true);
	});

	it("names the kind where a row has no model, and says plainly when no cost was recorded", () => {
		const [row] = toLedgerRows([evt(1, { kind: "policy_denied", data: {} })], {
			valid: true,
			breakIndex: null,
		});
		const name = rowAccessibleName(row as NonNullable<typeof row>);
		expect(name.startsWith("policy_denied, no cost recorded, ")).toBe(true);
		expect(name).not.toContain(" 0 UT");
	});

	it("says so for a row after a chain break", () => {
		const rows = toLedgerRows([evt(1, {}), evt(2, {})], { valid: false, breakIndex: 1 });
		expect(rowAccessibleName(rows[0] as NonNullable<(typeof rows)[0]>)).not.toContain(
			"after break",
		);
		expect(rowAccessibleName(rows[1] as NonNullable<(typeof rows)[1]>)).toMatch(/, after break$/);
	});
});
