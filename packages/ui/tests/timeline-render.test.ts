// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The header and the timeline at a past position, rendered as the browser gets them. The past view says what it is
 * ("As recorded at"), reads every figure from `/api/at` and never today's budget as the budget then, and never says
 * "verified".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AtPayload, SummaryPayload } from "../src/shared/api.js";
import { formatUsdTotal } from "../src/shared/format.js";
import { timelineLabel } from "../src/shared/timeline-view.js";

// The components are .tsx files, which the tests' tsconfig (no `jsx`) cannot resolve statically: load them by a
// computed path, typed here by what the tests use.
type Component<P> = (props: P) => React.JSX.Element;
async function app<T>(file: string): Promise<T> {
	return (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as T;
}

interface TimelineProps {
	at: AtPayload | null;
	wanted: number | null;
	head: number;
	loading: boolean;
	error: string | null;
	reloaded: boolean;
	holdNote?: string | null;
	announce?: string;
	onPreview(pos: number): void;
	onCommit(pos: number): void;
	onLive(): void;
}

let SummaryStrip: Component<{
	summary: SummaryPayload | null;
	live: "live";
	at?: AtPayload | null;
}>;
let Timeline: Component<TimelineProps>;
beforeAll(async () => {
	SummaryStrip = (await app<{ SummaryStrip: typeof SummaryStrip }>("summary-strip")).SummaryStrip;
	Timeline = (await app<{ Timeline: typeof Timeline }>("timeline")).Timeline;
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
		budget: { ut: 1_000_000, note: NOTE },
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

	it("counts the records up to the position", () => {
		expect(text(strip(at({ pos: 40 })))).toContain("41 events");
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
			at({ budget: { ut: null, note: NOTE } }),
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
		expect(html).toMatch(
			new RegExp(`<span class="ut-why" title="${NOTE.replace("'", "&#x27;")}">`),
		);
	});

	it("the anchor file at T is today's, and says so", () => {
		expect(text(strip(at()))).toMatch(/today: not set up/);
		expect(text(strip(null))).not.toMatch(/today:/);
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
});

describe("the timeline", () => {
	const props = (over: Partial<TimelineProps> = {}): TimelineProps => ({
		at: null,
		wanted: null,
		head: 99,
		loading: false,
		error: null,
		reloaded: false,
		onPreview: () => {},
		onCommit: () => {},
		onLive: () => {},
		...over,
	});
	const render = (over: Partial<TimelineProps> = {}): string =>
		renderToStaticMarkup(createElement(Timeline, props(over)));

	it("is a native range over 0..head whose aria-valuetext says Live when live", () => {
		const html = render();
		expect(html).toMatch(/<input[^>]*type="range"/);
		expect(html).toMatch(/<input[^>]*min="0"/);
		expect(html).toMatch(/<input[^>]*max="99"/);
		expect(html).toMatch(/<input[^>]*aria-valuetext="Live"/);
		expect(html).toMatch(/<input[^>]*value="99"/);
		// Live: no Live button to press.
		expect(html).not.toMatch(/<button[^>]*>Live<\/button>/);
	});

	it("at a past position, aria-valuetext gives the record and the visible label, and Live is a real button", () => {
		const a = at();
		const label = timelineLabel(a, new Date().toISOString());
		const html = render({ at: a, wanted: 40 });
		expect(label).toContain("As recorded at");
		expect(html).toContain(`aria-valuetext="Record 41 of 100 · ${label}"`);
		expect(text(html)).toContain(label);
		expect(html).toMatch(/<input[^>]*value="40"/);
		expect(html).toMatch(/<button type="button"[^>]*>Live<\/button>/);
	});

	it("records added since the position was chosen show as a real button", () => {
		const html = render({ at: at({ head: 99 }), wanted: 40, head: 120 });
		expect(html).toMatch(/<button type="button"[^>]*>21 new since<\/button>/);
		expect(html).toMatch(/<input[^>]*max="120"/);
		expect(render({ at: at({ head: 99 }), wanted: 40, head: 99 })).not.toContain("new since");
	});

	it("while the first answer loads, it says so and never claims Live", () => {
		const html = render({ wanted: 40, loading: true });
		expect(html).not.toMatch(/aria-valuetext="Live"/);
		expect(html).toContain('aria-valuetext="Record 41 of 100 · loading"');
	});

	it("a position the answer has not caught up with never announces the old time", () => {
		// The thumb is at 41, the screen still shows 40's answer.
		const html = render({ at: at({ pos: 40 }), wanted: 41 });
		expect(html).toContain('aria-valuetext="Record 42 of 100 · loading"');
	});

	it("a clamped position puts the thumb on the record answered, and stops calling it the latest once more arrive", () => {
		const a = at({ pos: 99, head: 99, clamped: true });
		const html = render({ at: a, wanted: 500 });
		expect(html).toMatch(/<input[^>]*value="99"/);
		expect(text(html)).toContain("(latest record)");
		const later = render({ at: a, wanted: 500, head: 120 });
		expect(text(later)).not.toContain("(latest record)");
		expect(later).toMatch(/<input[^>]*value="99"/);
	});

	it("an error is a short inline note beside the last good view", () => {
		const html = render({ at: at(), wanted: 41, error: "the dashboard did not answer" });
		expect(text(html)).toContain("the dashboard did not answer");
		expect(text(html)).toContain("As recorded at");
	});

	it("an error with nothing loaded says the live vault is shown", () => {
		const html = text(render({ wanted: 41, error: "the vault has no records" }));
		expect(html).toContain("the vault has no records");
		expect(html).toContain("showing the live vault");
	});

	it("its head row is one fixed height live and past (on a phone, the label and Live share one row of two lines)", () => {
		const css = readFileSync(join(import.meta.dirname, "..", "src", "app", "styles.css"), "utf-8");
		expect(css).toMatch(/\.ut-tl-head \{[^}]*\bheight: 26px;/);
		const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
		// One row: the label's two lines, Live beside it; the range directly under.
		const head = /\.ut-tl-head \{([^}]*)\}/.exec(phone)?.[1] ?? "";
		expect(head).toMatch(/flex-wrap: nowrap;/);
		expect(head).toMatch(/[^-]height: calc\(2 \* 12px \* 1\.4\);/);
		expect(head).not.toMatch(/36px|min-height/);
		const label = /\.ut-tl-label \{([^}]*)\}/.exec(phone)?.[1] ?? "";
		expect(label).toMatch(/flex: 1 1 0;/);
		expect(label).not.toMatch(/flex-basis: 100%/);
		expect(label).toMatch(/[^-]height: calc\(2 \* 12px \* 1\.4\);/);
		// A long past label ("As recorded at … (latest record)") wraps; it is never cut.
		expect(label).toMatch(/white-space: normal;/);
		expect(label).toMatch(/overflow: visible;/);
		// At most one button beside it: "N new since" is folded into Live, and the visible note has no room.
		expect(phone).toMatch(/\.ut-tl-held,\s*\.ut-tl-new \{\s*display: none;\s*\}/);
		expect(phone).toMatch(/\.ut-tl-count \{\s*display: inline;\s*\}/);
		const wide = css.slice(0, css.indexOf("@media (max-width: 900px)"));
		expect(wide).toMatch(/\.ut-tl-count \{\s*display: none;\s*\}/);
		// A compact box: the top padding and the gap Live's 44px area needs, and little under the range's own 44px box.
		const tl = /\.ut-tl \{([^}]*)\}/.exec(phone)?.[1] ?? "";
		expect(tl).toMatch(/gap: 10px;/);
		expect(tl).toMatch(/padding: 10px 12px;/);
		expect(tl).toMatch(/padding-bottom: calc\(6px \+ env\(safe-area-inset-bottom\)\);/);
		// No rule gives a past label a different size from a live one.
		expect(css).not.toMatch(
			/\.ut-tl-label\[data-past="true"\] \{[^}]*(flex-basis|white-space|font)/,
		);
	});

	it("on a phone the new-since count rides in Live: the same action, one button", () => {
		const html = render({ at: at({ head: 99 }), wanted: 40, head: 120 });
		expect(html).toMatch(
			/<button type="button" class="ut-tl-btn ut-tl-new"[^>]*>21 new since<\/button>/,
		);
		// "+21" (short, so a long label keeps its two lines beside it at 320px), "new records" for a screen reader.
		expect(html).toMatch(
			/<button type="button" class="ut-tl-btn"[^>]*>Live<span class="ut-tl-count"> \+21<span class="sr-only"> new records<\/span><\/span><\/button>/,
		);
		expect(render({ at: at({ head: 99 }), wanted: 40, head: 99 })).not.toContain("ut-tl-count");
	});

	it("announces the held views once as they start to lag and once as they catch up, in a region there before any text", () => {
		const idle = render({ at: at(), wanted: 40 });
		expect(idle).toMatch(/<span class="sr-only" role="status"><\/span>/);
		const held = render({
			at: at({ pos: 61 }),
			wanted: 61,
			holdNote: "Updating to record 62…",
			announce: "Updating to record 62…",
		});
		expect(held).toMatch(/<span class="sr-only" role="status">Updating to record 62…<\/span>/);
		// The visible note follows every answer, so it is hidden from the screen reader: only `announce` is read.
		expect(held).toMatch(
			/<span class="ut-tl-held" aria-hidden="true">Updating to record 62…<\/span>/,
		);
		expect(held.match(/role="status"/g)).toHaveLength(1);
	});

	it("an epoch change says the vault was reloaded", () => {
		expect(text(render({ at: at(), wanted: 40, reloaded: true }))).toContain(
			"the vault was reloaded",
		);
	});
});
