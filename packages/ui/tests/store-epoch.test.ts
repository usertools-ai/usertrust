// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { snapshotEpoch } from "../src/app/store.js";

describe("snapshotEpoch", () => {
	it("keeps a non-negative safe integer", () => {
		expect(snapshotEpoch(7)).toBe(7);
		expect(snapshotEpoch(0)).toBe(0);
	});

	it("is null for anything else: an older server sends none", () => {
		for (const v of [
			undefined,
			null,
			-1,
			1.5,
			"3",
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
			{},
		])
			expect(snapshotEpoch(v)).toBeNull();
	});
});
