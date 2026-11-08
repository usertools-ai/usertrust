// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	BUDGET_RECORD_FRESH_MS,
	budgetAsOf,
	budgetDisplay,
	budgetRecordAge,
	budgetSourceWord,
	formatRecordAge,
	isControllerRecord,
} from "../src/shared/budget-display.js";

/** What the summary strip shows for the budget: an UNKNOWN budget has no remaining figure at all. */
describe("budgetDisplay", () => {
	it.each([
		["unknown (no budget): 'budget unknown', no figure", null, null, { kind: "unknown" }],
		["a budget with no remaining figure: unknown, never a bar", 2_000, null, { kind: "unknown" }],
		["a zero budget: unknown, never a division", 0, 0, { kind: "unknown" }],
		[
			"a NaN remaining figure: unknown, never a gold NaN% bar",
			1_000,
			Number.NaN,
			{ kind: "unknown" },
		],
		["a NaN budget: unknown", Number.NaN, 500, { kind: "unknown" }],
		["an infinite remaining figure: unknown", 1_000, Number.POSITIVE_INFINITY, { kind: "unknown" }],
		["remaining well above 20%: gold", 2_000, 1_700, { kind: "known", leftPct: 85, fill: "gold" }],
		["50% used: gold", 1_000, 500, { kind: "known", leftPct: 50, fill: "gold" }],
		// The cut points are strict on the remaining fraction. 79.9% used (0.201 left) is gold; exactly 80% used
		// (0.2 left) is STILL gold; MORE than 80% used (0.199 left) is warn.
		["79.9% used (0.201 left): gold", 1_000, 201, { kind: "known", leftPct: 20.1, fill: "gold" }],
		[
			"exactly 80% used (0.2 left): still gold",
			1_000,
			200,
			{ kind: "known", leftPct: 20, fill: "gold" },
		],
		["80.1% used (0.199 left): warn", 1_000, 199, { kind: "known", leftPct: 19.9, fill: "warn" }],
		["90% used: warn", 1_000, 100, { kind: "known", leftPct: 10, fill: "warn" }],
		// Exactly 95% used (0.05 left) is STILL warn; MORE than 95% used (0.049 left) is danger.
		["94.9% used (0.051 left): warn", 1_000, 51, { kind: "known", leftPct: 5.1, fill: "warn" }],
		[
			"exactly 95% used (0.05 left): still warn",
			1_000,
			50,
			{ kind: "known", leftPct: 5, fill: "warn" },
		],
		["95.1% used (0.049 left): danger", 1_000, 49, { kind: "known", leftPct: 4.9, fill: "danger" }],
		["99% used: danger", 1_000, 10, { kind: "known", leftPct: 1, fill: "danger" }],
		["fully used (nothing left): danger", 1_000, 0, { kind: "known", leftPct: 0, fill: "danger" }],
		[
			"overspent: clamped to 0%, danger, never a negative bar",
			1_000,
			-50,
			{ kind: "known", leftPct: 0, fill: "danger" },
		],
	] as const)("%s", (_n, budget, remainingUt, expected) => {
		const shown = budgetDisplay({ budget, remainingUt, budgetProvenance: "P" });
		// leftPct is a float (79.9 + 0.1 style noise, e.g. 19.900000000000002); the fill is the exact, load-bearing part.
		const { leftPct, ...rest } = expected as { leftPct?: number };
		expect(shown).toMatchObject({ ...rest, provenance: "P" });
		if (leftPct !== undefined && shown.kind === "known")
			expect(shown.leftPct).toBeCloseTo(leftPct, 9);
	});

	it("the one figure is what is LEFT: a full budget is 100, 36.6% left is 36.6, nothing left and overspent are 0", () => {
		const left = (budget: number, remainingUt: number) => {
			const shown = budgetDisplay({ budget, remainingUt, budgetProvenance: "P" });
			return shown.kind === "known" ? shown.leftPct : Number.NaN;
		};
		expect(left(1_000, 1_000)).toBe(100);
		expect(left(1_000, 366)).toBeCloseTo(36.6, 9);
		expect(left(2_000, 300)).toBeCloseTo(15, 9);
		expect(left(1_000, 0)).toBe(0);
		expect(left(1_000, -50)).toBe(0);
		// A remaining figure above the budget cannot draw a bar wider than the track.
		expect(left(1_000, 1_500)).toBe(100);
	});

	it("red-first (no reason): an unknown budget is shown WITH which unknown it is", () => {
		for (const provenance of [
			"unknown: not yet published; no controller has recorded the budget it enforces",
			"unknown: the enforced-budget record could not be read; not valid JSON",
		]) {
			expect(
				budgetDisplay({ budget: null, remainingUt: null, budgetProvenance: provenance }),
			).toEqual({
				kind: "unknown",
				provenance,
			});
		}
	});

	it("red-first (no provenance): a config budget's figure is shown WITH 'not confirmed as enforced'", () => {
		const shown = budgetDisplay({
			budget: 1_000,
			remainingUt: 700,
			budgetProvenance: "from usertrust.config.json; not confirmed as enforced",
		});
		expect(shown).toMatchObject({
			kind: "known",
			provenance: "from usertrust.config.json; not confirmed as enforced",
		});
	});
});

const WRITTEN = "2026-11-02T23:33:00.000Z";
const T0 = Date.parse(WRITTEN);
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("BUDGET_RECORD_FRESH_MS", () => {
	it("is the ruling's bound: 15 minutes", () => {
		expect(BUDGET_RECORD_FRESH_MS).toBe(15 * MIN);
	});
});

/** The age in words: never negative, never a clock time. */
describe("formatRecordAge", () => {
	it.each([
		["0 s", 0, "just now"],
		["59 s", 59 * SEC, "just now"],
		["60 s", 60 * SEC, "1 min ago"],
		["12 min", 12 * MIN, "12 min ago"],
		["15 min", 15 * MIN, "15 min ago"],
		["59 min 59 s", 59 * MIN + 59 * SEC, "59 min ago"],
		["1 h exactly", HOUR, "1 h ago"],
		["1 h 5 min", HOUR + 5 * MIN, "1 h 5 min ago"],
		["23 h 59 min", 23 * HOUR + 59 * MIN, "23 h 59 min ago"],
		["1 day", DAY, "1 day ago"],
		["2 days", 2 * DAY, "2 days ago"],
		["a negative age (clock skew)", -5 * MIN, "just now"],
	])("%s reads %s", (_n, ms, expected) => {
		expect(formatRecordAge(ms)).toBe(expected);
	});
});

describe("budgetRecordAge", () => {
	it.each([
		["0 s", 0, true, "recorded just now"],
		["59 s", 59 * SEC, true, "recorded just now"],
		["12 min", 12 * MIN, true, "recorded 12 min ago"],
		["exactly 15 min is still fresh", 15 * MIN, true, "recorded 15 min ago"],
		["15 min + 1 s is stale", 15 * MIN + SEC, false, "recorded 15 min ago"],
		["1 h 5 min", HOUR + 5 * MIN, false, "recorded 1 h 5 min ago"],
		["2 days", 2 * DAY, false, "recorded 2 days ago"],
		["a record 1 min in the future (clock skew)", -MIN, true, "recorded just now"],
		["a record exactly 15 min in the future", -15 * MIN, true, "recorded just now"],
		["a record 15 min + 1 s in the future", -(15 * MIN + SEC), false, "recorded just now"],
		["a record a day in the future", -DAY, false, "recorded just now"],
	])("%s", (_n, age, fresh, line) => {
		const got = budgetRecordAge(WRITTEN, T0 + age);
		expect(got.fresh).toBe(fresh);
		expect(got.line).toBe(line);
		expect(got.exact).toBe("as of 2026-11-02 23:33Z");
	});

	it("a time that cannot be read is never fresh", () => {
		expect(budgetRecordAge("not a time", T0)).toEqual({
			fresh: false,
			line: "recorded at a time that cannot be read",
			exact: "not a time",
		});
	});
});

describe("budgetSourceWord", () => {
	it("a controller's FRESH record reads as enforced", () => {
		expect(budgetSourceWord("governor", WRITTEN, T0 + 12 * MIN)).toEqual({
			word: "enforced",
			tone: "ink",
		});
		expect(budgetSourceWord("governor", WRITTEN, T0 + 15 * MIN)).toEqual({
			word: "enforced",
			tone: "ink",
		});
	});

	it("red-first (enforced forever): a record older than 15 minutes reads recorded, in the amber tone, never enforced", () => {
		for (const age of [15 * MIN + SEC, HOUR + 5 * MIN, 2 * DAY])
			expect(budgetSourceWord("governor", WRITTEN, T0 + age)).toEqual({
				word: "recorded",
				tone: "info",
			});
	});

	it("a controller's record with no time, or one dated far in the future, cannot prove it is fresh", () => {
		expect(budgetSourceWord("governor", null, T0).word).toBe("recorded");
		expect(budgetSourceWord("governor", WRITTEN, T0 - DAY).word).toBe("recorded");
	});

	it("the other sources are unchanged whatever the clock says", () => {
		for (const age of [0, 2 * DAY]) {
			expect(budgetSourceWord("config", null, T0 + age)).toEqual({
				word: "config · unconfirmed",
				tone: "info",
			});
			for (const source of ["several", "unreadable", "unpublished"] as const)
				expect(budgetSourceWord(source, null, T0 + age)).toEqual({ word: "unknown", tone: "body" });
		}
	});
});

/** The line under a known budget: a controller's record gives its age, with the exact UTC time as the tooltip. */
describe("budgetAsOf", () => {
	const record = {
		budgetSource: "governor",
		budgetWrittenAt: WRITTEN,
		budgetProvenance: "the enforced budget, as of 2026-11-02T23:33:00.000Z",
	} as const;

	it("a fresh record: the age against now, the exact time in the tooltip", () => {
		expect(budgetAsOf(record, T0 + 12 * MIN)).toEqual({
			text: "recorded 12 min ago",
			title: "as of 2026-11-02 23:33Z",
			isRecord: true,
		});
	});

	it("a stale record: the age, and the word enforced nowhere (not the provenance sentence either)", () => {
		const got = budgetAsOf(record, T0 + HOUR + 5 * MIN);
		expect(got).toEqual({
			text: "recorded 1 h 5 min ago",
			title: "as of 2026-11-02 23:33Z",
			isRecord: true,
		});
		expect(JSON.stringify(got)).not.toContain("enforced");
	});

	it("a record from an earlier year shows its year in the tooltip, so it never reads as current", () => {
		const got = budgetAsOf({ ...record, budgetWrittenAt: "2025-10-12T21:58:00.000Z" }, T0);
		expect(got.title).toBe("as of 2025-10-12 21:58Z");
		expect(got.text).toMatch(/^recorded \d+ days ago$/);
	});

	it("the date is the UTC instant's, even where an offset moves it into another year", () => {
		const at = "2026-01-01T01:30:00+02:00";
		expect(budgetAsOf({ ...record, budgetWrittenAt: at }, Date.parse(at)).title).toBe(
			"as of 2025-12-31 23:30Z",
		);
	});

	it("a controller's record with no time says so, and never calls the budget enforced", () => {
		const got = budgetAsOf({ ...record, budgetWrittenAt: null }, T0);
		expect(got).toEqual({ text: "recorded at an unknown time", title: null, isRecord: true });
	});

	it("a config budget shows its provenance sentence, unchanged", () => {
		expect(
			budgetAsOf({ budgetSource: "config", budgetWrittenAt: WRITTEN, budgetProvenance: "P" }, T0),
		).toEqual({ text: "P", title: null, isRecord: false });
	});
});

describe("isControllerRecord", () => {
	// The one place the display names the controller source's wire value; every check of it goes through here.
	it("is true only for a controller's own record of the budget it enforces", () => {
		expect(isControllerRecord("governor")).toBe(true);
		for (const other of ["config", "several", "unreadable", "unpublished"] as const) {
			expect(isControllerRecord(other)).toBe(false);
		}
	});
});
