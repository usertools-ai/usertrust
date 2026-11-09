// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * How one category (a slice, a legend row, a lane, a band) is lit. One rule for every window: the selection is the
 * filter, so a window never keeps a second idea of what is selected. Display only: nothing here is a figure.
 */

import type { Dimension } from "./breakdown.js";

export type Lit = "selected" | "hover" | "dim" | "rest";

/** The categories of one dimension that the filter holds. */
export interface Selection {
	dim: Dimension;
	keys: ReadonlySet<string>;
}

/** The opacity of a category that is not selected while something else is. */
export const DIM_OPACITY = 0.3;

/**
 * Whether `key` is selected, hovered, dimmed (something else is selected) or at rest. A hover on another dimension is
 * ignored: it names a different thing.
 */
export function litState(
	sel: Selection,
	hover: { dim: Dimension; key: string } | null,
	key: string,
): Lit {
	if (sel.keys.has(key)) return "selected";
	if (hover !== null && hover.dim === sel.dim && hover.key === key) return "hover";
	return sel.keys.size > 0 ? "dim" : "rest";
}
