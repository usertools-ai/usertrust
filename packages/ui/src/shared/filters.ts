// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Pure filter engine shared by the audit table and trends dashboard.
 * Lives in src/shared so it stays unit-tested and coverage-counted.
 */

import { utcDay } from "./format.js";
import { jobTypeOf, type LedgerRow, statusOf, typeSourceOf } from "./rows.js";

export interface FilterState {
	search: string;
	kinds: string[];
	models: string[];
	actors: string[];
	statuses: string[];
	/** Job types as declared (`untyped` selects records with none). */
	jobTypes: string[];
	/** Who declared the type (`untyped` selects records with none). */
	typeSources: string[];
	// `| undefined`: a cleared field is set to undefined, and under exactOptionalPropertyTypes an optional field
	// declared without it refuses that.
	from?: string | undefined;
	to?: string | undefined;
	costMin?: number | undefined;
	costMax?: number | undefined;
}

export const EMPTY_FILTERS: FilterState = {
	search: "",
	kinds: [],
	models: [],
	actors: [],
	statuses: [],
	jobTypes: [],
	typeSources: [],
};

export function isFiltering(f: FilterState): boolean {
	return (
		f.search.trim() !== "" ||
		f.kinds.length > 0 ||
		f.models.length > 0 ||
		f.actors.length > 0 ||
		f.statuses.length > 0 ||
		f.jobTypes.length > 0 ||
		f.typeSources.length > 0 ||
		f.from !== undefined ||
		f.to !== undefined ||
		f.costMin !== undefined ||
		f.costMax !== undefined
	);
}

function haystack(r: LedgerRow): string {
	return [
		r.id,
		r.kind,
		r.actor,
		r.model,
		r.provider,
		r.transferId,
		r.hash,
		r.source,
		r.error,
		r.job,
	]
		.filter((v): v is string => typeof v === "string")
		.join(" ")
		.toLowerCase();
}

export function applyFilters(rows: LedgerRow[], f: FilterState): LedgerRow[] {
	const q = f.search.trim().toLowerCase();
	return rows.filter((r) => {
		if (q && !haystack(r).includes(q)) return false;
		if (f.kinds.length > 0 && !f.kinds.includes(r.kind)) return false;
		if (f.models.length > 0 && (r.model === undefined || !f.models.includes(r.model))) return false;
		if (f.actors.length > 0 && !f.actors.includes(r.actor)) return false;
		if (f.statuses.length > 0 && !f.statuses.includes(statusOf(r))) return false;
		if (f.jobTypes.length > 0 && !f.jobTypes.includes(jobTypeOf(r))) return false;
		if (f.typeSources.length > 0 && !f.typeSources.includes(typeSourceOf(r))) return false;
		// The UTC date: the date the row shows (`formatUtc`) and the date the pickers are labelled with.
		if (f.from !== undefined || f.to !== undefined) {
			const day = utcDay(r.ts);
			if (f.from !== undefined && day < f.from) return false;
			if (f.to !== undefined && day > f.to) return false;
		}
		// A row with no cost has an UNKNOWN cost, not 0: a cost bound keeps only rows with a cost in range. Read as 0,
		// "max 50 UT" kept every denial, release and ungoverned call as a cheap one.
		if (f.costMin !== undefined && (r.costUt === undefined || r.costUt < f.costMin)) return false;
		if (f.costMax !== undefined && (r.costUt === undefined || r.costUt > f.costMax)) return false;
		return true;
	});
}

export type SortKey = "seq" | "ts" | "kind" | "actor" | "model" | "costUt";

function compare(a: LedgerRow, b: LedgerRow, key: Exclude<SortKey, "costUt">): number {
	if (key === "seq") return (a.seq ?? 0) - (b.seq ?? 0);
	return String(a[key] ?? "").localeCompare(String(b[key] ?? ""));
}

/**
 * A sorted copy. By cost, rows with no cost go last in either direction: an unknown cost is not the cheapest one.
 */
export function sortRows(rows: readonly LedgerRow[], key: SortKey, desc: boolean): LedgerRow[] {
	if (key === "costUt") {
		const costed = rows.filter((r) => r.costUt !== undefined);
		const uncosted = rows.filter((r) => r.costUt === undefined);
		costed.sort((a, b) => ((a.costUt as number) - (b.costUt as number)) * (desc ? -1 : 1));
		return [...costed, ...uncosted];
	}
	const copy = [...rows].sort((a, b) => compare(a, b, key));
	return desc ? copy.reverse() : copy;
}
