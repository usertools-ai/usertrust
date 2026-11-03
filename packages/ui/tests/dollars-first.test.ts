// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Dollars lead and usertokens (UT) come second, with the one-line key wherever UT is shown. These render the real
 * components to static markup, so what is asserted is what a reader sees, in the order a screen reader reads it.
 */

import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PersistedAuditEvent } from "usertrust";
import { describe, expect, it } from "vitest";
import type { SummaryPayload } from "../src/shared/api.js";
import { EMPTY_FILTERS, type FilterState } from "../src/shared/filters.js";
import { UT_KEY } from "../src/shared/format.js";
import { type LedgerRow, toLedgerRows } from "../src/shared/rows.js";

// The components are .tsx files, which the tests' tsconfig (no `jsx`) cannot resolve statically: load them by a
// computed path, typed here by what the tests use.
type Component<P> = (props: P) => React.JSX.Element;
async function load<P>(file: string, name: string): Promise<Component<P>> {
	const mod = (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as Record<
		string,
		Component<P>
	>;
	return mod[name] as Component<P>;
}

function summary(over: Partial<SummaryPayload> = {}): SummaryPayload {
	return {
		vaultPath: "/vault/.usertrust",
		budget: 120_000,
		budgetSource: "config",
		budgetWrittenAt: null,
		budgetProvenance: "from the vault config",
		spentUt: 76_045,
		remainingUt: 43_955,
		chain: { events: 12, valid: true, empty: false, breakIndex: null, errors: [] },
		anchorFile: "absent",
		remote: { kit: false },
		rowCount: 12,
		truncated: false,
		verifiedAt: null,
		...over,
	};
}

function evt(n: number, cost: number): PersistedAuditEvent {
	return {
		id: `id-${n}`,
		timestamp: "2026-07-27T10:00:00.000Z",
		previousHash: "0".repeat(64),
		hash: String(n).repeat(64).slice(0, 64),
		kind: "llm_call",
		actor: "local",
		data: { cost, model: "claude-sonnet-4-5", usageSource: "provider" },
		sequence: n,
	};
}

function rows(...costs: number[]): LedgerRow[] {
	return toLedgerRows(
		costs.map((c, i) => evt(i + 1, c)),
		{ valid: true, breakIndex: null },
	);
}

const at = (html: string, needle: string): number => {
	const i = html.indexOf(needle);
	expect(i, `${needle} in the markup`).toBeGreaterThanOrEqual(0);
	return i;
};

describe("the Spend fact", () => {
	it("red-first (UT headline, dollars small): dollars come first, UT second, the exact figure on hover", async () => {
		const SummaryStrip = await load<{ summary: SummaryPayload | null; live: string }>(
			"summary-strip",
			"SummaryStrip",
		);
		const html = renderToStaticMarkup(
			createElement(SummaryStrip, { summary: summary(), live: "live" }),
		);
		expect(html).toContain('title="$7.6045">$7.60</span>');
		expect(at(html, "$7.60")).toBeLessThan(at(html, "76,045 UT"));
	});

	it("carries an info button whose title and label give the key", async () => {
		const SummaryStrip = await load<{ summary: SummaryPayload | null; live: string }>(
			"summary-strip",
			"SummaryStrip",
		);
		const html = renderToStaticMarkup(
			createElement(SummaryStrip, { summary: summary(), live: "live" }),
		);
		expect(html).toContain(`title="${UT_KEY}"`);
		expect(html).toContain(`aria-label="what a UT is: ${UT_KEY}"`);
	});

	it("the budget's amounts lead in dollars, with the exact figures on hover and UT second", async () => {
		const SummaryStrip = await load<{ summary: SummaryPayload | null; live: string }>(
			"summary-strip",
			"SummaryStrip",
		);
		const html = renderToStaticMarkup(
			createElement(SummaryStrip, { summary: summary(), live: "live" }),
		);
		expect(html).toContain('title="$4.3955 of $12.0000">$4.40 of $12.00</span>');
		expect(at(html, "$4.40 of $12.00")).toBeLessThan(at(html, "43,955 UT of 120,000 UT"));
	});

	it("an overspent budget leads in dollars too", async () => {
		const SummaryStrip = await load<{ summary: SummaryPayload | null; live: string }>(
			"summary-strip",
			"SummaryStrip",
		);
		const html = renderToStaticMarkup(
			createElement(SummaryStrip, {
				summary: summary({ spentUt: 130_000, remainingUt: -10_000 }),
				live: "live",
			}),
		);
		expect(at(html, "overspent by $1.00 of $12.00")).toBeLessThan(
			at(html, "10,000 UT of 120,000 UT"),
		);
	});
});

describe("an audit row and the inspector", () => {
	it("a row's cost is dollars (4 dp) first, UT second", async () => {
		const Row = await load<{ row: LedgerRow }>("audit-table", "Row");
		const [row] = rows(3_800);
		const html = renderToStaticMarkup(createElement(Row, { row: row as LedgerRow }));
		expect(at(html, "$0.3800")).toBeLessThan(at(html, "3,800 UT"));
		expect(html).toMatch(/class="ut-amt">\$0\.3800</);
	});

	it("the inspector's Cost lists Dollars before Usertokens, then the key", async () => {
		const RowPanel = await load<{ row: LedgerRow; docked: boolean; onClose(): void }>(
			"row-panel",
			"RowPanel",
		);
		const [row] = rows(3_800);
		const html = renderToStaticMarkup(
			createElement(RowPanel, { row: row as LedgerRow, docked: true, onClose: () => {} }),
		);
		const dollars = at(html, "<span>Dollars</span>");
		const tokens = at(html, "<span>Usertokens</span>");
		expect(dollars).toBeLessThan(tokens);
		expect(tokens).toBeLessThan(at(html, UT_KEY));
	});
});

describe("the key", () => {
	it("is in the Audit view's list foot beside 'times in UTC'", async () => {
		const AuditTable = await load<Record<string, unknown>>("audit-table", "AuditTable");
		const html = renderToStaticMarkup(
			createElement(AuditTable, {
				rows: [],
				total: 0,
				phase: "loaded",
				chain: "empty",
				selected: null,
				onOpen: () => {},
				onClearFilters: () => {},
			}),
		);
		expect(html).toContain(`<span>${UT_KEY}</span><span>times in UTC</span>`);
	});

	it("is on the Trends view, whose tiles lead in dollars with the exact figure on hover", async () => {
		const Trends = await load<{ rows: LedgerRow[]; newestOf: number | undefined }>(
			"trends",
			"Trends",
		);
		const html = renderToStaticMarkup(
			createElement(Trends, { rows: rows(3_800, 72_245), newestOf: undefined }),
		);
		expect(html).toContain(UT_KEY);
		expect(html).toContain('title="$7.6045">$7.60</span>');
		expect(at(html, "$7.60")).toBeLessThan(at(html, "76,045 UT · every costed record"));
		// the average is a per-record figure: 4 dp, with its UT second
		expect(at(html, "$3.8023")).toBeLessThan(at(html, "38022.5 UT"));
	});

	it("is on the Trends view even with nothing in view", async () => {
		const Trends = await load<{ rows: LedgerRow[]; newestOf: number | undefined }>(
			"trends",
			"Trends",
		);
		const html = renderToStaticMarkup(createElement(Trends, { rows: [], newestOf: undefined }));
		expect(html).toContain(UT_KEY);
	});

	it("a bar list's rows lead in dollars, UT second", async () => {
		const BarList = await load<{
			title: string;
			totals: Array<{ key: string; costUt: number; count: number }>;
		}>("bar-list", "BarList");
		const html = renderToStaticMarkup(
			createElement(BarList, {
				title: "Cost by model",
				totals: [{ key: "m", costUt: 76_045, count: 4 }],
			}),
		);
		expect(html).toContain('title="$7.6045">$7.60</span>');
		expect(at(html, "$7.60")).toBeLessThan(at(html, "76,045 UT"));
	});

	it("red-first (a one-line value pushed the name to 0 width at 320px): the UT figure is its own second line", async () => {
		const BarList = await load<{
			title: string;
			totals: Array<{ key: string; costUt: number; count: number }>;
		}>("bar-list", "BarList");
		const html = renderToStaticMarkup(
			createElement(BarList, {
				title: "Cost by model",
				totals: [{ key: "m", costUt: 12_045_500, count: 123 }],
			}),
		);
		// first line: dollars and count; second line: the UT figure alone, with no separator of its own
		expect(html).toMatch(/\$1,204\.55<\/span> · (<!-- -->)?123(<!-- -->)?×/);
		expect(html).toContain('<span class="ut-bl-ut">12,045,500 UT</span>');
		expect(at(html, "123")).toBeLessThan(at(html, "12,045,500 UT"));
		const css = await readFile(new URL("../src/app/styles.css", import.meta.url), "utf8");
		expect(css).toMatch(/\.ut-blist \.v \.ut-bl-ut \{[^}]*display: block;/);
	});
});

describe("the cost filter", () => {
	const props = (f: FilterState) => ({ rows: [] as LedgerRow[], filters: f, onChange: () => {} });

	it("keeps entry in UT: the placeholders say min UT and max UT", async () => {
		const FilterBar = await load<ReturnType<typeof props>>("filter-bar", "FilterBar");
		const html = renderToStaticMarkup(createElement(FilterBar, props(EMPTY_FILTERS)));
		expect(html).toContain('placeholder="min UT"');
		expect(html).toContain('placeholder="max UT"');
	});

	it("red-first (chip had no dollars): a set bound shows the UT bound with a ≈ $ echo", async () => {
		const FilterBar = await load<ReturnType<typeof props>>("filter-bar", "FilterBar");
		const html = renderToStaticMarkup(
			createElement(FilterBar, props({ ...EMPTY_FILTERS, costMin: 5_000, costMax: 120_000 })),
		);
		expect(html).toContain("cost ≥ 5000 UT ≈ $0.50 · uncosted hidden");
		expect(html).toContain("cost ≤ 120000 UT ≈ $12.00 · uncosted hidden");
	});
});
