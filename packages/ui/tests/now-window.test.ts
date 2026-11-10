// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Now window, small: the as-at line, the facts with Rate now and the projection inside their grid, and the last
 * record. Spend, Budget and Integrity are read at the shown position; the rate, the projection and the last record
 * read now, from every row the page holds, whatever is pinned.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chartWindow } from "../src/shared/chart-window.js";
import { rankColors } from "../src/shared/colors.js";
import { EMPTY_FILTERS, type FilterState } from "../src/shared/filters.js";
import { formatUsd, formatUsdTotal, formatUt } from "../src/shared/format.js";
import { projectionOf } from "../src/shared/now-burn.js";
import { NOW_COPY } from "../src/shared/now-copy.js";
import { rateNow } from "../src/shared/now-rate.js";
import type { LedgerRow } from "../src/shared/rows.js";
import { allCss } from "./helpers/css.js";
import { dayOneSummary } from "./helpers/day-one.js";
import { atOf, renderNow } from "./helpers/now-desk.js";
import { NOW_MS, spend, text } from "./helpers/share.js";

const END = chartWindow("1w", NOW_MS, null).endMs;
const iso = (ms: number): string => new Date(ms).toISOString();
const only = (field: "actors" | "providers", ...values: string[]): FilterState => ({
	...EMPTY_FILTERS,
	[field]: values,
});

// Two lanes over the week, each with a record in the last hour: x spends 7,000 UT, y 10,000.
const X_OLD = spend("x", 10, 5_000);
const Y_MID = spend("y", 100, 7_000);
const X_NEW = spend("x", 167, 2_000);
const Y_NEW = spend("y", 167, 3_000);
const ROWS = [X_OLD, Y_MID, X_NEW, Y_NEW];
/** One lane spending the same every hour for 30 hours: a rate inside its usual range. */
const STEADY = Array.from({ length: 30 }, (_, i) => spend("x", 138 + i, 1_000));
const SUMMARY = dayOneSummary();

/** One fact of the grid, by its heading: from its opening tag to the next fact, the Details button or the grid's end. */
function fact(html: string, heading: string): string {
	const parts = html.split(
		/(?=<div class="ut-fact)|(?=<button type="button" class="ut-more")|(?=<\/section>)/,
	);
	return (
		parts.find((c) => c.startsWith('<div class="ut-fact') && c.includes(`<b>${heading}`)) ?? ""
	);
}
const rateFigure = (html: string): string =>
	/<span class="v" data-fig="now\.rate">(.*?)<small>/.exec(html)?.[1] ?? "";
const lastLine = (html: string): string =>
	/<p class="ut-nw-last"[^>]*>.*?<\/p>/.exec(html)?.[0] ?? "";
const projLine = (html: string): string =>
	/<p class="ut-nw-proj"[^>]*>.*?<\/p>/.exec(html)?.[0] ?? "";
const escaped = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("'", "&#x27;");

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW_MS);
});
afterEach(() => {
	vi.useRealTimers();
});

describe("the Now window, live", () => {
	it("holds the facts, the rate, the projection and the last record, and no status tally", async () => {
		const html = await renderNow({ rows: ROWS });
		const said = text(html);
		expect(html).toContain('data-win="now"');
		expect(html).toContain('aria-label="vault summary"');
		expect(text(fact(html, "Spend"))).toContain("llm calls · whole vault");
		expect(fact(html, "Spend")).toContain(`title="${formatUsd(SUMMARY.spentUt)}"`);
		expect(text(fact(html, "Budget"))).toContain(NOW_COPY.scopeVault);
		expect(said).toContain("hash links only · not anchored");
		expect(said).toContain("Rate now");
		expect(said).toContain("Projection:");
		expect(said).toContain("Last record");
		expect(html).not.toContain('data-fig="status.');
		// The window has no line of its own under its title: what is read at a position says so itself.
		expect(html).not.toContain("ut-win-sub");
	});

	it("draws its parts in order: the as-at line, the facts with the rate after Budget, the last record", async () => {
		const html = await renderNow({ rows: ROWS });
		const marks = [
			'<div class="ut-nw" data-gen="0"><p class="ut-asat"',
			"<b>Spend</b>",
			"<b>Budget",
			"<b>Rate now</b>",
			'</svg></div><p class="ut-nw-proj"',
			'</p><button type="button" class="ut-more"',
			'id="ut-fact-chain"',
			"<b>Integrity</b>",
			'id="ut-fact-anchor"',
			'</section><p class="ut-nw-last"',
		];
		const found = marks.map((m) => html.indexOf(m));
		expect(found.every((i) => i >= 0)).toBe(true);
		expect(found).toEqual([...found].sort((a, b) => a - b));
	});

	it("says nothing it cannot stand behind", async () => {
		const said = text(await renderNow({ rows: ROWS }));
		expect(said).not.toMatch(
			/this month|\bverified\b|\bheld\b|runaway|anomaly|governor|\bloop\b|Rate at this point/i,
		);
	});

	it("the rate is the last hour of every row, on the small line with its usual range", async () => {
		const html = await renderNow({ rows: ROWS });
		const view = rateNow(ROWS, END);
		expect(view.known).toBe(true);
		expect(view.ratePerHourUt).toBe(5_000);
		expect(rateFigure(html)).toBe(formatUsdTotal(5_000));
		expect(html).toContain("ut-nw-band");
		// 5,000 UT in an hour, after a week of almost none: the view's own reading, in its words and its gold.
		expect(view.unusual).toBe(true);
		expect(text(html)).toContain(NOW_COPY.rateUnusual);
		expect(html).toContain('style="stroke:var(--dk-gold)"');
	});

	it("the rate runs to the end of the current minute", async () => {
		const rows = [
			spend("x", 0, 4_000, { ts: iso(NOW_MS - 3_600_000 + 50_000) }),
			spend("x", 0, 3_000, { ts: iso(NOW_MS + 30_000) }),
		];
		// At 12:00:45 the last hour is 11:01 to 12:01: the record at 11:00:50 is before it, the one at 12:00:30 in it.
		expect(rateFigure(await renderNow({ rows, nowMs: NOW_MS + 45_000 }))).toBe(
			formatUsdTotal(3_000),
		);
	});

	it("the projection is the pure one, over the unfiltered rows, with its tooltip", async () => {
		const p = projectionOf(SUMMARY, ROWS, END);
		expect(p?.text).toContain("Projection: reaches");
		const html = await renderNow({ rows: ROWS });
		expect(projLine(html)).toBe(
			`<p class="ut-nw-proj" title="${escaped(p?.title ?? "")}">${escaped(p?.text ?? "")}</p>`,
		);
		// A filter narrows the rate, never the pace the whole vault's budget is set against.
		const y = ROWS.filter((r) => r.actor === "y");
		expect(projectionOf(SUMMARY, y, END)?.text).not.toBe(p?.text);
		expect(projLine(await renderNow({ rows: ROWS, filters: only("actors", "y") }))).toBe(
			projLine(html),
		);
	});

	it("an overspent budget is already used, an idle vault has no date, an unknown budget has no line", async () => {
		const used = dayOneSummary({ spentUt: 1_200_000, remainingUt: -200_000 });
		expect(text(await renderNow({ rows: ROWS, summary: used }))).toContain(NOW_COPY.projectionUsed);
		expect(text(await renderNow({ rows: [] }))).toContain(NOW_COPY.projectionIdle);
		const unknown = dayOneSummary({ budget: null, remainingUt: null });
		const html = await renderNow({ rows: ROWS, summary: unknown });
		expect(html).not.toContain("ut-nw-proj");
		expect(text(html)).not.toContain("Projection");
		expect(text(html)).toContain("Rate now");
	});
});

describe("the Now window's last record", () => {
	it("is the newest by position, wherever it sits, as its time, model, actor and cost", async () => {
		const newest = spend("agent:5f1c2a9e-77aa", 167, 3_000);
		const html = await renderNow({ rows: [newest, X_OLD] });
		expect(lastLine(html)).toBe(
			`<p class="ut-nw-last" title="record ${newest.pos + 1} · ${newest.ts}"><b>Last record</b> 11:01:00Z · claude-sonnet-5 · agent · 5f1c2a9e · ${formatUsdTotal(3_000)}</p>`,
		);
	});

	it("a record of another day keeps its date; one that cannot be read is shown as written", async () => {
		expect(text(lastLine(await renderNow({ rows: [X_OLD] })))).toContain(
			"Last record 11-01 22:01:00Z · ",
		);
		const odd = spend("x", 0, 5, { ts: "not a time" });
		expect(text(lastLine(await renderNow({ rows: [odd] })))).toContain("Last record not a time · ");
		// 23:59:30: the minute ends at midnight, and a record at 23:10 is still today's.
		const late = Date.UTC(2026, 10, 8, 23, 59, 30);
		const today = spend("x", 0, 5, { ts: iso(late - 49 * 60_000 - 30_000) });
		expect(text(lastLine(await renderNow({ rows: [today], nowMs: late })))).toContain(
			"Last record 23:10:00Z · ",
		);
	});

	it("a record with no model is named by its kind, and one with no cost prints none", async () => {
		const bare = Object.fromEntries(
			Object.entries(spend("x", 167, 0, { kind: "policy_denied" })).filter(
				([k]) => k !== "costUt" && k !== "model",
			),
		) as unknown as LedgerRow;
		const line = text(lastLine(await renderNow({ rows: [bare] })));
		expect(line).toBe("Last record 11:01:00Z · policy_denied · x");
		expect(line).not.toContain("$");
		// A cost of nothing is still a cost the record states.
		const free = text(lastLine(await renderNow({ rows: [spend("x", 167, 0)] })));
		expect(free).toBe(`Last record 11:01:00Z · claude-sonnet-5 · x · ${formatUsdTotal(0)}`);
	});

	it("nothing is drawn when there is no record, or before the records have loaded", async () => {
		expect(await renderNow({ rows: [] })).not.toContain("ut-nw-last");
		const loading = await renderNow({ rows: ROWS, phase: "loading" });
		for (const cls of ["ut-nw-last", "ut-nw-rate", "ut-nw-proj"])
			expect(loading).not.toContain(cls);
		expect(loading).toContain('aria-label="vault summary"');
		// Records without a summary yet: the rate is theirs to give, the projection needs the budget.
		const noSummary = await renderNow({ rows: ROWS, summary: null });
		expect(noSummary).toContain("vault summary loading");
		expect(rateFigure(noSummary)).toBe(formatUsdTotal(5_000));
		expect(noSummary).not.toContain("ut-nw-proj");
	});
});

describe("the Now window at a past position", () => {
	it("reads its facts there and its rate now, with no projection", async () => {
		const html = await renderNow({ rows: ROWS, at: atOf(Y_MID, 12_000) });
		const said = text(html);
		expect(said).toContain("As recorded at");
		expect(text(fact(html, "Spend"))).toContain("llm calls · up to this point");
		expect(fact(html, "Spend")).toContain(`title="${formatUsd(12_000)}"`);
		expect(text(fact(html, "Budget"))).toContain("today: ");
		expect(text(fact(html, "Budget"))).toContain(NOW_COPY.scopeVault);
		expect(said).toContain("Rate now");
		expect(said).not.toContain("Rate at this point");
		expect(said).not.toContain("Projection");
		expect(html).not.toContain("ut-win-sub");
		// The rate and the last record are the live ones: records after the position count.
		const live = await renderNow({ rows: ROWS });
		expect(rateFigure(html)).toBe(rateFigure(live));
		expect(lastLine(html)).toBe(lastLine(live));
		expect(lastLine(html)).toContain(`title="record ${Y_NEW.pos + 1} `);
	});
});

describe("the Now window under a filter", () => {
	it("Spend is the filtered records' sum and says so; Budget stays the vault's; the rate narrows", async () => {
		const html = await renderNow({ rows: ROWS, filters: only("actors", "y") });
		const spendFact = fact(html, "Spend");
		expect(text(spendFact)).toContain(NOW_COPY.scopeFiltered);
		expect(text(spendFact)).not.toContain("up to this point");
		expect(text(spendFact)).toContain(formatUt(10_000));
		expect(spendFact).toContain(`title="${formatUsd(10_000)}"`);
		const live = await renderNow({ rows: ROWS });
		expect(text(fact(live, "Spend"))).not.toContain("filtered");
		expect(fact(html, "Budget")).toBe(fact(live, "Budget"));
		expect(fact(html, "Budget")).not.toBe("");
		expect(rateFigure(html)).toBe(formatUsdTotal(3_000));
		expect(lastLine(html)).toContain(`title="record ${Y_NEW.pos + 1} `);
		expect(lastLine(await renderNow({ rows: ROWS, filters: only("actors", "x") }))).toContain(
			`title="record ${X_NEW.pos + 1} `,
		);
	});

	it("at a position the sum stops there, the position's own record counted, and the label says both", async () => {
		const html = await renderNow({
			rows: ROWS,
			filters: only("actors", "y"),
			at: atOf(Y_MID, 12_000),
		});
		const spendFact = fact(html, "Spend");
		expect(text(spendFact)).toContain(NOW_COPY.scopeFilteredPast);
		expect(text(spendFact)).toContain(formatUt(7_000));
		expect(spendFact).not.toContain(formatUsd(12_000));
		// The rate still reads now, narrowed.
		expect(rateFigure(html)).toBe(formatUsdTotal(3_000));
	});

	it("one value of a category tints the line: the provider's colour before the lane's", async () => {
		expect(rateNow(STEADY, END).unusual).toBe(false);
		const provider = rankColors(STEADY, "provider").of("anthropic");
		const lane = rankColors(STEADY, "lane").of("x");
		expect(provider).not.toBe(lane);
		const stroke = async (filters: FilterState): Promise<string> =>
			/class="ut-nw-line"[^>]*style="stroke:([^"]*)"/.exec(
				await renderNow({ rows: STEADY, filters }),
			)?.[1] ?? "";
		expect(await stroke(EMPTY_FILTERS)).toBe("var(--dk-text)");
		expect(await stroke(only("actors", "x"))).toBe(lane);
		expect(await stroke({ ...only("actors", "x"), providers: ["anthropic"] })).toBe(provider);
	});
});

describe("the Now window, filled", () => {
	it("draws its data container and nothing in it yet", async () => {
		const html = await renderNow({ rows: ROWS, fill: "now" });
		expect(html).toContain('<div class="ut-nw" data-gen="0"></div>');
		expect(html).not.toContain("ut-facts");
	});
});

describe("the Now window's sheet", () => {
	const NOW_DIR = join(import.meta.dirname, "..", "src", "app", "windows", "now");
	const SHEET = readFileSync(join(NOW_DIR, "now.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
	const rules = [...SHEET.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
		(m) => [(m[1] ?? "").replace(/\s+/g, " ").trim(), m[2] ?? ""] as const,
	);
	/** The declarations of the rule whose selector is exactly `selector`, outside any narrower-screen block. */
	const rule = (selector: string): string => rules.find(([sel]) => sel === selector)?.[1] ?? "";
	const NARROW = SHEET.slice(SHEET.indexOf("@media (max-width: 760px)"));

	it("keeps every rule in the components layer, under the window's prefix or its scope", () => {
		expect(SHEET.trim().startsWith("@layer components {")).toBe(true);
		const selectors = rules
			.flatMap(([sel]) => sel.split(","))
			.map((s) => s.trim())
			.filter((s) => !/^(from|to|\d+%|@.*)$/.test(s));
		expect(selectors.length).toBeGreaterThan(15);
		for (const s of selectors) expect(s).toMatch(/^(\.ut-nw\b|\[data-win="now"\])/);
		expect(allCss()).toContain(".ut-nw-proj");
		expect(SHEET).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
	});

	it("fades the data in when it changes, on the container only, and not at all under reduced motion", () => {
		const timed = rules.filter(([, decls]) => /animation:/.test(decls) && /0\.22s/.test(decls));
		expect(timed.map(([sel]) => sel)).toEqual(['.ut-nw[data-gen="a"]', '.ut-nw[data-gen="b"]']);
		for (const [, decls] of timed) {
			expect(decls).toMatch(/0\.22s cubic-bezier\(0\.16, 0\.84, 0\.3, 1\)/);
		}
		expect(SHEET).not.toMatch(/transition:/);
		const reduced = SHEET.slice(SHEET.indexOf("@media (prefers-reduced-motion: reduce)"));
		expect(reduced).toMatch(/^@media[^{]*\{\s*\.ut-nw\[data-gen\]\s*\{\s*animation:\s*none;/);
		// The container is as tall as what it holds: the desk sizes its row from it.
		expect(rule(".ut-nw")).toMatch(/flex:\s*0 0 auto;/);
	});

	it("shows Details at every width, with Chain and Anchor file behind it", () => {
		const more = rule('[data-win="now"] .ut-facts .ut-more');
		expect(more).toMatch(/display:\s*flex;/);
		expect(more).toMatch(/align-self:\s*end;/);
		expect(more).toMatch(/justify-self:\s*start;/);
		expect(more).toMatch(/min-height:\s*28px;/);
		expect(more).toMatch(/font:\s*500 11px\/1 var\(--sans\);/);
		expect(more).toMatch(/text-transform:\s*uppercase;/);
		const detail = rule('[data-win="now"] .ut-facts .ut-fact.detail');
		expect(detail).toMatch(/display:\s*none;/);
		// The sheet reorders nothing: the order on screen stays the markup's, which Tab follows.
		expect(SHEET).not.toMatch(/(^|[\s;{])order\s*:/);
		expect(rule('[data-win="now"] .ut-facts[data-details="true"] .ut-fact.detail')).toMatch(
			/display:\s*flex;/,
		);
		// A phone's button keeps the 32px its touch area is measured from.
		expect(NARROW).toMatch(/\[data-win="now"\] \.ut-facts \.ut-more\s*\{\s*min-height:\s*32px;/);
	});

	it("lays the rate out as a fact with its line beside it, in two columns of facts", () => {
		expect(rule('[data-win="now"] .ut-facts')).toMatch(
			/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/,
		);
		expect(rule('[data-win="now"] .ut-nw-rate')).toMatch(
			/grid-template-columns:\s*minmax\(0, 1fr\) auto;/,
		);
		expect(rule('[data-win="now"] .ut-nw-rate > svg')).toMatch(/grid-column:\s*2;/);
		expect(rule(".ut-nw-line")).toMatch(/fill:\s*none;/);
		expect(rule('.ut-nw-rate[data-unusual="true"] .ut-nw-words')).toMatch(
			/color:\s*var\(--dk-gold\);/,
		);
		expect(rule(".ut-nw-dot")).toMatch(/fill:\s*var\(--dk-gold\);/);
		expect(rule(".ut-nw-proj")).toMatch(/font-variant-numeric:\s*tabular-nums;/);
		expect(rule(".ut-nw-last")).toMatch(/text-overflow:\s*ellipsis;/);
	});
});
