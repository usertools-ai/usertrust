// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Pure filter engine shared by the audit table and trends dashboard.
 * Lives in src/shared so it stays unit-tested and coverage-counted.
 */

import { type LedgerRow, statusOf } from "./rows.js";

export interface FilterState {
	search: string;
	kinds: string[];
	models: string[];
	actors: string[];
	statuses: string[];
	from?: string;
	to?: string;
	costMin?: number;
	costMax?: number;
}

export const EMPTY_FILTERS: FilterState = {
	search: "",
	kinds: [],
	models: [],
	actors: [],
	statuses: [],
};

export function isFiltering(f: FilterState): boolean {
	return (
		f.search.trim() !== "" ||
		f.kinds.length > 0 ||
		f.models.length > 0 ||
		f.actors.length > 0 ||
		f.statuses.length > 0 ||
		f.from !== undefined ||
		f.to !== undefined ||
		f.costMin !== undefined ||
		f.costMax !== undefined
	);
}

function haystack(r: LedgerRow): string {
	return [r.id, r.kind, r.actor, r.model, r.provider, r.transferId, r.hash, r.source, r.error]
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
		const day = r.ts.slice(0, 10);
		if (f.from !== undefined && day < f.from) return false;
		if (f.to !== undefined && day > f.to) return false;
		if (f.costMin !== undefined && (r.costUt ?? 0) < f.costMin) return false;
		if (f.costMax !== undefined && (r.costUt ?? 0) > f.costMax) return false;
		return true;
	});
}
