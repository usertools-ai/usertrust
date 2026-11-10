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
	rateUnknown: "too little history to call",
	rateUnusual: "unusual spend rate",
	rateNormal: "normal rate",
	rateTip: "The last hour's spend against the usual range of the past week",
	rateBandNote: "The shaded band is the usual range for those hours.",
	projectionUsed: "Projection: the budget is already used",
	projectionIdle: "Projection: no spend in the past week, so no date",
	integrityIntact: "hash links intact",
	integrityMonitor: "The dashboard is a monitor: usertrust verify is the authoritative check.",
	statusEmpty: "no records in this view",
} as const;
