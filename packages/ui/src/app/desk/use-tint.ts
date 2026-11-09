// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useMemo } from "react";
import { categoryTint } from "../../shared/category-tint.js";
import { useDeskData } from "./desk-state.js";

/**
 * The line's category tint (`categoryTint`), or null for the default ink. It reads the filters the list was DRAWN
 * with (`list.filters`), as the chart's rows do, so the colour never runs ahead of the line it paints; and it takes
 * the colour from the map of whichever dimension wins, which need not be the level the breakdown is taken at.
 */
export function useCategoryTint(): string | null {
	const { list, colorsFor } = useDeskData();
	return useMemo(
		() => categoryTint(list.filters, (dim, key) => colorsFor(dim).of(key)),
		[list.filters, colorsFor],
	);
}
