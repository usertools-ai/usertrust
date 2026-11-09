// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { useState } from "react";
import type { Dimension } from "../../shared/breakdown.js";
import type { WindowId } from "../../shared/desk-layout.js";
import { DEFAULT_RANGE, type RangeId } from "../../shared/spend-series.js";

/**
 * The reader's layout: which window fills the desk, the spend range and the split. They are kept in memory, not in
 * the page address: they are how this reader arranged the desk, not what a link should share, so a reload or a
 * followed link opens the defaults, and Back does not undo them. The position (the pin) stays in the address.
 */
export function useDeskMemory(): {
	fill: WindowId | null;
	setFill(fill: WindowId | null): void;
	range: RangeId;
	setRange(range: RangeId): void;
	dim: Dimension;
	setDim(dim: Dimension): void;
} {
	const [fill, setFill] = useState<WindowId | null>(null);
	const [range, setRange] = useState<RangeId>(DEFAULT_RANGE);
	const [dim, setDim] = useState<Dimension>("lane");
	return { fill, setFill, range, setRange, dim, setDim };
}
