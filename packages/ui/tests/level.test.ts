// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import type { Dimension } from "../src/shared/breakdown.js";
import { effectiveLevel } from "../src/shared/level.js";
import type { LedgerRow } from "../src/shared/rows.js";
import { rangeWindow } from "../src/shared/spend-series.js";

const DIMS: Dimension[] = ["lane", "role", "model", "kind", "provider"];

describe("effectiveLevel (identity until the share window adapts it)", () => {
	it("returns the dimension unchanged and not adapted, for every dimension", () => {
		for (const dim of DIMS) {
			expect(effectiveLevel(dim, [])).toEqual({ dim, adapted: false });
		}
	});

	it("takes the desk window as an optional third argument, and still ignores it", () => {
		const win = rangeWindow("1w", Date.parse("2026-11-07T12:00:00.000Z"));
		const rows: readonly LedgerRow[] = [];
		for (const dim of DIMS) {
			expect(effectiveLevel(dim, rows, win)).toEqual({ dim, adapted: false });
		}
	});
});
