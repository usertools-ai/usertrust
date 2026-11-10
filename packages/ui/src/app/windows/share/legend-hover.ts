// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Which hover the Share window's legend owns. The legend publishes the row under the pointer or, failing that, the
 * row holding keyboard focus; it clears only a hover it published itself, so one set by the ring or by another window
 * is never wiped by a blur or a pointer-leave here.
 */

import type { Dimension } from "../../../shared/breakdown.js";
import type { HoverCategory } from "../../../shared/hover-bus.js";

/** The sender the legend names on the hover it publishes. */
export const LEGEND_FROM = "share-legend";

/** The row to show: the one under the pointer, else the focused one, else none. */
export function rowToShow(pointer: string | null, focus: string | null): string | null {
	return pointer ?? focus;
}

/** Whether the hover now on the bus is the one this legend published last (`published`) at this level. */
export function isOurs(
	current: HoverCategory | null,
	level: Dimension,
	published: string | null,
): boolean {
	return (
		published !== null &&
		current !== null &&
		current.from === LEGEND_FROM &&
		current.dim === level &&
		current.key === published
	);
}
