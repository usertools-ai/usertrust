// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import type { PersistedAuditEvent } from "../../src/audit/read.js";
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

// One hostile string with every kind of live content: a remote image, raw HTML with a remote fetch and a handler, a
// javascript: link, a bare autolink, and control bytes. It is planted in EVERY field a vault can supply.
const HOSTILE =
	"![x](https://evil.example/pixel.png) <img src=https://evil.example/x onerror=alert(1)> [l](javascript:alert(1)) https://evil.example/auto \u001b[2J\u009b1A";

function hostileModel() {
	const e = (over: Record<string, unknown>): PersistedAuditEvent =>
		({
			id: HOSTILE,
			timestamp: "2026-10-08T01:00:00Z",
			previousHash: "p",
			hash: HOSTILE,
			kind: "llm_call",
			actor: "local",
			sequence: 1,
			data: {
				model: HOSTILE,
				cost: 100,
				settled: true,
				transferId: HOSTILE,
				usageSource: "provider",
				usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
				appliedRates: { inputPer1k: 1, outputPer1k: 1 },
				costBasis: HOSTILE,
				rateSource: HOSTILE,
				costCenter: HOSTILE,
				principal: { id: HOSTILE, origin: HOSTILE, type: HOSTILE, unit: HOSTILE },
				...over,
			},
		}) as unknown as PersistedAuditEvent;
	return buildWeeklyReport(
		[e({}), e({ costCenter: undefined, principal: { id: HOSTILE, origin: HOSTILE } })],
		{
			verified: false,
			errors: [HOSTILE, HOSTILE],
			chainLength: 2,
			firstEvent: HOSTILE,
			lastEvent: HOSTILE,
		},
		{ endMs: END, budget: 1000, budgetSource: HOSTILE, agentKey: "auto" },
	);
}

/** Markdown with every inline code span removed: what is left is what a renderer would interpret. */
function outsideCodeSpans(md: string): string {
	return md.replace(/(`+)[\s\S]*?\1/g, "");
}

describe("every vault-derived string passes ONE escaping boundary per format", () => {
	it("markdown: a hostile string in every field leaves no live markup, link, image or autolink outside a code span", () => {
		const out = render(hostileModel(), "md");
		const live = outsideCodeSpans(out);
		expect(live).not.toMatch(/!\[/);
		expect(live).not.toMatch(/\]\(/);
		expect(live).not.toMatch(/<[A-Za-z!/]/);
		expect(live).not.toContain("http");
		expect(live).not.toContain("javascript:");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting NO control character survives
		expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
		// CONTROL: the hostile text is still THERE (as text), so the check above is looking at something
		expect(out).toContain("evil.example");
	});

	it("html: a hostile string in every field becomes inert text: no tag, no attribute, no remote fetch", () => {
		const out = render(hostileModel(), "html");
		expect(out).not.toMatch(/<img/i);
		expect(out).not.toMatch(/<[^>]*\b(src|href|onerror)\s*=/i);
		expect(out).not.toMatch(/<script/i);
		expect(out).toContain("&lt;img");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting NO control character survives
		expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
		// the page's own markup holds no remote resource of its own
		expect(out.replace(/&lt;[\s\S]*?&gt;/g, "")).not.toMatch(/<[^>]*https?:\/\//i);
	});

	it("a backtick inside a vault string cannot break out of its code span", () => {
		const m = buildWeeklyReport(
			[
				{
					id: "i",
					timestamp: "2026-10-08T01:00:00Z",
					previousHash: "p",
					hash: "h",
					kind: "llm_call",
					actor: "local",
					data: {
						model: "a`![x](https://evil.example/p)`b```c",
						cost: 5,
						settled: true,
						transferId: "t",
					},
				} as unknown as PersistedAuditEvent,
			],
			{ verified: true, errors: [], chainLength: 1, firstEvent: "i", lastEvent: "i" },
			{ endMs: END },
		);
		const live = outsideCodeSpans(render(m, "md"));
		expect(live).not.toMatch(/!\[/);
		expect(live).not.toContain("evil.example");
	});
});
