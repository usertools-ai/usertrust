// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { render } from "../../src/report/render.js";
import { buildWeeklyReport, type IntegrityInfo } from "../../src/report/weekly.js";

const END = Date.parse("2026-10-12T00:00:00Z");
const EVIL = "evil\u001b[2K\u001b[1A\u009b2J\u0007id";
// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting NO control character survives
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

const model = (integrity: IntegrityInfo) => buildWeeklyReport([], integrity, { endMs: END });

describe("renderers scrub the integrity verdict", () => {
	it("an UNVERIFIED verdict whose errors carry escape sequences cannot repaint or erase the warning", () => {
		const m = model({
			verified: false,
			errors: [`Hash mismatch at ${EVIL}`, `Missing segment ${EVIL}`],
			chainLength: 3,
			firstEvent: EVIL,
			lastEvent: EVIL,
		});
		for (const format of ["md", "html"] as const) {
			const out = render(m, format);
			expect(out, format).not.toMatch(CONTROL);
			expect(out, format).toContain("UNVERIFIED");
			expect(out, format).toContain("Hash mismatch at");
		}
	});

	it("a VERIFIED verdict's first/last event ids are scrubbed too", () => {
		const m = model({
			verified: true,
			errors: [],
			chainLength: 2,
			firstEvent: EVIL,
			lastEvent: EVIL,
		});
		for (const format of ["md", "html"] as const) {
			const out = render(m, format);
			expect(out, format).not.toMatch(CONTROL);
			expect(out, format).toContain("VERIFIED");
		}
	});

	it("the JSON form keeps the exact strings (machine-readable), escaping C1 rather than substituting", () => {
		const m = model({
			verified: false,
			errors: [EVIL],
			chainLength: 0,
			firstEvent: null,
			lastEvent: null,
		});
		const json = render(m, "json");
		expect(json).not.toMatch(/[\u007f-\u009f]/);
		expect(JSON.parse(json).integrity.errors[0]).toBe(EVIL);
	});
});
