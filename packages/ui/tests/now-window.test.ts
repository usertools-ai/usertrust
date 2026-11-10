// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Now window, small: the as-at line, the facts with Rate now and the projection inside their grid, and the last
 * record. Spend, Budget and Integrity are read at the shown position; the rate, the projection and the last record
 * read now, from every row the page holds, whatever is pinned.
 */

import { readdirSync, readFileSync } from "node:fs";
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
import { atOf, type NowOver, renderNow } from "./helpers/now-desk.js";
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
/** A box held empty and unseen: its place is kept, so nothing moves when what it holds arrives or goes. */
const held = (tag: string, cls: string, inner = "\u00a0"): string =>
	`<${tag} class="${cls}" aria-hidden="true" data-reserve="true">${inner}</${tag}>`;
const HELD_PROJ = held("p", "ut-nw-proj");
const HELD_LAST = held("p", "ut-nw-last");
const HELD_RATE = `<div class="ut-fact ut-nw-rate" aria-busy="true"><b>Rate now</b><span class="v na">…</span>${held("span", "ut-nw-words")}${held("span", "ut-nw-spark", "")}</div>`;
/** The boxes the rate, the projection and the last record are drawn in, in the order the markup has them. */
const boxes = (html: string): string[] =>
	[...html.matchAll(/class="(?:ut-fact )?(ut-nw-(?:rate|words|spark|proj|last))"/g)].map(
		(m) => m[1] ?? "",
	);

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
			// The third row, by the markup's own order: Integrity under the rate, Details under the projection.
			'</p><div class="ut-fact"><b>Integrity</b>',
			'</div><button type="button" class="ut-more"',
			'</button><div class="ut-fact detail" id="ut-fact-chain"',
			'</div><div class="ut-fact detail" id="ut-fact-anchor"',
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

	it("the current minute is the minute, whatever the hour: at 12:31:45 the last hour is 11:32 to 12:32", async () => {
		const minute = NOW_MS + 31 * 60_000;
		const edge = spend("x", 0, 1_000, { ts: iso(minute - 3_600_000 + 60_000) });
		const inside = spend("x", 0, 4_000, { ts: iso(minute + 30_000) });
		// X_NEW and Y_NEW, at 11:02, are an hour and a half back; the records at 11:32:00 and 12:31:30 are in the hour.
		const rows = [X_NEW, Y_NEW, edge, inside];
		expect(rateNow(rows, chartWindow("1w", minute + 45_000, null).endMs).ratePerHourUt).toBe(5_000);
		// The first instant of that minute, the middle of it and its last read the same hour.
		for (const nowMs of [minute, minute + 45_000, minute + 59_999]) {
			expect(rateFigure(await renderNow({ rows, nowMs }))).toBe(formatUsdTotal(5_000));
		}
		// One millisecond on the minute has turned, and the hour starts at 11:33: the record at 11:32:00 has left it.
		expect(rateFigure(await renderNow({ rows, nowMs: minute + 60_000 }))).toBe(
			formatUsdTotal(4_000),
		);
	});

	it("the last full read is given in UTC, as every time on the page is", async () => {
		const summary = dayOneSummary({ verifiedAt: "2026-11-10T14:42:27.000Z" });
		const integrity = fact(await renderNow({ rows: ROWS, summary }), "Integrity");
		expect(text(integrity)).toContain("links checked as of 11-10 14:42:27Z");
		expect(integrity).not.toMatch(/11\/10\/2026|\b[AP]M\b/);
	});

	it("nothing the window draws is formatted by the reader's locale", () => {
		const SRC = join(import.meta.dirname, "..", "src", "app");
		const files = [
			...readdirSync(join(SRC, "windows", "now"))
				.filter((f) => /\.tsx?$/.test(f))
				.map((f) => join(SRC, "windows", "now", f)),
			join(SRC, "summary-strip.tsx"),
		];
		expect(files.length).toBeGreaterThan(4);
		for (const f of files) expect(readFileSync(f, "utf-8")).not.toMatch(/toLocale/);
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

	it("an overspent budget is already used, an idle vault has no date, an unknown budget holds the place empty", async () => {
		const used = dayOneSummary({ spentUt: 1_200_000, remainingUt: -200_000 });
		expect(text(await renderNow({ rows: ROWS, summary: used }))).toContain(NOW_COPY.projectionUsed);
		expect(text(await renderNow({ rows: [] }))).toContain(NOW_COPY.projectionIdle);
		const unknown = dayOneSummary({ budget: null, remainingUt: null });
		const html = await renderNow({ rows: ROWS, summary: unknown });
		expect(projLine(html)).toBe(HELD_PROJ);
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

	it("with no record the line's place is held empty; without a summary the rate is still given", async () => {
		expect(lastLine(await renderNow({ rows: [] }))).toBe(HELD_LAST);
		// Records without a summary yet: the rate is theirs to give, the projection needs the budget.
		const noSummary = await renderNow({ rows: ROWS, summary: null });
		expect(noSummary).toContain("vault summary loading");
		expect(rateFigure(noSummary)).toBe(formatUsdTotal(5_000));
		expect(projLine(noSummary)).toBe(HELD_PROJ);
	});
});

describe("the Now window before its records have loaded", () => {
	it("holds a box for the rate, the projection and the last record, and states no figure", async () => {
		for (const phase of ["loading", "failed"] as const) {
			const html = await renderNow({ rows: ROWS, phase });
			expect(html).toContain('aria-label="vault summary"');
			expect(html).toContain(`${HELD_RATE}${HELD_PROJ}<div class="ut-fact"><b>Integrity</b>`);
			expect(html).toContain(`</section>${HELD_LAST}</div>`);
			expect(html).not.toContain('data-fig="now.rate"');
			expect(html).not.toContain("<svg role");
			expect(text(html)).not.toContain("Projection");
			expect(text(html)).not.toContain("Last record");
		}
	});

	it("what loads takes the same boxes in the same order, whatever there is to say", async () => {
		const loading = boxes(await renderNow({ rows: ROWS, phase: "loading" }));
		expect(loading).toEqual([
			"ut-nw-rate",
			"ut-nw-words",
			"ut-nw-spark",
			"ut-nw-proj",
			"ut-nw-last",
		]);
		const loaded = await renderNow({ rows: ROWS });
		expect(loaded).toContain('<svg class="ut-nw-spark" role="img"');
		expect(loaded).not.toContain("data-reserve");
		const states: NowOver[] = [
			{ rows: ROWS },
			{ rows: ROWS, at: atOf(Y_MID, 12_000) },
			{ rows: ROWS, filters: only("actors", "nobody") },
			{ rows: ROWS, summary: dayOneSummary({ budget: null, remainingUt: null }) },
			{ rows: ROWS, summary: null },
			{ rows: [] },
		];
		for (const over of states) expect(boxes(await renderNow(over))).toEqual(loading);
		// At a past position the projection's place is kept, empty: the facts under it do not move up.
		expect(projLine(await renderNow({ rows: ROWS, at: atOf(Y_MID, 12_000) }))).toBe(HELD_PROJ);
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

describe("the Now window's budget at a past position", () => {
	const provenance = "from usertrust.config.json; not confirmed as enforced";
	const note = "budget history starts with the first budget record; this is today's budget";

	it("says where today's budget came from in the sentence the live fact uses", async () => {
		const at = atOf(Y_MID, 12_000, {
			budget: { ut: 1_000_000, source: "config", writtenAt: null, provenance, note },
		});
		const past = text(fact(await renderNow({ rows: ROWS, at }), "Budget"));
		expect(past).toContain(`${provenance}. ${note}`);
		expect(past).not.toContain("config · unconfirmed.");
		const summary = dayOneSummary({
			budgetSource: "config",
			budgetWrittenAt: null,
			budgetProvenance: provenance,
		});
		expect(text(fact(await renderNow({ rows: ROWS, summary }), "Budget"))).toContain(provenance);
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
	/** What the window's body holds: everything inside it, the frame around it left out. */
	const body = (html: string): string =>
		/<div class="ut-win-body">([\s\S]*)<\/div><\/section>/.exec(html)?.[1] ?? "";

	it("draws what the small form draws until its own parts land: live, at a position, under a filter", async () => {
		const states: NowOver[] = [
			{ rows: ROWS },
			{ rows: ROWS, at: atOf(Y_MID, 12_000) },
			{ rows: ROWS, filters: only("actors", "y") },
			{ rows: ROWS, at: atOf(Y_MID, 7_000), filters: only("actors", "y") },
			{ rows: ROWS, phase: "loading" },
		];
		for (const over of states) {
			const small = await renderNow(over);
			const filled = await renderNow({ ...over, fill: "now" });
			// Only the frame says which form it is.
			expect(small).toContain('data-win="now" data-filled="false" data-state="home"');
			expect(filled).toContain('data-win="now" data-filled="true" data-state="filled"');
			expect(filled).toContain('aria-label="Restore Now" aria-pressed="true"');
			const inside = body(filled);
			expect(inside.startsWith('<div class="ut-nw" data-gen="0"><')).toBe(true);
			for (const part of [
				'class="ut-facts"',
				"<b>Spend</b>",
				"<b>Rate now</b>",
				"ut-nw-proj",
				"ut-nw-last",
			])
				expect(inside).toContain(part);
			expect(inside).toBe(body(small));
		}
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
		// Rows 12px apart, columns 16px.
		expect(rule('[data-win="now"] .ut-facts')).toMatch(/gap:\s*12px 16px;/);
		expect(rule('[data-win="now"] .ut-nw-rate')).toMatch(
			/grid-template-columns:\s*minmax\(0, 1fr\) auto;/,
		);
		const spark = rule('[data-win="now"] .ut-nw-rate > .ut-nw-spark');
		expect(spark).toMatch(/grid-column:\s*2;/);
		expect(rule(".ut-nw-line")).toMatch(/fill:\s*none;/);
		expect(rule('.ut-nw-rate[data-unusual="true"] .ut-nw-words')).toMatch(
			/color:\s*var\(--dk-gold\);/,
		);
		// The dot's colour is set where it is drawn, as the line's is.
		expect(SHEET).not.toMatch(/\.ut-nw-dot/);
		expect(rule(".ut-nw-proj")).toMatch(/font-variant-numeric:\s*tabular-nums;/);
		expect(rule(".ut-nw-last")).toMatch(/text-overflow:\s*ellipsis;/);
	});

	it("sets the facts' lines closer than the page-wide strip did, so the Budget fact is at most 170px tall", () => {
		const px = (decls: string, prop: string): number =>
			Number(new RegExp(`(?:^|[;\\s])${prop}:\\s*([0-9.]+)px;`).exec(decls)?.[1] ?? Number.NaN);
		const gap = px(rule('[data-win="now"] .ut-facts .ut-fact'), "row-gap");
		const label = px(rule('[data-win="now"] .ut-facts .ut-fact > b'), "min-height");
		const value = rule(
			'[data-win="now"] .ut-facts .ut-fact .v, [data-win="now"] .ut-facts .ut-fact .v.na',
		);
		const sub = rule('[data-win="now"] .ut-facts .ut-fact.budget > .ut-sub');
		expect([gap, label, px(value, "height"), px(value, "line-height")]).toEqual([4, 13, 18, 18]);
		// The Budget fact's usertoken line and its scope line are one line each.
		expect([px(sub, "height"), px(sub, "line-height")]).toEqual([14, 14]);
		expect(sub).toMatch(/-webkit-line-clamp:\s*1;/);
		expect(sub).toMatch(/(?:^|[;\s])line-clamp:\s*1;/);
		// The lines the older sheet still sizes: the meter, the amounts and the two-line note.
		const older = allCss();
		const meter = Number(/\.ut-meter\s*\{\s*height:\s*([0-9.]+)px;/.exec(older)?.[1]);
		const amounts = Number(/\.ut-facts \.ut-amts\s*\{\s*height:\s*([0-9.]+)px;/.exec(older)?.[1]);
		const why = Number(/\.ut-facts \.ut-why\s*\{\s*height:\s*([0-9.]+)px;/.exec(older)?.[1]);
		expect([meter, amounts, why]).toEqual([3, 32, 34]);
		// Label, figure, meter, amounts, usertokens, scope, note: seven lines and the six gaps between them. Each line's
		// top, from the fact's: the figure 17, the meter 39, the amounts 46, the usertokens 82, the scope 100, the note
		// 118.
		const heights = [
			label,
			px(value, "height"),
			meter,
			amounts,
			px(sub, "height"),
			px(sub, "height"),
			why,
		];
		const tops = heights.map((_, i) => heights.slice(0, i).reduce((a, b) => a + b + gap, 0));
		expect(tops).toEqual([0, 17, 39, 46, 82, 100, 118]);
		const cell = (tops.at(-1) ?? Number.NaN) + why;
		expect(cell).toBe(152);
		expect(cell).toBeLessThanOrEqual(170);
	});

	it("gives each held box the size of what it will hold, and keeps it unseen", () => {
		// The line's box is the drawn line's: 96 by 32, whether it is the line or its place.
		const spark = rule('[data-win="now"] .ut-nw-rate > .ut-nw-spark');
		expect(spark).toMatch(/width:\s*96px;/);
		expect(spark).toMatch(/min-height:\s*32px;/);
		// One line of their own text, at the least.
		for (const line of [".ut-nw-proj", ".ut-nw-last"]) {
			expect(rule(line)).toMatch(/font:\s*400 11\.5px\/1\.4 var\(--sans\);/);
			expect(rule(line)).toMatch(/min-height:\s*calc\(11\.5px \* 1\.4\);/);
		}
		// Inside the facts the older sheet hides what is held; the last record sits outside them.
		expect(allCss()).toMatch(/\.ut-facts \[data-reserve="true"\]\s*\{\s*visibility:\s*hidden;/);
		expect(rule('.ut-nw-last[data-reserve="true"]')).toMatch(/visibility:\s*hidden;/);
	});
});
