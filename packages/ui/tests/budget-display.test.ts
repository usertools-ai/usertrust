// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { budgetAsOf, budgetDisplay, budgetSourceWord } from "../src/shared/budget-display.js";

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
			"unknown: not yet published; no governor has recorded the budget it enforces",
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

describe("budgetSourceWord", () => {
	it("only a governor's record reads as enforced; a config budget is unconfirmed; the rest are unknown", () => {
		expect(budgetSourceWord("governor")).toEqual({ word: "enforced", tone: "ink" });
		expect(budgetSourceWord("config")).toEqual({ word: "config · unconfirmed", tone: "info" });
		for (const source of ["several", "unreadable", "unpublished"] as const)
			expect(budgetSourceWord(source)).toEqual({ word: "unknown", tone: "body" });
	});
});

/** The line under a known budget: a governor's record says when it was written, with its year. */
describe("budgetAsOf", () => {
	it("red-first (MM-DD only): a record from an earlier year shows its year, so it never reads as current", () => {
		const line = budgetAsOf({
			budgetSource: "governor",
			budgetWrittenAt: "2025-10-12T21:58:00.000Z",
			budgetProvenance: "P",
		});
		expect(line).toBe("published by the governor, as of 2025-10-12 21:58Z");
	});

	it("the date is the UTC instant's, even where an offset moves it into another year", () => {
		const line = budgetAsOf({
			budgetSource: "governor",
			budgetWrittenAt: "2026-01-01T01:30:00+02:00",
			budgetProvenance: "P",
		});
		expect(line).toBe("published by the governor, as of 2025-12-31 23:30Z");
	});

	it.each([
		["a config budget", "config", "2026-10-12T21:58:00.000Z"],
		["a governor record with no time", "governor", null],
	] as const)("%s shows its provenance sentence", (_n, budgetSource, budgetWrittenAt) => {
		expect(budgetAsOf({ budgetSource, budgetWrittenAt, budgetProvenance: "P" })).toBe("P");
	});
});
