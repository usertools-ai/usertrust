// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { SummaryPayload } from "./api.js";

/**
 * What the summary strip shows for the budget. An UNKNOWN budget shows as unknown with NO remaining figure: computing
 * one from a placeholder printed a negative balance for a vault whose governor enforces a real budget.
 */
export type BudgetDisplay =
	| { kind: "unknown"; provenance: string }
	| { kind: "known"; pct: number; fill: "chart" | "amber" | "danger"; provenance: string };

export function budgetDisplay(
	s: Pick<SummaryPayload, "budget" | "remainingUt" | "budgetProvenance">,
): BudgetDisplay {
	// An unknown budget says WHICH unknown (several governors, an unreadable record, none published yet).
	if (s.budget === null || s.remainingUt === null || s.budget <= 0)
		return { kind: "unknown", provenance: s.budgetProvenance };
	const frac = s.remainingUt / s.budget;
	// Healthy budget is --chart (connectivity-neutral), never green: amber under 20% remaining, danger under 5%.
	const fill = frac > 0.2 ? "chart" : frac >= 0.05 ? "amber" : "danger";
	// The provenance is shown with every known figure: a config budget says it is unconfirmed, a record its age.
	return {
		kind: "known",
		pct: Math.max(0, Math.min(100, frac * 100)),
		fill,
		provenance: s.budgetProvenance,
	};
}

/**
 * The budget's source as one word, beside the figure; the full provenance sentence is in its tooltip. Only a
 * governor's record of what it enforces reads as enforced.
 */
export function budgetSourceWord(source: SummaryPayload["budgetSource"]): {
	word: string;
	tone: "ink" | "info" | "body";
} {
	if (source === "governor") return { word: "enforced", tone: "ink" };
	if (source === "config") return { word: "config · unconfirmed", tone: "info" };
	return { word: "unknown", tone: "body" };
}
