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
			leftPct: number;
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
		// `leftPct` is what is LEFT, clamped to 0-100: the one figure the strip prints AND the width the bar fills to, so
		// the bar drains as money is spent, like a fuel gauge. An overspent budget is an empty bar, never a negative one.
		leftPct: Math.max(0, Math.min(100, frac * 100)),
		fill,
		provenance: s.budgetProvenance,
	};
}

/**
 * How old the controller's budget record may be and still read as `enforced`. The record is a file the controller wrote
 * at one point in time; it says nothing about the controller still running, so past this age the budget reads
 * `recorded`, never `enforced`. This is the ruling's bound, kept in one place; the controller's publish interval may
 * replace it later.
 */
export const BUDGET_RECORD_FRESH_MS = 15 * 60 * 1000;

/** How the controller's record reads right now: its age in words, whether it is fresh, and its exact UTC time. */
export type BudgetRecordAge = {
	/** Within BUDGET_RECORD_FRESH_MS of `now`, either side (a clock that runs ahead counts as fresh only that far). */
	fresh: boolean;
	/** `recorded 12 min ago`; never a negative age. */
	line: string;
	/** `as of 2026-11-02 23:33Z`, for a tooltip. */
	exact: string;
};

/** An age as words: `just now` under a minute, then minutes, then hours (`1 h 5 min ago`), then days. */
export function formatRecordAge(ageMs: number): string {
	const minutes = Math.floor(Math.max(0, ageMs) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest === 0 ? `${hours} h ago` : `${hours} h ${rest} min ago`;
	}
	const days = Math.floor(hours / 24);
	return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * The age of a controller's record at `now` (ms since the epoch; passed in so the result is testable). A time that
 * cannot be read is never fresh. A time in the future (clock skew) reads `recorded just now` and is fresh only within
 * the same window, so a record dated far ahead cannot hold `enforced` indefinitely.
 */
export function budgetRecordAge(writtenAt: string, now: number): BudgetRecordAge {
	const t = Date.parse(writtenAt);
	if (Number.isNaN(t))
		return { fresh: false, line: "recorded at a time that cannot be read", exact: writtenAt };
	const age = now - t;
	return {
		fresh: Math.abs(age) <= BUDGET_RECORD_FRESH_MS,
		line: `recorded ${formatRecordAge(age)}`,
		exact: `as of ${formatUtcMinute(writtenAt)}`,
	};
}

/**
 * The budget's source as one word, beside the figure; the full provenance sentence is in its tooltip. Only a
 * controller's FRESH record of what it enforces reads as enforced: an older one (or one with no readable time) reads
 * `recorded`, in the amber tone, because the file cannot say the controller is still running.
 */
export function budgetSourceWord(
	source: SummaryPayload["budgetSource"],
	writtenAt: string | null,
	now: number,
): {
	word: string;
	tone: "ink" | "info" | "body";
} {
	if (source === "governor")
		return writtenAt !== null && budgetRecordAge(writtenAt, now).fresh
			? { word: "enforced", tone: "ink" }
			: { word: "recorded", tone: "info" };
	if (source === "config") return { word: "config · unconfirmed", tone: "info" };
	return { word: "unknown", tone: "body" };
}

/**
 * The line under a known budget, with the exact time for its tooltip. A controller's record gives its AGE relative to
 * `now`, not a clock time to do sums on; the exact UTC time (with its year) is the tooltip. The provenance sentence
 * calls a controller's budget "enforced", so a controller's record never shows it: the age line is shown instead. Any
 * other source shows its provenance sentence. `isRecord` says which of the two it is.
 */
export function budgetAsOf(
	s: Pick<SummaryPayload, "budgetSource" | "budgetWrittenAt" | "budgetProvenance">,
	now: number,
): { text: string; title: string | null; isRecord: boolean } {
	if (s.budgetSource !== "governor")
		return { text: s.budgetProvenance, title: null, isRecord: false };
	if (s.budgetWrittenAt === null)
		return { text: "recorded at an unknown time", title: null, isRecord: true };
	const age = budgetRecordAge(s.budgetWrittenAt, now);
	return { text: age.line, title: age.exact, isRecord: true };
}
