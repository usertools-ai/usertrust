// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * One word per status, everywhere. An ambiguous charge is shown as "unresolved": recorded, not confirmed, and inside
 * spend. The URL and filter value stays `ambiguous`, so old links round-trip.
 */

import { describe, expect, it } from "vitest";
import type { RowStatus } from "../src/shared/rows.js";
import { statusWord, UNRESOLVED_LINE, UNRESOLVED_TIP } from "../src/shared/status-word.js";

// A record over the full union: a new RowStatus is a type error here until it is listed, and then must be mapped.
const ALL: Record<RowStatus, true> = {
	settled: true,
	ambiguous: true,
	failed: true,
	denied: true,
	released: true,
	unrecoverable: true,
	ungoverned: true,
	info: true,
	unknown: true,
};

describe("statusWord", () => {
	it("names an ambiguous charge unresolved", () => {
		expect(statusWord("ambiguous")).toBe("unresolved");
	});

	for (const status of Object.keys(ALL) as RowStatus[]) {
		if (status === "ambiguous") continue;
		it(`leaves "${status}" as it is`, () => {
			expect(statusWord(status)).toBe(status);
		});
	}

	it("pins the two shared strings exactly", () => {
		expect(UNRESOLVED_TIP).toBe("the outcome isn't confirmed yet");
		expect(UNRESOLVED_LINE).toBe("recorded, not confirmed");
	});
});
