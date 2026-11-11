// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The sentences the Now window prints that a test pins. One place, so a wording rule is checked once: a rate is
 * "unusual", never given a cause; a forecast is a "Projection"; the hash links are "intact", which is all the
 * dashboard checks.
 */
export const NOW_COPY = {
	scopeVault: "whole vault",
	scopeFiltered: "llm calls · filtered",
	scopeFilteredPast: "llm calls · filtered, up to this point",
	scopeFilteredHeld: "llm calls · filtered, rows held only",
	scopeFilteredHeldPast: "llm calls · filtered, rows held only, up to this point",
	rateHeading: "Rate now",
	rateHeadingFiltered: "Rate now · filtered",
	rateUnknown: "too little history to call",
	rateUnusual: "unusual spend rate",
	rateNormal: "normal rate",
	rateTip: "The last hour's spend against the usual range of the 24 hours before",
	rateNotWhole: "The list begins inside the last hour, so its spend is not known",
	rateFromFirstWhole: ", beginning at the first whole hour listed",
	rateBandNote: "The shaded band is the usual range for those hours.",
	projectionLead: "Projection:",
	projectionLeadFiltered: "Projection, whole vault:",
	projectionUsed: "Projection: the budget is already used",
	projectionIdle: "Projection: no spend in the past week, so no date",
	projectionPaceWeek: "the past week's pace",
	projectionPaceYoung: "the pace so far",
	lastRecord: "Last record",
	lastRecordFiltered: "Last record · filtered",
	integrityIntact: "hash links intact",
	integrityMonitor: "The dashboard is a monitor: usertrust verify is the authoritative check.",
	statusEmpty: "no records in this view",
} as const;

/**
 * A projection's sentence as it reads while a filter is on. The projection is the whole vault's whatever is
 * filtered (a whole-vault budget against a whole-vault pace), so beside filtered figures its opening says so.
 */
export function wholeVaultProjection(sentence: string): string {
	return `${NOW_COPY.projectionLeadFiltered}${sentence.slice(NOW_COPY.projectionLead.length)}`;
}

/** The average a projection assumes for a vault with a week or more of spend records. `perDay` is a printed pace. */
export function weekPaceWords(perDay: string): string {
	return `the past 7 days' average of ${perDay}`;
}

/**
 * The average a projection assumes for a vault whose first spend record is under 7 days old: it names that age,
 * since there is no week to average.
 */
export function youngPaceWords(perDay: string, ageDays: number): string {
	const age = ageDays < 1 ? "under a day ago" : `${ageDays.toFixed(1)} days ago`;
	return `the average of ${perDay} since the first spend record, ${age},`;
}
