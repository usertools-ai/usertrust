// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import type { AtPayload } from "../src/shared/api.js";
import {
	atFailureText,
	newSince,
	stepFor,
	timelineLabel,
	timelineValueText,
} from "../src/shared/timeline-view.js";

const NOW = "2026-11-06T12:00:00.000Z";

function at(overrides: Partial<AtPayload> = {}): AtPayload {
	return {
		pos: 40,
		ts: "2026-11-06T10:04:05.000Z",
		head: 99,
		clamped: false,
		epoch: 0,
		spentUt: 0,
		counts: { llm_call: 0, denied: 0, other: 0 },
		chain: { valid: true, breakIndex: null },
		budget: { ut: null, note: "" },
		plan: null,
		windowStartPos: 0,
		statusAt: {},
		...overrides,
	};
}

describe("timelineLabel", () => {
	it("label live and past", () => {
		expect(timelineLabel(null, NOW)).toBe("Live");
		expect(timelineLabel(at(), NOW)).toBe("As recorded at 11-06 10:04:05Z");
	});

	it("a position past the head says it is the latest record", () => {
		expect(timelineLabel(at({ clamped: true }), NOW)).toBe(
			"As recorded at 11-06 10:04:05Z (latest record)",
		);
	});

	it("names the year when it is not the current one, so a date never reads as this year's", () => {
		expect(timelineLabel(at({ ts: "2025-11-06T10:04:05.000Z" }), NOW)).toBe(
			"As recorded at 2025-11-06 10:04:05Z",
		);
	});

	it("an unreadable time is shown as it was written", () => {
		expect(timelineLabel(at({ ts: "yesterday" }), NOW)).toBe("As recorded at yesterday");
	});

	it("never says verified", () => {
		expect(timelineLabel(at({ clamped: true }), NOW)).not.toMatch(/verif/i);
	});
});

describe("stepFor", () => {
	it("keys step within 0..head", () => {
		// The arrows move one position.
		expect(stepFor("ArrowLeft", 40, 99)).toBe(39);
		expect(stepFor("ArrowRight", 40, 99)).toBe(41);
		expect(stepFor("ArrowLeft", 0, 99)).toBe(0);
		expect(stepFor("ArrowRight", 99, 99)).toBe(99);
		// PageUp and PageDown move 5% of head + 1, rounded up: 100 positions, 5.
		expect(stepFor("PageUp", 40, 99)).toBe(45);
		expect(stepFor("PageDown", 40, 99)).toBe(35);
		expect(stepFor("PageUp", 97, 99)).toBe(99);
		expect(stepFor("PageDown", 3, 99)).toBe(0);
		// Home and End jump to the ends.
		expect(stepFor("Home", 40, 99)).toBe(0);
		expect(stepFor("End", 40, 99)).toBe(99);
	});

	it("the page step rounds 5% up, in whole numbers (61 positions: 4; 60: exactly 3)", () => {
		expect(stepFor("PageUp", 0, 60)).toBe(4);
		// 0.05 * 60 is 3.0000000000000004 in floating point; rounded up that would be 4.
		expect(stepFor("PageUp", 0, 59)).toBe(3);
		// A short vault still moves at least one position.
		expect(stepFor("PageUp", 0, 4)).toBe(1);
	});

	it("a vault of one record has nowhere to go", () => {
		for (const key of ["ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"] as const)
			expect(stepFor(key, 0, 0)).toBe(0);
	});
});

describe("newSince", () => {
	it("live append keeps T: the position stays 40 and 21 records are new since it was chosen", () => {
		const shown = at({ pos: 40, head: 99 });
		expect(newSince(shown, 99)).toBe(0);
		expect(newSince(shown, 120)).toBe(21);
		expect(shown.pos).toBe(40);
	});

	it("is 0 when live, and never negative", () => {
		expect(newSince(null, 120)).toBe(0);
		expect(newSince(at({ head: 99 }), 90)).toBe(0);
	});
});

describe("atFailureText", () => {
	it("says what went wrong in a few words, never a status code alone", () => {
		expect(atFailureText(400)).toBe("the dashboard did not accept that position");
		expect(atFailureText(404)).toBe("the vault has no records");
		expect(atFailureText(500)).toBe("the dashboard could not read the vault at that point");
		expect(atFailureText(null)).toBe("the dashboard did not answer");
	});
});

describe("timelineValueText", () => {
	it("names the record, and the time only when the screen shows that record", () => {
		const shown = at({ pos: 40 });
		expect(timelineValueText(null, 99, null, NOW)).toBe("Live");
		expect(timelineValueText(40, 99, shown, NOW)).toBe(
			"Record 41 of 100 · As recorded at 11-06 10:04:05Z",
		);
		expect(timelineValueText(41, 99, shown, NOW)).toBe("Record 42 of 100 · loading");
		expect(timelineValueText(41, 99, null, NOW)).toBe("Record 42 of 100 · loading");
	});

	it("a clamped answer stops calling itself the latest once records arrive after it", () => {
		const shown = at({ pos: 99, head: 99, clamped: true });
		expect(timelineValueText(99, 99, shown, NOW)).toBe(
			"Record 100 of 100 · As recorded at 11-06 10:04:05Z (latest record)",
		);
		expect(timelineValueText(99, 120, shown, NOW)).toBe(
			"Record 100 of 121 · As recorded at 11-06 10:04:05Z",
		);
	});
});
