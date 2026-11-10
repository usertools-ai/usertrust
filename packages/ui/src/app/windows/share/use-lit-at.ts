// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * How a category is lit in the Share window, at the level the window itself draws. The desk's `useLit` reads the
 * level of the desk window, which ends at a pin; the Share window's level comes from the chart's rows, which run to
 * now, and the two can differ. The rule is the same one (`litState`): the selection is the filter.
 */

import { useCallback, useMemo } from "react";
import type { Dimension } from "../../../shared/breakdown.js";
import { selectedKeys } from "../../../shared/desk-filters.js";
import { type Lit, litState } from "../../../shared/selection.js";
import { useFilters, useHoverCategory } from "../../desk/desk-state.js";

/** A reader of every key's lit state at `level`: one subscription for a whole ring or legend. */
export function useLitOf(level: Dimension): (key: string) => Lit {
	const { filters } = useFilters();
	const hover = useHoverCategory();
	const selection = useMemo(
		() => ({ dim: level, keys: selectedKeys(filters, level) }),
		[filters, level],
	);
	return useCallback((key: string) => litState(selection, hover, key), [selection, hover]);
}

/** How one category is lit at `level`: selected, hovered, dimmed because another is selected, or at rest. */
export function useLitAt(level: Dimension, key: string): Lit {
	return useLitOf(level)(key);
}
