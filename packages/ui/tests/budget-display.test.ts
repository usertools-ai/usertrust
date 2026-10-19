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
		["remaining well above 20%: chart", 2_000, 1_700, { kind: "known", pct: 85, fill: "chart" }],
		["under 20%: amber", 1_000, 100, { kind: "known", pct: 10, fill: "amber" }],
		["under 5%: danger", 1_000, 10, { kind: "known", pct: 1, fill: "danger" }],
		[
			"overspent: clamped to 0%, danger, never a negative bar",
			1_000,
			-50,
			{ kind: "known", pct: 0, fill: "danger" },
		],
	] as const)("%s", (_n, budget, remainingUt, expected) => {
		const shown = budgetDisplay({ budget, remainingUt, budgetProvenance: "P" });
		expect(shown).toEqual({ ...expected, provenance: "P" });
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
