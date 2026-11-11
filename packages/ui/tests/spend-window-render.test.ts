// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Spend window, inside both desk contexts: the data its chart is drawn from (`useChartData`), what the window
 * claims (its headline, its range sum, its tint and its marks), its states, and its stylesheet's pinned values.
 *
 * The plot's box is given a size here (a static render measures none), so the marks that need a width are drawn.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DeskData, DeskView } from "../src/app/desk/desk-types.js";
import type { SummaryPayload } from "../src/shared/api.js";
import { breakdown, type SpendWindow as RangeWindow } from "../src/shared/breakdown.js";
import { PROVIDER_COLOR, rankColors } from "../src/shared/colors.js";
import { deskWindow } from "../src/shared/desk-filters.js";
import type { LoadPhase } from "../src/shared/display.js";
import { EMPTY_FILTERS, type FilterState } from "../src/shared/filters.js";
import { formatUsdTotal } from "../src/shared/format.js";
import { listView } from "../src/shared/list-view.js";
import type { LedgerRow } from "../src/shared/rows.js";
import type { RangeId } from "../src/shared/spend-series.js";
import { allCss } from "./helpers/css.js";
import { appExport, dayOneSummary } from "./helpers/day-one.js";
import { withDesk } from "./helpers/desk.js";
import { HOUR, spendRow } from "./helpers/spend-fixture.js";

interface ChartData {
	chartRows: LedgerRow[];
	allRows: LedgerRow[] | null;
	chartWindow: RangeWindow;
	filterNote: string | null;
}

// The plot's box, as the browser would measure it: a static render measures none, and the ring needs a width.
vi.mock("../src/app/desk/use-box-size.js", async (importOriginal) => {
	const real = await importOriginal<Record<string, unknown>>();
	return { ...real, useBoxSize: () => ({ w: 700, h: 220 }) };
});

let SpendWindow: React.ComponentType;
let useChartData: () => ChartData;
let filterNoteOf: (order: readonly string[]) => string;
let chartWindowOf: (range: RangeId, nowMs: number, firstMs: number | null) => RangeWindow;
let firstRecordMs: (rows: readonly LedgerRow[]) => number | null;
let minuteOf: (nowMs: number) => number;
let resolvedPin: (addressPos: number | null, resolvedPos: number | null) => number | null;

beforeAll(async () => {
	SpendWindow = await appExport("windows/spend/spend-window", "SpendWindow");
	useChartData = await appExport("windows/spend/chart-data", "useChartData");
	filterNoteOf = await appExport("windows/spend/chart-data", "filterNoteOf");
	chartWindowOf = await appExport("windows/spend/chart-data", "chartWindowOf");
	minuteOf = await appExport("windows/spend/chart-data", "minuteOf");
	firstRecordMs = await appExport("windows/spend/chart-data", "firstRecordMs");
	resolvedPin = await appExport("windows/spend/chart-data", "resolvedPin");
});

/** The desk's clock in these cases: 2026-11-08 12:00:20 UTC, twenty seconds into a minute. */
const NOW = Date.UTC(2026, 10, 8, 12, 0, 20);

/**
 * Thirteen rows over the three days before now, 6 h apart: twelve spend records costing 1,000 to 13,000 UT by
 * position and one info row at 6. Even positions are lane `alpha` on an xAI model, odd ones lane `beta` on an
 * Anthropic model.
 */
function thirteen(): LedgerRow[] {
	return Array.from({ length: 13 }, (_, pos) =>
		spendRow(pos, {
			ts: new Date(NOW - 72 * HOUR + pos * 6 * HOUR).toISOString(),
			costUt: (pos + 1) * 1000,
			actor: pos % 2 === 0 ? "alpha" : "beta",
			model: pos % 2 === 0 ? "grok-4" : "claude-sonnet-5",
			...(pos === 6 ? { kind: "policy_decision" } : {}),
		}),
	);
}

interface DataCase {
	rows?: LedgerRow[];
	/** The rows the list was drawn from: a past view draws fewer than the page holds. */
	listRows?: LedgerRow[];
	/** The filters the list was drawn with. */
	filters?: FilterState;
	/** The filters just set, which the list has not drawn yet. */
	viewFilters?: FilterState;
	order?: readonly string[];
	nowMs?: number;
	range?: RangeId;
	window?: RangeWindow;
}

/** What `useChartData` returns inside the desk, read from one static render. */
async function chartData(o: DataCase = {}): Promise<ChartData> {
	const rows = o.rows ?? thirteen();
	const filters = o.filters ?? EMPTY_FILTERS;
	const got: { v: ChartData | null } = { v: null };
	function Probe(): null {
		got.v = useChartData();
		return null;
	}
	const data: Partial<DeskData> = {
		rows,
		head: rows.length - 1,
		nowMs: o.nowMs ?? NOW,
		list: listView({
			rows: o.listRows ?? rows,
			at: null,
			filters,
			phase: "loaded",
			summary: null,
		}),
		filterOrder: o.order ?? [],
		...(o.window === undefined ? {} : { window: o.window }),
	};
	const view: Partial<DeskView> = {
		filters: o.viewFilters ?? filters,
		range: o.range ?? "1w",
	};
	await withDesk(createElement(Probe), { data, view });
	if (got.v === null) throw new Error("the probe did not render");
	return got.v;
}

const xAI: FilterState = { ...EMPTY_FILTERS, providers: ["xAI"] };

describe("useChartData: the rows run to now", () => {
	it("draws every row the page holds, unfiltered, with no faint line and no note", async () => {
		const rows = thirteen();
		const d = await chartData({ rows });
		expect(d.chartRows).toBe(rows);
		expect(d.allRows).toBeNull();
		expect(d.filterNote).toBeNull();
	});

	it("reads the rows the page holds, not the list's cut at a past position", async () => {
		const rows = thirteen();
		const d = await chartData({ rows, listRows: rows.slice(0, 5) });
		expect(d.chartRows).toHaveLength(13);
	});

	it("filters with the filters the list was drawn with, not ones just typed", async () => {
		const drawn = await chartData({ viewFilters: xAI });
		expect(drawn.chartRows).toHaveLength(13);
		const applied = await chartData({ filters: xAI, order: ["providers:xAI"] });
		expect(applied.chartRows.map((r) => r.pos)).toEqual([0, 2, 4, 6, 8, 10, 12]);
	});

	it("ends its window at the end of the current minute whatever the desk's window is", async () => {
		const pinWindow = deskWindow("1w", { ts: new Date(NOW - 48 * HOUR).toISOString() }, NOW);
		const d = await chartData({ window: pinWindow });
		// The week opens before the first record (72 h back), so the window opens at that record's hour.
		expect(d.chartWindow.startMs).toBe(Math.floor((NOW - 72 * HOUR) / HOUR) * HOUR);
		expect(d.chartWindow.endMs).toBe(Date.UTC(2026, 10, 8, 12, 1));
		expect(d.chartWindow.endMs).not.toBe(pinWindow.endMs);
	});

	it("opens at the first record the page holds even when a filter drops it", async () => {
		const beta: FilterState = { ...EMPTY_FILTERS, actors: ["beta"] };
		const d = await chartData({ filters: beta, order: ["actors:beta"] });
		expect(d.chartRows.map((r) => r.pos)).toEqual([1, 3, 5, 7, 9, 11]);
		// Position 0 (alpha) is 72 h back; the window opens at its hour, not at position 1's (6 h later).
		expect(d.chartWindow.startMs).toBe(Math.floor((NOW - 72 * HOUR) / HOUR) * HOUR);
	});

	it("takes the chosen range", async () => {
		const d = await chartData({ range: "1d" });
		// The day ends at the end of the minute and opens on a 5 min boundary: a day and one minute here.
		expect(d.chartWindow.endMs).toBe(Date.UTC(2026, 10, 8, 12, 1));
		expect(d.chartWindow.endMs - d.chartWindow.startMs).toBe(24 * HOUR + 60_000);
	});
});

describe("useChartData: under a filter, all spend and the note", () => {
	it("hands over every row for the scale and the faint line, and names the filter", async () => {
		const rows = thirteen();
		const d = await chartData({ rows, filters: xAI, order: ["providers:xAI"] });
		expect(d.allRows).toBe(rows);
		expect(d.filterNote).toBe("Filtered: xAI · faint line: all spend");
	});

	it("says search for a text search alone", async () => {
		const d = await chartData({
			filters: { ...EMPTY_FILTERS, search: "grok" },
			order: ["search:grok"],
		});
		expect(d.chartRows.length).toBeLessThan(13);
		expect(d.filterNote).toBe("Filtered: search · faint line: all spend");
	});

	it("joins two values in the order they were added, the newest last", async () => {
		const d = await chartData({
			filters: { ...EMPTY_FILTERS, providers: ["xAI"], actors: ["alpha"] },
			order: ["actors:alpha", "providers:xAI"],
		});
		expect(d.filterNote).toBe("Filtered: alpha · xAI · faint line: all spend");
	});

	it("is unfiltered when the filters keep every row", async () => {
		const d = await chartData({
			filters: { ...EMPTY_FILTERS, actors: ["alpha", "beta"] },
			order: ["actors:alpha", "actors:beta"],
		});
		expect(d.allRows).toBeNull();
		expect(d.filterNote).toBeNull();
	});
});

describe("the chart data's pure parts", () => {
	it("names each token by its value after the first colon, and a search as search", () => {
		expect(filterNoteOf(["providers:xAI"])).toBe("Filtered: xAI · faint line: all spend");
		expect(filterNoteOf(["search:grok"])).toBe("Filtered: search · faint line: all spend");
		expect(filterNoteOf(["kinds:llm_call", "search:a:b", "models:m:1"])).toBe(
			"Filtered: llm_call · search · m:1 · faint line: all spend",
		);
		// The four bounds are named by their field, as the filter bar names them.
		expect(filterNoteOf(["from:2026-11-01"])).toBe(
			"Filtered: from 2026-11-01 UTC · faint line: all spend",
		);
		expect(filterNoteOf(["to:2026-11-05", "costMin:500", "costMax:900"])).toBe(
			"Filtered: to 2026-11-05 UTC · cost ≥ 500 UT · cost ≤ 900 UT · faint line: all spend",
		);
		expect(filterNoteOf([])).toBe("Filtered: search · faint line: all spend");
	});

	it("keeps one window for the whole of a minute, and moves it with the next", () => {
		const start = Date.UTC(2026, 10, 8, 12, 0);
		expect(minuteOf(start)).toBe(minuteOf(start + 59_999));
		expect(minuteOf(start + 60_000)).toBe(minuteOf(start) + 1);
		expect(chartWindowOf("1w", start, null)).toEqual(chartWindowOf("1w", start + 59_999, null));
		expect(chartWindowOf("1w", start + 60_000, null).endMs).toBe(
			chartWindowOf("1w", start, null).endMs + 60_000,
		);
	});

	it("opens no earlier than the first held record, and on its bucket", () => {
		const first = Date.UTC(2026, 10, 7, 9, 41);
		const w = chartWindowOf("1w", NOW, first);
		expect(w.startMs).toBe(Date.UTC(2026, 10, 7, 9));
		expect(chartWindowOf("1w", NOW, null).startMs).toBeLessThan(w.startMs);
		// A first record older than the range changes nothing.
		expect(chartWindowOf("1w", NOW, Date.UTC(2020, 0, 1))).toEqual(chartWindowOf("1w", NOW, null));
	});

	it("takes the first record as the earliest position among the rows whose time reads", () => {
		const t = (h: number): string => new Date(NOW - h * HOUR).toISOString();
		const rows = [
			spendRow(4, { ts: t(10) }),
			spendRow(2, { ts: t(20) }),
			spendRow(1, { ts: "not a date" }),
			spendRow(0, { ts: t(30), kind: "policy_decision" }),
		];
		expect(firstRecordMs(rows)).toBe(NOW - 20 * HOUR);
		expect(firstRecordMs([])).toBeNull();
		expect(firstRecordMs([spendRow(0, { ts: "x" })])).toBeNull();
	});

	it("takes the least time, so a row written out of order with an earlier time stays inside the window", async () => {
		const t = (h: number): string => new Date(NOW - h * HOUR).toISOString();
		// Position 1 is the later record by position but carries the earlier time.
		const rows = [spendRow(0, { ts: t(10) }), spendRow(1, { ts: t(20) })];
		expect(firstRecordMs(rows)).toBe(NOW - 20 * HOUR);
		const d = await chartData({ rows });
		expect(d.chartWindow.startMs).toBeLessThanOrEqual(NOW - 20 * HOUR);
	});

	it("resolves the pin: the follower's resolved record, else the address's own", () => {
		expect(resolvedPin(null, 12)).toBeNull();
		expect(resolvedPin(null, null)).toBeNull();
		// An address past the vault's end is answered with the head: the pin stands there...
		expect(resolvedPin(20, 12)).toBe(12);
		// ...and a reconnect that raises the head does not move it (the resolved record is kept, not re-derived).
		expect(resolvedPin(20, 12)).toBe(12);
		expect(resolvedPin(4, 4)).toBe(4);
		// Before the first answer, the address's own.
		expect(resolvedPin(4, null)).toBe(4);
		expect(resolvedPin(20, null)).toBe(20);
	});

	it("reads the same window through the hook at two moments of one minute", async () => {
		const a = await chartData({ nowMs: Date.UTC(2026, 10, 8, 12, 0, 10) });
		const b = await chartData({ nowMs: Date.UTC(2026, 10, 8, 12, 0, 50) });
		expect(a.chartWindow).toEqual(b.chartWindow);
	});
});

interface WinCase {
	rows?: LedgerRow[];
	/** The rows the list was drawn from: at a past position the list holds fewer than the page. */
	listRows?: LedgerRow[];
	filters?: FilterState;
	order?: readonly string[];
	summary?: SummaryPayload | null;
	/** The pinned position (the address's `#at`). */
	pin?: number | null;
	openHash?: string | null;
	phase?: LoadPhase;
	range?: RangeId;
	/** What the past view answered for the pin: its head is the vault's head when the position was chosen. */
	at?: { head: number; pos?: number; spentUt?: number } | null;
	/** The record the follower answered the pin with (kept across reconnects), or null before the first answer. */
	resolved?: number | null;
	/** How the rows were chosen against the answer; `answered` whenever an answer is given, unless said. */
	past?: DeskData["pastKind"];
}

/** The Spend window inside the desk, as static markup. */
function spend(o: WinCase = {}): Promise<string> {
	const rows = o.rows ?? thirteen();
	const filters = o.filters ?? EMPTY_FILTERS;
	const data: Partial<DeskData> = {
		rows,
		head: rows.length - 1,
		nowMs: NOW,
		list: listView({
			rows: o.listRows ?? rows,
			at: null,
			filters,
			phase: o.phase ?? "loaded",
			summary: null,
		}),
		summary: o.summary === undefined ? null : o.summary,
		...(o.at === undefined || o.at === null ? {} : { at: o.at as unknown as DeskData["at"] }),
		resolvedPos: o.resolved ?? null,
		pastKind: o.past ?? (o.at === undefined || o.at === null ? "live" : "answered"),
		pastHeld: o.past === "held",
		filterOrder: o.order ?? [],
		colorsFor: (dim) => rankColors(rows, dim),
	};
	const view: Partial<DeskView> = {
		filters,
		range: o.range ?? "1w",
		at: o.pin ?? null,
		openHash: o.openHash ?? null,
	};
	return withDesk(createElement(SpendWindow), { data, view });
}

/** The text of `html` from the first `from` to the first `to` after it ("" when either is missing). */
function between(html: string, from: string, to: string): string {
	const i = html.indexOf(from);
	if (i < 0) return "";
	const j = html.indexOf(to, i + from.length);
	return j < 0 ? "" : html.slice(i, j);
}

/** The headline's settled figure: the visually hidden span inside the `spend.headline` block. */
function headline(html: string): string | undefined {
	return /data-fig="spend\.headline"><span[^>]*>[^<]*<\/span><span class="sr-only">([^<]*)<\/span>/.exec(
		html,
	)?.[1];
}

/** The headline's label. */
function label(html: string): string | undefined {
	return /<span class="ut-sp-lbl">([^<]*)<\/span>/.exec(html)?.[1];
}

/** The range's spend, as the sub-line writes it. */
function rangeSum(html: string): string | undefined {
	return /<span class="ut-sp-sub">\+([^ <]+) in this range/.exec(html)?.[1];
}

/** The plot's opening tag. */
function plotTag(html: string): string {
	return /<div[^>]*class="ut-sp-plot"[^>]*>/.exec(html)?.[0] ?? "";
}

const WEEK = deskWindow("1w", null, NOW);
const COST = (r: LedgerRow): number => (r.kind === "llm_call" ? (r.costUt ?? 0) : 0);
const cumTo = (rows: readonly LedgerRow[], pos: number): number =>
	rows.filter((r) => r.pos <= pos).reduce((a, r) => a + COST(r), 0);
const alpha: FilterState = { ...EMPTY_FILTERS, actors: ["alpha"] };

describe("Spend: the window", () => {
	it("is the section named Spend, its subtitle per bucket", async () => {
		const html = await spend();
		expect(html).toMatch(/<section class="ut-win" aria-label="Spend" data-win="spend"/);
		expect(html).toContain('<span class="ut-win-sub">per bucket</span>');
	});

	it("holds the six range chips in the headline row, after the headline, and none in the title bar", async () => {
		const html = await spend();
		const bar = between(html, 'class="ut-win-bar"', 'class="ut-win-body"');
		expect(bar.length).toBeGreaterThan(0);
		expect(bar).not.toContain('aria-label="Range"');
		const head = between(html, 'class="ut-sp-head"', 'class="ut-sp-plot"');
		expect(head).toContain('aria-label="Range"');
		expect(head.indexOf('class="ut-sp-hl"')).toBeGreaterThanOrEqual(0);
		expect(head.indexOf('class="ut-sp-hl"')).toBeLessThan(head.indexOf('aria-label="Range"'));
		const chips = between(html, 'aria-label="Range"', "</div>");
		expect(chips.match(/<button\b/g)).toHaveLength(6);
		expect(chips).toContain('aria-pressed="true" title="Last 7 days">1W<');
	});

	it("draws its own chart, not the old trends card", async () => {
		const html = await spend();
		expect(html).toContain('class="ut-sp-plot"');
		expect(html).not.toContain("ut-trends");
		expect(html).not.toContain("Cost over time");
	});
});

describe("Spend: an honest headline", () => {
	const summary = dayOneSummary({ spentUt: 1_234_500, truncated: true });

	it("reads the header's Spend, the vault's total, not the sum of the rows the page holds", async () => {
		const html = await spend({ summary });
		expect(headline(html)).toBe(formatUsdTotal(1_234_500));
		expect(cumTo(thirteen(), 12)).toBeLessThan(1_234_500);
		expect(label(html)).toBe("Spend");
	});

	it("says what the range spent, from the same rows and window as the breakdown", async () => {
		const html = await spend({ summary });
		expect(rangeSum(html)).toBe(formatUsdTotal(breakdown(thirteen(), WEEK, "lane").totalUt));
	});

	it("is this view's spend under a lane filter and under a provider filter alone", async () => {
		for (const filters of [alpha, { ...EMPTY_FILTERS, providers: ["xAI"] }]) {
			const html = await spend({ summary, filters });
			expect(label(html)).toBe("Spend in this view");
			expect(headline(html)).not.toBe(formatUsdTotal(1_234_500));
			const even = thirteen().filter((r) => r.pos % 2 === 0);
			expect(headline(html)).toBe(formatUsdTotal(cumTo(even, 12)));
		}
	});
});

describe("Spend: the tint", () => {
	const ink = async (filters: FilterState): Promise<string> =>
		/--sp-ink:([^;"]+)/.exec(plotTag(await spend({ filters })))?.[1] ?? "none";

	it("takes one lane's colour", async () => {
		const lane = rankColors(thirteen(), "lane").of("alpha");
		expect(await ink(alpha)).toBe(lane);
	});
	it("takes one provider's colour", async () => {
		expect(await ink({ ...EMPTY_FILTERS, providers: ["xAI"] })).toBe(PROVIDER_COLOR.xAI);
	});
	it("takes the provider's colour over the lane's", async () => {
		expect(await ink({ ...EMPTY_FILTERS, providers: ["xAI"], actors: ["alpha"] })).toBe(
			PROVIDER_COLOR.xAI,
		);
	});
	it("takes none for two lanes", async () => {
		expect(await ink({ ...EMPTY_FILTERS, actors: ["alpha", "beta"] })).toBe("none");
	});
});

describe("Spend: the marks", () => {
	it("rings the open record on the line, and rings nothing with no record open", async () => {
		expect(await spend({ openHash: "h4" })).toContain('class="ut-sp-mark"');
		expect(await spend()).not.toContain("ut-sp-mark");
	});

	it("rings a record written out of order where the line puts it: at the running latest time", async () => {
		// Position 7 carries a time before position 5's; the line and the cursor read it at position 5's time.
		const rows = thirteen().map((r) =>
			r.pos === 7 ? { ...r, ts: new Date(NOW - 72 * HOUR + 2 * HOUR).toISOString() } : r,
		);
		const cx = (html: string): number =>
			Number(/<circle class="ut-sp-mark" cx="([^"]+)"/.exec(html)?.[1]);
		const out = cx(await spend({ rows, openHash: "h7" }));
		expect(out).toBeGreaterThan(0);
		expect(out).toBeCloseTo(cx(await spend({ rows, openHash: "h5" })), 3);
	});

	it("rings a record that is not a spend record at its own time, not at the nearest spend record's", async () => {
		const cx = (html: string): number =>
			Number(/<circle class="ut-sp-mark" cx="([^"]+)"/.exec(html)?.[1]);
		// Position 6 is the policy decision, between spend positions 5 and 7.
		const before = cx(await spend({ openHash: "h5" }));
		const policy = cx(await spend({ openHash: "h6" }));
		const after = cx(await spend({ openHash: "h7" }));
		expect(policy).toBeGreaterThan(before);
		expect(policy).toBeLessThan(after);
	});

	it("marks where the chain breaks, from the summary's break index", async () => {
		const broken = dayOneSummary({
			chain: { events: 13, valid: false, empty: false, breakIndex: 5, errors: [] },
		});
		expect(await spend({ summary: broken })).toContain("chain breaks here");
		expect(await spend({ summary: dayOneSummary() })).not.toContain("chain breaks here");
	});

	it("under a filter draws all spend faint, and says so in the exact words", async () => {
		const html = await spend({
			filters: { ...EMPTY_FILTERS, providers: ["xAI"] },
			order: ["providers:xAI"],
		});
		expect(html).toContain('class="ut-sp-ghost"');
		expect(html).toContain(">Filtered: xAI · faint line: all spend</text>");
		expect(await spend()).not.toContain("ut-sp-ghost");
	});
});

describe("Spend: the range", () => {
	it("draws the line in the chosen range's bucket", async () => {
		const day = await spend({ range: "1d" });
		expect(/<span class="ut-sp-sub">[^<]*peak \$\S+\/5 min</.test(day)).toBe(true);
		const week = await spend({ range: "1w" });
		expect(/<span class="ut-sp-sub">[^<]*peak \$\S+\/h</.test(week)).toBe(true);
	});
});

describe("Spend: what the words say about the records held", () => {
	it("says since the oldest record held under a filter on a cut vault, and not without a filter", async () => {
		const cutVault = dayOneSummary({ spentUt: 1_234_500, truncated: true });
		const filtered = await spend({ summary: cutVault, filters: alpha });
		expect(filtered).toContain("since the oldest record held");
		expect(await spend({ summary: cutVault })).not.toContain("since the oldest record held");
		const whole = dayOneSummary({ spentUt: 1_234_500, truncated: false });
		expect(await spend({ summary: whole, filters: alpha })).not.toContain(
			"since the oldest record held",
		);
	});

	it("counts the records added since the pin after Now, and says nothing live", async () => {
		const rows = thirteen();
		const html = await spend({ rows, pin: 4, at: { head: 9 } });
		expect(html).toContain('<span class="ut-sp-new"> +3 new</span>');
		expect(await spend({ rows })).not.toContain("ut-sp-new");
	});

	it("gives the slider the vault's last position: its range and the 'of N' in its words", async () => {
		const html = await spend({ pin: 4 });
		expect(plotTag(html)).toContain('aria-valuemax="13"');
		expect(plotTag(html)).toContain("Record 5 of 13");
	});
});

describe("Spend: a pin that the address names past, or before, what the page holds", () => {
	it("draws a pin past the vault's end at the head the server answered, not at later records", async () => {
		const rows = thirteen();
		// The vault had ten records (head 9) when the link was followed; three have arrived since.
		const html = await spend({
			rows,
			pin: 20,
			filters: alpha,
			at: { head: 9, pos: 9, spentUt: 55_000 },
			resolved: 9,
		});
		const lane = rows.filter((r) => r.actor === "alpha");
		expect(headline(html)).toBe(formatUsdTotal(cumTo(lane, 9)));
		expect(cumTo(lane, 9)).not.toBe(cumTo(lane, 12));
	});

	it("keeps a clamped pin on its record after a reconnect raises the head, in the header's step", async () => {
		const rows = thirteen();
		const lane = rows.filter((r) => r.actor === "alpha");
		// Address 20 was answered with record 4; the re-read after a reconnect holds {pos 4, head 30}.
		const html = await spend({
			rows,
			pin: 20,
			filters: alpha,
			at: { head: 30, pos: 4, spentUt: 10_000 },
			resolved: 4,
		});
		expect(headline(html)).toBe(formatUsdTotal(cumTo(lane, 4)));
		expect(cumTo(lane, 4)).not.toBe(cumTo(lane, 12));
		// Before any answer the address's own position is drawn.
		const first = await spend({ rows, pin: 4, filters: alpha });
		expect(headline(first)).toBe(formatUsdTotal(cumTo(lane, 4)));
	});

	it("draws nothing while the rows are not the answer's vault (held, or the answer's snapshot drawn elsewhere), and the answer's total only for its own", async () => {
		const rows = thirteen();
		const at = { head: 12, pos: 4, spentUt: 10_000 };
		for (const past of ["held", "snapshot"] as const) {
			const html = await spend({ rows, pin: 4, at, past });
			expect(html, past).toContain('class="ut-sp-wait" aria-busy="true"');
			expect(html, past).not.toContain('role="slider"');
			expect(html, past).not.toContain("ut-sp-chips");
			expect(html, past).not.toContain("ut-sp-new");
			expect(html, past).not.toContain(formatUsdTotal(10_000));
			// The same with no record under the filters of a loaded vault: the wait, never the empty line or the chips.
			const empty = await spend({ rows: [], pin: 4, at, past, phase: "loaded" });
			expect(empty, past).toContain('class="ut-sp-wait" aria-busy="true"');
			expect(empty, past).not.toContain("no records");
			expect(empty, past).not.toContain("ut-sp-chips");
		}
		// The answer's own vault: its total.
		expect(headline(await spend({ rows, pin: 4, at, past: "answered" }))).toBe(
			formatUsdTotal(10_000),
		);
		expect(cumTo(rows, 4)).not.toBe(10_000);
		// And live, with nothing pinned, the chart is drawn.
		expect(await spend({ rows })).toContain('role="slider"');
	});

	it("reads an unfiltered pin's total from the snapshot, which counts what the rows held begin after", async () => {
		const rows = thirteen();
		const html = await spend({ rows, pin: 4, at: { head: 12, pos: 4, spentUt: 10_000 } });
		expect(headline(html)).toBe(formatUsdTotal(10_000));
		expect(cumTo(rows, 4)).toBe(15_000);
	});

	it("keeps the rows' total under a filter, and while the answer is for another position", async () => {
		const rows = thirteen();
		const lane = rows.filter((r) => r.actor === "alpha");
		const filtered = await spend({
			rows,
			pin: 4,
			filters: alpha,
			at: { head: 12, pos: 4, spentUt: 10_000 },
		});
		expect(headline(filtered)).toBe(formatUsdTotal(cumTo(lane, 4)));
		const other = await spend({ rows, pin: 4, at: { head: 12, pos: 3, spentUt: 10_000 } });
		expect(headline(other)).toBe(formatUsdTotal(15_000));
	});
});

describe("Spend: its states", () => {
	it("keeps the plot's room, not busy, and says nothing about records when the load failed", async () => {
		const html = await spend({ rows: [], phase: "failed" });
		expect(html).toContain('class="ut-sp-wait" aria-busy="false"');
		expect(html).not.toContain("no records");
	});

	it("marks the room busy while the vault loads", async () => {
		expect(await spend({ rows: [], phase: "loading" })).toContain(
			'class="ut-sp-wait" aria-busy="true"',
		);
	});

	it("passes the chosen range to the chart, which clears its cursor on a change", () => {
		const src = readFileSync(
			join(import.meta.dirname, "../src/app/windows/spend/spend-window.tsx"),
			"utf-8",
		);
		expect(src).toMatch(/<SpendChart[^>]*\srange=\{range\}/);
	});

	it("says no records in this view, and mounts no slider, when the filters leave none", async () => {
		const html = await spend({ filters: { ...EMPTY_FILTERS, actors: ["nobody"] } });
		expect(html).toContain("no records in this view");
		expect(html).not.toContain('role="slider"');
	});

	it("keeps the range chips with the empty line, so the range can still be changed (Share reads it)", async () => {
		const html = await spend({ filters: { ...EMPTY_FILTERS, actors: ["nobody"] } });
		expect(html).toContain("no records in this view");
		const chips = /<[^>]*class="ut-sp-chips[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
		expect(html.match(/class="ut-sp-chips/g)).toHaveLength(1);
		// The chart's frame, its headline row (the spacer, then the chips), then the empty line.
		expect(html).toMatch(
			/<div class="ut-sp-chart"><div class="ut-sp-head"><span class="ut-sp-grow"><\/span><div class="ut-sp-chips[^"]*"[\s\S]*?<\/div><\/div><p class="ut-sp-empty">no records in this view<\/p><\/div>/,
		);
		expect(chips.match(/<button/g)).toHaveLength(6);
		expect(chips).toContain('aria-pressed="true"');
		// Not while the vault loads, which says nothing about the records.
		expect(await spend({ rows: [], phase: "loading" })).not.toContain("ut-sp-chips");
	});

	it("claims nothing about the records while the vault loads", async () => {
		const html = await spend({ rows: [], phase: "loading" });
		expect(html).not.toContain("no records");
		expect(html).not.toContain('role="slider"');
		expect(html).toContain('class="ut-sp-wait"');
	});
});

describe("Spend: the chart runs to now (a pin is a marker inside it)", () => {
	const rows = thirteen();
	const cut = rows.slice(0, 5);

	it("at a pin on the 5th record draws all twelve records, and reads the 5th's cumulative", async () => {
		const html = await spend({ rows, listRows: cut, pin: 4 });
		expect(rangeSum(html)).toBe(formatUsdTotal(breakdown(rows, WEEK, "lane").totalUt));
		expect(rangeSum(html)).not.toBe(formatUsdTotal(breakdown(cut, WEEK, "lane").totalUt));
		expect(label(html)).toBe("Spend by then");
		expect(headline(html)).toBe(formatUsdTotal(15_000));
		expect(cumTo(rows, 4)).toBe(15_000);
	});

	it("under a lane filter at the pin draws only that lane's records", async () => {
		const html = await spend({ rows, listRows: cut, pin: 4, filters: alpha });
		const lane = rows.filter((r) => r.actor === "alpha");
		expect(rangeSum(html)).toBe(formatUsdTotal(breakdown(lane, WEEK, "lane").totalUt));
		expect(label(html)).toBe("Spend by then in this view");
		expect(headline(html)).toBe(formatUsdTotal(cumTo(lane, 4)));
	});
});

describe("Spend: the stylesheet", () => {
	const sheetPath = join(import.meta.dirname, "..", "src", "app", "windows", "spend", "spend.css");
	const own = readFileSync(sheetPath, "utf-8");
	const css = allCss();
	/** Every innermost rule of the sheet: its selector list and its body. */
	const rules = [...own.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{};]+)\{([^{}]*)\}/g)].map(
		(m) => ({ sel: (m[1] ?? "").trim(), body: m[2] ?? "" }),
	);
	const ruleOf = (sel: string): string => rules.find((r) => r.sel === sel)?.body ?? "";

	it("keeps room under the plot for the cursor's time stamp, which hangs 17px below it", () => {
		const pad = /padding:\s*\d+px\s+\d+px\s+(\d+)px/.exec(ruleOf(".ut-sp-chart"));
		expect(Number(pad?.[1])).toBeGreaterThanOrEqual(17);
		expect(ruleOf(".ut-sp-time")).toContain("top: 100%");
	});

	it("lets the chart take its content's height on a phone, so the stamp's room stays inside the window", () => {
		const phone = /@media \(max-width: 999px\)\s*\{([\s\S]*?\n\t\})/.exec(own);
		expect(phone).not.toBeNull();
		const rule = /\[data-win="spend"\] \.ut-sp-chart\s*\{([^}]*)\}/.exec(phone?.[1] ?? "");
		expect(rule?.[1]).toContain("flex: 0 0 auto");
	});

	it("is read with the page's stylesheets", () => {
		expect(css).toContain(own);
	});

	it("carries each value the spec pins", () => {
		const pinned: Array<[string, RegExp]> = [
			['[data-win="spend"]', /--sp-ink:\s*#F7FAFF/],
			['[data-win="spend"]', /--sp-glow:\s*#A9C8F2/],
			[".ut-sp-plot", /flex:\s*1 1 0/],
			[".ut-sp-plot", /min-height:\s*120px/],
			[".ut-sp-glow", /stroke-width:\s*3;/],
			[".ut-sp-glow", /opacity:\s*0?\.38/],
			[".ut-sp-knock", /stroke-width:\s*3\.6/],
			[".ut-sp-knock", /opacity:\s*0?\.75/],
			[".ut-sp-line", /stroke-width:\s*1\.6/],
			[".ut-sp-xh", /transition:\s*none/],
			[".ut-sp-pin line", /stroke:\s*color-mix\(in srgb, var\(--dk-gold\) 45%, transparent\)/],
			[".ut-sp-pin line", /stroke-width:\s*1\.25/],
			[".ut-sp-pin line", /stroke-dasharray:\s*1\.5 6/],
			[".ut-sp-pin line", /stroke-linecap:\s*round/],
			[".ut-sp-pin circle", /fill:\s*var\(--dk-gold\)/],
			[".ut-sp-now", /border-color:\s*var\(--dk-gold\)/],
			[".ut-sp-now", /color:\s*var\(--dk-gold\)/],
			[".ut-sp-mark", /stroke:\s*var\(--dk-gold\)/],
			[".ut-sp-mark", /stroke-width:\s*2/],
			[".ut-sp-mark", /pointer-events:\s*none/],
			[".ut-sp-break circle", /stroke:\s*var\(--stakes\)/],
			[".ut-sp-break text", /fill:\s*var\(--stakes\)/],
			[".ut-sp-broke", /color:\s*var\(--stakes\)/],
			[".ut-sp-line.ut-sp-gap", /stroke:\s*var\(--dk-pane\)/],
			[".ut-sp-line.ut-sp-gap", /stroke-width:\s*3\.5/],
			[".ut-sp-line.ut-sp-dashed", /stroke-dasharray:\s*4 4/],
			[".ut-sp-ghost", /stroke:\s*var\(--dk-legend\)/],
			[".ut-sp-ghost", /stroke-opacity:\s*0?\.32/],
			[".ut-sp-ghost", /stroke-width:\s*1\.2/],
			[".ut-sp-ghost", /stroke-dasharray:\s*2 3/],
			[".ut-sp-ghost", /pointer-events:\s*none/],
			[".ut-sp-fcap", /font:[^;]*10\.5px/],
			[".ut-sp-fcap", /fill:\s*var\(--dk-legend\)/],
			[".ut-sp-fcap", /stroke:\s*var\(--dk-pane\)/],
			[".ut-sp-fcap", /stroke-width:\s*3px/],
			[".ut-sp-fcap", /paint-order:\s*stroke/],
			[".ut-sp-peak", /font:[^;]*11px var\(--mono\)/],
			[".ut-sp-peak", /color:\s*var\(--dk-label\)/],
			[".ut-sp-peak", /pointer-events:\s*none/],
			[".ut-sp-plot:focus-visible", /outline:\s*2px solid var\(--dk-text\)/],
			[".ut-sp-plot:focus-visible", /outline-offset:\s*-2px/],
			[".ut-sp-frame", /animation:[^;]*0?\.22s cubic-bezier\(\.16, ?\.84, ?\.3, ?1\)/],
			[".ut-sp-chips button", /height:\s*32px/],
			[".ut-sp-fig", /font-family:\s*var\(--mono\)/],
			[".ut-sp-fig", /font-variant-numeric:\s*tabular-nums/],
		];
		for (const [sel, value] of pinned) expect(ruleOf(sel), sel).toMatch(value);
	});

	it("has a note rule for the layers' words", () => {
		expect(rules.some((r) => r.sel === ".ut-sp-note")).toBe(true);
	});

	it("turns the fade and the live dot's pulse off for reduced motion", () => {
		const block = between(own, "@media (prefers-reduced-motion: reduce)", "\n\t}\n");
		expect(block).toMatch(/\.ut-sp-frame\s*\{[^}]*animation:\s*none/);
		expect(block).toMatch(/\.ut-sp-live\s*\{[^}]*animation:\s*none/);
	});

	it("puts gold only on the live dot, the pin, the Now button and the open record's ring", () => {
		const GOLD = /--dk-gold|--dk-a0|--accent|#f0c462|#e8b54b/i;
		const gold = rules.filter((r) => GOLD.test(r.body));
		expect(gold.length).toBeGreaterThan(0);
		for (const r of gold) {
			for (const sel of r.sel.split(",")) {
				expect(sel, r.sel).toMatch(/\.ut-sp-(live|pin|now|mark)\b/);
			}
		}
	});

	it("keeps the one narrow-column block, with the chart's own rule added, and no other width query", () => {
		expect(own.match(/@media \(max-width/g)).toHaveLength(1);
		expect(own).toContain(
			[
				"\t@media (max-width: 999px) {",
				'\t\t[data-win="spend"] .ut-trends {',
				"\t\t\tflex: 0 0 auto;",
				"\t\t}",
				"",
				'\t\t[data-win="spend"] .ut-card[data-part="chart"] {',
				"\t\t\tflex: 0 0 auto;",
				"\t\t}",
				"",
				'\t\t[data-win="spend"] .ut-chart-box {',
				"\t\t\tflex: 0 0 auto;",
				"\t\t\theight: 240px;",
				"\t\t}",
				"",
				"\t\t/* The chart takes its content's height here too, so the room under the plot for the cursor's time stamp is",
				"\t\t   inside the window and not hanging over the gap below it. */",
				'\t\t[data-win="spend"] .ut-sp-chart {',
				"\t\t\tflex: 0 0 auto;",
				"\t\t}",
				"\t}",
			].join("\n"),
		);
	});
});

describe("Spend: a hover leaves the page header alone", () => {
	it("never asks the desk to preview a position: only a committed pin moves the header", () => {
		for (const f of ["spend-chart.tsx", "spend-window.tsx"]) {
			const src = readFileSync(join(import.meta.dirname, "../src/app/windows/spend", f), "utf-8");
			expect(src, f).not.toMatch(/preview/i);
		}
	});
});
