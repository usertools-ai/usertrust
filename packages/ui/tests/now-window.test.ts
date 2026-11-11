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
import { GAP, ROW_STEP, rowsToFit } from "../src/shared/desk-grid.js";
import { DESK_GAP, HOME, USUAL_NOW_ROWS } from "../src/shared/desk-layout.js";
import { applyFilters, EMPTY_FILTERS, type FilterState } from "../src/shared/filters.js";
import { formatUsd, formatUsdTotal, formatUt } from "../src/shared/format.js";
import { listView } from "../src/shared/list-view.js";
import { projectionOf } from "../src/shared/now-burn.js";
import { NOW_COPY } from "../src/shared/now-copy.js";
import { spendUpTo } from "../src/shared/now-lists.js";
import { rateNow } from "../src/shared/now-rate.js";
import type { LedgerRow } from "../src/shared/rows.js";
import { allCss } from "./helpers/css.js";
import { dayOneSummary } from "./helpers/day-one.js";
import { atOf, type NowOver, renderNow } from "./helpers/now-desk.js";
import { NOW_MS, spend, text } from "./helpers/share.js";

const END = chartWindow("1w", NOW_MS, null).endMs;
const iso = (ms: number): string => new Date(ms).toISOString();
const only = (field: "actors" | "providers" | "statuses", ...values: string[]): FilterState => ({
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
	/<span class="v" data-fig="now\.rate"[^>]*><span class="ut-fit"[^>]*>(.*?)<small>/.exec(
		html,
	)?.[1] ?? "";
/** The line under the Spend figure that says what the figure is the sum of. */
const spendScope = (html: string): string =>
	/<span class="ut-sub" title="([^"]*)">/.exec(fact(html, "Spend"))?.[1] ?? "";
const asAtLine = (html: string): string => /<p class="ut-asat"[^>]*>.*?<\/p>/.exec(html)?.[0] ?? "";
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

	it("the one use of the word held is the rows held, said once, of a filtered sum in a vault not all in the list", async () => {
		const cut = dayOneSummary({ truncated: true, rowCount: 4 });
		const y = only("actors", "y");
		const states: [NowOver, number][] = [
			[{ rows: ROWS }, 0],
			[{ rows: ROWS, filters: y }, 0],
			[{ rows: ROWS, summary: cut }, 0],
			[{ rows: ROWS, summary: cut, filters: y }, 1],
			[{ rows: ROWS, summary: cut, filters: y, at: atOf(Y_MID, 12_000) }, 1],
		];
		for (const [over, times] of states) {
			const said = text(await renderNow(over));
			expect(said.split("rows held only").length - 1).toBe(times);
			// Nothing else is held: not a figure, not a record, not a budget.
			expect(said.replaceAll("rows held only", "")).not.toMatch(
				/this month|\bverified\b|\bheld\b|runaway|anomaly|\bloop\b|Rate at this point/i,
			);
		}
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
		// X_NEW and Y_NEW, at 11:01, are an hour and a half back; the records at 11:32:00 and 12:31:30 are in the hour.
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
		// A filter narrows the rate, never the pace the whole vault's budget is set against: the date and the pace are
		// the unfiltered ones, and the sentence says whose they are.
		const y = ROWS.filter((r) => r.actor === "y");
		expect(projectionOf(SUMMARY, y, END)?.text).not.toBe(p?.text);
		const whole = projectionOf(SUMMARY, ROWS, END, true);
		expect(whole?.text).toBe(p?.text.replace("Projection:", "Projection, whole vault:"));
		expect(whole?.text.startsWith("Projection, whole vault: reaches ")).toBe(true);
		expect(projLine(await renderNow({ rows: ROWS, filters: only("actors", "y") }))).toBe(
			`<p class="ut-nw-proj" title="${escaped(p?.title ?? "")}">${escaped(whole?.text ?? "")}</p>`,
		);
	});

	it("an overspent budget is already used, an idle vault has no date, an unknown budget holds the place empty", async () => {
		const used = dayOneSummary({ spentUt: 1_200_000, remainingUt: -200_000 });
		expect(text(await renderNow({ rows: ROWS, summary: used }))).toContain(NOW_COPY.projectionUsed);
		expect(text(await renderNow({ rows: [] }))).toContain(NOW_COPY.projectionIdle);
		// Under a filter each says it is the whole vault's.
		const y = only("actors", "y");
		expect(text(projLine(await renderNow({ rows: ROWS, summary: used, filters: y })))).toBe(
			"Projection, whole vault: the budget is already used",
		);
		expect(text(projLine(await renderNow({ rows: [], filters: y })))).toBe(
			"Projection, whole vault: no spend in the past week, so no date",
		);
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
			// A failed read is not announced as busy: nothing is coming.
			const held = phase === "failed" ? HELD_RATE.replace(' aria-busy="true"', "") : HELD_RATE;
			expect(html).toContain(`${held}${HELD_PROJ}<div class="ut-fact"><b>Integrity</b>`);
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

describe("the Now window's as-at line", () => {
	it("follows the header's position: a previewed one, while the facts stay at the committed one", async () => {
		const committed = atOf(Y_MID, 12_000);
		const preview = atOf(X_OLD, 5_000);
		const atPreview = asAtLine(await renderNow({ rows: ROWS, at: preview }));
		const atCommitted = asAtLine(await renderNow({ rows: ROWS, at: committed }));
		expect(text(atPreview)).toContain("As recorded at");
		expect(atPreview).not.toBe(atCommitted);
		const html = await renderNow({ rows: ROWS, at: committed, headAt: preview });
		expect(asAtLine(html)).toBe(atPreview);
		// The facts are not the header's: they stay where the view is.
		expect(fact(html, "Spend")).toContain(`title="${formatUsd(12_000)}"`);
		// A preview over the live view: the line says where the header is, the facts stay live.
		const live = await renderNow({ rows: ROWS, headAt: preview });
		expect(asAtLine(live)).toBe(atPreview);
		expect(text(fact(live, "Spend"))).toContain("llm calls · whole vault");
		// With no preview the header is back at the committed position, or live.
		expect(asAtLine(await renderNow({ rows: ROWS, at: committed, headAt: committed }))).toBe(
			atCommitted,
		);
		expect(asAtLine(await renderNow({ rows: ROWS, at: committed, headAt: null }))).toContain(
			'data-live="true"',
		);
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

	it("at a position the sum is of the records the Ledger lists there, each with the status it had then", async () => {
		// Four calls in the last hour. The first was settled at the position and has failed since; the second had no
		// verdict there and is settled now.
		const changed = spend("x", 167, 4_000, { status: "failed" });
		const since = spend("x", 167, 1_000, { status: "settled" });
		const pin = spend("x", 167, 2_000, { status: "settled" });
		const after = spend("x", 167, 8_000, { status: "settled" });
		const rows = [changed, since, pin, after];
		const filters = only("statuses", "settled");
		const at = atOf(pin, 99_000, {
			statusAt: { [changed.hash]: "settled", [since.hash]: "unknown" },
		});
		// The Ledger's own list at the position, from the page's helper.
		const listed = listView({ rows, at, filters, phase: "loaded", summary: SUMMARY }).filtered;
		expect(listed.map((r) => r.pos)).toEqual([changed.pos, pin.pos]);
		const want = spendUpTo(listed, null);
		expect(want).toBe(6_000);
		const html = await renderNow({ rows, filters, at });
		expect(fact(html, "Spend")).toContain(`title="${formatUsd(want)}"`);
		expect(text(fact(html, "Spend"))).toContain(formatUt(want));
		expect(spendScope(html)).toBe(NOW_COPY.scopeFilteredPast);
		// Read with today's statuses the sum to the position is another: the call settled since is counted, the one
		// that has failed since is dropped.
		expect(spendUpTo(applyFilters(rows, filters), pin.pos)).toBe(3_000);
		// The rate and the last record read now, with today's statuses: the three calls settled today.
		expect(rateFigure(html)).toBe(formatUsdTotal(11_000));
		expect(lastLine(html)).toContain(`title="record ${after.pos + 1} `);
	});

	it("while the list waits for the position's own records, Spend stays the vault's figure there under its own label", async () => {
		const html = await renderNow({
			rows: ROWS,
			filters: only("actors", "y"),
			at: atOf(Y_MID, 12_000),
			reloading: true,
		});
		expect(fact(html, "Spend")).toContain(`title="${formatUsd(12_000)}"`);
		expect(spendScope(html)).toBe("llm calls · up to this point");
		expect(text(fact(html, "Spend"))).not.toContain("filtered");
	});

	it("while the list still draws another position than the committed one, the sum and its label are both the list's", async () => {
		const y = only("actors", "y");
		const pin = atOf(Y_MID, 12_000);
		// Back to live, the list not yet redrawn: the records up to the pin, and the label says so.
		const lagging = await renderNow({ rows: ROWS, filters: y, at: null, listAt: pin });
		expect(fact(lagging, "Spend")).toContain(`title="${formatUsd(7_000)}"`);
		expect(spendScope(lagging)).toBe("llm calls · filtered, up to this point");
		// A pin just set, the list still live: every filtered record, and no word of a point.
		const ahead = await renderNow({ rows: ROWS, filters: y, at: pin, listAt: null });
		expect(fact(ahead, "Spend")).toContain(`title="${formatUsd(10_000)}"`);
		expect(spendScope(ahead)).toBe("llm calls · filtered");
	});

	it("the rate and the last record say they are filtered, before the records load too; with no filter they do not", async () => {
		const y = only("actors", "y");
		for (const over of [{}, { at: atOf(Y_MID, 12_000) }]) {
			const html = await renderNow({ rows: ROWS, filters: y, ...over });
			expect(html).toContain("<b>Rate now · filtered</b>");
			expect(html).not.toContain("<b>Rate now</b>");
			expect(lastLine(html)).toContain("<b>Last record · filtered</b> 11:01:00Z · ");
		}
		const live = await renderNow({ rows: ROWS });
		expect(live).toContain("<b>Rate now</b>");
		expect(lastLine(live)).toContain("<b>Last record</b> 11:01:00Z · ");
		expect(text(live)).not.toContain("filtered");
		expect(text(live)).not.toContain("Projection, whole vault");
		// The heading is known before the rate is: the box held for it already says which rate it will be.
		const loading = await renderNow({ rows: ROWS, filters: y, phase: "loading" });
		expect(HELD_RATE).toContain("<b>Rate now</b>");
		expect(loading).toContain(HELD_RATE.replace("<b>Rate now</b>", "<b>Rate now · filtered</b>"));
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

describe("the Now window under a filter, in a vault the list does not hold whole", () => {
	const CUT = dayOneSummary({ truncated: true, rowCount: ROWS.length });
	const y = only("actors", "y");

	it("the filtered sum says it is of the rows held, and at a position that it stops there", async () => {
		const html = await renderNow({ rows: ROWS, summary: CUT, filters: y });
		expect(spendScope(html)).toBe("llm calls · filtered, rows held only");
		expect(fact(html, "Spend")).toContain(`title="${formatUsd(10_000)}"`);
		const pinned = await renderNow({
			rows: ROWS,
			summary: CUT,
			filters: y,
			at: atOf(Y_MID, 12_000),
		});
		expect(spendScope(pinned)).toBe("llm calls · filtered, rows held only, up to this point");
		expect(fact(pinned, "Spend")).toContain(`title="${formatUsd(7_000)}"`);
	});

	it("a position before the rows held: none of them is at or before it, and the label says whose sum the zero is", async () => {
		const at = atOf(X_OLD, 5_000, { windowStartPos: Y_MID.pos });
		const html = await renderNow({ rows: ROWS, summary: CUT, filters: only("actors", "x"), at });
		expect(fact(html, "Spend")).toContain(`title="${formatUsd(0)}"`);
		expect(text(fact(html, "Spend"))).toContain(formatUsdTotal(0));
		expect(formatUsdTotal(0)).toBe("$0.00");
		expect(spendScope(html)).toBe("llm calls · filtered, rows held only, up to this point");
	});

	it("with no filter the figure is the summary's, of the whole vault, as in a vault held whole", async () => {
		const cut = await renderNow({ rows: ROWS, summary: CUT });
		expect(spendScope(cut)).toBe("llm calls · whole vault");
		expect(text(fact(cut, "Spend"))).toBe(text(fact(await renderNow({ rows: ROWS }), "Spend")));
		const pinned = await renderNow({ rows: ROWS, summary: CUT, at: atOf(Y_MID, 12_000) });
		expect(spendScope(pinned)).toBe("llm calls · up to this point");
		expect(fact(pinned, "Spend")).toContain(`title="${formatUsd(12_000)}"`);
	});

	it("a vault held whole keeps the shorter labels under a filter", async () => {
		expect(spendScope(await renderNow({ rows: ROWS, filters: y }))).toBe("llm calls · filtered");
		expect(spendScope(await renderNow({ rows: ROWS, filters: y, at: atOf(Y_MID, 12_000) }))).toBe(
			"llm calls · filtered, up to this point",
		);
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
				"<b>Rate now",
				"ut-nw-proj",
				"ut-nw-last",
			])
				expect(inside).toContain(part);
			expect(inside).toBe(body(small));
		}
	});
});

describe("the Now window under a filter before its records have loaded", () => {
	const y = only("actors", "y");

	it("keeps the vault's Spend under its own label until the list is loaded, and when its read failed", async () => {
		const spent = (html: string): string =>
			/<b>Spend<\/b><span class="v" title="([^"]*)"/.exec(html)?.[1] ?? "";
		for (const phase of ["loading", "failed"] as const) {
			for (const over of [{}, { at: atOf(Y_MID, 12_000) }]) {
				const html = await renderNow({ rows: ROWS, filters: y, phase, ...over });
				expect(spendScope(html)).toBe(
					"at" in over ? "llm calls · up to this point" : "llm calls · whole vault",
				);
				expect(text(fact(html, "Spend"))).not.toContain("filtered");
				expect(spent(html)).not.toBe(formatUsd(0));
			}
			expect(spent(await renderNow({ rows: ROWS, filters: y, phase }))).toBe(
				formatUsd(SUMMARY.spentUt),
			);
		}
		// Loaded, the same filter sums the Ledger's own list.
		const loaded = await renderNow({ rows: ROWS, filters: y });
		expect(spendScope(loaded)).toBe("llm calls · filtered");
		expect(spent(loaded)).toBe(formatUsd(10_000));
	});
});

describe("the Now window on a cut vault", () => {
	const cut = { ...dayOneSummary(), truncated: true };

	it("states no projection from rows that do not reach back over the week", async () => {
		// ROWS start 10 hours into the week: the pace of the week would be read from a part of it.
		for (const over of [{}, { filters: only("actors", "y") }]) {
			const html = await renderNow({ rows: ROWS, summary: cut, ...over });
			expect(projLine(html)).toBe(HELD_PROJ);
			expect(text(html)).not.toContain("Projection");
			expect(text(html)).toContain("Rate now");
			expect(lastLine(html)).not.toBe(HELD_LAST);
		}
		expect(text(projLine(await renderNow({ rows: ROWS })))).toContain("Projection");
	});

	it("states no usual range from rows that stop short of the hours it reads, and states it from rows that reach them", async () => {
		const wordsOf = (html: string): string =>
			/<span class="ut-nw-words"[^>]*>(.*?)<\/span>/.exec(html)?.[1] ?? "";
		// Twelve hours held, the last far above the rest: on a vault that is not cut this is "unusual"; on a cut one
		// the oldest row is where the cut falls, so there is no range to say it against.
		const short = [
			...Array.from({ length: 11 }, (_, i) => spend("x", 156 + i, 1_000)),
			spend("x", 167, 90_000),
		];
		const uncut = await renderNow({ rows: short });
		expect(text(wordsOf(uncut))).toBe(NOW_COPY.rateUnusual);
		const cutShort = await renderNow({ rows: short, summary: cut });
		expect(text(wordsOf(cutShort))).toBe(NOW_COPY.rateUnknown);
		// The line begins at the first whole hour listed, and says so; the uncut vault's line does not.
		expect(cutShort).toContain(`${NOW_COPY.rateFromFirstWhole}`);
		expect(uncut).not.toContain(NOW_COPY.rateFromFirstWhole);
		expect(cutShort).toContain('data-fig="now.rate"');
		// The cut falls inside the last hour: its spend is partial, so there is no figure.
		const lateRow = spend("x", 167, 5_000, { ts: iso(END - 30 * 60_000) });
		const inLast = await renderNow({ rows: [lateRow], summary: cut });
		expect(inLast).not.toContain('data-fig="now.rate"');
		expect(text(wordsOf(inLast))).toBe(NOW_COPY.rateUnknown);
		expect(inLast).not.toContain("<circle");
		// The same rows on a vault that is not cut are its own last hour's.
		expect(await renderNow({ rows: [lateRow] })).toContain('data-fig="now.rate"');
		// Held back over the 25 hours the range reads: the range is as on any vault.
		const reaching = [...STEADY, spend("x", 167, 90_000)];
		for (const over of [{}, { summary: cut }]) {
			expect(text(wordsOf(await renderNow({ rows: reaching, ...over })))).toBe(
				NOW_COPY.rateUnusual,
			);
		}
		// The reach is of every row held, not of a filter's: a lane whose own rows start late is read against the range
		// when another lane's row reaches back over the hours it reads, and not when none does.
		const late = [
			...Array.from({ length: 7 }, (_, i) => spend("y", 160 + i, 1_000)),
			spend("y", 167, 90_000),
		];
		const onlyY = only("actors", "y");
		const early = await renderNow({
			rows: [spend("x", -1, 1), ...late],
			summary: cut,
			filters: onlyY,
		});
		expect(text(wordsOf(early))).toBe(NOW_COPY.rateUnusual);
		const noEarly = await renderNow({ rows: late, summary: cut, filters: onlyY });
		expect(text(wordsOf(noEarly))).toBe(NOW_COPY.rateUnknown);
	});

	it("states it from rows that reach back over the week", async () => {
		const reaching = [spend("x", -1, 1_000), ...ROWS];
		const html = await renderNow({ rows: reaching, summary: cut });
		expect(text(projLine(html))).toContain("Projection");
		expect(text(projLine(html))).toContain(NOW_COPY.projectionPaceWeek);
	});
});

describe("the Now window's body keeps one component through a fill", () => {
	const SRC = readFileSync(
		join(import.meta.dirname, "..", "src", "app", "windows", "now", "now-window.tsx"),
		"utf-8",
	);

	it("draws one component at one place for both forms, so a fill or a restore remounts nothing", () => {
		// The tests run without a DOM, so state held across a fill is pinned in the source: no branch on the form
		// chooses between two component types under the body.
		expect(SRC).not.toMatch(/filled\s*\?\s*<\w+/);
		expect(SRC).not.toContain("NowFilled");
		expect(SRC).toContain("{() => <NowBody />}");
		expect(SRC.match(/<NowSmall \/>/g)?.length).toBe(1);
	});

	it("tells the rate it is not busy once the records failed to load", async () => {
		const failed = await renderNow({ phase: "failed" });
		expect(fact(failed, "Rate now")).not.toContain("aria-busy");
		expect(fact(await renderNow({ phase: "loading" }), "Rate now")).toContain('aria-busy="true"');
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
	/** What the block opened by `prelude` holds: from its brace to the one that closes it. */
	function block(prelude: string): string {
		const from = SHEET.indexOf(prelude);
		if (from < 0) return "";
		const open = SHEET.indexOf("{", from);
		let depth = 0;
		for (let i = open; i < SHEET.length; i++) {
			if (SHEET[i] === "{") depth++;
			else if (SHEET[i] === "}" && --depth === 0) return SHEET.slice(open + 1, i);
		}
		return "";
	}
	/** The declarations of the rule for exactly `selector` inside `css`. */
	const ruleIn = (css: string, selector: string): string =>
		[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
			(m) => (m[1] ?? "").replace(/\s+/g, " ").trim() === selector,
		)?.[2] ?? "";
	const px = (decls: string, prop: string): number =>
		Number(new RegExp(`(?:^|[;\\s])${prop}:\\s*([0-9.]+)px;`).exec(decls)?.[1] ?? Number.NaN);
	/** The window width at or under which the rate's line goes under its words. */
	const BREAK = Number(/@container ut-nw \(max-width: (\d+)px\)/.exec(SHEET)?.[1] ?? Number.NaN);

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

	it("the rate's heading runs the fact's width, and the line sits beside the figure and its words", () => {
		// A heading longer than the words' column ("Rate now · filtered") never runs under the line.
		expect(rule('[data-win="now"] .ut-nw-rate > b')).toMatch(/grid-column:\s*1 \/ -1;/);
		const spark = rule('[data-win="now"] .ut-nw-rate > .ut-nw-spark');
		expect(spark).toMatch(/grid-row:\s*2 \/ span 2;/);
		expect(spark).toMatch(/align-self:\s*center;/);
		expect(px(rule('[data-win="now"] .ut-nw-rate'), "column-gap")).toBe(8);
	});

	it("in a narrow window the line goes under the words, in the box it has beside them", () => {
		// The window is the container asked: its own width, whatever the screen's.
		expect(rule(".ut-nw")).toMatch(/container:\s*ut-nw \/ inline-size;/);
		expect(SHEET.split("@container").length - 1).toBe(1);
		const narrow = block(`@container ut-nw (max-width: ${BREAK}px)`);
		expect(ruleIn(narrow, '[data-win="now"] .ut-nw-rate')).toMatch(
			/^\s*grid-template-columns:\s*minmax\(0, 1fr\);\s*$/,
		);
		const spark = ruleIn(narrow, '[data-win="now"] .ut-nw-rate > .ut-nw-spark');
		expect(spark).toMatch(/grid-column:\s*1;/);
		expect(spark).toMatch(/grid-row:\s*auto;/);
		expect(spark).toMatch(/justify-self:\s*start;/);
		// The box is sized once, outside the block: under the words it is the box it is beside them, drawn or kept
		// empty before the records load, so neither form moves when the line arrives.
		expect(spark).not.toMatch(/width|height/);
		expect(SHEET.split(".ut-nw-spark").length - 1).toBe(2);
		// The heading may take two lines here, and holds two of its 11px lines always: a filter moves nothing.
		const heading = ruleIn(narrow, '[data-win="now"] .ut-facts .ut-nw-rate > b');
		expect(px(heading, "min-height")).toBe(22);
		expect(heading).toMatch(/white-space:\s*normal;/);
		expect(heading).toMatch(/align-items:\s*flex-start;/);
		expect(allCss()).toMatch(/\.ut-fact > b\s*\{[^}]*font:\s*500 11px\/1 var\(--sans\);/);
		// It follows the rules it changes: at the same weight, the later one is read.
		const at = SHEET.indexOf("@container ut-nw");
		expect(at).toBeGreaterThan(SHEET.indexOf('[data-win="now"] .ut-nw-rate > .ut-nw-spark'));
		expect(at).toBeGreaterThan(SHEET.indexOf('[data-win="now"] .ut-facts .ut-fact > b'));
	});

	it("the line goes under where a figure stops fitting beside it: at 1000, 1024 and 1100px, not at 1440", () => {
		expect(BREAK).toBe(444);
		const older = allCss();
		const frame = Number(/\.ut-win\s*\{[^}]*border:\s*([0-9.]+)px/.exec(older)?.[1]);
		const [pad = Number.NaN, edge = Number.NaN] = (
			/\.ut-facts\s*\{[^}]*padding:\s*14px ([0-9.]+)px 15px;[^}]*border:\s*([0-9.]+)px/.exec(
				older,
			) ?? []
		)
			.slice(1)
			.map(Number);
		const between = Number(
			/gap:\s*12px ([0-9.]+)px;/.exec(rule('[data-win="now"] .ut-facts'))?.[1],
		);
		const line = px(rule('[data-win="now"] .ut-nw-rate > .ut-nw-spark'), "width");
		const gap = px(rule('[data-win="now"] .ut-nw-rate'), "column-gap");
		expect([DESK_GAP, HOME.now.span, frame, pad, edge, between, line, gap]).toEqual([
			16, 4, 1, 18, 1, 16, 96, 8,
		]);
		// The window's data at a screen width: the desk inside the page's gaps, four of its twelve columns and the
		// three gaps between them, less the frame's two edges.
		const data = (screen: number): number =>
			((screen - 2 * DESK_GAP - 11 * DESK_GAP) / 12) * HOME.now.span +
			(HOME.now.span - 1) * DESK_GAP -
			2 * frame;
		// One of the two facts' columns in it.
		const column = (width: number): number => (width - 2 * (pad + edge) - between) / 2;
		const beside = (width: number): number => column(width) - line - gap;
		// The figure keeps its 16px while its characters, "/h" included, fit at 0.62em each: the older sheet's rule for
		// a figure that shrinks to fit.
		const whole = (room: number, figure: string): boolean =>
			room / (figure.length + 2) / 0.62 >= 16;
		expect(older).toMatch(/font-size:\s*min\(1em, calc\(100cqi \/ var\(--n, 1\) \/ 0\.62\)\);/);
		expect(older).toMatch(/\.ut-fact \.v\s*\{\s*font:\s*400 16px\//);
		expect([1000, 1024, 1100].map(data).map((w) => Math.round(w * 100) / 100)).toEqual([
			310, 318, 343.33,
		]);
		for (const screen of [1000, 1024, 1100]) {
			expect(data(screen)).toBeLessThanOrEqual(BREAK);
			// Beside the line there are 24 to 41px: not room for "$0.00/h". Under the fact's own width, there is.
			expect(whole(beside(data(screen)), "$0.00")).toBe(false);
			expect(whole(column(data(screen)), "$12,345.67")).toBe(true);
		}
		expect([1000, 1024].map((s) => column(data(s)))).toEqual([128, 132]);
		// A window wider than the breakpoint keeps the line beside the figure, with room for $999.99/h whole.
		expect(data(1440)).toBeGreaterThan(BREAK);
		expect(beside(BREAK)).toBe(91);
		expect(whole(beside(BREAK), "$999.99")).toBe(true);
		expect(whole(beside(BREAK - 4), "$999.99")).toBe(false);
	});

	it("never cuts the Budget heading's source chip: it wraps under the word, and the provenance line wraps whole", () => {
		const heading = rule('[data-win="now"] .ut-facts .ut-fact.budget > b');
		expect(heading).toMatch(/(?:^|[;\s])flex-wrap:\s*wrap;/);
		expect(px(heading, "row-gap")).toBe(4);
		// The chip is the heading's own child, so it can wrap beneath the word; the older sheet keeps it from breaking
		// inside, and nothing here clips the heading.
		expect(heading).not.toMatch(/overflow|text-overflow|-webkit-line-clamp|(?:^|[;\s])height:/);
		expect(allCss()).toMatch(/\.ut-mark\s*\{[^}]*white-space:\s*nowrap;/);
		const why = rule('[data-win="now"] .ut-facts .ut-fact.budget:has(> b > .ut-mark) > .ut-why');
		expect(why).toMatch(/(?:^|[;\s])display:\s*block;/);
		expect(why).toMatch(/(?:^|[;\s])height:\s*auto;/);
		expect(why).toMatch(/(?:^|[;\s])overflow:\s*visible;/);
		expect(why).toMatch(/-webkit-line-clamp:\s*unset;/);
		expect(why).toMatch(/(?:^|[;\s])line-clamp:\s*unset;/);
		// Only the live Budget fact's note (the one with the chip): the other facts and the past fact keep their two
		// clamped lines.
		expect(rules.filter(([sel]) => /\.ut-why/.test(sel)).map(([sel]) => sel)).toEqual([
			'[data-win="now"] .ut-facts .ut-fact.budget:has(> b > .ut-mark) > .ut-why',
		]);
		// The chip is in the heading in the markup, after the word.
		const strip = readFileSync(
			join(import.meta.dirname, "..", "src", "app", "summary-strip.tsx"),
			"utf-8",
		);
		expect(strip).toMatch(/<b>\s*Budget\s*<span className="ut-mark" data-tone=\{word\.tone\}>/);
	});

	it("sets the facts' lines closer than the page-wide strip did, so the Budget fact is at most 170px tall", () => {
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

	it("red-first (421px of data, thirteen rows of the desk): at 1440px the window's data is 390.9px tall, at most 394", () => {
		const older = allCss();
		const num = (re: RegExp, css: string): number => Number(re.exec(css)?.[1] ?? Number.NaN);
		// Summed from the window's top edge down, each height read from the sheet that sets it. At 1440px the window is
		// wider than the break (the case above), so the rate has its line beside it.
		// 1. The as-at line: one line of its 12px text.
		expect(older).toMatch(/\.ut-asat\s*\{[^}]*height:\s*calc\(12px \* 1\.4\);/);
		const asAt = 12 * 1.4;
		// 2. The facts' edge and the room inside it: above the first row, and under the last.
		const facts = rule('[data-win="now"] .ut-facts');
		const edge = num(/\.ut-facts\s*\{[^}]*border:\s*([0-9.]+)px/, older);
		const [above = Number.NaN, under = Number.NaN] = (
			/(?:^|[;\s])padding-block:\s*([0-9.]+)px ([0-9.]+)px;/.exec(facts) ?? []
		)
			.slice(1)
			.map(Number);
		const between = num(/gap:\s*([0-9.]+)px 16px;/, facts);
		// 3. The three rows. A fact's lines: its label, its figure, and the lines under them, a gap apart.
		const gap = px(rule('[data-win="now"] .ut-facts .ut-fact'), "row-gap");
		const label = px(rule('[data-win="now"] .ut-facts .ut-fact > b'), "min-height");
		const figure = px(
			rule('[data-win="now"] .ut-facts .ut-fact .v, [data-win="now"] .ut-facts .ut-fact .v.na'),
			"height",
		);
		const oneLine = px(rule('[data-win="now"] .ut-facts .ut-fact.budget > .ut-sub'), "height");
		const meter = num(/\.ut-meter\s*\{\s*height:\s*([0-9.]+)px;/, older);
		const amounts = num(/\.ut-facts \.ut-amts\s*\{\s*height:\s*([0-9.]+)px;/, older);
		const twoLines = num(/\.ut-facts \.ut-sub\s*\{\s*height:\s*([0-9.]+)px;/, older);
		const why = num(/\.ut-facts \.ut-why\s*\{\s*height:\s*([0-9.]+)px;/, older);
		// Spend and Budget: the Budget fact's seven lines are the taller.
		const budget = label + figure + meter + amounts + oneLine + oneLine + why + 6 * gap;
		// The rate and its projection: the rate's label, figure and words, its own gap apart.
		const rateGap = px(rule('[data-win="now"] .ut-facts .ut-nw-rate'), "row-gap");
		const words = num(/font:\s*500 11\.5px\/([0-9.]+)px var\(--sans\);/, rule(".ut-nw-words"));
		const rate = label + figure + words + 2 * rateGap;
		// Integrity and Details: the label, the pill, the pill's two-line note and the two-line reason.
		const pill = rule('[data-win="now"] .ut-facts .ut-pill');
		expect(pill).toMatch(/padding-block:\s*0;/);
		const integrity = label + px(pill, "height") + twoLines + why + 3 * gap;
		// 4. The last record: one line of its 11.5px text and the room under it.
		const last = rule(".ut-nw-last");
		expect(last).toMatch(/font:\s*400 11\.5px\/1\.4 var\(--sans\);/);
		const [lastAbove = Number.NaN, lastUnder = Number.NaN] = (
			/(?:^|[;\s])padding:\s*([0-9.]+)(?:px)? 14px ([0-9.]+)px;/.exec(last) ?? []
		)
			.slice(1)
			.map(Number);
		const lastRecord = lastAbove + 11.5 * 1.4 + lastUnder;

		expect([edge + above, budget, between, rate, integrity, under + edge]).toEqual([
			8, 152, 12, 51, 110, 10,
		]);
		expect(lastRecord).toBeCloseTo(19.1, 6);
		const factsBox = edge + above + budget + between + rate + between + integrity + under + edge;
		expect(factsBox).toBe(355);
		const sum = asAt + factsBox + lastRecord;
		expect(sum).toBeCloseTo(390.9, 6);
		expect(sum).toBeLessThanOrEqual(394);

		// What that costs in rows: the window is its title bar and frame around the data.
		const bar = num(/\.ut-win-bar\s*\{[^}]*min-height:\s*([0-9.]+)px;/, older);
		const frame = num(/\.ut-win\s*\{[^}]*border:\s*([0-9.]+)px/, older);
		expect(bar + 2 * frame).toBe(46);
		// A window of n rows is n * 40 - 16px tall: eleven rows hold 378px of data under this bar, twelve hold 418.
		expect([11, 12].map((n) => n * ROW_STEP - GAP - (bar + 2 * frame))).toEqual([378, 418]);
		expect(rowsToFit(bar + 2 * frame + sum)).toBe(12);
		// The desk is first painted with these rows, so the fit moves nothing at this width.
		expect(USUAL_NOW_ROWS).toBe(rowsToFit(bar + 2 * frame + sum));
	});

	it("red-first (the desk's tighter edges carried into the column and the phone): under 1000px the facts keep the older sheet's room", () => {
		const older = allCss();
		expect(older).toMatch(/\.ut-facts\s*\{[^}]*padding:\s*14px 18px 15px;/);
		expect(ruleIn(block("@media (max-width: 999px)"), '[data-win="now"] .ut-facts')).toMatch(
			/(?:^|[;\s])padding-block:\s*14px 15px;/,
		);
		// From 999px down the facts lay out as the older sheet's 900px block does (so 901 to 999px does not differ from
		// 900px and under): three columns, the dense flow, the wider gap, and the Budget fact across two columns.
		const column = block("@media (max-width: 999px)");
		const cols = ruleIn(column, '[data-win="now"] .ut-facts');
		expect(cols).toMatch(/grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/);
		expect(cols).toMatch(/grid-auto-flow:\s*row dense;/);
		expect(cols).toMatch(/(?:^|[;\s])gap:\s*16px 20px;/);
		expect(ruleIn(column, '[data-win="now"] .ut-facts .ut-fact.budget')).toMatch(
			/grid-column:\s*span 2;/,
		);
		expect(older).toMatch(
			/@media \(max-width: 900px\)\s*\{[^}]*\.ut-facts\s*\{[^}]*grid-auto-flow:\s*row dense;[^}]*gap:\s*16px 20px;/,
		);
		// A phone's facts have 12px all round in the older sheet.
		expect(older).toMatch(
			/@media \(max-width: 760px\)[\s\S]*?\n\t\t\.ut-facts\s*\{[^}]*padding:\s*12px;/,
		);
		expect(ruleIn(NARROW, '[data-win="now"] .ut-facts')).toMatch(
			/(?:^|[;\s])padding-block:\s*12px;/,
		);
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
		// A held line is its line's own rule and nothing else, so it is the height of what it holds: the last record's
		// room, the rate's words.
		expect(rule('.ut-nw-last[data-reserve="true"]').trim()).toBe("visibility: hidden;");
		expect(SHEET).not.toMatch(/\.ut-nw-words\[data-reserve/);
	});
});
