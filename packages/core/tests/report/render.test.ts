// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import type { PersistedAuditEvent } from "../../src/audit/read.js";
import { MD_ALLOWED, md, render } from "../../src/report/render.js";
import {
	buildWeeklyReport,
	type IntegrityInfo,
	type NominalUt,
	type UsdUt,
} from "../../src/report/weekly.js";

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

describe("md() is an allowlist, not an escaper", () => {
	it("keeps only letters, digits, space and . , : ; _ @ / + = - ; everything else becomes a visible placeholder", () => {
		for (const hostile of [
			"a\\|b",
			"x`y",
			"![p](https://remote/pixel)",
			"<img src=x onerror=1>",
			"\u202eevil\u0000\u009b",
			"| a | b |\n| - | - |",
		]) {
			const out = md(hostile);
			expect(out.startsWith("`") && out.endsWith("`"), hostile).toBe(true);
			const inner = out.slice(1, -1);
			expect(MD_ALLOWED.test(inner) || /^[A-Za-z0-9 .,:;_@/+=?-]*$/.test(inner), hostile).toBe(
				true,
			);
			expect(inner, hostile).not.toMatch(/[|\\`<>!()[\]\n]/);
		}
		expect(md("claude-sonnet-5-5")).toBe("`claude-sonnet-5-5`");
	});
});

describe("both evidence tiers are headlined", () => {
	it("md and html show confirmed spend and the ledger-proven part, with the plain sentence", () => {
		const ev = (data: Record<string, unknown>): PersistedAuditEvent =>
			({
				id: "i",
				kind: "llm_call",
				timestamp: "2026-10-11T00:00:00Z",
				actor: "local",
				hash: "h",
				data: { model: "m", cost: 100, settled: true, ...data },
			}) as unknown as PersistedAuditEvent;
		const m = buildWeeklyReport(
			[ev({ transferId: "a" }), ev({ transferId: "b", source: "headless", ledgerPosted: true })],
			{ verified: true, errors: [], chainLength: 2, firstEvent: "a", lastEvent: "b" },
			{ endMs: END },
		);
		for (const f of ["md", "html"] as const) {
			const out = render(m, f);
			expect(out, f).toMatch(/ledger-proven/);
			expect(out, f).toMatch(/not proven|no record contradicts/);
		}
		expect(m.totals.confirmedCalls).toBe(2);
		expect(m.totals.postProvenCalls).toBe(1);
	});
});

describe("unconfirmed governed actions are headlined", () => {
	it("a 12,345-UT unconfirmed action shows in md and html, not as $0.00", () => {
		const m = buildWeeklyReport(
			[
				{
					id: "i",
					kind: "tool_call",
					timestamp: "2026-10-11T00:00:00Z",
					actor: "local",
					hash: "h",
					data: { actionName: "x", cost: 12_345, transferId: "t", settled: false },
				} as unknown as PersistedAuditEvent,
			],
			{ verified: true, errors: [], chainLength: 1, firstEvent: "a", lastEvent: "a" },
			{ endMs: END },
		);
		for (const f of ["md", "html"] as const) {
			expect(render(m, f), f).toMatch(/unconfirmed/i);
			expect(render(m, f), f).toContain("$1.23");
		}
	});
});

describe("unlabelled spend is headlined", () => {
	it("md and html show confirmed spend with no recorded denomination", () => {
		const m = buildWeeklyReport(
			[
				{
					id: "i",
					kind: "llm_call",
					timestamp: "2026-10-11T00:00:00Z",
					actor: "local",
					hash: "h",
					data: { model: "m", cost: 5_000, settled: true, transferId: "t", source: "headless" },
				} as unknown as PersistedAuditEvent,
			],
			{ verified: true, errors: [], chainLength: 1, firstEvent: "a", lastEvent: "a" },
			{ endMs: END },
		);
		for (const f of ["md", "html"] as const) expect(render(m, f), f).toMatch(/denomination/);
	});
});

describe("nominal units are headlined, never dollar-formatted", () => {
	const local = (cost: number, extra: Record<string, unknown> = {}): PersistedAuditEvent =>
		({
			id: "i",
			kind: "llm_call",
			timestamp: "2026-10-11T00:00:00Z",
			actor: "local",
			hash: "h",
			data: {
				model: "llama",
				cost,
				settled: true,
				transferId: `t${cost}`,
				costBasis: "nominal",
				endpointClass: "local",
				...extra,
			},
		}) as unknown as PersistedAuditEvent;
	const ok = { verified: true, errors: [], chainLength: 1, firstEvent: "a", lastEvent: "a" };

	it("a nominal-only window shows its units in md and html, not $0.00 alone", () => {
		const m = buildWeeklyReport([local(40), local(2)], ok, { endMs: END, budget: 1000 });
		for (const f of ["md", "html"] as const) {
			const out = render(m, f);
			expect(out, f).toContain("42 nominal units");
			expect(out, f).toMatch(/not dollars/);
		}
	});

	it("the budget section reports nominal debits separately and does not add them to a dollar figure", () => {
		const m = buildWeeklyReport([local(40)], ok, { endMs: END, budget: 1000 });
		const out = render(m, "md");
		expect(out).toContain("40 nominal units");
		expect(m.budget.recordedSessionUt).toBe(0);
	});

	it("types: a nominal amount cannot be handed to a dollar formatter", () => {
		const m = buildWeeklyReport([local(40)], ok, { endMs: END });
		// @ts-expect-error a NominalUt is not a UsdUt: mixing denominations is a compile error
		const asDollars: UsdUt = m.totals.nominalUt;
		// @ts-expect-error and the other way round
		const asUnits: NominalUt = m.totals.confirmedUt;
		// @ts-expect-error a budget WalletUt is not dollars either: the dollar formatter never accepts it
		const walletAsDollars: UsdUt = m.budget.recordedSessionWallet;
		expect([asDollars, asUnits, walletAsDollars]).toBeDefined();
	});
});

describe("unrecoverable and unrecognised records are disclosed in every format", () => {
	const ok = { verified: true, errors: [], chainLength: 2, firstEvent: "a", lastEvent: "b" };
	const mk = (kind: string, data: Record<string, unknown>): PersistedAuditEvent =>
		({
			id: "i",
			kind,
			timestamp: "2026-10-11T00:00:00Z",
			actor: "local",
			hash: "h",
			data,
		}) as unknown as PersistedAuditEvent;

	it("md, html and json show the unrecoverable call with usage and no dollar value, and the unknown kind", () => {
		const m = buildWeeklyReport(
			[
				mk("settlement_unrecoverable", {
					usage: { inputTokens: 40, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
				}),
				mk("future_kind<script>", {}),
			],
			ok,
			{ endMs: END },
		);
		for (const f of ["md", "html"] as const) {
			const out = render(m, f);
			expect(out, f).toMatch(/Served but never charged/);
			expect(out, f).toMatch(/40 input/);
			expect(out, f).toMatch(/Records this report does not read/);
			expect(out, f).not.toContain("<script>"); // the kind is chain text: neutralised
		}
		const json = JSON.parse(render(m, "json")) as {
			unrecoverable: { records: number };
			unrecognised: Record<string, number>;
		};
		expect(json.unrecoverable.records).toBe(1);
		expect(json.unrecognised).toEqual({ "future_kind<script>": 1 });
	});
});
