// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The filters a click sets (a slice, a legend row, the record panel's "Only" buttons), as chips: one per facet value,
 * each named by its facet's label. They are the ordinary filter state, so the address carries them and Back undoes
 * them; `order` is the order they were set in, newest last.
 */

import type { FilterState } from "./filters.js";

/** The facets a chip can show, with the label it reads. */
export const CHIP_FACETS = [
	["providers", "Provider"],
	["models", "Model"],
	["actors", "Lane"],
	["kinds", "Kind"],
	["statuses", "Status"],
	["jobTypes", "Role (declared)"],
	["typeSources", "Type declared by"],
] as const;

export type ChipField = (typeof CHIP_FACETS)[number][0];

export interface Chip {
	field: ChipField;
	value: string;
}

const same = (a: Chip, b: Chip): boolean => a.field === b.field && a.value === b.value;

/**
 * Every facet value set, as chips: those `order` does not know first (in facet order), then those in `order`, newest
 * last. An entry of `order` whose value is no longer set is dropped.
 */
export function chipsOf(f: FilterState, order: readonly Chip[]): Chip[] {
	const all: Chip[] = [];
	for (const [field] of CHIP_FACETS) for (const value of f[field]) all.push({ field, value });
	const known = order.filter((c) => all.some((a) => same(a, c)));
	const rest = all.filter((a) => !known.some((c) => same(a, c)));
	return [...rest, ...known];
}

/** The filters without one chip's value. */
export function without(f: FilterState, chip: Chip): FilterState {
	return { ...f, [chip.field]: f[chip.field].filter((v) => v !== chip.value) };
}

/** Whether the value is its facet's one value: an "Only" button's pressed state, and when `toggleOnly` clears. */
export function isOnly(f: FilterState, field: ChipField, value: string): boolean {
	const cur = f[field];
	return cur.length === 1 && cur[0] === value;
}

/** The filters with one value alone in its facet; when it already is the facet's one value, the facet clears. */
export function toggleOnly(f: FilterState, field: ChipField, value: string): FilterState {
	return { ...f, [field]: isOnly(f, field, value) ? [] : [value] };
}
