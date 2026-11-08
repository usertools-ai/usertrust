// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The desk draws the existing components in parts: the Trends chart card and its lists apart, the summary strip's bar
 * and its facts apart. With no part, or `all`, the markup is what the page always drew. The filter bar names a provider
 * chip, and prints an ambiguous status as "unresolved" while the value stays `ambiguous`.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PersistedAuditEvent } from "usertrust";
import { beforeAll, describe, expect, it } from "vitest";
import type { SummaryPayload } from "../src/shared/api.js";
import { EMPTY_FILTERS, type FilterState } from "../src/shared/filters.js";
import { type LedgerRow, toLedgerRows } from "../src/shared/rows.js";

type Component<P> = (props: P) => React.JSX.Element;
async function app<T>(file: string): Promise<T> {
	return (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as T;
}

type TrendsPart = "chart" | "lists" | "all";
type StripPart = "bar" | "facts" | "all";
let Trends: Component<{ rows: LedgerRow[]; newestOf: number | undefined; part?: TrendsPart }>;
let SummaryStrip: Component<{
	summary: SummaryPayload | null;
	live: "live";
	part?: StripPart;
}>;
let FilterBar: Component<{
	rows: LedgerRow[];
	filters: FilterState;
	onChange(f: FilterState): void;
}>;

beforeAll(async () => {
	Trends = (await app<{ Trends: typeof Trends }>("trends")).Trends;
	SummaryStrip = (await app<{ SummaryStrip: typeof SummaryStrip }>("summary-strip")).SummaryStrip;
	FilterBar = (await app<{ FilterBar: typeof FilterBar }>("filter-bar")).FilterBar;
});

function evt(n: number, kind: string, cost: number, data: object = {}): PersistedAuditEvent {
	return {
		id: `id-${n}`,
		timestamp: `2026-11-0${n}T10:00:00.000Z`,
		previousHash: "0".repeat(64),
		hash: String(n).repeat(64).slice(0, 64),
		kind,
		actor: "local",
		data: { cost, model: "claude-sonnet-5", ...data },
		sequence: n,
	};
}

function rows(): LedgerRow[] {
	return toLedgerRows(
		[
			evt(1, "llm_call", 1_500),
			evt(2, "llm_call", 28_000),
			evt(3, "settlement_ambiguous", 400, { transferId: "t3" }),
		],
		{ valid: true, breakIndex: null },
		undefined,
		0,
	);
}

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
		verifiedAt: "2026-10-13T09:15:00.000Z",
		...over,
	} as SummaryPayload;
}

const trends = (part?: TrendsPart): string =>
	renderToStaticMarkup(
		createElement(Trends, {
			rows: rows(),
			newestOf: undefined,
			...(part === undefined ? {} : { part }),
		}),
	);
const strip = (s: SummaryPayload | null, part?: StripPart): string =>
	renderToStaticMarkup(
		createElement(SummaryStrip, {
			summary: s,
			live: "live",
			...(part === undefined ? {} : { part }),
		}),
	);
const bar = (filters: FilterState): string =>
	renderToStaticMarkup(createElement(FilterBar, { rows: rows(), filters, onChange: () => {} }));

describe("Trends draws one part", () => {
	it("no part and part=all are the same markup", () => {
		expect(trends()).toBe(trends("all"));
	});

	it("all keeps the tiles, the footer lines and the key", () => {
		const html = trends("all");
		expect(html).toContain("Cost in view");
		expect(html).toContain("Cost over time");
		expect(html).toContain("Cost by kind");
		expect(html).toContain("records in view");
	});

	it("chart is the cost-over-time card and its table, nothing else", () => {
		const html = trends("chart");
		expect(html).toContain("Cost over time");
		expect(html).toContain("Show table");
		expect(html).not.toContain("Cost by kind");
		expect(html).not.toContain("Cost by model");
		expect(html).not.toContain("Cost in view");
		expect(html).not.toContain("records in view");
	});

	it("lists is the three bar lists, nothing else", () => {
		const html = trends("lists");
		expect(html).toContain("Cost by kind");
		expect(html).toContain("Cost by model");
		expect(html).toContain("Cost by job type");
		expect(html).not.toContain("Cost over time");
		expect(html).not.toContain("Cost in view");
		expect(html).not.toContain("Show table");
	});
});

describe("the status tile says unresolved", () => {
	it("an ambiguous charge's tile reads unresolved, never ambiguous", () => {
		const html = trends("all");
		expect(html).toContain(">unresolved<");
		expect(html).not.toMatch(/>\s*Ambiguous\s*</i);
	});
});

describe("SummaryStrip draws one part", () => {
	it("no part and part=all are the same markup", () => {
		expect(strip(summary())).toBe(strip(summary(), "all"));
		expect(strip(null)).toBe(strip(null, "all"));
	});

	it("bar has the page bar and not the facts grid", () => {
		const html = strip(summary(), "bar");
		expect(html).toContain('class="ut-top"');
		expect(html).not.toContain('class="ut-facts"');
		expect(html).not.toContain("vault summary");
	});

	it("facts has the grid and not the page bar", () => {
		const html = strip(summary(), "facts");
		expect(html).toContain('aria-label="vault summary"');
		expect(html).not.toContain('class="ut-top"');
	});

	it("with no summary, facts is the loading skeleton and bar is the bar", () => {
		expect(strip(null, "facts")).toContain("vault summary loading");
		expect(strip(null, "facts")).not.toContain('class="ut-top"');
		expect(strip(null, "bar")).toContain('class="ut-top"');
		expect(strip(null, "bar")).not.toContain("vault summary loading");
	});

	it("a broken chain's alarm is in bar only", () => {
		const broken = summary({
			chain: { events: 100, valid: false, empty: false, breakIndex: 40, errors: ["x"] },
		});
		expect(strip(broken, "bar")).toContain('role="alert"');
		expect(strip(broken, "facts")).not.toContain('role="alert"');
	});
});

describe("FilterBar chips", () => {
	it("a provider filter has a provider chip", () => {
		const html = bar({ ...EMPTY_FILTERS, providers: ["xAI"] });
		expect(html).toContain("provider: xAI");
	});

	it("a status filter on ambiguous reads unresolved and never ambiguous as text", () => {
		const html = bar({ ...EMPTY_FILTERS, statuses: ["ambiguous"] });
		expect(html).toContain("status: unresolved");
		const shown = html.replace(/<[^>]*>/g, "");
		expect(shown).not.toContain("ambiguous");
		expect(html).not.toMatch(/(?:title|aria-label)="[^"]*ambiguous/);
	});
});
