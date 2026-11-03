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
		["remaining well above 20%: gold", 2_000, 1_700, { kind: "known", pct: 85, fill: "gold" }],
		["50% used: gold", 1_000, 500, { kind: "known", pct: 50, fill: "gold" }],
		// The cut points are strict on the remaining fraction. 79.9% used (0.201 left) is gold; exactly 80% used
		// (0.2 left) is STILL gold; MORE than 80% used (0.199 left) is warn.
		["79.9% used (0.201 left): gold", 1_000, 201, { kind: "known", pct: 20.1, fill: "gold" }],
		[
			"exactly 80% used (0.2 left): still gold",
			1_000,
			200,
			{ kind: "known", pct: 20, fill: "gold" },
		],
		["80.1% used (0.199 left): warn", 1_000, 199, { kind: "known", pct: 19.9, fill: "warn" }],
		["90% used: warn", 1_000, 100, { kind: "known", pct: 10, fill: "warn" }],
		// Exactly 95% used (0.05 left) is STILL warn; MORE than 95% used (0.049 left) is danger.
		["94.9% used (0.051 left): warn", 1_000, 51, { kind: "known", pct: 5.1, fill: "warn" }],
		[
			"exactly 95% used (0.05 left): still warn",
			1_000,
			50,
			{ kind: "known", pct: 5, fill: "warn" },
		],
		["95.1% used (0.049 left): danger", 1_000, 49, { kind: "known", pct: 4.9, fill: "danger" }],
		["99% used: danger", 1_000, 10, { kind: "known", pct: 1, fill: "danger" }],
		["fully used (nothing left): danger", 1_000, 0, { kind: "known", pct: 0, fill: "danger" }],
		[
			"overspent: clamped to 0%, danger, never a negative bar",
			1_000,
			-50,
			{ kind: "known", pct: 0, fill: "danger" },
		],
	] as const)("%s", (_n, budget, remainingUt, expected) => {
		const shown = budgetDisplay({ budget, remainingUt, budgetProvenance: "P" });
		// pct is a float (79.9 + 0.1 style noise, e.g. 19.900000000000002); the fill is the exact, load-bearing part.
		const { pct, ...rest } = expected as { pct?: number };
		expect(shown).toMatchObject({ ...rest, provenance: "P" });
		if (pct !== undefined && shown.kind === "known") {
			expect(shown.pct).toBeCloseTo(pct, 9);
			// The bar fills with what is USED, the complement of what the strip says is left, clamped to 0-100.
			expect(shown.usedPct).toBeCloseTo(100 - pct, 9);
		}
	});

	it("the bar fill is the USED percentage: 85% used is 85, a full budget is 100, overspent stays 100", () => {
		const used = (budget: number, remainingUt: number) => {
			const shown = budgetDisplay({ budget, remainingUt, budgetProvenance: "P" });
			return shown.kind === "known" ? shown.usedPct : Number.NaN;
		};
		expect(used(1_000, 1_000)).toBe(0);
		expect(used(2_000, 300)).toBeCloseTo(85, 9);
		expect(used(1_000, 0)).toBe(100);
		expect(used(1_000, -50)).toBe(100);
		// A remaining figure above the budget cannot draw a negative bar.
		expect(used(1_000, 1_500)).toBe(0);
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
		expect(line).toBe("published by the controller, as of 2025-10-12 21:58Z");
	});

	it("the date is the UTC instant's, even where an offset moves it into another year", () => {
		const line = budgetAsOf({
			budgetSource: "governor",
			budgetWrittenAt: "2026-01-01T01:30:00+02:00",
			budgetProvenance: "P",
		});
		expect(line).toBe("published by the controller, as of 2025-12-31 23:30Z");
	});

	it.each([
		["a config budget", "config", "2026-10-12T21:58:00.000Z"],
		["a governor record with no time", "governor", null],
	] as const)("%s shows its provenance sentence", (_n, budgetSource, budgetWrittenAt) => {
		expect(budgetAsOf({ budgetSource, budgetWrittenAt, budgetProvenance: "P" })).toBe("P");
	});
});
