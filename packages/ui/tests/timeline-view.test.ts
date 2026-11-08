// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import type { AtPayload } from "../src/shared/api.js";
import { atFailureText, newSince, shownLabel, timelineLabel } from "../src/shared/timeline-view.js";

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
		budget: {
			ut: null,
			source: "unpublished",
			writtenAt: null,
			provenance: "unknown: not yet published; no controller has recorded the budget it enforces",
			note: "",
		},
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

describe("shownLabel", () => {
	it("a clamped answer stops calling itself the latest once records arrive after it", () => {
		const shown = at({ pos: 99, head: 99, clamped: true });
		expect(shownLabel(shown, 99, NOW)).toBe("As recorded at 11-06 10:04:05Z (latest record)");
		expect(shownLabel(shown, 120, NOW)).toBe("As recorded at 11-06 10:04:05Z");
		expect(shownLabel(null, 120, NOW)).toBe("Live");
	});
});
