// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { SummaryPayload } from "../src/shared/api.js";
import { activeFilterCount, EMPTY_FILTERS, type FilterState } from "../src/shared/filters.js";
import { PHONE_MAX_WIDTH, PHONE_QUERY } from "../src/shared/layout.js";
import { allCss, deskCss, legacyCss } from "./helpers/css.js";

// The phone block and the wide rules are the original stylesheet's; the breakpoint check below reads every sheet.
const CSS = legacyCss();

// The components are .tsx, which the tests' typecheck (no jsx) cannot import statically: they are loaded by a computed
// path, as the other render tests do, and typed here by what these tests pass.
type Component<P> = (props: P) => React.JSX.Element;
async function load<P>(file: string, name: string): Promise<Component<P>> {
	const mod = (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as Record<
		string,
		Component<P>
	>;
	return mod[name] as Component<P>;
}
let SummaryStrip: Component<{ summary: SummaryPayload | null; live: string }>;
let FilterBar: Component<{
	rows: never[];
	filters: FilterState;
	onChange: () => void;
	held?: boolean;
	count?: string;
}>;
beforeAll(async () => {
	SummaryStrip = await load("summary-strip", "SummaryStrip");
	FilterBar = await load("filter-bar", "FilterBar");
});

/** The text between the braces of the block that opens at `open` (brace-matched). */
function blockAt(css: string, open: number): { body: string; end: number } {
	const start = css.indexOf("{", open);
	let depth = 0;
	for (let i = start; i < css.length; i++) {
		if (css[i] === "{") depth++;
		else if (css[i] === "}" && --depth === 0) return { body: css.slice(start + 1, i), end: i + 1 };
	}
	throw new Error("unbalanced braces in styles.css");
}

const PHONE_HEADER = `@media (max-width: ${PHONE_MAX_WIDTH}px)`;
const phoneAt = CSS.indexOf(PHONE_HEADER);
/** The phone layout's own block (the first at the phone width; the hit-area block at the end has its own). */
const phone = blockAt(CSS, phoneAt);
/** The stylesheet with every phone-width block cut out: what every wider window gets. */
const WIDE = (() => {
	let out = CSS;
	for (let at = out.indexOf(PHONE_HEADER); at >= 0; at = out.indexOf(PHONE_HEADER)) {
		out = out.slice(0, at) + out.slice(blockAt(out, at).end);
	}
	return out;
})();

/** The declarations of the FIRST rule whose selector is exactly `selector`, or null. */
function rule(css: string, selector: string): string | null {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const m = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
	return m === null ? null : (m[1] ?? "");
}

function summary(): SummaryPayload {
	return {
		vaultPath: "/vault",
		budget: 1_000,
		budgetSource: "config",
		budgetWrittenAt: null,
		budgetProvenance: "from the vault config",
		spentUt: 250,
		remainingUt: 750,
		chain: { events: 12, valid: true, empty: false, breakIndex: null, errors: [] },
		anchorFile: "absent",
		remote: { kit: false },
		rowCount: 12,
		truncated: false,
		verifiedAt: "2026-01-01T00:00:00.000Z",
	} as SummaryPayload;
}

describe("the phone breakpoint", () => {
	it("is one number: the components' query and the stylesheet's narrow block agree", () => {
		expect(phoneAt).toBeGreaterThan(0);
		expect(PHONE_QUERY).toBe(`(max-width: ${PHONE_MAX_WIDTH}px)`);
		// Every narrow block is written at the phone width (or the summary's wider 900px step, or the 999px under which
		// the desk is a column), so a phone block written with another number, which would drift from the components'
		// query, fails here. (The hit-area block at the end has its own phone-width section, at the same width.)
		const widths = [...allCss().matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) =>
			Number(m[1]),
		);
		expect(widths.filter((w) => w !== PHONE_MAX_WIDTH && w !== 900 && w !== 999)).toEqual([]);
		// The column's width is the desk's own number, and it is in the sheets: 900px alone would pass with it missing.
		expect(widths.filter((w) => w === 999).length).toBeGreaterThanOrEqual(1);
		expect(widths.filter((w) => w === PHONE_MAX_WIDTH).length).toBeGreaterThanOrEqual(1);
	});
});

describe("phones: the list flows in the page", () => {
	it("gives the work panel no fixed height", () => {
		const work = rule(phone.body, ".ut-work");
		expect(work).not.toBeNull();
		expect(work).toMatch(/height:\s*auto/);
		// No viewport-relative or pixel height on the panel, the body or the list anywhere in the phone block.
		for (const sel of [".ut-work", ".ut-body", ".ut-list", ".ut-pane"]) {
			expect(rule(phone.body, sel) ?? "").not.toMatch(/height:\s*[1-9]/);
		}
		expect(phone.body).not.toMatch(/78dvh/);
	});

	it("leaves the list, and the body around it, without a scroller of their own", () => {
		expect(rule(phone.body, ".ut-list")).toMatch(/overflow:\s*visible/);
		expect(rule(phone.body, ".ut-body")).toMatch(/overflow:\s*visible/);
		// The only `overflow: auto|scroll` left in the phone block is the open filter sheet, which is a modal layer.
		const scrollers = [
			...phone.body.matchAll(/([^{}]+)\{([^{}]*overflow:\s*(?:auto|scroll)[^{}]*)\}/g),
		];
		expect(scrollers.map((m) => (m[1] ?? "").trim())).toEqual(['.ut-bar[data-sheet="true"]']);
	});

	it("pins the sort bar to the top of the screen while the page scrolls", () => {
		const cap = rule(phone.body, ".ut-cap");
		expect(cap).toMatch(/position:\s*sticky/);
		expect(cap).toMatch(/top:\s*0/);
	});

	it("leaves wider windows as they were: the list is still its own scroller, the bar is not sticky", () => {
		expect(rule(WIDE, ".ut-list")).toMatch(/overflow:\s*auto/);
		expect(rule(WIDE, ".ut-body")).toMatch(/overflow:\s*hidden/);
		expect(rule(WIDE, ".ut-cap")).not.toMatch(/sticky/);
		expect(rule(WIDE, ".ut-work")).toMatch(/min-height:\s*440px/);
		expect(rule(WIDE, ".ut-work")).not.toMatch(/(?<![-\w])height:/);
	});
});

describe("phones: the facts collapse to three, with the rest under Details", () => {
	it("lays spend and integrity side by side, and the budget across the row under them", () => {
		// A third of a phone cut the budget's amounts ("overspent by $X of $Y"): the budget takes the row's width.
		expect(rule(phone.body, ".ut-facts")).toMatch(/repeat\(2,/);
		expect(rule(phone.body, ".ut-facts .budget")).toMatch(/grid-column: 1 \/ -1;/);
	});

	it("hides Chain and Anchor until the toggle opens them", () => {
		expect(rule(phone.body, ".ut-facts .ut-fact.detail")).toMatch(/display:\s*none/);
		expect(rule(phone.body, '.ut-facts[data-details="true"] .ut-fact.detail')).toMatch(
			/display:\s*flex/,
		);
	});

	it("shows Chain and Anchor, and no toggle, everywhere else", () => {
		// Nothing outside the phone block hides a detail fact; the toggle is hidden by default and shown only on phones.
		expect(WIDE).not.toMatch(/\.detail[^{]*\{[^}]*display:\s*none/);
		expect(rule(WIDE, ".ut-more")).toBeNull();
		expect(WIDE).toMatch(/\.ut-more,[^{]*\{\s*display:\s*none;/);
		expect(rule(phone.body, ".ut-facts .ut-more")).toMatch(/display:\s*flex/);
	});

	it("renders the toggle closed, with Chain and Anchor in the page (hidden by the stylesheet, not removed)", () => {
		const html = renderToStaticMarkup(
			createElement(SummaryStrip, { summary: summary(), live: "live" }),
		);
		expect(html).toMatch(/<button[^>]*class="ut-more"[^>]*aria-expanded="false"/);
		expect(html).toContain('aria-controls="ut-fact-chain ut-fact-anchor"');
		expect(html).toContain('data-details="false"');
		expect(html).toMatch(/<div class="ut-fact detail" id="ut-fact-chain"><b>Chain<\/b>/);
		expect(html).toMatch(/<div class="ut-fact detail" id="ut-fact-anchor"><b>Anchor file<\/b>/);
		// Spend, Budget and Integrity are never details.
		expect(html).not.toMatch(/ut-fact detail[^>]*><b>(Spend|Budget|Integrity)/);
		expect(html).toMatch(/<div class="ut-fact"[^>]*><b>Spend<\/b>/);
		expect(html).toMatch(/<div class="ut-fact"><b>Integrity<\/b>/);
	});

	it("marks Chain and Anchor as details in the loading skeleton too", () => {
		const html = renderToStaticMarkup(
			createElement(SummaryStrip, { summary: null, live: "connecting" }),
		);
		expect(html).toMatch(/<div class="ut-fact detail"><b>Chain<\/b>/);
		expect(html).toMatch(/<div class="ut-fact detail"><b>Anchor file<\/b>/);
		expect(html).toMatch(/<div class="ut-fact"><b>Spend<\/b>/);
	});
});

describe("phones: the filter bar is one Filters button that opens the sheet", () => {
	const render = (filters: FilterState): string =>
		renderToStaticMarkup(createElement(FilterBar, { rows: [], filters, onChange: () => {} }));
	const button = (html: string): string =>
		/<button[^>]*ut-filters-btn[^>]*>.*?<\/button>/.exec(html)?.[0] ?? "";

	it("counts the active filters on the button, and says plain Filters when there are none", () => {
		expect(button(render(EMPTY_FILTERS))).toContain("<span>Filters</span>");
		expect(button(render({ ...EMPTY_FILTERS, kinds: ["llm_call"] }))).toContain(
			"<span>Filters (1)</span>",
		);
		expect(button(render({ ...EMPTY_FILTERS, kinds: ["llm_call"], from: "2026-01-01" }))).toContain(
			"<span>Filters (2)</span>",
		);
	});

	it("is a button that controls the bar, closed by default", () => {
		const html = render(EMPTY_FILTERS);
		expect(button(html)).toContain('aria-expanded="false"');
		expect(button(html)).toContain('aria-haspopup="dialog"');
		expect(button(html)).toContain('aria-controls="ut-filter-sheet"');
		// The bar it controls is the same bar, closed: not a dialog, and no scrim.
		expect(html).toContain('id="ut-filter-sheet"');
		expect(html).toContain('data-sheet="false"');
		expect(html).not.toContain('role="dialog"');
		expect(html).not.toContain("ut-scrim");
	});

	it("keeps every filter in the bar the sheet shows", () => {
		const html = render(EMPTY_FILTERS);
		for (const label of [
			">kind<",
			">model<",
			">actor<",
			">status<",
			">job type (declared)<",
			">type declared by<",
			"From (UTC)",
			"To (UTC)",
			'aria-label="minimum cost in UT"',
			'aria-label="maximum cost in UT"',
		]) {
			expect(html).toContain(label);
		}
	});

	it("hides the bar on a phone until the sheet is open, and shows it as a fixed sheet then", () => {
		expect(rule(phone.body, ".ut-bar")).toMatch(/display:\s*none/);
		const open = rule(phone.body, '.ut-bar[data-sheet="true"]');
		expect(open).toMatch(/display:\s*flex/);
		expect(open).toMatch(/position:\s*fixed/);
		// The button and the sheet's header exist only on a phone.
		expect(WIDE).toMatch(/\.ut-filters-btn,[^{]*\.ut-sheet-head\s*\{\s*display:\s*none;/);
		expect(rule(phone.body, ".ut-filters-btn")).toMatch(/display:\s*flex/);
		// Wider windows keep the bar as the row it was.
		expect(rule(WIDE, ".ut-bar")).toMatch(/display:\s*flex/);
	});

	it("puts the tabs and the count on one row, and the search and Export on the next", () => {
		const head = rule(phone.body, ".ut-head") ?? "";
		expect(head).toMatch(/display:\s*flex/);
		expect(head).toMatch(/flex-wrap:\s*wrap/);
		// The spacer between the count and the search takes a whole line of no height: it ends row one.
		const spacer = rule(phone.body, ".ut-head .ut-grow") ?? "";
		expect(spacer).toMatch(/flex:\s*0 0 100%/);
		expect(spacer).toMatch(/height:\s*0/);
		expect(spacer).not.toMatch(/display:\s*none/);
		// The rows keep the 8px between them: 4px, the spacer's empty line, 4px.
		expect(head).toMatch(/gap:\s*4px 10px/);
	});

	it("never makes the page wider than a 320px screen, whatever Export's count: its rows do not share columns", () => {
		// Red-first (a 320px page 5-7px wide with "Export 100,000 rows"): the head was one grid whose first column was the
		// tabs' width (row one) and last column Export's (row two), so the two had to fit side by side though they never
		// share a row. Two flex rows: the count and the search give way (no minimum width), the tabs and Export do not.
		const head = rule(phone.body, ".ut-head") ?? "";
		expect(head).not.toMatch(/display:\s*grid/);
		expect(head).not.toMatch(/grid-template-columns/);
		for (const sel of [".ut-head .ut-label", ".ut-head .ut-search"]) {
			const r = rule(phone.body, sel) ?? "";
			expect(r, sel).toMatch(/flex:\s*1 1 0/);
			expect(r, sel).toMatch(/min-width:\s*0/);
		}
		expect(rule(phone.body, ".ut-head .ut-btn")).toMatch(/flex:\s*0 0 auto/);
		// No phone rule places a head child in a grid column any more.
		expect(phone.body).not.toMatch(/\.ut-head [^{]*\{[^}]*grid-column/);
	});

	it("red-first (active chips beside the filter controls ran a 320px page 114px wide): the chips take a row of their own", () => {
		// On the desk the filter bar's chip strip is a flex sibling of the Filters button and the record count. In a row
		// that never wrapped it kept its widest chip's width (a chip is up to 260px, plus the strip's padding), and a long
		// search beside two facet chips drew the page 434px wide on a 320px screen. Above the list, as before the desk,
		// the strip has its own row; a long chip still fits it, and its chips wrap inside it.
		const desk = deskCss();
		const row = rule(desk, ".ut-dk-filters") ?? "";
		expect(row).toMatch(/display:\s*flex/);
		expect(row).toMatch(/flex-wrap:\s*wrap/);
		const strip = rule(desk, ".ut-dk-filters > .ut-active") ?? "";
		expect(strip).toMatch(/flex:\s*1 1 100%/);
		expect(strip).toMatch(/min-width:\s*0/);
		// Never by a CSS order (the desk's sheets set none): the record count comes before the strip in the DOM.
		expect(strip).not.toMatch(/order:/);
		// The chips themselves wrap inside the strip.
		expect(rule(CSS, ".ut-active") ?? "").toMatch(/flex-wrap:\s*wrap/);
	});

	it("red-first (a count handed in as a node, new on every render): draws the desk's record count itself, after the bar and before the active chips, as a status that dims with the list", () => {
		// Left after the whole FilterBar, the count followed the chips: with the chips on a row of their own it took a
		// third row, below them. In the DOM between the two, it shares the bar's row and Tab and a screen reader meet
		// the bar, the count and the chips in the order they are drawn. Handed in as text, not as a node, so the bar's
		// memo compares it by value.
		const html = renderToStaticMarkup(
			createElement(FilterBar, {
				rows: [],
				filters: { ...EMPTY_FILTERS, search: "abc" },
				onChange: () => {},
				held: true,
				count: "12 records",
			}),
		);
		const bar = html.indexOf('class="ut-bar');
		const count = html.indexOf(
			'<span class="ut-label" role="status" data-held="true">12 records</span>',
		);
		const chips = html.indexOf('class="ut-active"');
		expect(bar).toBeGreaterThan(-1);
		expect(chips).toBeGreaterThan(-1);
		expect(count).toBeGreaterThan(bar);
		expect(count).toBeLessThan(chips);
		// No count, no status: the bar on its own draws none.
		const alone = renderToStaticMarkup(
			createElement(FilterBar, { rows: [], filters: EMPTY_FILTERS, onChange: () => {} }),
		);
		expect(alone).not.toContain('role="status"');
	});
});

describe("activeFilterCount", () => {
	it("is 0 for no filters, and does not count the search box (it stays on screen)", () => {
		expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
		expect(activeFilterCount({ ...EMPTY_FILTERS, search: "abc" })).toBe(0);
	});

	it("counts one per selected value and one per date or cost bound", () => {
		expect(
			activeFilterCount({
				...EMPTY_FILTERS,
				kinds: ["a", "b"],
				models: ["m"],
				providers: ["xAI"],
				actors: ["x"],
				statuses: ["settled"],
				jobTypes: ["j"],
				typeSources: ["t"],
				from: "2026-01-01",
				to: "2026-02-01",
				costMin: 0,
				costMax: 5,
			}),
		).toBe(12);
	});

	it("counts a zero cost bound: zero is a bound, not an absent one", () => {
		expect(activeFilterCount({ ...EMPTY_FILTERS, costMin: 0 })).toBe(1);
	});
});
