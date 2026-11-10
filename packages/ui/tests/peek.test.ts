// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * What the record panel works out about one record from the records around it: an unusually busy hour for its
 * actor and model, its share of the budget, the budget it is a share of, its neighbour in the list, and whether it
 * falls in a span of time. Pure functions, pinned here.
 */

import { describe, expect, it } from "vitest";
import type { AtPayload, SummaryPayload } from "../src/shared/api.js";
import {
	budgetOf,
	budgetShare,
	rowInSpan,
	stepRecord,
	UNUSUAL_FACTOR,
	UNUSUAL_MIN,
	unusualNote,
} from "../src/shared/peek.js";
import type { LedgerRow } from "../src/shared/rows.js";

const HOUR = 3_600_000;
/** 14:00 UTC, the start of the hour the record under test is in. */
const H0 = Date.UTC(2026, 10, 3, 14);

let made = 0;
function row(ms: number, overrides: Partial<LedgerRow> = {}): LedgerRow {
	made++;
	return {
		seq: made,
		pos: made,
		id: `e${made}`,
		ts: new Date(ms).toISOString(),
		kind: "llm_call",
		actor: "a",
		model: "m",
		hash: `h${made}`,
		previousHash: `h${made - 1}`,
		integrity: "verified",
		...overrides,
	};
}

/** `n` calls spread inside the hour that starts at `h0`. */
function inHour(n: number, overrides: Partial<LedgerRow> = {}, h0: number = H0): LedgerRow[] {
	return Array.from({ length: n }, (_, i) => row(h0 + 60_000 + i * 60_000, overrides));
}

/** `n` calls spread evenly over the 168 hours before `H0`. */
function before(n: number, overrides: Partial<LedgerRow> = {}): LedgerRow[] {
	const step = (168 * HOUR) / n;
	return Array.from({ length: n }, (_, i) =>
		row(H0 - 168 * HOUR + Math.floor(i * step), overrides),
	);
}

/** The first row of `rows`: the note is the same whichever call of the hour is opened. */
function first(rows: LedgerRow[]): LedgerRow {
	const r = rows[0];
	if (r === undefined) throw new Error("no rows");
	return r;
}

describe("unusualNote", () => {
	it("the thresholds: at least 8 calls in the hour, and at least 3 times the usual", () => {
		expect(UNUSUAL_MIN).toBe(8);
		expect(UNUSUAL_FACTOR).toBe(3);
	});

	it("10 calls in an hour against a usual 1 an hour is said, with both numbers", () => {
		const hour = inHour(10);
		expect(unusualNote([...before(168), ...hour], first(hour))).toEqual({
			calls: 10,
			usual: 1,
			text: "Unusual: 10 calls from a to m in this hour (usual 1)",
		});
	});

	it("the note is about the record's hour, whichever of its calls is opened and wherever it is in the rows", () => {
		const hour = inHour(10);
		const rows = [...hour.slice(0, 4), ...before(168), ...hour.slice(4)];
		const last = hour[9];
		if (last === undefined) throw new Error("no rows");
		expect(unusualNote(rows, last)?.text).toBe(
			"Unusual: 10 calls from a to m in this hour (usual 1)",
		);
	});

	it("no history at all: the usual is said as under 1, never as a figure it is not", () => {
		const hour = inHour(10);
		const note = unusualNote(hour, first(hour));
		expect(note?.text).toBe("Unusual: 10 calls from a to m in this hour (usual under 1)");
		// The number the test used, never below 1.
		expect(note?.usual).toBe(1);
		expect(note?.calls).toBe(10);
	});

	it("under half a call an hour is under 1; exactly half is 1", () => {
		const hour = inHour(10);
		// 83 in 168 hours is 0.494 an hour.
		expect(unusualNote([...before(83), ...hour], first(hour))?.text).toBe(
			"Unusual: 10 calls from a to m in this hour (usual under 1)",
		);
		// 84 in 168 hours is exactly 0.5.
		expect(unusualNote([...before(84), ...hour], first(hour))?.text).toBe(
			"Unusual: 10 calls from a to m in this hour (usual 1)",
		);
	});

	it("a busier usual raises the bar and is printed rounded", () => {
		// 5 an hour before: 15 calls is 3 times that, 14 is not.
		const usual5 = before(840);
		const fourteen = inHour(14);
		expect(unusualNote([...usual5, ...fourteen], first(fourteen))).toBeNull();
		const fifteen = inHour(15);
		expect(unusualNote([...usual5, ...fifteen], first(fifteen))).toEqual({
			calls: 15,
			usual: 5,
			text: "Unusual: 15 calls from a to m in this hour (usual 5)",
		});
		// 1.5 an hour before prints as 2; the bar is 4.5 calls, so the minimum of 8 decides.
		const eight = inHour(8);
		expect(unusualNote([...before(252), ...eight], first(eight))?.text).toBe(
			"Unusual: 8 calls from a to m in this hour (usual 2)",
		);
	});

	it("7 calls in the hour say nothing; 8 do", () => {
		const seven = inHour(7);
		expect(unusualNote(seven, first(seven))).toBeNull();
		const eight = inHour(8);
		expect(unusualNote(eight, first(eight))?.calls).toBe(8);
	});

	it("10 calls by two actors, 5 and 5, say nothing for either", () => {
		const a = inHour(5);
		const b = inHour(5, { actor: "b" });
		expect(unusualNote([...a, ...b], first(a))).toBeNull();
		expect(unusualNote([...a, ...b], first(b))).toBeNull();
	});

	it("another model and another kind of record are not counted", () => {
		const mine = inHour(5);
		const otherModel = inHour(5, { model: "n" });
		const failed = inHour(5, { kind: "llm_call_failed" });
		expect(unusualNote([...mine, ...otherModel, ...failed], first(mine))).toBeNull();
		// Nor do they count toward the usual: 840 calls to another model leave this pair's usual under 1.
		const ten = inHour(10);
		expect(unusualNote([...before(840, { model: "n" }), ...ten], first(ten))?.text).toBe(
			"Unusual: 10 calls from a to m in this hour (usual under 1)",
		);
	});

	it("a record with no model says nothing", () => {
		const { model: _model, ...noModel } = row(H0 + 1);
		const rows: LedgerRow[] = Array.from({ length: 10 }, () => ({ ...noModel }));
		expect(unusualNote(rows, noModel)).toBeNull();
	});

	it("a record whose time cannot be read says nothing, and such a record is never counted", () => {
		const hour = inHour(10);
		const unreadable = row(H0, { ts: "not a date" });
		expect(unusualNote([...hour, unreadable], unreadable)).toBeNull();
		const seven = inHour(7);
		expect(unusualNote([...seven, unreadable], first(seven))).toBeNull();
	});

	it("the hour is [h0, h0 + 1h): a call at exactly h0 is in it, one at exactly h0 + 1h is not", () => {
		const seven = inHour(7);
		const opened = first(seven);
		expect(unusualNote([...seven, row(H0 + HOUR)], opened)).toBeNull();
		expect(unusualNote([...seven, row(H0 + HOUR - 1)], opened)?.calls).toBe(8);
		expect(unusualNote([...seven, row(H0)], opened)?.calls).toBe(8);
		// A call a millisecond before h0 belongs to the history, not the hour.
		expect(unusualNote([...seven, row(H0 - 1)], opened)).toBeNull();
	});

	it("the history is the 168 hours before the hour: a call at exactly its start counts, one before it does not", () => {
		const hour = inHour(10);
		const start = H0 - 168 * HOUR;
		// 83 calls strictly inside the window, each an hour apart, and one more at its edge.
		const inside = Array.from({ length: 83 }, (_, i) => row(start + (i + 1) * HOUR));
		expect(unusualNote([...inside, row(start), ...hour], first(hour))?.text).toBe(
			"Unusual: 10 calls from a to m in this hour (usual 1)",
		);
		expect(unusualNote([...inside, row(start - 1), ...hour], first(hour))?.text).toBe(
			"Unusual: 10 calls from a to m in this hour (usual under 1)",
		);
	});

	it("calls after the hour are not history", () => {
		const hour = inHour(10);
		const later = inHour(200, {}, H0 + HOUR);
		expect(unusualNote([...hour, ...later], first(hour))?.text).toBe(
			"Unusual: 10 calls from a to m in this hour (usual under 1)",
		);
	});
});

describe("budgetShare", () => {
	it("says the share with the precision it needs", () => {
		expect(budgetShare(20_000, 1_000_000)).toBe("2.0% of the budget");
		expect(budgetShare(5_000, 1_000_000)).toBe("0.500% of the budget");
		expect(budgetShare(1, 1_000_000)).toBe("0.00010% of the budget");
	});

	it("the steps are at 1% and at 0.01%", () => {
		expect(budgetShare(10_000, 1_000_000)).toBe("1.0% of the budget");
		expect(budgetShare(9_990, 1_000_000)).toBe("0.999% of the budget");
		expect(budgetShare(100, 1_000_000)).toBe("0.010% of the budget");
		expect(budgetShare(99, 1_000_000)).toBe("0.00990% of the budget");
		expect(budgetShare(2_500_000, 1_000_000)).toBe("250.0% of the budget");
	});

	it("no cost, or no budget to be a share of: null, never a figure", () => {
		expect(budgetShare(undefined, 1)).toBeNull();
		expect(budgetShare(5, null)).toBeNull();
		expect(budgetShare(5, 0)).toBeNull();
		expect(budgetShare(5, -100)).toBeNull();
		expect(budgetShare(Number.NaN, 100)).toBeNull();
		expect(budgetShare(5, Number.NaN)).toBeNull();
	});
});

describe("budgetOf", () => {
	const summary: Pick<SummaryPayload, "budget" | "budgetProvenance"> = {
		budget: 1_000_000,
		budgetProvenance: "from the vault config",
	};
	const at: Pick<AtPayload, "budget"> = {
		budget: {
			ut: 750_000,
			source: "config",
			writtenAt: null,
			provenance: "from the vault config, as of now",
			note: "The budget in force now, not at this record.",
		},
	};

	it("live: the summary's budget and where it came from, with no note", () => {
		expect(budgetOf(summary, null)).toEqual({
			ut: 1_000_000,
			provenance: "from the vault config",
			note: null,
		});
	});

	it("at a past position: that answer's budget, where it came from, and its note", () => {
		expect(budgetOf(summary, at)).toEqual({
			ut: 750_000,
			provenance: "from the vault config, as of now",
			note: "The budget in force now, not at this record.",
		});
		// The position's answer is enough by itself.
		expect(budgetOf(null, at).ut).toBe(750_000);
	});

	it("an unknown budget stays unknown, with the words that say which unknown", () => {
		expect(
			budgetOf({ budget: null, budgetProvenance: "unknown: no record published" }, null),
		).toEqual({ ut: null, provenance: "unknown: no record published", note: null });
		const unknownAt: Pick<AtPayload, "budget"> = {
			budget: { ...at.budget, ut: null, source: "unreadable", provenance: "unknown: unreadable" },
		};
		expect(budgetOf(summary, unknownAt)).toEqual({
			ut: null,
			provenance: "unknown: unreadable",
			note: "The budget in force now, not at this record.",
		});
	});

	it("nothing loaded yet: no budget, and no words claiming a source", () => {
		expect(budgetOf(null, null)).toEqual({ ut: null, provenance: "", note: null });
	});
});

describe("stepRecord", () => {
	const order = [{ hash: "a" }, { hash: "b" }, { hash: "c" }];

	it("the middle record has a neighbour either way", () => {
		expect(stepRecord(order, "b", -1)).toBe("a");
		expect(stepRecord(order, "b", 1)).toBe("c");
	});

	it("there is nothing before the first or after the last", () => {
		expect(stepRecord(order, "a", -1)).toBeNull();
		expect(stepRecord(order, "c", 1)).toBeNull();
		expect(stepRecord(order, "a", 1)).toBe("b");
		expect(stepRecord(order, "c", -1)).toBe("b");
	});

	it("a record that is not in the list has no neighbour", () => {
		expect(stepRecord(order, "z", 1)).toBeNull();
		expect(stepRecord(order, "z", -1)).toBeNull();
		expect(stepRecord([], "a", 1)).toBeNull();
	});

	it("the order is the one given, not the records' own", () => {
		const reversed = [...order].reverse();
		expect(stepRecord(reversed, "b", 1)).toBe("a");
	});
});

describe("rowInSpan", () => {
	const a = H0;
	const b = H0 + HOUR;
	const iso = (ms: number) => new Date(ms).toISOString();

	it("the span is [a, b): it includes a and excludes b", () => {
		expect(rowInSpan(iso(a), [a, b])).toBe(true);
		expect(rowInSpan(iso(a + 1), [a, b])).toBe(true);
		expect(rowInSpan(iso(b - 1), [a, b])).toBe(true);
		expect(rowInSpan(iso(b), [a, b])).toBe(false);
		expect(rowInSpan(iso(a - 1), [a, b])).toBe(false);
	});

	it("no span, or a time that cannot be read: false", () => {
		expect(rowInSpan(iso(a), null)).toBe(false);
		expect(rowInSpan("not a date", [a, b])).toBe(false);
		expect(rowInSpan("not a date", [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY])).toBe(
			false,
		);
	});
});
