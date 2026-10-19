// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { SummaryPayload } from "./api.js";
import { formatUtcMinute } from "./format.js";

/**
 * What the summary strip shows for the budget. An UNKNOWN budget shows as unknown with NO remaining figure: computing
 * one from a placeholder printed a negative balance for a vault whose governor enforces a real budget.
 */
export type BudgetDisplay =
	| { kind: "unknown"; provenance: string }
	| {
			kind: "known";
			pct: number;
			usedPct: number;
			fill: "gold" | "warn" | "danger";
			provenance: string;
	  };

export function budgetDisplay(
	s: Pick<SummaryPayload, "budget" | "remainingUt" | "budgetProvenance">,
): BudgetDisplay {
	// An unknown budget says WHICH unknown (several governors, an unreadable record, none published yet).
	if (
		s.budget === null ||
		s.remainingUt === null ||
		!Number.isFinite(s.budget) ||
		!Number.isFinite(s.remainingUt) ||
		s.budget <= 0
	)
		return { kind: "unknown", provenance: s.budgetProvenance };
	const frac = s.remainingUt / s.budget;
	// Healthy is gold (--gold), warn is orange (--warn, the --alert value), critical is red (--danger). Never green:
	// green is earned by verification only. Both cut points are STRICT on the remaining fraction: warn is MORE than 80% used (remaining
	// < 0.2), critical is MORE than 95% used (remaining < 0.05). Exactly 80% used (0.2 left) is still gold and exactly
	// 95% used (0.05 left) is still warn; the bar changes colour on the call that crosses the line, not the one that
	// lands on it. An overspent budget (negative remaining) is critical.
	const fill = frac < 0.05 ? "danger" : frac < 0.2 ? "warn" : "gold";
	// The provenance is shown with every known figure: a config budget says it is unconfirmed, a record its age.
	return {
		kind: "known",
		// `pct` is what is LEFT (the figure the strip prints); `usedPct` is what the bar FILLS to: it grows with spend, so
		// an overspent budget is a full bar (clamped to 100), never an overflow.
		pct: Math.max(0, Math.min(100, frac * 100)),
		usedPct: Math.max(0, Math.min(100, (1 - frac) * 100)),
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

/**
 * The line under a known budget. A governor's record says when it was written, WITH its year: a record surviving from an
 * earlier year must not read as current. Any other source shows its provenance sentence.
 */
export function budgetAsOf(
	s: Pick<SummaryPayload, "budgetSource" | "budgetWrittenAt" | "budgetProvenance">,
): string {
	return s.budgetSource === "governor" && s.budgetWrittenAt !== null
		? `published by the governor, as of ${formatUtcMinute(s.budgetWrittenAt)}`
		: s.budgetProvenance;
}
