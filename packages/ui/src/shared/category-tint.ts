// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The category tint: when a facet filter holds exactly one value, the line takes that category's colour, so a chart
 * narrowed to one provider or one lane reads as that category at a glance. One function for every window that tints
 * (the Spend line, its loupe, Now's sparkline), called with the same arguments, so they can never disagree.
 */

import type { Dimension } from "./breakdown.js";
import { FACET_FIELD } from "./desk-filters.js";
import type { FilterState } from "./filters.js";

/**
 * The dimensions checked, in order. Provider first: its colours are fixed and known to the reader, so with a provider
 * and a lane both narrowed to one, the provider's colour is the one that says the most.
 */
export const TINT_ORDER: readonly Dimension[] = ["provider", "lane", "role", "model", "kind"];

/**
 * The colour of the first dimension in `TINT_ORDER` whose filter field holds exactly one value, or null when none
 * does. A field with two or more values is skipped rather than ending the search: a line over two providers is not
 * either one's, but it can still be one lane's.
 */
export function categoryTint(
	filters: FilterState,
	colorOf: (dim: Dimension, key: string) => string,
): string | null {
	for (const dim of TINT_ORDER) {
		const values = filters[FACET_FIELD[dim]];
		if (values.length === 1) return colorOf(dim, values[0] as string);
	}
	return null;
}
