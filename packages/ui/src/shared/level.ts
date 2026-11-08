// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { Dimension, SpendWindow } from "./breakdown.js";
import type { LedgerRow } from "./rows.js";

/**
 * The level the desk breaks spend down by. Today it is the one the reader chose, unchanged.
 *
 * `rows` are the rows excluding the models filter and `win` is the desk window; both are taken now so the share window
 * can adapt the level later without changing any caller.
 */
export function effectiveLevel(
	dim: Dimension,
	_rows: readonly LedgerRow[],
	_win?: SpendWindow,
): { dim: Dimension; adapted: boolean } {
	return { dim, adapted: false };
}
