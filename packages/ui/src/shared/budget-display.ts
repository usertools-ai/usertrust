// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { SummaryPayload } from "./api.js";

/**
 * What the summary strip shows for the budget. An UNKNOWN budget shows as unknown with NO remaining figure: computing
 * one from a placeholder printed a negative balance for a vault whose governor enforces a real budget.
 */
export type BudgetDisplay =
	| { kind: "unknown" }
	| { kind: "known"; pct: number; fill: "chart" | "amber" | "danger"; provenance: string };

export function budgetDisplay(
	s: Pick<SummaryPayload, "budget" | "remainingUt" | "budgetProvenance">,
): BudgetDisplay {
	if (s.budget === null || s.remainingUt === null || s.budget <= 0) return { kind: "unknown" };
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
