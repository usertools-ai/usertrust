// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The header at a past position, rendered as the browser gets them. The past view says what it is
 * ("As recorded at"), reads every figure from `/api/at` and never today's budget as the budget then, and never says
 * "verified".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AtPayload, SummaryPayload } from "../src/shared/api.js";
import { budgetSourceWord } from "../src/shared/budget-display.js";
import { formatUsdTotal } from "../src/shared/format.js";

// The components are .tsx files, which the tests' tsconfig (no `jsx`) cannot resolve statically: load them by a
// computed path, typed here by what the tests use.
type Component<P> = (props: P) => React.JSX.Element;
async function app<T>(file: string): Promise<T> {
	return (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as T;
}

let SummaryStrip: Component<{
	summary: SummaryPayload | null;
	live: "connecting" | "live" | "reconnecting" | "offline";
	at?: AtPayload | null;
	part?: "bar" | "head" | "facts" | "all";
}>;
let TrendsReloading: Component<{
	rows: never[];
	newestOf: number | undefined;
	reloading?: boolean;
	reloadingNote?: string;
}>;
let Trends: Component<{
	rows: never[];
	newestOf: number | undefined;
	at?: AtPayload | null;
	head?: number;
}>;
beforeAll(async () => {
	Trends = (await app<{ Trends: typeof Trends }>("trends")).Trends;
	TrendsReloading = (await app<{ Trends: typeof TrendsReloading }>("trends")).Trends;
	SummaryStrip = (await app<{ SummaryStrip: typeof SummaryStrip }>("summary-strip")).SummaryStrip;
});

/** The text a reader sees: tags removed, and the entities React escapes read back. */
const text = (html: string): string =>
	html
		.replace(/<[^>]*>/g, "")
		.replace(/&#x27;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
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
		verifiedAt: "2026-10-13T09:15:00.000Z",
		...over,
	};
}

const NOTE = "budget history starts with the first budget record; this is today's budget";

/** The budget a past position carries: today's, with where it came from and when the controller recorded it. */
function pastBudget(over: Partial<AtPayload["budget"]> = {}): AtPayload["budget"] {
	return {
		ut: 1_000_000,
		source: "governor",
		writtenAt: "2026-11-01T10:00:00.000Z",
		provenance: "the enforced budget, as of 2026-11-01T10:00:00.000Z",
		note: NOTE,
		...over,
	};
}

/** The fields of a budget no controller has published. */
const UNPUBLISHED = {
	ut: null,
	source: "unpublished",
	writtenAt: null,
	provenance: "unknown: not yet published; no controller has recorded the budget it enforces",
} as const;

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
		budget: pastBudget(),
		plan: null,
		windowStartPos: 0,
		statusAt: {},
		...over,
	};
}

const strip = (a: AtPayload | null, s: SummaryPayload = summary()): string =>
	renderToStaticMarkup(createElement(SummaryStrip, { summary: s, live: "live", at: a }));

describe("the header at a past position", () => {
	it("with at set, it shows the dollars of at.spentUt and says As recorded at", () => {
		const html = strip(at());
		expect(text(html)).toContain(formatUsdTotal(56_700));
		expect(text(html)).toContain("As recorded at");
		// Today's spend is not the spend then.
		expect(text(html)).not.toContain(formatUsdTotal(123_400));
	});

	it("with at null, it shows neither", () => {
		const html = strip(null);
		expect(text(html)).not.toContain("As recorded at");
		expect(text(html)).not.toContain(formatUsdTotal(56_700));
		expect(text(html)).toContain(formatUsdTotal(123_400));
	});

	it("the budget then is the server's note, never today's budget presented as then", () => {
		const html = text(strip(at()));
		expect(html).toContain(NOTE);
		// Today's live budget figures (87.7% left, $87.66 of $100.00) are not shown as the budget then.
		expect(html).not.toContain("% left");
		expect(html).not.toContain(formatUsdTotal(876_600));
	});

	it("the chain then reads from at.chain: a position that reads broken looks broken", () => {
		const html = strip(at({ chain: { valid: false, breakIndex: 30 } }));
		expect(html).toContain('data-tone="stakes"');
		expect(text(html)).toContain("broken");
		expect(text(html)).not.toContain("chained");
		// The live vault is intact; the position is not, and the header follows the position.
		const intact = strip(at());
		expect(intact).toContain('data-tone="approve"');
		expect(text(intact)).not.toContain("broken");
	});

	it("the past chained pill's hover text claims only the links up to that point", () => {
		const html = strip(at());
		const m = /<span class="ut-pill" data-tone="approve" title="([^"]*)"/.exec(html);
		expect(m).not.toBeNull();
		const title = m?.[1] ?? "";
		expect(title).toContain("up to this point");
		expect(title).not.toContain("in the vault");
		// Live, the same pill speaks for the whole vault.
		const live = /<span class="ut-pill" data-tone="approve" title="([^"]*)"/.exec(strip(null));
		expect(live?.[1]).toContain("in the vault");
	});

	it("counts the records up to the position", () => {
		expect(text(strip(at({ pos: 40 })))).toContain("41 events");
	});

	it("a clamped answer stops saying '(latest record)' in the header once more records have arrived", () => {
		const a = at({ pos: 99, head: 99, clamped: true });
		const live = (events: number): SummaryPayload =>
			summary({ chain: { events, valid: true, empty: false, breakIndex: null, errors: [] } });
		// Positive control: with no record after it, the answer is the latest and says so.
		expect(text(strip(a, live(100)))).toContain("(latest record)");
		// 120 records now: the answer at record 100 is no longer the latest.
		expect(text(strip(a, live(120)))).not.toContain("(latest record)");
		expect(text(strip(a, live(120)))).toContain("As recorded at");
	});

	it("Trends' footer drops '(latest record)' too once records follow a clamped answer", () => {
		const a = at({ pos: 99, head: 99, clamped: true });
		const trends = (head: number): string =>
			text(
				renderToStaticMarkup(createElement(Trends, { rows: [], newestOf: undefined, at: a, head })),
			);
		expect(trends(99)).toContain("(latest record)");
		expect(trends(119)).not.toContain("(latest record)");
		expect(trends(119)).toContain("As recorded at");
	});

	it("Trends names the ambiguous tile 'unresolved', in a past view too, and never 'Ambiguous'", () => {
		for (const a of [null, at()]) {
			const shown = text(
				renderToStaticMarkup(createElement(Trends, { rows: [], newestOf: undefined, at: a })),
			);
			expect(shown).toContain("unresolved");
			expect(shown).not.toMatch(/ambiguous/i);
		}
	});

	it("never says verified", () => {
		for (const a of [at(), at({ chain: { valid: false, breakIndex: 3 } }), at({ clamped: true })])
			expect(text(strip(a))).not.toMatch(/verif/i);
	});

	it("window note at T: a position before the first row held says so, once", () => {
		const html = text(
			strip(
				at({ pos: 10, windowStartPos: 50 }),
				summary({ truncated: true, rowCount: 50, chain: { ...summary().chain, events: 100 } }),
			),
		);
		// Positions count from 1, as the integrity texts do: position 50 (0-based) is the 51st record.
		expect(html).toContain("The list holds records from position 51");
		// One note, not two: the live truncation notice gives way to the position's own.
		expect(html).not.toContain("Showing the newest");
	});

	it("a position inside a truncated window says where the list starts, in figures true at T", () => {
		const html = text(
			strip(
				at({ pos: 60, windowStartPos: 50 }),
				summary({ truncated: true, rowCount: 50, chain: { ...summary().chain, events: 100 } }),
			),
		);
		expect(html).toContain(
			"The list holds records from position 51 (the newest 50 now); earlier ones count in the totals above.",
		);
		// The live "of 100 events" is not a figure at T.
		expect(html).not.toContain("Showing the newest");
	});

	it("the as-at line's slot is in the live markup too, hidden, so entering the past view moves nothing", () => {
		const live = strip(null);
		expect(live).toMatch(/<p class="ut-asat" data-live="true" aria-hidden="true">/);
		const past = strip(at());
		expect(past).toMatch(/<p class="ut-asat" data-live="false">/);
		// The same number of lines either way: the slot is never added or removed.
		expect(live.match(/class="ut-asat"/g)).toHaveLength(1);
		expect(past.match(/class="ut-asat"/g)).toHaveLength(1);
		// Hidden, not removed, and a fixed height either way: one line, and two on a phone (where it can wrap).
		const css = readFileSync(join(import.meta.dirname, "..", "src", "app", "styles.css"), "utf-8");
		expect(css).toMatch(/\.ut-asat\[data-live="true"\] \{\s*visibility: hidden;\s*\}/);
		expect(css).toMatch(/\.ut-asat \{[^}]*[^-]height: calc\(12px \* 1\.4\);/);
		expect(css).not.toMatch(/\.ut-asat \{[^}]*min-height/);
		const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
		expect(phone).toMatch(/\.ut-asat \{[^}]*[^-]height: calc\(2 \* 12px \* 1\.4\);/);
		// The loading header holds the slot too.
		expect(
			renderToStaticMarkup(createElement(SummaryStrip, { summary: null, live: "live", at: null })),
		).toContain('class="ut-asat" data-live="true"');
	});

	it("the past Budget keeps the live one's lines (meter row, amounts, usertokens, note), so it does not change height", () => {
		const past = strip(at());
		const live = strip(null);
		const lines = (html: string): number => {
			const budget =
				/<div class="ut-fact budget"[^>]*>([\s\S]*?)<\/div><(?:button|div class="ut-fact)/.exec(
					html,
				)?.[1] ?? "";
			return (budget.match(/class="(?:v|v na|ut-meter|ut-amts|ut-sub mono|ut-why)[" ]/g) ?? [])
				.length;
		};
		expect(lines(past)).toBe(lines(live));
	});

	it("every fact has the same lines live and past, in every state, so the facts row never changes height", () => {
		/** Each fact's line slots, in order: what the stylesheet gives a fixed height. */
		const slots = (html: string): string[] => {
			const facts = html.slice(html.indexOf('class="ut-facts"'));
			return facts
				.split('<div class="ut-fact')
				.slice(1)
				.map((f) =>
					(
						f.match(
							/class="(v|v na|ut-meter|ut-amts|ut-amts red|ut-sub|ut-sub mono|ut-why|ut-why info|ut-pill|ut-info)"/g,
						) ?? []
					)
						.map((c) => c.replace(/class="|"/g, "").split(" ")[0])
						.join(","),
				);
		};
		const lives = [
			summary(),
			summary({
				budget: null,
				remainingUt: null,
				budgetSource: "unpublished",
				budgetProvenance: "unknown: none",
			}),
			summary({ remainingUt: -5_000 }),
			summary({ anchorFile: "present" }),
			summary({ chain: { events: 100, valid: false, empty: false, breakIndex: 30, errors: [] } }),
		];
		const pasts = [
			at(),
			at({ budget: pastBudget(UNPUBLISHED) }),
			at({ chain: { valid: false, breakIndex: 30 } }),
		];
		const expected = slots(strip(null, lives[0]));
		expect(expected.length).toBeGreaterThanOrEqual(5);
		for (const s of lives) expect(slots(strip(null, s))).toEqual(expected);
		for (const s of lives) for (const a of pasts) expect(slots(strip(a, s))).toEqual(expected);
		// The loading header too: the first summary moves nothing. Its first line is a "…" (a value, or a pill), each
		// other line held empty.
		const loading = renderToStaticMarkup(
			createElement(SummaryStrip, { summary: null, live: "live", at: null }),
		);
		expect(slots(loading)).toEqual(expected);
		// And the phone's Details toggle has its slot while loading.
		expect(loading).toMatch(/<span class="ut-more" aria-hidden="true" data-reserve="true">/);
		expect(loading).toContain('<div class="ut-fact budget">');
	});

	it("each fact line has a fixed height in the stylesheet: amounts and sub lines hold two lines and wrap; a value shrinks to fit", () => {
		const css = readFileSync(join(import.meta.dirname, "..", "src", "app", "styles.css"), "utf-8");
		const rule = (sel: string): string => {
			const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const m = new RegExp(`(?:^|[}\\s])${esc} \\{([^}]*)\\}`, "m").exec(css);
			return m?.[1] ?? "";
		};
		const twoLines = (sel: string, line: number): void => {
			const r = rule(sel);
			expect(r).toMatch(new RegExp(`(^|[^-])height: ${2 * line}px;`));
			expect(r).toMatch(new RegExp(`line-height: ${line}px;`));
			// Fixed, never a minimum: the same height in every state.
			expect(r).not.toMatch(/min-height|max-height/);
			// The text wraps in the box; nothing cuts it to one line.
			expect(r).toMatch(/white-space: normal;/);
			expect(r).not.toMatch(/text-overflow: ellipsis/);
		};
		twoLines(".ut-facts .ut-amts", 16);
		twoLines(".ut-facts .ut-sub", 14);
		expect(rule(".ut-facts .ut-why")).toMatch(/height: 34px;/);
		expect(rule(".ut-facts .ut-why")).toMatch(/-webkit-line-clamp: 2;/);
		// A value is one line, and shrinks to fit its column rather than being cut.
		const v = rule(".ut-facts .ut-fact .v");
		expect(v).toMatch(/height: 20px;/);
		expect(v).not.toMatch(/text-overflow: ellipsis/);
		expect(v).toMatch(/container-type: inline-size;/);
		expect(rule(".ut-facts .ut-fit")).toMatch(
			/font-size: min\(1em, calc\(100cqi \/ var\(--n, 1\) \/ 0\.62\)\);/,
		);
		expect(rule('.ut-facts [data-reserve="true"]')).toMatch(/visibility: hidden;/);
		// No rule anywhere sets a header fact's line back to one line with an ellipsis.
		for (const sel of [".ut-facts .ut-amts", ".ut-facts .ut-sub", ".ut-facts .ut-fact .v"]) {
			const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			expect(css).not.toMatch(new RegExp(`${esc} \\{[^}]*text-overflow: ellipsis`));
		}
	});

	it("a value, and every amount, carries its length for the fit; amounts wrap between units, never inside one", () => {
		const fits = (html: string): string[] =>
			[...html.matchAll(/<span class="ut-fit" style="--n:(\d+)">([\s\S]*?)<\/span>/g)].map(
				(m) => `${m[1]}:${text(m[2] ?? "")}`,
			);
		const over = strip(null, summary({ remainingUt: -5_000_000, budget: 1_000_000 }));
		const amts =
			/<span class="ut-amts red"[^>]*>([\s\S]*?)<\/span><span class="ut-sub mono"/.exec(
				over,
			)?.[1] ?? "";
		const units = fits(amts);
		// Two units: "overspent by $X" and "of $Y", each whole, each with its own length.
		expect(units).toHaveLength(2);
		expect(units[0]).toBe(
			`${`overspent by ${formatUsdTotal(5_000_000)}`.length}:overspent by ${formatUsdTotal(5_000_000)}`,
		);
		expect(units[1]).toBe(
			`${`of ${formatUsdTotal(1_000_000)}`.length}:of ${formatUsdTotal(1_000_000)}`,
		);
		expect(text(amts)).toBe(
			`overspent by ${formatUsdTotal(5_000_000)} of ${formatUsdTotal(1_000_000)}`,
		);
		// The Spend figure, the budget's percentage and the chain's count each fit their column.
		const live = strip(null);
		expect(live).toContain(`--n:${formatUsdTotal(123_400).length}`);
		expect(live).toContain(`--n:${"87.7% left".length}`);
		expect(live).toContain(`--n:${"100 events".length}`);
	});

	it("a clamped line keeps its full text in a title", () => {
		const html = strip(at());
		const why = /<span class="ut-why" title="([^"]*)">([\s\S]*?)<\/span>/.exec(html);
		expect(why).not.toBeNull();
		expect(why?.[1]).toContain(NOTE.replace("'", "&#x27;"));
		expect(why?.[1]).toBe(why?.[2]);
	});

	it("the past Budget's today figure is followed by whole vault, the scope it has", () => {
		const html = text(strip(at()));
		const fact = html.slice(html.indexOf("Budget"), html.indexOf("Chain"));
		const today = fact.lastIndexOf("today:");
		expect(today).toBeGreaterThan(-1);
		expect(fact.indexOf("whole vault")).toBeGreaterThan(today);
		expect(fact).not.toContain("this month");
		// A budget with no figure has nothing to scope.
		const none = text(strip(at({ budget: pastBudget(UNPUBLISHED) })));
		expect(none.slice(none.indexOf("Budget"), none.indexOf("Chain"))).not.toContain("whole vault");
	});

	it("the anchor file at T is today's, and says so", () => {
		expect(text(strip(at()))).toMatch(/today: not set up/);
		expect(text(strip(null))).not.toMatch(/today:/);
	});
});

describe("past budget provenance", () => {
	// The clock the header reads, fixed so the source word (which depends on the record's age) is known.
	const NOW = Date.parse("2026-11-01T10:05:00.000Z");
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("a controller's record: the source word and the time it was written", () => {
		const html = text(strip(at({ budget: pastBudget() })));
		expect(html).toContain(budgetSourceWord("governor", "2026-11-01T10:00:00.000Z", NOW).word);
		expect(html).toContain("2026-11-01 10:00Z");
	});

	it("a controller's record gone stale reads as recorded, never enforced", () => {
		const old = "2026-10-01T10:00:00.000Z";
		const html = text(
			strip(at({ budget: pastBudget({ writtenAt: old, provenance: "the enforced budget" }) })),
		);
		expect(html).toContain("recorded");
		expect(html).toContain("2026-10-01 10:00Z");
		expect(html).not.toContain("enforced");
	});

	it("the config's budget: the sentence the live fact shows, then the note, and never called enforced", () => {
		const provenance = "from usertrust.config.json; not confirmed as enforced";
		const html = text(
			strip(at({ budget: pastBudget({ source: "config", writtenAt: null, provenance }) })),
		);
		expect(html).toContain(`${provenance}. ${NOTE}`);
		// Not the bare source word in the sentence's place.
		expect(html).not.toContain(`${budgetSourceWord("config", null, NOW).word}. `);
		// The only "enforced" is the sentence's own "not confirmed as enforced".
		expect(html.split("not confirmed as enforced").join("")).not.toContain("enforced");
	});

	it("the line's title is the line: the sentence is not said twice", () => {
		const provenance = "from usertrust.config.json; not confirmed as enforced";
		const html = strip(
			at({ budget: pastBudget({ source: "config", writtenAt: null, provenance }) }),
		);
		const title = /<span class="ut-why" title="([^"]*)"/.exec(html)?.[1] ?? "";
		expect(title.replace(/&#x27;/g, "'")).toBe(`${provenance}. ${NOTE}`);
	});

	it("a source that is not a controller's record: the provenance sentence is in the line's title", () => {
		const html = strip(
			at({
				budget: pastBudget({
					source: "config",
					writtenAt: null,
					provenance: "a sentence from the server",
				}),
			}),
		);
		expect(html).toMatch(/<span class="ut-why" title="a sentence from the server\. /);
	});

	it("an unknown budget shows its reason and no figure", () => {
		const reason = "the enforced-budget record could not be read; permission denied";
		const html = text(
			strip(
				at({
					budget: pastBudget({
						ut: null,
						source: "unreadable",
						writtenAt: null,
						provenance: `unknown: ${reason}`,
					}),
				}),
			),
		);
		// The Budget fact alone: the Spend fact beside it shows a figure.
		const fact = html.slice(html.indexOf("Budget"), html.indexOf("Chain"));
		expect(fact).toContain(reason);
		expect(fact).not.toContain("$");
	});

	it("no figure and no controller's record: the line is the note, and its title says why there is none", () => {
		// The three sentences the reader of the vault writes for a budget it cannot give.
		const states = [
			UNPUBLISHED,
			{
				ut: null,
				source: "unreadable",
				writtenAt: null,
				provenance: "unknown: the enforced-budget record could not be read; permission denied",
			},
			{
				ut: null,
				source: "several",
				writtenAt: "2026-11-01T10:00:00.000Z",
				provenance:
					"unknown: several controllers with different budgets, as of 2026-11-01T10:00:00.000Z",
			},
		] as const;
		for (const state of states) {
			const html = strip(at({ budget: pastBudget(state) }));
			const [, title = "", line = ""] =
				/<span class="ut-why" title="([^"]*)"[^>]*>(.*?)<\/span>/.exec(html) ?? [];
			expect(text(line)).toBe(NOTE);
			// The sentence in full, "unknown" included, then the note: the line alone does not say why.
			expect(text(title)).toBe(`${state.provenance}. ${NOTE}`);
		}
	});
});

describe("the list at a past position before the first row held", () => {
	type TableProps = {
		rows: never[];
		total: number;
		phase: "loaded";
		chain: "verified" | "broken" | "empty" | null;
		beforeWindow?:
			| { kind: "before"; firstHeld: number; upTo: number }
			| { kind: "not-held"; upTo: number }
			| null;
		reloading?: boolean;
		reloadingNote?: string;
		selected: null;
		onOpen(): void;
		onClearFilters(): void;
	};
	let AuditTable: Component<TableProps>;
	beforeAll(async () => {
		AuditTable = (await app<{ AuditTable: typeof AuditTable }>("audit-table")).AuditTable;
	});
	beforeEach(() => {
		// The list reads the viewport width: there is no browser here.
		vi.stubGlobal("window", {
			matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("a healthy vault never reads as one that failed verification", () => {
		// As the page passes it at T: no rows held at or before the position, the chain read from at.chain.
		const html = text(
			renderToStaticMarkup(
				createElement(AuditTable, {
					rows: [],
					total: 0,
					phase: "loaded",
					chain: "verified",
					beforeWindow: { kind: "before", firstHeld: 50, upTo: 10 },
					selected: null,
					onOpen: () => {},
					onClearFilters: () => {},
				}),
			),
		);
		expect(html).not.toMatch(/failed verification/i);
		expect(html).toContain("The list starts at position 51, the first record it holds");
		expect(html).toContain("The 11 records up to this point count in the totals above");
	});

	it("when the records for the point are not held (a resync gap, or none held), it names no position it does not hold", () => {
		const html = text(
			renderToStaticMarkup(
				createElement(AuditTable, {
					rows: [],
					total: 0,
					phase: "loaded",
					chain: "verified",
					beforeWindow: { kind: "not-held", upTo: 10 },
					selected: null,
					onOpen: () => {},
					onClearFilters: () => {},
				}),
			),
		);
		expect(html).toContain("No records are held for this point yet");
		expect(html).toContain("The 11 records up to this point count in the totals above");
		expect(html).not.toMatch(/The list starts at position|Before the first record/);
		expect(html).not.toMatch(/failed verification/i);
	});

	const notHeld = {
		rows: [] as never[],
		total: 0,
		phase: "loaded" as const,
		chain: "verified" as const,
		beforeWindow: { kind: "not-held", upTo: 10 } as const,
		selected: null,
		onOpen: () => {},
		onClearFilters: () => {},
	};

	it("while the point's records are reloading, the list says so and never says no records are held", () => {
		const html = text(
			renderToStaticMarkup(
				createElement(AuditTable, {
					...notHeld,
					reloading: true,
					reloadingNote: "Updating to the reloaded vault…",
				}),
			),
		);
		expect(html).toContain("Updating to the reloaded vault…");
		expect(html).not.toContain("No records are held for this point yet");
		expect(html).not.toMatch(/No events to show|No governed calls yet/);
		// Plain text: the status already speaks.
		expect(
			renderToStaticMarkup(
				createElement(AuditTable, {
					...notHeld,
					reloading: true,
					reloadingNote: "Loading this point's records…",
				}),
			),
		).not.toMatch(/role="status"[^>]*>[^<]*Loading this point/);
	});

	it("CONTROL: a past point with no rows held and not reloading still says no records are held", () => {
		const html = text(renderToStaticMarkup(createElement(AuditTable, { ...notHeld })));
		expect(html).toContain("No records are held for this point yet");
		expect(html).not.toContain("Updating to the reloaded vault…");
	});
});

describe("Trends while the point's records are reloading", () => {
	it("shows the held words instead of its empty state", () => {
		const html = text(
			renderToStaticMarkup(
				createElement(TrendsReloading, {
					rows: [],
					newestOf: undefined,
					reloading: true,
					reloadingNote: "Updating to the reloaded vault…",
				}),
			),
		);
		expect(html).toContain("Updating to the reloaded vault…");
		expect(html).not.toContain("No records in view");
		// The lists are hidden too: each would print its own empty sentence.
		expect(html).not.toContain("Cost by kind");
		expect(html).not.toContain("Cost by model");
	});

	it("with no note given, says the default held words, never an empty bold line", () => {
		const html = text(
			renderToStaticMarkup(
				createElement(TrendsReloading, { rows: [], newestOf: undefined, reloading: true }),
			),
		);
		expect(html).toContain("Loading this point's records…");
	});

	it("CONTROL: not reloading, an empty Trends says so and shows its lists", () => {
		const html = text(
			renderToStaticMarkup(createElement(TrendsReloading, { rows: [], newestOf: undefined })),
		);
		expect(html).toContain("No records in view");
		expect(html).toContain("Cost by kind");
	});
});

describe("the bar's one pill names a past position whichever window is open", () => {
	// The year the pill leaves out is the clock's, so the clock is fixed.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.parse("2026-11-10T12:00:00.000Z"));
	});
	afterEach(() => {
		vi.useRealTimers();
	});
	// A filled window dims the Now window, which carries the as-at line; the bar is drawn by the shell above every
	// window, so the position is the connection pill's own text there: one pill, never two.
	const part = (p: "bar" | "head" | "facts", a: AtPayload | null): string =>
		renderToStaticMarkup(
			createElement(SummaryStrip, { summary: summary(), live: "live", at: a, part: p }),
		);
	const chip = (html: string): string =>
		/<span class="ut-live"[^>]*>[\s\S]*?<\/span>/.exec(html)?.[0] ?? "";

	it("draws `past · MM-DD HH:MMZ` in the bar, the time to the minute in UTC", () => {
		const c = chip(part("bar", at()));
		expect(text(c)).toBe("past \u00b7 11-06 10:04Z");
	});

	it("carries the whole line in its title and accessible name, with the record number", () => {
		const c = chip(part("bar", at({ pos: 60 })));
		const whole = "As recorded at 11-06 10:04:05Z, up to record 61. Stream: connected";
		expect(c).toContain(`title="${whole}"`);
		expect(c).toContain(`aria-label="${whole}"`);
		expect(c).toContain('role="status"');
	});

	it("says latest record in the name when the position was clamped to the head and nothing has followed", () => {
		const c = chip(part("bar", at({ pos: 99, head: 99, clamped: true })));
		expect(c).toContain("(latest record), up to record 100. Stream: connected");
	});

	it("drops the latest-record words once records follow a clamped position (the summary's chain is longer)", () => {
		const c = chip(part("bar", at({ pos: 90, head: 90, clamped: true })));
		expect(c).toContain(
			'title="As recorded at 11-06 10:04:05Z, up to record 91. Stream: connected"',
		);
		expect(c).not.toContain("latest record");
	});

	it("shows the time as written when it cannot be read, never a made-up minute", () => {
		const c = chip(part("bar", at({ ts: "not a time" })));
		expect(text(c)).toBe("past \u00b7 not a time");
		expect(c).toContain("As recorded at not a time, up to record 41. Stream: connected");
	});

	it("shows an unreadable time whole even when it ends like a time, never cutting its seconds", () => {
		const c = chip(part("bar", at({ ts: "2026-13-40T10:04:09Z" })));
		expect(text(c)).toBe("past \u00b7 2026-13-40T10:04:09Z");
	});

	it("is drawn while the summary is still loading, from the position itself", () => {
		const html = renderToStaticMarkup(
			createElement(SummaryStrip, { summary: null, live: "live", at: at(), part: "bar" }),
		);
		expect(text(chip(html))).toBe("past \u00b7 11-06 10:04Z");
		const none = renderToStaticMarkup(
			createElement(SummaryStrip, { summary: null, live: "live", at: null, part: "bar" }),
		);
		expect(text(chip(none))).toBe("live");
	});

	it("puts the year first when the position is not this year's, as the line does", () => {
		const c = chip(part("bar", at({ ts: "2025-03-02T04:05:06.000Z" })));
		expect(text(c)).toBe("past \u00b7 2025-03-02 04:05Z");
		expect(c).toContain("As recorded at 2025-03-02 04:05:06Z, up to record 41. Stream: connected");
	});

	it("groups the record number in the name like the desk's other figures", () => {
		expect(chip(part("bar", at({ pos: 10_000 })))).toContain("up to record 10,001");
	});

	it("is the only pill in the bar: no second pill, in any stream state", () => {
		const one = (live: "connecting" | "live" | "reconnecting" | "offline", a: AtPayload | null) =>
			renderToStaticMarkup(
				createElement(SummaryStrip, { summary: summary(), live, at: a, part: "bar" }),
			);
		for (const live of ["connecting", "live", "reconnecting", "offline"] as const) {
			for (const a of [null, at()]) {
				const html = one(live, a);
				expect(html.split('class="ut-live"').length - 1).toBe(1);
				expect(html).not.toContain("ut-past");
			}
		}
	});

	it("is not drawn live: the pill keeps its own word without a pin", () => {
		const live = part("bar", null);
		expect(text(chip(live))).toBe("live");
		expect(text(live)).not.toContain("past");
		expect(chip(live)).not.toContain("title=");
	});

	it("keeps the stream's state in the name, not the text, at a past position", () => {
		for (const live of ["reconnecting", "offline", "connecting"] as const) {
			const html = renderToStaticMarkup(
				createElement(SummaryStrip, { summary: summary(), live, at: at(), part: "bar" }),
			);
			const c = chip(html);
			expect(text(c)).toBe("past \u00b7 11-06 10:04Z");
			expect(c).toContain(`up to record 41. Stream: ${live}"`);
			expect(c).toContain(`data-st="${live}"`);
		}
	});

	it("is drawn by the bar only: the head and the facts never repeat the time", () => {
		expect(chip(part("head", at()))).toBe("");
		expect(chip(part("facts", at()))).toBe("");
		expect(text(part("bar", at())).split("10:04").length - 1).toBe(1);
		expect(text(part("head", at()))).not.toContain("past \u00b7");
		expect(text(part("facts", at()))).not.toContain("past \u00b7");
	});

	it("leaves no layout rule behind for a pinned bar: no header mark, no wrap rule in the desk sheet", () => {
		expect(part("bar", at())).toContain('<header class="ut-top">');
		const css = readFileSync(
			join(import.meta.dirname, "..", "src", "app", "desk", "desk.css"),
			"utf-8",
		);
		expect(css).not.toContain("data-past");
	});
});

describe("the bar's header gives the vault path up first", () => {
	// Measured in a browser: with the second mark and a long pill the header shrank into the search at 800–900 px.
	const css = readFileSync(
		join(import.meta.dirname, "..", "src", "app", "desk", "desk.css"),
		"utf-8",
	);
	const rule = (selector: string): string =>
		new RegExp(`${selector.replace(/[.>[\]"=*]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

	it("the header is never narrower than its own contents", () => {
		const r = rule(".ut-dk-top > .ut-top");
		expect(r).toMatch(/min-width:\s*min-content;/);
		expect(r).toMatch(/flex:\s*1 1 320px;/);
	});

	it("the path counts as nothing toward that size, takes the room left, and the spacer takes none", () => {
		const path = rule(".ut-dk-top > .ut-top > .ut-asof");
		expect(path).toMatch(/contain:\s*inline-size;/);
		expect(path).toMatch(/flex:\s*1 1 0;/);
		expect(path).toMatch(/text-align:\s*left;/);
		expect(rule(".ut-dk-top > .ut-top > .ut-grow")).toMatch(/flex:\s*0 0 0;/);
	});
});

describe("the connection pill at a past position", () => {
	// "live" means the screen shows now AND the stream is up. At a past point the stream may be up, but the screen is
	// not live, so the pill says "connected". Found in a real browser: the pill read LIVE beside "As recorded at".
	const bar = (
		live: "connecting" | "live" | "reconnecting" | "offline",
		a: AtPayload | null,
	): string =>
		renderToStaticMarkup(
			createElement(SummaryStrip, { summary: summary(), live, at: a, part: "bar" }),
		);
	const pill = (html: string): string =>
		/<span class="ut-live"[^>]*>[\s\S]*?<\/span>/.exec(html)?.[0] ?? "";

	it("says connected, never live, while a past point is shown and the stream is up", () => {
		const p = pill(bar("live", at()));
		expect(p).toContain("Stream: connected");
		expect(text(p).toLowerCase()).not.toContain("live");
		expect(p).toContain('data-past="true"');
		// The dot keeps the stream's state: it is up.
		expect(p).toContain('data-st="live"');
	});

	it("says live when the screen is live", () => {
		const p = pill(bar("live", null));
		expect(text(p)).toBe("live");
		expect(p).not.toContain("data-past");
	});

	it("keeps the stream's own word when the stream is not up, past or not", () => {
		expect(pill(bar("reconnecting", at()))).toContain("Stream: reconnecting");
		expect(pill(bar("offline", at()))).toContain("Stream: offline");
		expect(text(pill(bar("connecting", null)))).toBe("connecting");
	});

	it("stops the dot's pulse at a past point", () => {
		const css = readFileSync(join(import.meta.dirname, "..", "src", "app", "styles.css"), "utf-8");
		const rule = /\.ut-live\[data-past="true"\] i::after\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
		expect(rule).toMatch(/animation:\s*none/);
		expect(rule).toMatch(/content:\s*none/);
		// It comes after the live pulse, so the same specificity lets it win.
		expect(css.indexOf('.ut-live[data-past="true"] i::after')).toBeGreaterThan(
			css.indexOf('.ut-live[data-st="live"] i::after'),
		);
	});
});
