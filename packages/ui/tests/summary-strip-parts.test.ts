// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The summary strip drawn part by part. The page bar keeps the chain alarm and the Window notice (a broken chain, and
 * a list that does not hold every record, show whatever else is on screen); the as-at line is a part of its own,
 * `head`; the facts take a note after Budget and a Spend figure of another scope, which is then labelled as that
 * scope.
 */

import { createHash } from "node:crypto";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AtPayload, SummaryPayload } from "../src/shared/api.js";
import { NOT_ANCHORED_NOTE } from "../src/shared/display.js";
import { formatUsdTotal, formatUt } from "../src/shared/format.js";
import { NOW_COPY } from "../src/shared/now-copy.js";
import { type Component, noIds } from "./helpers/day-one.js";

type Part = "bar" | "head" | "facts" | "all";
interface StripProps {
	summary: SummaryPayload | null;
	live: "connecting" | "live" | "reconnecting" | "offline";
	at?: AtPayload | null;
	part?: Part;
	budgetNote?: ReactNode;
	spentOverride?: { ut: number; label: string };
}
interface StripModule {
	SummaryStrip: Component<StripProps>;
	SpendFact: Component<{ spentUt: number; past: boolean; scope?: string }>;
	PastBudgetFact: Component<{ at: AtPayload }>;
	IntegrityFact: Component<{ s: SummaryPayload; at: AtPayload | null; anchorLine?: boolean }>;
}

let mod: StripModule;
beforeAll(async () => {
	const file = "summary-strip";
	mod = (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as StripModule;
});
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.parse("2026-11-08T12:00:00.000Z"));
});
afterEach(() => {
	vi.useRealTimers();
});

/** The text a reader sees: tags removed, and the entities React escapes read back. */
const text = (html: string): string =>
	html
		.replace(/<[^>]*>/g, "")
		.replace(/&#x27;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&");

function summary(over: Partial<SummaryPayload> = {}): SummaryPayload {
	return {
		vaultPath: "/v/.usertrust",
		budget: 1_000_000,
		budgetSource: "config",
		budgetWrittenAt: null,
		budgetProvenance: "from the vault config",
		spentUt: 123_400,
		remainingUt: 876_600,
		chain: { events: 100, valid: true, empty: false, breakIndex: null, errors: [] },
		anchorFile: "absent",
		remote: { kit: false },
		rowCount: 100,
		truncated: false,
		verifiedAt: null,
		...over,
	};
}

function at(over: Partial<AtPayload> = {}): AtPayload {
	return {
		pos: 40,
		ts: "2026-11-06T10:04:05.000Z",
		head: 99,
		clamped: false,
		epoch: 0,
		spentUt: 56_700,
		counts: { llm_call: 30, denied: 2, other: 9 },
		chain: { valid: true, breakIndex: null },
		budget: {
			ut: 1_000_000,
			source: "config",
			writtenAt: null,
			provenance: "from the vault config",
			note: "budget history starts with the first budget record; this is today's budget",
		},
		plan: null,
		windowStartPos: 0,
		statusAt: {},
		...over,
	};
}

const BROKEN = summary({
	chain: { events: 100, valid: false, empty: false, breakIndex: 40, errors: ["x"] },
});
const TRUNCATED = summary({ truncated: true, rowCount: 50 });

const strip = (over: Partial<StripProps> = {}): string =>
	renderToStaticMarkup(
		createElement(mod.SummaryStrip, { summary: summary(), live: "live", ...over }),
	);

/** The one fact whose heading is `name`, tags and all. */
function fact(html: string, name: string): string {
	const from = html.indexOf(`<b>${name}`);
	const start = html.lastIndexOf('<div class="ut-fact', from);
	const next = html.indexOf('<div class="ut-fact', from);
	const more = html.indexOf('class="ut-more"', from);
	const ends = [next, more, html.length].filter((i) => i >= 0);
	return from < 0 ? "" : html.slice(start, Math.min(...ends));
}

describe("the page bar", () => {
	it("keeps the chain alarm, at a past position too", () => {
		for (const a of [null, at()]) {
			const html = strip({ summary: BROKEN, at: a, part: "bar" });
			expect(html).toContain('class="ut-top"');
			expect(html).toContain('role="alert"');
			expect(text(html)).toContain("Chain integrity failure");
		}
	});

	it("has no as-at line: it is the head's", () => {
		const html = strip({ summary: TRUNCATED, at: at(), part: "bar" });
		expect(text(html)).not.toContain("As recorded at");
		expect(html).not.toContain("ut-asat");
		expect(html).not.toContain("ut-facts");
		expect(strip({ summary: null, part: "bar" })).not.toContain("ut-asat");
		expect(strip({ summary: null, part: "bar" })).toContain('class="ut-top"');
	});

	it("carries the Window notice, once, after the alarm: the live one, or the position's own", () => {
		const live = strip({ summary: TRUNCATED, part: "bar" });
		expect(live).toContain('<div class="ut-notice" role="status"><b>Window</b>');
		expect(live.split("ut-notice").length - 1).toBe(1);
		expect(text(live)).toContain("Showing the newest 50 of 100 events");
		const past = text(
			strip({ summary: TRUNCATED, at: at({ pos: 10, windowStartPos: 50 }), part: "bar" }),
		);
		expect(past).toContain("The list holds records from position 51");
		expect(past).not.toContain("Showing the newest");
		expect(past).not.toContain("As recorded at");
		// A vault held whole has none, and nor does one whose summary has not landed.
		expect(strip({ part: "bar" })).not.toContain("ut-notice");
		expect(strip({ summary: null, part: "bar" })).not.toContain("ut-notice");
		// A broken chain's alarm comes first.
		const both = strip({ summary: { ...BROKEN, truncated: true, rowCount: 50 }, part: "bar" });
		expect(both.indexOf('role="alert"')).toBeGreaterThan(0);
		expect(both.indexOf("ut-notice")).toBeGreaterThan(both.indexOf('role="alert"'));
	});
});

describe("the head", () => {
	it("says As recorded at, at a past position", () => {
		const html = strip({ at: at(), part: "head" });
		expect(text(html)).toContain("As recorded at");
		expect(html).toContain('<p class="ut-asat" data-live="false">');
	});

	it("live, holds the as-at line's slot empty and unseen, and nothing else", () => {
		const slot = '<p class="ut-asat" data-live="true" aria-hidden="true"> </p>';
		expect(strip({ part: "head" })).toBe(slot);
		expect(strip({ summary: null, part: "head" })).toBe(slot);
		// With no summary there is no position to speak for, whatever the caller holds.
		expect(strip({ summary: null, at: at(), part: "head" })).toBe(slot);
	});

	it("is the as-at line alone: the Window notice is the bar's, in a vault the list does not hold whole too", () => {
		const live = strip({ summary: TRUNCATED, part: "head" });
		expect(live).toBe('<p class="ut-asat" data-live="true" aria-hidden="true">\u00a0</p>');
		const past = strip({
			summary: TRUNCATED,
			at: at({ pos: 10, windowStartPos: 50 }),
			part: "head",
		});
		expect(past).not.toContain("ut-notice");
		expect(text(past)).not.toContain("The list holds records");
		expect(text(past)).toContain("As recorded at");
		expect(past).toMatch(/^<p class="ut-asat" data-live="false">[^<]*<\/p>$/);
	});

	it("has no page bar, no alarm and no facts", () => {
		const html = strip({ summary: BROKEN, at: at(), part: "head" });
		expect(html).not.toContain('class="ut-top"');
		expect(html).not.toContain('role="alert"');
		expect(html).not.toContain("ut-facts");
	});
});

describe("the facts", () => {
	it("have no as-at line, no notice and no alarm", () => {
		const html = strip({ summary: { ...BROKEN, truncated: true }, at: at(), part: "facts" });
		expect(html).toContain('aria-label="vault summary"');
		expect(html).not.toContain("ut-asat");
		expect(html).not.toContain("ut-notice");
		expect(html).not.toContain('role="alert"');
		expect(strip({ summary: null, part: "facts" })).not.toContain("ut-asat");
	});
});

describe("all", () => {
	const cases: [string, Partial<StripProps>][] = [
		["live", {}],
		["a past position", { at: at() }],
		["a broken chain", { summary: BROKEN }],
		["a truncated vault", { summary: TRUNCATED, at: at({ pos: 10, windowStartPos: 50 }) }],
		["no summary yet", { summary: null }],
	];
	it.each(cases)(
		"%s: is the bar, then the head, then the facts, with the Window notice after the as-at line as it always was",
		(_name, over) => {
			const all = strip({ ...over, part: "all" });
			expect(all).toBe(strip(over));
			// Part by part the notice is the bar's; drawn whole, the strip keeps it where it was, after the as-at line.
			const bar = strip({ ...over, part: "bar" });
			const notice = /<div class="ut-notice" role="status">.*?<\/div>/.exec(bar)?.[0] ?? "";
			expect(noIds(all)).toBe(
				noIds(
					bar.replace(notice, "") +
						strip({ ...over, part: "head" }) +
						notice +
						strip({ ...over, part: "facts" }),
				),
			);
			expect(notice === "").toBe(over.summary !== TRUNCATED);
			expect(all.split("ut-notice").length - 1).toBe(over.summary === TRUNCATED ? 1 : 0);
		},
	);

	// The markup as it was before the head became a part of its own, kept as a digest. What has changed since is
	// undone before the comparison, so everything else is held byte for byte: the Budget fact's scope line is taken
	// out, the Integrity fact is put back between Chain and Anchor file, and a past budget's line is given its old
	// words.
	const SCOPE_LINE = `<span class="ut-sub" title="${NOW_COPY.scopeVault}">${NOW_COPY.scopeVault}</span>`;
	const NOTE = at().budget.note.replaceAll("'", "&#x27;");
	const FROM = at().budget.provenance;
	const asBefore = (html: string): string =>
		noIds(html)
			.split(SCOPE_LINE)
			.join("")
			.replace(
				/(<div class="ut-fact"><b>Integrity<\/b>.*?<\/div>)(<button type="button" class="ut-more".*?<\/button>)(<div class="ut-fact detail" id="ut-fact-chain">.*?<\/div>)/,
				"$2$3$1",
			)
			.replace(
				`title="${FROM}. ${NOTE}">${FROM}. ${NOTE}<`,
				`title="${FROM}. config · unconfirmed. ${NOTE}">config · unconfirmed. ${NOTE}<`,
			);
	const digest = (html: string): string =>
		createHash("sha256").update(asBefore(html)).digest("hex");
	it.each([
		["live", {}, "1532d41fda26553e42a5f3f3cd0db57ffb9d805da2181f72103248c8c8d5ccfb"],
		// The bar's one change: the connection pill's text and name at a past position (nothing else in the strip moved).
		[
			"a past position",
			{ at: at() },
			"a2e93ca08b01365318d672a8be7cc9d3c1335f5ddc5bb75c7cc23475c9c7631a",
		],
		[
			"a broken chain",
			{ summary: BROKEN },
			"e1280ecefec731475c27bd4840229eaf908e3652285d033e05de6479c29881be",
		],
	] as [string, Partial<StripProps>, string][])(
		"%s: every part in the order it had, nothing else moved",
		(_name, over, want) => {
			expect(digest(strip(over))).toBe(want);
		},
	);
});

describe("the Spend fact's scope", () => {
	it("with no scope given, says the whole vault live and up to this point in the past", () => {
		expect(text(fact(strip({ part: "facts" }), "Spend"))).toContain("llm calls · whole vault");
		const past = text(fact(strip({ at: at(), part: "facts" }), "Spend"));
		expect(past).toContain("llm calls · up to this point");
		expect(past).not.toContain("whole vault");
	});

	it("a figure of another scope replaces the vault's and carries its label", () => {
		const spentOverride = { ut: 4_200, label: NOW_COPY.scopeFiltered };
		const live = fact(strip({ part: "facts", spentOverride }), "Spend");
		expect(text(live)).toContain(formatUsdTotal(4_200));
		expect(text(live)).toContain(formatUt(4_200));
		expect(text(live)).toContain("llm calls · filtered");
		expect(text(live)).not.toContain(formatUsdTotal(123_400));
		expect(text(live)).not.toContain("whole vault");
		// The whole-vault sentence would be false for a filtered figure, in a tooltip too.
		expect(live).not.toContain("every llm_call record");
	});

	it("at a past position the override replaces the position's figure too", () => {
		const spentOverride = { ut: 900, label: NOW_COPY.scopeFilteredPast };
		const past = fact(strip({ at: at(), part: "facts", spentOverride }), "Spend");
		expect(text(past)).toContain(formatUsdTotal(900));
		expect(text(past)).not.toContain(formatUsdTotal(56_700));
		expect(text(past)).toContain("llm calls · filtered, up to this point");
		expect(past).not.toContain("every llm_call record");
	});

	it("the override changes Spend only: the Budget fact is the same markup", () => {
		const spentOverride = { ut: 4_200, label: NOW_COPY.scopeFiltered };
		for (const a of [null, at()]) {
			const plain = strip({ at: a, part: "facts" });
			const over = strip({ at: a, part: "facts", spentOverride });
			expect(fact(over, "Budget")).toBe(fact(plain, "Budget"));
			expect(fact(over, "Budget").length).toBeGreaterThan(0);
		}
	});

	it("SpendFact is exported and takes the scope itself", () => {
		const html = renderToStaticMarkup(
			createElement(mod.SpendFact, { spentUt: 700, past: false, scope: "llm calls · filtered" }),
		);
		expect(text(html)).toContain("llm calls · filtered");
		expect(text(html)).toContain(formatUsdTotal(700));
		const plain = renderToStaticMarkup(createElement(mod.SpendFact, { spentUt: 700, past: false }));
		expect(plain).toContain('title="The cost of every llm_call record in the vault"');
		expect(text(plain)).toContain("llm calls · whole vault");
	});
});

describe("the note after Budget", () => {
	const note = createElement("i", { "data-note": "here" }, "the note");

	it("is drawn between the Budget fact and the Integrity fact", () => {
		for (const a of [null, at()]) {
			const html = strip({ at: a, part: "facts", budgetNote: note });
			const budget = html.indexOf("<b>Budget");
			const noteAt = html.indexOf('<i data-note="here">the note</i>');
			const integrity = html.indexOf("<b>Integrity</b>");
			expect(budget).toBeGreaterThan(-1);
			expect(noteAt).toBeGreaterThan(budget);
			expect(integrity).toBeGreaterThan(noteAt);
			// Directly before the fact: nothing else between them.
			expect(html.slice(noteAt, integrity)).toBe(
				'<i data-note="here">the note</i><div class="ut-fact">',
			);
		}
	});

	it("is drawn in the same place while the summary loads", () => {
		const html = strip({ summary: null, part: "facts", budgetNote: note });
		const noteAt = html.indexOf('<i data-note="here">the note</i>');
		expect(noteAt).toBeGreaterThan(html.indexOf("<b>Budget"));
		expect(html.slice(noteAt, html.indexOf("<b>Integrity</b>"))).toBe(
			'<i data-note="here">the note</i><div class="ut-fact">',
		);
	});

	it("absent, nothing is drawn there", () => {
		expect(strip({ part: "facts" })).not.toContain("data-note");
		expect(strip({ part: "bar", budgetNote: note })).not.toContain("data-note");
		expect(strip({ part: "head", budgetNote: note })).not.toContain("data-note");
	});
});

describe("the Budget fact's scope", () => {
	it("at a past position today's figure is followed by whole vault", () => {
		const budget = text(fact(strip({ at: at(), part: "facts" }), "Budget"));
		const today = budget.indexOf(`today: ${formatUt(1_000_000)}`);
		expect(today).toBeGreaterThan(-1);
		expect(budget.indexOf("whole vault")).toBeGreaterThan(today);
		expect(budget.indexOf("whole vault")).toBeLessThan(budget.indexOf("budget history starts"));
		expect(budget).not.toContain("this month");
	});

	it("a past budget with no figure has nothing to scope, and holds the line empty", () => {
		const a = at({
			budget: {
				ut: null,
				source: "unpublished",
				writtenAt: null,
				provenance: "unknown: not yet published",
				note: "no budget is recorded",
			},
		});
		const budget = fact(strip({ at: a, part: "facts" }), "Budget");
		expect(text(budget)).not.toContain("whole vault");
		expect(budget.match(/class="ut-sub"/g)).toHaveLength(2);
		expect(budget).toContain('<span class="ut-sub" aria-hidden="true" data-reserve="true">');
	});

	it("PastBudgetFact is exported", () => {
		const html = renderToStaticMarkup(createElement(mod.PastBudgetFact, { at: at() }));
		expect(text(html)).toContain(`today: ${formatUsdTotal(1_000_000)}`);
		expect(text(html)).toContain("whole vault");
	});
});

describe("the facts' order", () => {
	/** Where each of the facts and the Details control starts, by its own mark. */
	const places = (html: string): number[] =>
		[
			"<b>Spend</b>",
			"<b>Budget",
			"<b>Integrity</b>",
			'class="ut-more"',
			"<b>Chain</b>",
			"<b>Anchor file</b>",
		].map((m) => html.indexOf(m));

	it("is Spend, Budget, Integrity, then Details and what it opens: Chain and Anchor file", () => {
		const cases: Partial<StripProps>[] = [{}, { at: at() }, { summary: BROKEN }, { summary: null }];
		for (const over of cases) {
			const found = places(strip({ ...over, part: "facts" }));
			expect(found.every((i) => i >= 0)).toBe(true);
			expect(found).toEqual([...found].sort((a, b) => a - b));
		}
	});

	it("the Details control comes straight after Integrity, and Chain straight after it", () => {
		const html = strip({ part: "facts" });
		expect(html).toMatch(
			/<b>Integrity<\/b>(?:(?!<div class="ut-fact).)*<\/div><button type="button" class="ut-more"/,
		);
		expect(html).toContain('</button><div class="ut-fact detail" id="ut-fact-chain">');
		const loading = strip({ summary: null, part: "facts" });
		expect(loading).toMatch(
			/<b>Integrity<\/b>(?:(?!<div class="ut-fact).)*<\/div><span class="ut-more" aria-hidden="true" data-reserve="true">Details<\/span><div class="ut-fact detail"><b>Chain<\/b>/,
		);
	});
});

describe("the Chain fact", () => {
	it("groups its count the one way the page writes numbers, whatever the reader's locale", () => {
		const chain = { events: 12_345, valid: true, empty: false, breakIndex: null, errors: [] };
		const live = strip({ summary: summary({ chain }), part: "facts" });
		expect(text(fact(live, "Chain"))).toContain("12,345 events");
		expect(fact(live, "Chain")).toContain('style="--n:13"');
		// At a past position the count is the records up to it.
		const past = strip({ at: at({ pos: 1_233 }), part: "facts" });
		expect(text(fact(past, "Chain"))).toContain("1,234 events");
	});
});

describe("the Integrity fact", () => {
	const draw = (s: SummaryPayload, a: AtPayload | null, anchorLine?: boolean): string =>
		renderToStaticMarkup(
			createElement(
				mod.IntegrityFact,
				anchorLine === undefined ? { s, at: a } : { s, at: a, anchorLine },
			),
		);

	it("live, chained and unanchored: says hash links only, never verified", () => {
		const html = draw(summary(), null);
		expect(text(html)).toContain("chained");
		expect(text(html)).toContain(NOT_ANCHORED_NOTE);
		expect(NOT_ANCHORED_NOTE).toBe("hash links only · not anchored");
		expect(text(html)).toContain("not yet read in full");
		expect(html).not.toMatch(/\bverified\b/i);
	});

	it("gives the time of the last full read in UTC, as the rest of the page does", () => {
		const html = draw(summary({ verifiedAt: "2026-11-10T14:42:27.000Z" }), null);
		expect(text(html)).toContain("links checked as of 11-10 14:42:27Z");
		expect(html).toContain(
			'title="links checked as of 11-10 14:42:27Z. The dashboard is a monitor',
		);
		// Never the reader's own clock or date order.
		expect(html).not.toMatch(/11\/10\/2026|\b[AP]M\b/);
		// A time that cannot be read is shown as written.
		expect(text(draw(summary({ verifiedAt: "not a time" }), null))).toContain(
			"links checked as of not a time",
		);
	});

	it("is the strip's own Integrity fact, live and past", () => {
		for (const s of [summary(), BROKEN, summary({ anchorFile: "present" })])
			for (const a of [null, at(), at({ chain: { valid: false, breakIndex: 3 } })]) {
				const own = draw(s, a);
				expect(own.startsWith('<div class="ut-fact"><b>Integrity</b>')).toBe(true);
				expect(strip({ summary: s, at: a, part: "facts" })).toContain(own);
			}
	});

	it("at a past position it reads the position's chain", () => {
		const html = text(draw(summary(), at({ chain: { valid: false, breakIndex: 3 } })));
		expect(html).toContain("broken from chain position 4");
		expect(text(draw(BROKEN, at()))).toContain("the links up to this point are intact");
	});

	it("with the anchor line, a recorded anchor file is named under the pill", () => {
		const anchored = summary({ anchorFile: "present" });
		expect(text(draw(anchored, null, true))).toContain("an anchor file is recorded");
		expect(text(draw(anchored, null, true))).not.toContain(NOT_ANCHORED_NOTE);
		expect(draw(anchored, null, true)).not.toMatch(/\bverified\b/i);
		// Off by default, and off when asked: the strip's own fact holds the line empty.
		expect(text(draw(anchored, null))).not.toContain("an anchor file is recorded");
		expect(text(draw(anchored, null, false))).not.toContain("an anchor file is recorded");
		expect(strip({ summary: anchored, part: "facts" })).not.toContain("an anchor file is recorded");
	});

	it("the anchor line says nothing of a file that is not there, or under a pill that is not chained", () => {
		expect(text(draw(summary(), null, true))).not.toContain("an anchor file is recorded");
		expect(text(draw(summary(), null, true))).toContain(NOT_ANCHORED_NOTE);
		const broken = { ...BROKEN, anchorFile: "present" as const };
		expect(text(draw(broken, null, true))).not.toContain("an anchor file is recorded");
		const empty = summary({
			anchorFile: "present",
			chain: { events: 0, valid: true, empty: true, breakIndex: null, errors: [] },
		});
		expect(text(draw(empty, null, true))).not.toContain("an anchor file is recorded");
		expect(text(draw(empty, null, true))).toContain("no events");
	});
});
