// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * What the record panel shows about one charge: each tier's tokens, rate and product, the sum beside the charged
 * cost, and the lines and actions the Ledger window adds under the status. Rendered to static markup, so what is
 * asserted is what a reader sees.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_FILTERS, type FilterState } from "../src/shared/filters.js";
import { DENSE_ROW_PX } from "../src/shared/list-chunk.js";
import { budgetOf } from "../src/shared/peek.js";
import type { LedgerRow, RowStatus } from "../src/shared/rows.js";
import { statusWord } from "../src/shared/status-word.js";

// The components are .tsx files, which the tests' typecheck (no jsx) cannot import statically: load them by a
// computed path, typed here by what the tests use.
type Component<P> = (props: P) => React.JSX.Element | null;
async function load<P>(file: string, name: string): Promise<Component<P>> {
	const mod = (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as Record<
		string,
		Component<P>
	>;
	return mod[name] as Component<P>;
}

type Budget = ReturnType<typeof budgetOf>;
interface PanelProps {
	row: LedgerRow;
	docked: boolean;
	past: boolean;
	onClose(): void;
	inWindow?: boolean;
	extra?: ReactNode;
	actions?: ReactNode;
}
let ChargeTable: Component<{ row: LedgerRow }>;
let PeekExtra: Component<{ row: LedgerRow; rows: readonly LedgerRow[]; budget: Budget }>;
let RowPanel: Component<PanelProps>;
interface ListProps {
	rows: LedgerRow[];
	total: number;
	phase: "loaded";
	chain: "broken";
	selected: string | null;
	onOpen(): void;
	onClearFilters(): void;
	hourSpan?: readonly [number, number] | null;
	pinnedPos?: number | null;
	full?: boolean;
}
interface ListRowProps {
	row: LedgerRow;
	index: number;
	setSize: number;
	active: boolean;
	selected: boolean;
	fresh: boolean;
	hour?: boolean;
	pinned?: boolean;
	top: number;
	full?: boolean;
}
let AuditTable: Component<ListProps>;
let AuditRow: Component<ListRowProps>;
let PeekActions: Component<{
	row: LedgerRow;
	filters: FilterState;
	onPin(pos: number): void;
	onFilters(f: FilterState): void;
}>;
beforeAll(async () => {
	ChargeTable = await load("windows/ledger/charge-table", "ChargeTable");
	PeekExtra = await load("windows/ledger/peek-extra", "PeekExtra");
	PeekActions = await load("windows/ledger/peek-extra", "PeekActions");
	RowPanel = await load("row-panel", "RowPanel");
	AuditTable = await load("audit-table", "AuditTable");
	AuditRow = await load("audit-table", "AuditRow");
});

const appFile = (file: string): string =>
	readFileSync(join(import.meta.dirname, "..", "src", "app", file), "utf-8");

const RATES = { inputPer1k: 30, outputPer1k: 150, cacheReadPer1k: 3, cacheWritePer1k: 37.5 };

/** 30 + 75 + 6 + 3.75 = 114.75 usertokens, charged as 115. */
function row(over: Partial<LedgerRow> = {}): LedgerRow {
	return {
		seq: 7,
		pos: 7,
		id: "id-7",
		ts: "2026-10-12T17:59:02.770Z",
		kind: "llm_call",
		actor: "a",
		model: "m",
		hash: "7".padStart(64, "0"),
		previousHash: "0".repeat(64),
		integrity: "verified",
		status: "settled",
		costUt: 115,
		usageSource: "provider",
		usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 },
		appliedRates: RATES,
		pricingTableVersion: "2026-11-02",
		...over,
	};
}

/** Input tokens only, at 1 usertoken per 1,000: `tokens / 1000` usertokens exactly. */
const inputOnly = (tokens: number, costUt: number): LedgerRow =>
	row({
		costUt,
		usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		appliedRates: { ...RATES, inputPer1k: 1 },
	});

/** Three terms that are exactly 3 in decimals and land a hair above 3 as the charge sums them: charged 4. */
const RESIDUE = row({
	costUt: 4,
	usage: { inputTokens: 1, outputTokens: 194, cacheReadTokens: 290, cacheWriteTokens: 0 },
	appliedRates: { inputPer1k: 3, outputPer1k: 15, cacheReadPer1k: 0.3, cacheWritePer1k: 3.75 },
});

const table = (r: LedgerRow): string =>
	renderToStaticMarkup(createElement(ChargeTable, { row: r }));
const fig = (name: string, value: string): string => `data-fig="ledger.${name}">${value}<`;

describe("the panel's arithmetic", () => {
	it("a priced charge: every tier's tokens, rate and product, the sum, the charged cost and its sources", () => {
		const html = table(row());
		expect(html).toContain("<caption>How this cost adds up</caption>");
		for (const head of ["Tier", "Tokens", "Rate per 1k", "Cost"]) expect(html).toContain(head);
		for (const tier of ["Input", "Output", "Cache read", "Cache write"])
			expect(html).toContain(tier);
		for (const cell of ["1,000", "30 UT", "75 UT", "$0.0075", "3.75 UT", "37.5 UT"]) {
			expect(html).toContain(cell);
		}
		expect(html).toContain("Rounded up to a whole UT (minimum 1)");
		expect(html).toContain(fig("panel-sum-exact", "114.75 UT"));
		expect(html).toContain(fig("panel-sum", "115 UT"));
		expect(html).toContain(fig("panel-cost", "115 UT"));
		// The three rows under the tiers say it: no sentence repeats the sum.
		expect(html).not.toContain("ut-lg-sumnote");
		expect(html).not.toContain("Sum ");
		expect(html).toContain("Pricing table version: 2026-11-02");
		expect(html).toContain("Usage source: provider-reported");
		expect(html).not.toMatch(/verified|reconciled/i);
	});

	it("a fractional sum rounded up is told by the rows alone, with no sentence", () => {
		const html = table(inputOnly(2500, 3));
		expect(html).not.toContain("ut-lg-sumnote");
		expect(html).not.toContain("Sum 2.5");
		expect(html).toContain(fig("panel-sum-exact", "2.5 UT"));
		expect(html).toContain(fig("panel-sum", "3 UT"));
		expect(html).not.toContain("ledger.panel-residue");
	});

	it("a whole sum charged at that number is told by the rows alone, with no sentence", () => {
		const html = table(inputOnly(3000, 3));
		expect(html).not.toContain("ut-lg-sumnote");
		expect(html).not.toContain("Sum 3");
		expect(html).not.toContain("floating point");
		expect(html).toContain(fig("panel-sum-exact", "3 UT"));
		expect(html).toContain(fig("panel-sum", "3 UT"));
		expect(html).not.toContain("ledger.panel-residue");
	});

	it("a whole sum charged one higher is explained, carries the residue hook and is not a difference", () => {
		const html = table(RESIDUE);
		expect(html).toContain(
			"Sum 3 UT. Recorded 4 UT: the cost was computed in floating point, came out a hair above 3, and charges round up.",
		);
		// "charges round up" is the rule for any charge; nothing says this record was charged.
		expect(html).not.toMatch(/Charged|the charge was/);
		expect(html).not.toContain("costs round up");
		expect(html).toContain(fig("panel-sum-exact", "3 UT"));
		expect(html).toContain(fig("panel-sum", "4 UT"));
		expect(html).toContain(fig("panel-residue", "1 UT"));
		expect(html).toContain(fig("panel-cost", "4 UT"));
		expect(html).not.toMatch(/higher|lower/);
	});

	it("a sum of nothing is charged the minimum, and says so", () => {
		const html = table(inputOnly(0, 1));
		expect(html).toContain("Sum 0 UT. A charge is at least 1 UT.");
		expect(html).not.toContain("ledger.panel-residue");
	});

	it("a difference is shown, in both directions, as recorded", () => {
		const more = table(row({ costUt: 120 }));
		expect(more).toContain(
			"The tiers add up to 115 UT; the record holds 120 UT; the recorded cost is 5 UT higher. Shown as recorded.",
		);
		expect(more).toContain(fig("panel-cost", "120 UT"));
		expect(more).toContain('<p class="ut-lg-sumnote">The tiers add up to 115 UT;');
		expect(table(row({ costUt: 112 }))).toContain("the recorded cost is 3 UT lower.");
		expect(more).not.toMatch(/the record charged|the charge is/);
	});

	it("no token counts: says so, claims no sum, still shows the charged cost", () => {
		const { usage: _usage, ...bare } = row();
		const html = table(bare);
		expect(html).toContain(
			"No token counts are recorded for this cost, so it cannot be added up from tokens.",
		);
		expect(html).not.toContain("ledger.panel-sum");
		expect(html).not.toContain("Sum ");
		expect(html).toContain(fig("panel-cost", "115 UT"));
	});

	it("a missing count is 'not recorded' and named; a recorded 0 is printed as 0", () => {
		const html = table(
			row({ usage: { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 100 } }),
		);
		const cacheRead = html.slice(html.indexOf("Cache read"), html.indexOf("Cache write"));
		expect(cacheRead).toContain("not recorded");
		// The absent product: the one long dash the table prints, built here so no escape is typed.
		expect(cacheRead).toContain(`>${String.fromCharCode(0x2014)}<`);
		expect(html).toContain("Cannot be added up: the cache-read token count was not recorded.");
		expect(html).not.toContain("ledger.panel-sum");
		expect(html).toContain("ledger.panel-cost");

		const zero = table(row({ costUt: 109, usage: { ...row().usage, cacheReadTokens: 0 } }));
		const zeroRead = zero.slice(zero.indexOf("Cache read"), zero.indexOf("Cache write"));
		expect(zeroRead).toContain("<td>0</td>");
		expect(zeroRead).not.toContain("not recorded");
		expect(zero).toContain(fig("panel-sum", "109 UT"));
	});

	it("two things missing are both named", () => {
		const html = table(
			row({
				usage: { inputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 100 },
				appliedRates: { inputPer1k: 30, outputPer1k: 150, cacheWritePer1k: 37.5 },
			}),
		);
		expect(html).toContain(
			"Cannot be added up: the output token count and the cache-read rate were not recorded.",
		);
	});

	it("a cache write with a 1-hour share shows its two parts", () => {
		const html = table(row({ costUt: 116, cacheWrite1h: { tokens: 40, ratePer1k: 60 } }));
		expect(html).toContain("5-minute");
		expect(html).toContain("1-hour");
		// 60 at 37.5 and 40 at 60: 2.25 + 2.4.
		for (const cell of ["2.25 UT", "2.4 UT", "4.65 UT"]) expect(html).toContain(cell);
		expect(html).toContain(fig("panel-sum", "116 UT"));
	});

	it("a cache write shown in two parts has no one rate: its own row keeps the total tokens and cost only", () => {
		const html = table(row({ costUt: 116, cacheWrite1h: { tokens: 40, ratePer1k: 60 } }));
		const parent = html.slice(html.indexOf("Cache write"), html.indexOf("5-minute"));
		const dash = String.fromCharCode(0x2014);
		expect(parent).toContain(`<td class="na" aria-label="two rates, below">${dash}</td>`);
		expect(parent).not.toContain("37.5 UT");
		expect(parent).toContain("<td>100</td>");
		expect(parent).toContain("4.65 UT");
		// The two rates are on the rows below it.
		const parts = html.slice(html.indexOf("5-minute"), html.indexOf("<tfoot>"));
		expect(parts).toContain("<td>37.5 UT</td>");
		expect(parts).toContain("<td>60 UT</td>");
	});

	it("a cache write in one part keeps its rate on its own row", () => {
		const html = table(row());
		const parent = html.slice(html.indexOf("Cache write"), html.indexOf("<tfoot>"));
		expect(parent).toContain("<td>37.5 UT</td>");
		expect(html).not.toContain("two rates, below");
	});

	it("a 1-hour share without its rate is partial, and the sentence names the rate", () => {
		const html = table(row({ cacheWrite1h: { tokens: 40 } }));
		expect(html).toContain("1-hour");
		expect(html).toContain("Cannot be added up: the 1-hour cache-write rate was not recorded.");
		expect(html).not.toContain("ledger.panel-sum");
	});

	it("an estimate says so; a missing version or usage source is 'not recorded'", () => {
		expect(table(row({ usageSource: "estimated" }))).toContain("Usage source: estimated");
		const { pricingTableVersion: _version, usageSource: _source, ...bare } = row();
		const html = table(bare);
		expect(html).toContain("Pricing table version: not recorded");
		expect(html).toContain("Usage source: not recorded");
	});

	it("a record with no cost has no table", () => {
		const { costUt: _cost, ...bare } = row();
		expect(table(bare)).toBe("");
	});

	it("only a call has a table: a record of another kind has none, whatever cost and model it carries", () => {
		expect(table(row({ kind: "settlement_ambiguous", status: "ambiguous", costUt: 40 }))).toBe("");
		expect(table(row({ kind: "policy_denied", status: "denied" }))).toBe("");
		expect(table(row())).toContain("How this cost adds up");
	});

	it("an unresolved call's cost is a recorded cost, not a charge, in the rows and in the sentences", () => {
		const open = row({ status: "ambiguous", settled: false });
		const html = table(open);
		expect(html).toContain('<th scope="row" colSpan="3">Recorded cost</th>');
		expect(html).not.toContain(">Charged<");
		// The hooks stay on the same rows.
		expect(html).toContain(fig("panel-sum", "115 UT"));
		expect(html).toContain(fig("panel-cost", "115 UT"));
		expect(table({ ...open, costUt: 120 })).toContain(
			"The tiers add up to 115 UT; the record holds 120 UT; the recorded cost is 5 UT higher. Shown as recorded.",
		);
		expect(table({ ...open, costUt: 112 })).toContain("the recorded cost is 3 UT lower.");
		// A whole sum recorded one higher: the cost was recorded, so nothing is said to have been charged.
		const residue = table({ ...RESIDUE, status: "ambiguous", settled: false });
		expect(residue).toContain(
			"Sum 3 UT. Recorded 4 UT: the cost was computed in floating point, came out a hair above 3, and charges round up.",
		);
		expect(residue).not.toMatch(/Charged|the charge was/);
		expect(residue).not.toContain("costs round up");
	});

	it("no status says Charged: the last row is the recorded cost for a settled call and for every other", () => {
		// A settled call's settlement can be less than its metered cost, and the record carries only the metered
		// cost: so it is a recorded cost whatever the status. A row that carries no status at all reads the same.
		const { status: _status, ...bare } = row({ settled: false });
		const rows = [
			bare,
			...(["settled", "ambiguous", "unknown", "unrecoverable", "failed"] as const).map((s) =>
				row({ status: s }),
			),
		];
		for (const r of rows) {
			const html = table(r);
			expect(html).toContain('<th scope="row" colSpan="3">Recorded cost</th>');
			expect(html).not.toMatch(/Charged|\bcharged\b/);
			expect(html).toContain(fig("panel-cost", "115 UT"));
		}
		for (const status of ["settled", "unknown"] as const) {
			expect(table(row({ status, costUt: 120 }))).toContain(
				"the record holds 120 UT; the recorded cost is 5 UT higher.",
			);
			expect(table({ ...RESIDUE, status })).toContain("Sum 3 UT. Recorded 4 UT: the cost was");
		}
	});

	it("a whole sum that computes one higher, on a record that holds another figure: both sentences in full", () => {
		const tiers =
			"Sum 3 UT. A charge of these tiers comes to 4 UT: it is computed in floating point, came out a hair above 3, and charges round up.";
		// The first sentence is about the tiers, not this record, so it keeps "charge"; the second speaks of the
		// recorded cost. The same for a settled call and for one that is not.
		for (const status of ["settled", "unknown"] as const) {
			expect(table({ ...RESIDUE, costUt: 7, status })).toContain(
				`<p class="ut-lg-sumnote">${tiers} The tiers add up to 4 UT; the record holds 7 UT; the recorded cost is 3 UT higher. Shown as recorded.</p>`,
			);
		}
	});

	it("a missing rate reads 'not recorded' in its own cell, never 0", () => {
		const html = table(
			row({ appliedRates: { inputPer1k: 30, outputPer1k: 150, cacheWritePer1k: 37.5 } }),
		);
		const cacheRead = html.slice(html.indexOf("Cache read"), html.indexOf("Cache write"));
		expect(cacheRead).toContain("<td>2,000</td><td>not recorded</td>");
		expect(cacheRead).not.toContain("0 UT");
		expect(html).toContain("Cannot be added up: the cache-read rate was not recorded.");
	});

	it("a priced cache write in two parts has exactly two part rows, and a tier in one part exactly one row", () => {
		const split = table(row({ costUt: 116, cacheWrite1h: { tokens: 40, ratePer1k: 60 } }));
		const rowsIn = (html: string): number =>
			html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>")).split("<tr").length - 1;
		expect(split.split('class="ut-lg-part"').length - 1).toBe(2);
		expect(split.split("1-hour").length - 1).toBe(1);
		// Four tiers and the two parts.
		expect(rowsIn(split)).toBe(6);
		const whole = table(row());
		expect(rowsIn(whole)).toBe(4);
		expect(whole).not.toContain("ut-lg-part");
		expect(whole).not.toContain('<th scope="row"></th>');
	});

	it("a 1-hour share with a rate and no count: its row shows that, and the sentence names the count", () => {
		const html = table(row({ cacheWrite1h: { ratePer1k: 60 } }));
		expect(html).toContain(
			'<tr class="ut-lg-part"><th scope="row">1-hour</th><td>not recorded</td><td>60 UT</td>',
		);
		expect(html).toContain(
			"Cannot be added up: the 1-hour cache-write token count was not recorded.",
		);
		expect(html).not.toContain("ledger.panel-sum");
	});

	it("an unusable 1-hour share shows the share's own count, not the write's", () => {
		const html = table(row({ cacheWrite1h: { tokens: 40 } }));
		expect(html).toContain(
			'<tr class="ut-lg-part"><th scope="row">1-hour</th><td>40</td><td>not recorded</td>',
		);
		// The write's own row keeps the write's count and its rate.
		expect(html).toContain('<th scope="row">Cache write</th><td>100</td><td>37.5 UT</td>');
	});

	it("the minimum is said only of a sum of nothing: not of half a usertoken, and not of exactly 1", () => {
		const half = table(inputOnly(500, 1));
		expect(half).toContain(fig("panel-sum-exact", "0.5 UT"));
		expect(half).toContain(fig("panel-sum", "1 UT"));
		expect(half).not.toContain("at least");
		expect(half).not.toContain("ut-lg-sumnote");
		const one = table(inputOnly(1000, 1));
		expect(one).toContain(fig("panel-sum-exact", "1 UT"));
		expect(one).not.toContain("at least");
		expect(one).not.toContain("ut-lg-sumnote");
	});

	it("in a difference the 'Rounded up' row shows what the tiers come to, not the record's cost", () => {
		const html = table(row({ costUt: 120 }));
		expect(html).toContain(fig("panel-sum-exact", "114.75 UT"));
		expect(html).toContain(fig("panel-sum", "115 UT"));
		expect(html).toContain(fig("panel-cost", "120 UT"));
		expect(html).not.toContain(fig("panel-sum", "120 UT"));
	});

	it("a sum of a thousand usertokens or more is grouped, with its fraction kept", () => {
		const html = table(inputOnly(1_234_500, 1235));
		expect(html).toContain("<td>1,234,500</td>");
		expect(html).toContain(fig("panel-sum-exact", "1,234.5 UT"));
		expect(html).toContain(fig("panel-sum", "1,235 UT"));
		expect(html).toContain(fig("panel-cost", "1,235 UT"));
		expect(html).not.toContain("1234.5");
	});

	it("a rate is written out in plain grouped decimals: 1,250 and 0.0000001, never an exponent", () => {
		const html = table(
			row({ appliedRates: { ...RATES, inputPer1k: 1250, cacheReadPer1k: 0.0000001 } }),
		);
		const input = html.slice(html.indexOf("Input"), html.indexOf("Output"));
		expect(input).toContain("<td>1,000</td><td>1,250 UT</td>");
		const cacheRead = html.slice(html.indexOf("Cache read"), html.indexOf("Cache write"));
		expect(cacheRead).toContain("<td>2,000</td><td>0.0000001 UT</td>");
		expect(html).not.toMatch(/\de-\d/);
		// A rate keeps every digit it was recorded with.
		expect(html).toContain("<td>150 UT</td>");
		expect(html).toContain("<td>37.5 UT</td>");
		expect(table(RESIDUE)).toContain("<td>0.3 UT</td>");
	});

	it("a rate too large to be written without an exponent is still written out, with its zeros", () => {
		const html = table(row({ appliedRates: { ...RATES, inputPer1k: 1e21, outputPer1k: 1.5e21 } }));
		const input = html.slice(html.indexOf("Input"), html.indexOf("Output"));
		expect(input).toContain("<td>1,000</td><td>1,000,000,000,000,000,000,000 UT</td>");
		const output = html.slice(html.indexOf("Output"), html.indexOf("Cache read"));
		expect(output).toContain("<td>500</td><td>1,500,000,000,000,000,000,000 UT</td>");
		expect(html).not.toMatch(/\de\+\d/);
	});

	it("a partial charge names what is missing and does not claim that no counts are recorded", () => {
		const html = table(
			row({ usage: { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 100 } }),
		);
		expect(html).toContain("Cannot be added up:");
		expect(html).not.toContain("No token counts are recorded");
		// And the other way round.
		const { usage: _usage, ...bare } = row();
		expect(table(bare)).not.toContain("Cannot be added up:");
	});
});

describe("the lines under a record's status", () => {
	const HOUR = Date.parse("2026-10-12T17:00:00.000Z");
	const busy = Array.from({ length: 10 }, (_, i) =>
		row({ hash: `h${i}`, ts: new Date(HOUR + i * 60_000).toISOString() }),
	);
	const budget = (over: Partial<Budget> = {}): Budget => ({
		ut: 1_000_000,
		provenance: "from the vault config",
		note: null,
		...over,
	});
	const extra = (r: LedgerRow, rows: readonly LedgerRow[], b: Budget): string =>
		renderToStaticMarkup(createElement(PeekExtra, { row: r, rows, budget: b }));

	it("an unusual hour is a note", () => {
		const html = extra(busy[0] as LedgerRow, busy, budget());
		expect(html).toMatch(
			/<p[^>]*role="note"[^>]*>Unusual: 10 calls from a to m in this hour \(usual under 1\)<\/p>/,
		);
		expect(extra(row(), [row()], budget())).not.toContain('role="note"');
	});

	it("the record's share of the budget, with where the budget came from", () => {
		const html = extra(row({ costUt: 5000 }), [], budget());
		expect(html).toContain("0.500% of the budget. ");
		expect(html).toContain("Budget: from the vault config.");
		const past = extra(row({ costUt: 5000 }), [], budget({ note: "this is today's budget" }));
		expect(past).toContain("Budget: from the vault config (this is today&#x27;s budget).");
	});

	it("an unknown budget shows only its source, never a share", () => {
		const html = extra(row(), [], budget({ ut: null, provenance: "no budget is set" }));
		expect(html).toContain("Budget: no budget is set.");
		expect(html).not.toContain("%");
	});

	it("with nothing loaded it prints no budget source at all", () => {
		expect(extra(row(), [], budgetOf(null, null))).toBe("");
		const html = extra(busy[0] as LedgerRow, busy, budgetOf(null, null));
		expect(html).toContain('role="note"');
		expect(html).not.toContain("Budget");
	});

	it("a record with no cost has no share, so no budget line and no source", () => {
		const { costUt: _cost, ...bare } = row();
		expect(extra(bare, [], budget())).toBe("");
		// With a note to show, the note is all there is.
		const { costUt: _busyCost, ...busyBare } = busy[0] as LedgerRow;
		const html = extra(busyBare, busy, budget());
		expect(html).toContain('role="note"');
		expect(html).not.toContain("Budget");
		expect(html).not.toContain("ut-lg-share");
	});

	it("a cost that is not a cost (below 0, not a number) has no share, so no budget line and no source", () => {
		for (const costUt of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(extra(row({ costUt }), [], budget()), String(costUt)).toBe("");
			const html = extra({ ...(busy[0] as LedgerRow), costUt }, busy, budget());
			expect(html).toContain('role="note"');
			expect(html).not.toContain("Budget");
		}
		// A cost of exactly 0 is a cost: its share and the source are shown.
		const zero = extra(row({ costUt: 0 }), [], budget());
		expect(zero).toContain("% of the budget. ");
		expect(zero).toContain("Budget: from the vault config.");
	});
});

describe("the record panel", () => {
	const SLOTS = {
		extra: createElement("p", { id: "x-extra" }, "extra here"),
		actions: createElement("p", { id: "x-actions" }, "actions here"),
	};
	const panel = (r: LedgerRow, over: Partial<PanelProps> = {}): string =>
		renderToStaticMarkup(
			createElement(RowPanel, { row: r, docked: true, past: false, onClose: () => {}, ...over }),
		);

	it("shows the arithmetic in every variant, after the Usage line", () => {
		for (const over of [{}, { docked: false }, { inWindow: true }]) {
			const html = panel(row(), over);
			expect(html).toContain("How this cost adds up");
			expect(html.indexOf("How this cost adds up")).toBeGreaterThan(html.indexOf("Usage"));
		}
	});

	it("in the window it is glass with no scrim, and says where the record stands on the chain", () => {
		const html = panel(row(), { inWindow: true, ...SLOTS });
		expect(html).toMatch(/<aside class="ut-lg-peek ut-glass"/);
		expect(html).not.toContain("ut-scrim");
		expect(html).not.toContain('role="dialog"');
		expect(html).toContain(
			'<p class="ut-chainnote" data-ok="true">Tamper-evident chain intact through this record</p>',
		);
		const broken = panel(row({ integrity: "after-break" }), { inWindow: true });
		expect(broken).toContain(
			'<p class="ut-chainnote" data-ok="false">This record comes after a break in the chain</p>',
		);
		expect(broken).not.toContain("Tamper-evident");
		// The chain line, then the extra lines, then the actions, all before the record's sections.
		const order = ["ut-chainnote", "extra here", "actions here", "ut-sec"].map((s) =>
			html.indexOf(s),
		);
		expect(order.every((at) => at >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it("in the window it takes the window's form whatever it is told about docking", () => {
		const html = panel(row(), { inWindow: true, docked: false, ...SLOTS });
		expect(html).toMatch(/<aside class="ut-lg-peek ut-glass"/);
		expect(html).not.toContain("ut-scrim");
		expect(html).not.toContain('role="dialog"');
		expect(html).toContain("ut-chainnote");
		expect(html).toContain("extra here");
	});

	it("docked beside the list it stays solid, takes the same slots and has no chain line", () => {
		const html = panel(row(), SLOTS);
		expect(html).toMatch(/<aside class="ut-insp"/);
		expect(html).not.toContain("ut-glass");
		expect(html).not.toContain("ut-chainnote");
		expect(html).toContain("extra here");
		expect(html).toContain("actions here");
	});

	it("an unconfirmed outcome reads 'unresolved' in the pill, with what that means", () => {
		for (const over of [{}, { inWindow: true }]) {
			const html = panel(row({ status: "ambiguous" }), over);
			expect(html).toMatch(
				/<span class="ut-pill"[^>]*title="the outcome isn&#x27;t confirmed yet"[^>]*><i><\/i>unresolved<\/span>/,
			);
			expect(html.replace(/<[^>]*>/g, " ")).not.toMatch(/ambiguous|\bheld\b/);
			const settled = panel(row(), over);
			expect(settled).toMatch(/<span class="ut-pill"[^>]*><i><\/i>settled<\/span>/);
			expect(settled).not.toContain("confirmed yet");
		}
	});

	it("its keys: Escape is marked as handled, and Up and Down step only from inside the Ledger window", () => {
		const src = appFile("row-panel.tsx");
		const onEscape = src.slice(src.indexOf('e.key === "Escape"'), src.indexOf('e.key === "Tab"'));
		expect(onEscape).toContain("e.preventDefault()");
		const arrows = src.slice(src.indexOf('"ArrowUp"'), src.indexOf('e.key === "Escape"'));
		expect(arrows).toContain(`closest('[data-win="ledger"]')`);
		expect(arrows).toContain("input, textarea, select, [role='listbox'], [role='menu']");
		// A chord (Cmd+Up, Alt+Down, Shift+Down) is the browser's or the system's: it is left alone, before anything
		// is prevented.
		const chord = "if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;";
		expect(arrows).toContain(chord);
		expect(arrows.indexOf(chord)).toBeLessThan(arrows.indexOf("e.preventDefault()"));
		expect(arrows).toContain("e.preventDefault()");
		expect(arrows).toContain("e.stopPropagation()");
		expect(arrows).toMatch(/onStep\(e\.key === "ArrowUp" \? -1 : 1\)/);
	});
});

describe("the dense list", () => {
	// The list asks whether it is on a phone (window.matchMedia) as it first renders; there is no browser here, so
	// the answer is given: not a phone.
	beforeEach(() => {
		vi.stubGlobal("window", {
			matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const T0 = Date.parse("2026-10-12T00:00:00.000Z");
	const DASH = String.fromCharCode(0x2014);
	/** `n` calls a minute apart, oldest first. The list draws the newest first: row `seq` is at place `n - seq`. */
	const many = (n: number): LedgerRow[] =>
		Array.from({ length: n }, (_, i) =>
			row({
				seq: i,
				pos: i,
				id: `id-${i}`,
				hash: `${i}`.padStart(64, "c"),
				ts: new Date(T0 + i * 60_000).toISOString(),
				costUt: 100 + i,
			}),
		);
	/** The row drawn at this place (counted from 1) of a list of `rows`. */
	const placed = (rows: LedgerRow[], place: number): LedgerRow =>
		rows[rows.length - place] as LedgerRow;
	const list = (rows: LedgerRow[], over: Partial<ListProps> = {}): string =>
		renderToStaticMarkup(
			createElement(AuditTable, {
				rows,
				total: rows.length,
				phase: "loaded",
				chain: "broken",
				selected: null,
				onOpen: () => {},
				onClearFilters: () => {},
				...over,
			}),
		);
	const count = (html: string, needle: string): number => html.split(needle).length - 1;
	/** The opening tag of a record's row: where its attributes are. */
	const tagOf = (html: string, r: LedgerRow): string =>
		new RegExp(`<div[^>]*id="ut-row-${r.hash}"[^>]*>`).exec(html)?.[0] ?? "";
	const one = (r: LedgerRow, over: Partial<ListRowProps> = {}): string =>
		renderToStaticMarkup(
			createElement(AuditRow, {
				row: r,
				index: 0,
				setSize: 1,
				active: false,
				selected: false,
				fresh: false,
				top: 0,
				...over,
			}),
		);
	const words = (html: string): string => html.replace(/<[^>]*>/g, " ");

	it("draws only the rows near the screen, each at its place among all the records", () => {
		const html = list(many(400));
		const drawn = count(html, 'role="option"');
		// Until the list is measured it draws for a screen of twenty rows, and six more past its edge.
		expect(drawn).toBe(20 + 6);
		expect(count(html, 'aria-setsize="400"')).toBe(drawn);
		expect(html).toContain('aria-posinset="1"');
		expect(html).not.toContain(`aria-posinset="${drawn + 1}"`);
		// The newest record is first.
		expect(html.indexOf(`ut-row-${placed(many(400), 1).hash}`)).toBeLessThan(
			html.indexOf(`ut-row-${placed(many(400), 2).hash}`),
		);
		// The rows stand in one block as tall as every record at 30px, each moved down to its own place.
		expect(html).toContain('<div class="ut-lg-rows" style="height:12000px">');
		expect(tagOf(html, placed(many(400), 1))).toContain('style="transform:translateY(0px)"');
		expect(tagOf(html, placed(many(400), 2))).toContain('style="transform:translateY(30px)"');
		expect(tagOf(html, placed(many(400), 3))).toContain('style="transform:translateY(60px)"');
		// A hundred thousand records draw no more rows than four hundred do.
		const vast = list(many(100_000));
		expect(count(vast, 'role="option"')).toBe(drawn);
		expect(count(vast, 'aria-setsize="100000"')).toBe(drawn);
		expect(vast).toContain('<div class="ut-lg-rows" style="height:3000000px">');
	});

	it("filters that leave nothing say how many records they hide", () => {
		const none = list([], { total: 7 });
		expect(none).not.toContain('role="option"');
		expect(none).toContain("<b>Nothing matches these filters</b>7 records are hidden");
		expect(list([], { total: 1 })).toContain(
			"<b>Nothing matches these filters</b>1 record is hidden",
		);
		expect(list([], { total: 1_234 })).toContain("1,234 records are hidden");
		// The count is of the records hidden. The message is drawn only when no record is left, so this is read
		// in the source: the two cannot differ on screen.
		expect(src).toContain("hidden={props.total - count}");
	});

	it("a record that has just arrived carries the mark that lights it, and no other row does", () => {
		const r = row();
		expect(one(r, { fresh: true })).toMatch(/^<div[^>]*class="ut-row ut-lg-row fresh"/);
		expect(one(r, { fresh: true, selected: true, active: true })).toMatch(
			/^<div[^>]*class="ut-row ut-lg-row sel act fresh"/,
		);
		expect(one(r)).not.toContain("fresh");
	});

	it("a short list draws every record", () => {
		for (const n of [1, 2, 5]) {
			const html = list(many(n));
			expect(count(html, 'role="option"'), String(n)).toBe(n);
			expect(html, String(n)).toContain(`style="height:${n * 30}px"`);
		}
	});

	it("an open record among the rows drawn is selected and named as the active row; one far away is not drawn", () => {
		const rows = many(400);
		const open = placed(rows, 3);
		const html = list(rows, { selected: open.hash });
		expect(count(html, 'aria-selected="true"')).toBe(1);
		expect(tagOf(html, open)).toContain('aria-selected="true"');
		expect(tagOf(html, open)).toContain('aria-posinset="3"');
		expect(tagOf(html, open)).toContain("ut-row ut-lg-row sel act");
		expect(html).toContain(`aria-activedescendant="ut-row-${open.hash}"`);
		// A record far down the list is not in the page, so the list names no active row and draws no more rows.
		const far = list(rows, { selected: placed(rows, 300).hash });
		expect(count(far, 'role="option"')).toBe(count(html, 'role="option"'));
		expect(far).not.toContain('aria-selected="true"');
		expect(far).not.toContain("aria-activedescendant");
		expect(tagOf(far, placed(rows, 300))).toBe("");
	});

	/** Five calls twenty minutes apart from midnight: positions 0 to 2 in the first hour, 3 and 4 in the second. */
	const spaced = (): LedgerRow[] =>
		many(5).map((r, i) => ({ ...r, ts: new Date(T0 + i * 20 * 60_000).toISOString() }));
	const marked = (html: string, rows: LedgerRow[], attr: string): number[] =>
		rows.filter((r) => tagOf(html, r).includes(`${attr}="true"`)).map((r) => r.pos);

	it("the pinned record is marked, and only it; the records of its hour carry the hour's mark", () => {
		const rows = spaced();
		const html = list(rows, { pinnedPos: 1 });
		expect(marked(html, rows, "data-pinned")).toEqual([1]);
		expect(marked(html, rows, "data-hour")).toEqual([0, 1, 2]);
		expect(marked(list(rows, { pinnedPos: 4 }), rows, "data-hour")).toEqual([3, 4]);
		// Nothing pinned, or a position the list does not hold: no mark of either kind.
		for (const pinnedPos of [null, 9_999]) {
			expect(list(rows, { pinnedPos })).not.toMatch(/data-pinned|data-hour/);
		}
		expect(list(rows)).not.toMatch(/data-pinned|data-hour/);
		// A pinned record whose time cannot be read is marked alone.
		const odd = rows.map((r) => (r.pos === 1 ? { ...r, ts: "not a time" } : r));
		const alone = list(odd, { pinnedPos: 1 });
		expect(marked(alone, odd, "data-pinned")).toEqual([1]);
		expect(alone).not.toContain("data-hour");
		// The hour a chart points at is marked in place of the pinned record's own hour.
		const pointed = list(rows, { pinnedPos: 1, hourSpan: [T0 + 3_600_000, T0 + 7_200_000] });
		expect(marked(pointed, rows, "data-pinned")).toEqual([1]);
		expect(marked(pointed, rows, "data-hour")).toEqual([3, 4]);
	});

	it("marks the records of the hour a chart points at: from its start, up to its end and not at it", () => {
		const rows = many(5);
		const from = placed(rows, 4);
		const until = placed(rows, 1);
		const html = list(rows, { hourSpan: [Date.parse(from.ts), Date.parse(until.ts)] });
		expect(count(html, "data-hour")).toBe(3);
		for (const place of [2, 3, 4]) {
			expect(tagOf(html, placed(rows, place)), String(place)).toContain('data-hour="true"');
		}
		expect(tagOf(html, until)).not.toContain("data-hour");
		expect(tagOf(html, placed(rows, 5))).not.toContain("data-hour");
		expect(list(rows, { hourSpan: null })).not.toContain("data-hour");
		expect(list(rows)).not.toContain("data-hour");
	});

	it("a row is one line of seven cells, and carries its time for the pointer", () => {
		const r = row({ model: "claude-sonnet-4-6", actor: "agent:1234567890" });
		const html = one(r);
		expect(html).toMatch(/^<div[^>]*class="ut-row ut-lg-row"/);
		// Its place in the list's one tall block.
		expect(html).toMatch(/^<div[^>]*style="transform:translateY\(0px\)"/);
		expect(one(r, { top: 2_999_970 })).toMatch(
			/^<div[^>]*style="transform:translateY\(2999970px\)"/,
		);
		expect(html).toContain(`data-ms="${Date.parse(r.ts)}"`);
		const cells = [...html.matchAll(/<span class="(ut-lg-[a-z])"/g)].map((m) => m[1]);
		expect(cells).toEqual([
			"ut-lg-t",
			"ut-lg-m",
			"ut-lg-a",
			"ut-lg-k",
			"ut-lg-u",
			"ut-lg-s",
			"ut-lg-c",
		]);
		expect(html).toContain(`<span class="ut-lg-t" title="${r.ts}">10-12 17:59:02Z</span>`);
		// The kind's cell is narrow: a long kind is cut, and its title says it whole.
		expect(html).toContain('<span class="ut-lg-k" title="llm_call">llm_call</span>');
		expect(one(row({ kind: "settlement_unrecoverable" }))).toContain(
			'<span class="ut-lg-k" title="settlement_unrecoverable">settlement_unrecoverable</span>',
		);
		expect(html).toMatch(/<span class="ut-lg-a" title="actor agent:1234567890">agent . 12345678</);
		// The two-line body is gone from the list.
		expect(html).not.toContain("ut-meta");
		expect(html).not.toContain("ut-rtitle");
		// A time that cannot be read gives the pointer nothing.
		expect(one(row({ ts: "not a time" }))).not.toContain("data-ms");
		// Neither mark unless it is asked for, and each on its own.
		expect(html).not.toMatch(/data-hour|data-pinned/);
		expect(one(r, { hour: true })).toMatch(/data-hour="true"/);
		expect(one(r, { hour: true })).not.toContain("data-pinned");
		expect(one(r, { pinned: true })).toMatch(/data-pinned="true"/);
		expect(one(r, { pinned: true })).not.toContain("data-hour");
		expect(one(r, { hour: false, pinned: false })).not.toMatch(/data-hour|data-pinned/);
	});

	it("filled, a row has nine cells: the Transaction and the Hash after the kind, and says so", () => {
		const ELLIPSIS = String.fromCharCode(0x2026);
		const r = row({ transferId: "0000abcd" });
		const html = one(r, { full: true });
		expect(html).toMatch(/^<div[^>]*data-full="true"/);
		// The row's own cells as they are, with the two new ones right after the kind and nowhere else.
		const cellsOf = (h: string): string[] =>
			[...h.matchAll(/<span class="(ut-lg-[a-z])"/g)].map((m) => m[1] as string);
		const plainCells = cellsOf(one(r));
		const k = plainCells.indexOf("ut-lg-k");
		expect(k).toBeGreaterThanOrEqual(0);
		expect(cellsOf(html)).toEqual([
			...plainCells.slice(0, k + 1),
			"ut-lg-x",
			"ut-lg-h",
			...plainCells.slice(k + 1),
		]);
		expect(html).toContain('<span class="ut-lg-x" title="transfer 0000abcd">0000abcd</span>');
		expect(html).toContain(
			`<span class="ut-lg-h" title="hash ${r.hash}">${r.hash.slice(0, 10)}${ELLIPSIS}</span>`,
		);
		// No transfer: the dash, and a title that says there is none.
		expect(one(row(), { full: true })).toContain(
			`<span class="ut-lg-x" title="no transfer">${DASH}</span>`,
		);
		expect(html).not.toMatch(/verified/i);
		// Not filled, neither cell and no mark.
		for (const plain of [one(r), one(r, { full: false })]) {
			expect(plain).not.toMatch(/ut-lg-x|ut-lg-h|data-full/);
		}
		// The list hands it to every row it draws, however many that is.
		const rows = many(3);
		const filled = list(rows, { full: true });
		const drawn = count(filled, 'role="option"');
		expect(drawn).toBeGreaterThan(0);
		expect(count(filled, 'data-full="true"')).toBe(drawn);
		expect(count(filled, 'class="ut-lg-x"')).toBe(drawn);
		expect(count(filled, 'class="ut-lg-h"')).toBe(drawn);
		expect(list(rows)).not.toMatch(/ut-lg-x|ut-lg-h|data-full/);
	});

	it("the model has a short dash in its provider's colour, muted for a provider it cannot name", () => {
		const dash = (r: LedgerRow): string =>
			/<i class="ut-lg-dash" style="([^"]*)"/.exec(one(r))?.[1] ?? "";
		expect(dash(row({ model: "claude-sonnet-4-6" }))).toBe("background:#BE804D");
		expect(dash(row({ model: "gpt-5" }))).toBe("background:#5D6775");
		expect(dash(row({ model: "some-other-model" }))).toBe("background:#8A877F");
		const { model: _model, ...bare } = row();
		expect(dash(bare)).toBe("background:#8A877F");
		// The cell's title: the model with its provider, the model alone for a provider it cannot name, and
		// "no model" for a record that has none.
		const title = (r: LedgerRow): string =>
			/<span class="ut-lg-m" title="([^"]*)"/.exec(one(r))?.[1] ?? "";
		expect(title(row({ model: "claude-sonnet-4-6" }))).toBe("claude-sonnet-4-6, Anthropic");
		expect(title(row({ model: "some-other-model" }))).toBe("some-other-model");
		expect(title(bare)).toBe("llm_call, no model");
		// The kind may be cut short where it stands in the model's cell: the title has all of it.
		expect(title({ ...bare, kind: "hold_released" })).toBe("hold_released, no model");
		// With no model the cell shows the long dash, not an empty cell (and its kind, where the sheet says so).
		expect(one(bare)).toContain(`<span class="ut-lg-name">${DASH}</span>`);
		expect(one(row({ model: "gpt-5" }))).toContain('<span class="ut-lg-name">gpt-5</span>');
	});

	it("a cost that rests on estimated usage says est. in the cost cell; an exact cost carries no mark", () => {
		// The usage cell says it too, and a narrow list drops that cell: the sheet shows this mark exactly there.
		const est = one(row({ costUt: 3_800, usageSource: "estimated" }));
		expect(est).toContain(
			'<span class="ut-lg-c"><span class="ut-lg-est" title="This cost rests on estimated usage">est.</span><span class="ut-amt">$0.3800</span></span>',
		);
		expect(est.match(/ut-lg-est/g)).toHaveLength(1);
		expect(one(row({ costUt: 3_800, usageSource: "provider" }))).not.toContain("ut-lg-est");
		const { usageSource: _source, ...unsaid } = row({ costUt: 3_800 });
		expect(one(unsaid)).not.toContain("ut-lg-est");
		// No cost, no mark: there is no figure for it to qualify.
		const { costUt: _cost, ...bare } = row({ usageSource: "estimated" });
		expect(one(bare)).toContain(`<span class="ut-lg-c"><span class="ut-amt">${DASH}</span></span>`);
		expect(src).toContain("{cost?.estimated === true && (");
	});

	it("a record with no model carries its kind in the model cell, for the widths that drop the kind's own cell", () => {
		const { model: _model, ...bare } = row({ kind: "policy_denied" });
		expect(one(bare)).toContain(
			`<span class="ut-lg-kin">policy_denied</span><span class="ut-lg-name">${DASH}</span>`,
		);
		// A record with a model is named by it at every width: no second name.
		expect(one(row({ model: "gpt-5", kind: "llm_call" }))).not.toContain("ut-lg-kin");
	});

	it("the cost is in dollars, with nothing drawn behind it; no cost is a dash, never $0", () => {
		const html = one(row({ costUt: 3_800 }));
		expect(html).toContain('<span class="ut-lg-c"><span class="ut-amt">$0.3800</span></span>');
		const { costUt: _cost, ...bare } = row();
		const none = one(bare);
		expect(none).toContain(`<span class="ut-lg-c"><span class="ut-amt">${DASH}</span></span>`);
		expect(none).not.toContain("$");
		expect(list(many(5))).not.toContain("ut-lg-bar");
		expect(src).not.toMatch(/ut-lg-bar|maxCost/);
	});

	it("says how the usage was measured: reported, est., or a dash when the record does not say", () => {
		const usage = (r: LedgerRow): string =>
			/<span class="ut-lg-u"[^>]*>[^<]*</.exec(one(r))?.[0] ?? "";
		expect(usage(row())).toBe(
			'<span class="ut-lg-u" title="usage as the provider reported it">reported<',
		);
		expect(usage(row({ usageSource: "estimated" }))).toBe(
			'<span class="ut-lg-u" title="This cost rests on estimated usage">est.<',
		);
		const { usageSource: _source, ...bare } = row();
		expect(usage(bare)).toBe(`<span class="ut-lg-u" title="source not recorded">${DASH}<`);
	});

	it("an unconfirmed outcome reads 'unresolved' in the badge and in the row's name", () => {
		const html = one(row({ status: "ambiguous" }));
		expect(html).toMatch(
			/<span class="ut-badge" data-tone="info" title="the outcome isn&#x27;t confirmed yet"><i aria-hidden="true"><\/i>unresolved<\/span>/,
		);
		expect(words(html)).not.toMatch(/ambiguous|\bheld\b/);
		expect(html).not.toMatch(/ambiguous|\bheld\b/);
		expect(html).toMatch(/aria-label="[^"]*, unresolved"/);
		const settled = one(row());
		expect(settled).toMatch(/<span class="ut-badge"><i aria-hidden="true"><\/i>settled<\/span>/);
		expect(settled).not.toContain("confirmed yet");
		expect(settled).toMatch(/aria-label="[^"]*, settled"/);
		expect(one(row({ status: "failed" }))).toMatch(
			/<span class="ut-badge" data-tone="stakes"><i aria-hidden="true"><\/i>failed<\/span>/,
		);
	});

	it("a record after a break in the chain keeps its mark, after the badge", () => {
		const mark = String.fromCharCode(0x26a0);
		const html = one(row({ integrity: "after-break" }));
		expect(html).toContain(`<span class="bad" title="after a break in the chain">${mark}</span>`);
		expect(html.indexOf(mark)).toBeGreaterThan(html.indexOf("ut-badge"));
		expect(one(row())).not.toContain(mark);
		expect(one(row())).not.toContain('class="bad"');
	});

	const src = appFile("audit-table.tsx");
	const between = (from: string, to: string): string => {
		const a = src.indexOf(from);
		const b = src.indexOf(to, a);
		return a < 0 || b < 0 ? "" : src.slice(a, b);
	};

	it("draws a window of rows over one tall block: the list never grows, and watches no mark", () => {
		expect(src).toContain(
			'import { useVirtualizer, useWindowVirtualizer } from "@tanstack/react-virtual";',
		);
		// Every row is one height, so none is measured: the block is the row count times 30px.
		expect(DENSE_ROW_PX).toBe(30);
		expect(src).toContain("estimateSize: () => DENSE_ROW_PX");
		expect(src).toContain("style={{ height: virtualizer.getTotalSize() }}");
		expect(src).toContain("top={item.start - virtualizer.options.scrollMargin}");
		expect(src).not.toMatch(/measureElement|measure=|paddingStart|paddingEnd|gap:/);
		// The rows drawn past each edge of the screen: a list 1,400px tall still draws no more than 60 rows.
		expect(src).toContain("overscan: OVERSCAN");
		const over = Number(/const OVERSCAN = (\d+);/.exec(src)?.[1]);
		expect(over).toBeGreaterThanOrEqual(1);
		expect(Math.ceil(1_400 / DENSE_ROW_PX) + 1 + 2 * over).toBeLessThanOrEqual(60);
		for (const gone of [
			"IntersectionObserver",
			"chunkInit",
			"chunkSync",
			"chunkGrow",
			"chunkReveal",
			"shownCount",
			"ut-lg-more",
			"scrollIntoView",
		]) {
			expect(src, gone).not.toContain(gone);
		}
		// On a phone the page is the scroller: the rows follow the window, below the sort bar as it is measured.
		expect(src).toContain("enabled: !phone,");
		expect(src).toContain("enabled: phone,");
		expect(src).toContain("const virtualizer = phone ? inPage : inList;");
		expect(src).toContain("scrollPaddingStart: capH,");
		expect(src).toContain("setCapH(capRef.current?.offsetHeight ?? 0);");
	});

	it("a new sort or a new filter starts again at the top; a record arriving does not", () => {
		expect(src).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a line of the source, quoted as it is written
			'const key = `${props.resetKey ?? ""}|${sortKey}|${desc ? "desc" : "asc"}`;',
		);
		const top = between("const drawnKey = useRef(key);", "}, [key]);");
		expect(top).toContain("if (drawnKey.current === key) return;");
		expect(top).toContain("parentRef.current.scrollTop = 0;");
		// On a phone the page is the scroller and the sort bar sticks over the list: the page is moved so the
		// list's top sits just under the bar, wherever the bar's bottom is measured to be.
		expect(top).toContain("const under = capRef.current?.getBoundingClientRect().bottom ?? 0;");
		expect(top).toContain("const at = parentRef.current.getBoundingClientRect().top;");
		expect(top).toContain("if (at < under) window.scrollBy(0, at - under);");
		expect(src).toContain('<div className="ut-cap" ref={capRef}>');
	});

	it("a move by key, by step or by pin scrolls its row in, and the rows there are drawn", () => {
		expect(src).toMatch(
			/const showRow = \(index: number, align: "auto" \| "center"\): void =>\s*virtualizer\.scrollToIndex\(index, \{ align \}\);/,
		);
		const move = between("const moveTo = (", "const onClick");
		expect(move).toContain("setActiveHash(target.hash);");
		expect(move).toContain('showRow(index, "auto");');
		// The active row is named to assistive technology only while it is drawn.
		expect(src).toContain("items.some((v) => v.index === activeIndex)");
		// A screenful is the rows that fit: on a phone the window's, below the sort bar.
		const keys = between("const onKeyDown = (", "const restore = ");
		expect(keys).toContain("pageSizeForRows(");
		expect(keys).toContain("phone ? window.innerHeight - capH :");
		expect(keys).toContain("nextRowIndex(activeIndex, e.key, count, page)");
	});

	it("the pinned record is centred and made the active row once per pin, and gives the list its hour", () => {
		const pin = between("const pinDone = useRef", "}, [pinnedHash, sorted]);");
		expect(pin).toContain("const act = pinAction(pinDone.current, pinnedHash, sorted);");
		expect(pin).toContain("pinDone.current = act.done;");
		expect(pin).toContain("if (act.target === null) return;");
		expect(pin).toContain("setActiveHash(act.target.hash);");
		expect(pin).toContain('showRow(act.target.index, "center");');
		expect(src).toContain("sorted.findIndex((r) => r.pos === pinnedPos)");
		expect(src).toContain(
			"props.hourSpan ?? (Number.isFinite(pinnedMs) ? hourSpanOf(pinnedMs) : null)",
		);
	});

	it("the open record steps to its neighbour in the order drawn, through the caller's ref", () => {
		const step = between("const step = (", "const sortBy");
		expect(step).toContain("const from = props.selected ?? activeRow?.hash;");
		expect(step).toContain("stepRecord(sorted, from, dir)");
		expect(step).toContain("moveTo(index);");
		expect(step).toContain("props.onOpen(target, true);");
		expect(step).toContain("ref.current = step;");
		expect(step).toContain("ref.current = null;");
		// The active row follows the open record, so the panel's keys and the list's are on the same row.
		expect(src).toMatch(
			/if \(props\.selected !== null\) setActiveHash\(props\.selected\);\s*\}, \[props\.selected\]\);/,
		);
	});

	it("the pointer is read once, on the list: the row under it gives its time, and leaving gives none", () => {
		const hover = between("const hovered = useRef", "const onKeyDown");
		expect(hover).toContain("if (ms === hovered.current) return;");
		expect(hover).toContain("props.onHover?.(ms);");
		expect(hover).toContain('closest<HTMLElement>("[data-ms]")?.dataset.ms');
		expect(hover).toContain("hoverTo(at === undefined ? null : Number(at));");
		expect(hover).toContain("const onPointerLeave = (): void => hoverTo(null);");
		expect(src).toMatch(/onClick,\s*onPointerOver,\s*onPointerLeave,/);
		// A row has no pointer handler of its own, and no hovered state: hover is the sheet's.
		const rowSrc = between("export const AuditRow", "export type { BeforeWindow }");
		expect(rowSrc).not.toMatch(/onPointer|onClick|onMouse|hover/i);
		const click = between("const onClick = (", "const hovered = useRef");
		expect(click).toContain(`closest('[role="option"]')?.id`);
		expect(click).toContain("setActiveHash(target.hash);");
		expect(click).toContain("props.onOpen(target, false);");
	});
});

describe("the record's actions", () => {
	interface Pressed {
		pins: number[];
		filters: FilterState[];
	}
	interface Button {
		text: string;
		onClick(): void;
	}
	const textOf = (node: ReactNode): string =>
		Array.isArray(node)
			? node.map(textOf).join("")
			: typeof node === "string" || typeof node === "number"
				? String(node)
				: "";
	/** The buttons of a returned element, in order, with their text and click handler. */
	const buttonsOf = (node: ReactNode): Button[] => {
		if (Array.isArray(node)) return node.flatMap(buttonsOf);
		if (!isValidElement(node)) return [];
		const p = node.props as { children?: ReactNode; onClick?: () => void };
		if (node.type === "button")
			return [{ text: textOf(p.children), onClick: p.onClick ?? (() => {}) }];
		return buttonsOf(p.children);
	};
	const props = (r: LedgerRow, filters: FilterState = EMPTY_FILTERS) => {
		const pressed: Pressed = { pins: [], filters: [] };
		return {
			pressed,
			props: {
				row: r,
				filters,
				onPin: (pos: number) => pressed.pins.push(pos),
				onFilters: (f: FilterState) => pressed.filters.push(f),
			},
		};
	};
	const markup = (r: LedgerRow): string =>
		renderToStaticMarkup(createElement(PeekActions, props(r).props));
	const press = (r: LedgerRow, text: string, filters: FilterState = EMPTY_FILTERS): Pressed => {
		const { pressed, props: p } = props(r, filters);
		const button = buttonsOf(PeekActions(p)).find((b) => b.text === text);
		expect(button, text).toBeDefined();
		button?.onClick();
		return pressed;
	};

	it("a row of tier-3 buttons: show on the chart, only this lane, only this model", () => {
		expect(markup(row())).toBe(
			'<div class="ut-lg-actions">' +
				'<button type="button" class="ut-t3">Show on chart</button>' +
				'<button type="button" class="ut-t3" aria-pressed="false">Only a</button>' +
				'<button type="button" class="ut-t3" aria-pressed="false">Only m</button>' +
				"</div>",
		);
	});

	it("an Only button is pressed when its value is the facet's only one; Show on chart is not a toggle", () => {
		const pressed = (filters: FilterState): string[] => {
			const html = renderToStaticMarkup(createElement(PeekActions, props(row(), filters).props));
			return [...html.matchAll(/<button([^>]*)>([^<]*)</g)].map(
				([, attrs, text]) => `${text}=${/aria-pressed="(\w+)"/.exec(attrs ?? "")?.[1] ?? "none"}`,
			);
		};
		expect(pressed({ ...EMPTY_FILTERS, actors: ["a"] })).toEqual([
			"Show on chart=none",
			"Only a=true",
			"Only m=false",
		]);
		expect(pressed({ ...EMPTY_FILTERS, models: ["m"] })).toEqual([
			"Show on chart=none",
			"Only a=false",
			"Only m=true",
		]);
		expect(pressed({ ...EMPTY_FILTERS, actors: ["a", "b"], models: ["m", "x"] })).toEqual([
			"Show on chart=none",
			"Only a=false",
			"Only m=false",
		]);
		expect(pressed(EMPTY_FILTERS)).toEqual(["Show on chart=none", "Only a=false", "Only m=false"]);
	});

	it("a record with no model, or an empty one, has no second Only button", () => {
		const { model: _model, ...bare } = row();
		for (const r of [bare, row({ model: "" }), row({ model: "  " })]) {
			const html = markup(r);
			expect(html).toContain(">Show on chart<");
			expect(html).toContain(">Only a<");
			expect(html.match(/>Only/g)).toHaveLength(1);
		}
	});

	it("never a button with an empty name: an empty lane has no Only button", () => {
		const html = markup(row({ actor: "" }));
		expect(html).toContain(">Show on chart<");
		expect(html).not.toMatch(/>Only a</);
		expect(html.match(/>Only/g)).toHaveLength(1);
		expect(html).toContain(">Only m<");
		for (const blank of ["", " "]) {
			const names = buttonsOf(PeekActions(props(row({ actor: blank, model: blank })).props)).map(
				(b) => b.text,
			);
			expect(names, JSON.stringify(blank)).toEqual(["Show on chart"]);
		}
	});

	it("Show on chart pins the record's position, and sets no filter", () => {
		const pressed = press(row({ pos: 42 }), "Show on chart");
		expect(pressed.pins).toEqual([42]);
		expect(pressed.filters).toEqual([]);
	});

	it("Only <lane> keeps that lane alone, and a second press clears it", () => {
		const others = { ...EMPTY_FILTERS, actors: ["b"], models: ["x"] };
		const once = press(row(), "Only a", others);
		expect(once.pins).toEqual([]);
		expect(once.filters).toEqual([{ ...others, actors: ["a"] }]);
		const again = press(row(), "Only a", { ...EMPTY_FILTERS, actors: ["a"] });
		expect(again.filters).toEqual([EMPTY_FILTERS]);
	});

	it("Only <model> keeps that model alone, and leaves the lanes", () => {
		const others = { ...EMPTY_FILTERS, actors: ["b"], models: ["x", "y"] };
		const once = press(row(), "Only m", others);
		expect(once.pins).toEqual([]);
		expect(once.filters).toEqual([{ ...others, models: ["m"] }]);
		const again = press(row(), "Only m", { ...EMPTY_FILTERS, models: ["m"] });
		expect(again.filters).toEqual([EMPTY_FILTERS]);
	});
});

describe("the Ledger window's sheet", () => {
	const css = appFile("windows/ledger/ledger.css").replace(/\/\*[\s\S]*?\*\//g, "");
	/** The declarations of the first rule with this selector. */
	const rule = (selector: string): string => {
		const at = css.indexOf(`${selector} {`);
		return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
	};

	it("the floating panel is near-opaque glass with an 18px blur, and slides in over 220ms", () => {
		const glass = rule(".ut-glass.ut-lg-peek");
		expect(glass).toContain("color-mix(in srgb, var(--dk-raised) 97%, transparent)");
		expect(glass).toMatch(/[^-]backdrop-filter: blur\(18px\)/);
		expect(glass).toContain("animation: ut-lg-peek-in 0.22s cubic-bezier(0.16, 0.84, 0.3, 1) both");
		expect(css).toMatch(/@keyframes ut-lg-peek-in\s*\{\s*from\s*\{[^}]*translateX\(24px\)/);
		const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
		expect(reduced).toMatch(/\.ut-glass\.ut-lg-peek\s*\{\s*animation: none/);
		expect(rule('.ut-lg-peek[data-held="true"] > .ut-insp-in')).toContain("opacity: 0.55");
	});

	it("every new class has a rule, the figures are right-aligned and tabular, and no colour is written out", () => {
		const names =
			"lg-charge lg-sums lg-part lg-src lg-extra lg-unusual lg-share lg-peek chainnote lg-actions";
		for (const name of names.split(" ")) {
			expect(css, name).toMatch(new RegExp(`\\.ut-${name}[^{}]*\\{`));
		}
		expect(rule(".ut-lg-sums td")).toContain("text-align: right");
		expect(rule(".ut-lg-sums td")).toContain("font-variant-numeric: tabular-nums");
		expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
	});

	/** The body of the first `@container (max-width: <px>px)` block. */
	const narrow = (px: number): string => {
		const head = `@container (max-width: ${px}px) {`;
		const at = css.indexOf(head);
		if (at < 0) return "";
		let depth = 1;
		let i = at + head.length;
		while (i < css.length && depth > 0) {
			if (css[i] === "{") depth++;
			if (css[i] === "}") depth--;
			i++;
		}
		return css.slice(at + head.length, i - 1);
	};
	const ruleIn = (block: string, selector: string): string => {
		const at = block.indexOf(`${selector} {`);
		return at < 0 ? "" : block.slice(at, block.indexOf("}", at));
	};

	it("a dense row is 30px on one line of seven columns, placed in the list's one block", () => {
		const dense = rule(".ut-row.ut-lg-row");
		expect(dense).toContain(
			"grid-template-columns: 118px minmax(0, 1.3fr) minmax(0, 1fr) 64px 60px 116px minmax(96px, 0.9fr);",
		);
		expect(dense).toContain("height: 30px;");
		expect(dense).toContain("box-sizing: border-box;");
		// Each row is placed by the list (it moves the row down to its place), 8px in from either side.
		for (const decl of ["position: absolute;", "top: 0;", "left: 8px;", "right: 8px;"]) {
			expect(dense).toContain(decl);
		}
		expect(rule(".ut-lg-rows")).toContain("position: relative;");
		expect(css).not.toMatch(/content-visibility|contain-intrinsic-size|ut-lg-more/);
		expect(dense).toContain("padding: 0 12px;");
		expect(dense).toContain("border-radius: 0;");
		// The hairline under a row is not drawn on the open record, whose border is its own.
		expect(rule(".ut-row.ut-lg-row:not(.sel)")).toContain(
			"border-bottom-color: color-mix(in srgb, var(--dk-text) 5%, transparent);",
		);
		const cell = rule(".ut-lg-row > span");
		for (const decl of ["min-width: 0;", "overflow: hidden;", "text-overflow: ellipsis;"]) {
			expect(cell).toContain(decl);
		}
		expect(cell).toContain("white-space: nowrap;");
	});

	it("the time and the kind are in the figure face; the cost is right-aligned and tabular, with no bar", () => {
		expect(rule(".ut-lg-row .ut-lg-t,\n\t.ut-lg-row .ut-lg-k")).toContain(
			"font-family: var(--fig);",
		);
		expect(rule(".ut-lg-row .ut-lg-c")).toContain("text-align: right;");
		const amount = rule(".ut-lg-c .ut-amt");
		expect(amount).toContain("font: 600 12px var(--fig);");
		expect(amount).toContain("font-variant-numeric: tabular-nums;");
		expect(css).not.toContain("ut-lg-bar");
		const dash = rule(".ut-lg-dash");
		for (const decl of ["flex: none;", "width: 10px;", "height: 2px;"])
			expect(dash).toContain(decl);
		// The dash has no colour in the sheet: each row gives it its provider's.
		expect(dash).not.toMatch(/background|color/);
		expect(rule(".ut-lg-row .ut-lg-m")).toContain("display: flex;");
		expect(rule(".ut-lg-name")).toContain("text-overflow: ellipsis;");
	});

	it("the badge may be cut short in its cell; the mark after a break never is", () => {
		expect(rule(".ut-lg-row .ut-lg-s")).toContain("display: flex;");
		const badge = rule(".ut-lg-s .ut-badge");
		expect(badge).toContain("min-width: 0;");
		expect(badge).toContain("flex: 0 1 auto;");
		// A capsule in the figure face, 16px tall, gold on a gold wash; a status that is a warning keeps its own colour.
		for (const decl of ["height: 16px;", "padding: 0 4px;", "border-radius: 8px;"]) {
			expect(badge).toContain(decl);
		}
		expect(badge).toContain("background: color-mix(in srgb, var(--accent) 16%, transparent);");
		expect(badge).toContain("color: var(--accent);");
		expect(badge).toContain("font: 600 10px/16px var(--fig);");
		expect(rule('.ut-lg-s .ut-badge[data-tone="alert"]')).toContain("color: var(--alert);");
		expect(rule('.ut-lg-s .ut-badge[data-tone="stakes"]')).toContain("color: var(--stakes);");
		expect(css.indexOf('.ut-lg-s .ut-badge[data-tone="alert"] {')).toBeGreaterThan(
			css.indexOf(".ut-lg-s .ut-badge {"),
		);
		// The status column holds the longest status word whole: its letters (6px each at 10px in the figure face,
		// spaced 1.2px), the dot and its gap (6px each) and the capsule's padding (4px a side).
		const statuses =
			"settled released failed denied ambiguous ungoverned unrecoverable info unknown";
		const longest = Math.max(...statuses.split(" ").map((s) => statusWord(s as RowStatus).length));
		expect(longest).toBe("unrecoverable".length);
		const column = Number(/64px 60px (\d+)px minmax\(96px/.exec(rule(".ut-row.ut-lg-row"))?.[1]);
		expect(column).toBeGreaterThanOrEqual(longest * (6 + 1.2) + 6 + 6 + 2 * 4);
		expect(column).toBeLessThan(120);
		const bad = rule(".ut-lg-s .bad");
		expect(bad).toContain("flex: none;");
		expect(bad).toContain("color: var(--stakes);");
	});

	it("a hovered row lights alone; the hour's rows carry a 5% tint and a 2px gold bar, the pinned record 10% and 3px", () => {
		const hover = rule(".ut-row.ut-lg-row:not(.sel):hover");
		expect(hover).toContain("background: color-mix(in srgb, var(--dk-text) 6%, transparent);");
		// No selector with :hover reaches a sibling or a row beside it.
		for (const m of css.matchAll(/([^{}]*ut-lg-row[^{}]*:hover[^{}]*)\{/g)) {
			expect(m[1]).not.toMatch(/[~+]/);
			expect((m[1] as string).trim().split(/\s+/)).toHaveLength(1);
		}
		// The bar is the row's own; the tint is painted by a layer under the row's cells, not as the row's
		// background: a record that has just arrived is lit by an animation of its background, which would
		// hold the tint off for good.
		const hour = rule('.ut-row.ut-lg-row[data-hour="true"]');
		expect(hour).toContain("box-shadow: inset 2px 0 0 var(--dk-gold);");
		expect(hour).not.toContain("background");
		const pinned = rule('.ut-row.ut-lg-row[data-pinned="true"]');
		expect(pinned).toContain("box-shadow: inset 3px 0 0 var(--dk-gold);");
		expect(pinned).not.toContain("background");
		const layer = rule(
			'.ut-row.ut-lg-row[data-hour="true"]::before,\n\t.ut-row.ut-lg-row[data-pinned="true"]::before',
		);
		for (const decl of [
			'content: "";',
			"position: absolute;",
			"inset: 0;",
			"z-index: -1;",
			"border-radius: inherit;",
			"pointer-events: none;",
		]) {
			expect(layer, decl).toContain(decl);
		}
		// Under the cells and over the row's own background: the row is its own stacking context.
		expect(rule(".ut-row.ut-lg-row")).toContain("isolation: isolate;");
		// Each tint is a rule of its own, after the rule the two share (which ends in the pinned record's selector).
		const hourTint = '\n\n\t.ut-row.ut-lg-row[data-hour="true"]::before';
		const pinnedTint = '\n\n\t.ut-row.ut-lg-row[data-pinned="true"]::before';
		expect(rule(hourTint)).toContain(
			"background: color-mix(in srgb, var(--dk-gold) 5%, transparent);",
		);
		expect(rule(pinnedTint)).toContain(
			"background: color-mix(in srgb, var(--dk-gold) 10%, transparent);",
		);
		// A record that is both pinned and in the hour reads as pinned; a hovered one lights too.
		expect(css.indexOf('[data-pinned="true"] {')).toBeGreaterThan(
			css.indexOf('[data-hour="true"] {'),
		);
		expect(css.indexOf(`${hourTint} {`)).toBeGreaterThan(0);
		expect(css.indexOf(`${pinnedTint} {`)).toBeGreaterThan(css.indexOf(`${hourTint} {`));
		expect(css.indexOf(":not(.sel):hover {")).toBeGreaterThan(
			css.indexOf('[data-pinned="true"] {'),
		);
	});

	it("a narrower list drops columns, never squeezes them: the kind and the usage, then the actor", () => {
		// All seven columns stay down to a 600px list: a 1000px screen gives the list 640px.
		expect(narrow(680)).toBe("");
		expect(css.match(/@container \(max-width: \d+px\)/g)).toEqual([
			// A filled list made narrow by the docked panel drops its Transaction and Hash (the filled-columns test below).
			"@container (max-width: 900px)",
			// The docked panel's own block (the test below it).
			"@container (max-width: 800px)",
			"@container (max-width: 600px)",
			"@container (max-width: 520px)",
		]);
		const five = narrow(600);
		expect(ruleIn(five, ".ut-row.ut-lg-row")).toContain(
			"grid-template-columns: 118px minmax(0, 1.3fr) minmax(0, 1fr) 116px minmax(104px, max-content);",
		);
		// The cost cell holds "est." and a figure in the thousands (102px), and grows for a longer one: the model and
		// the lane give the room.
		expect(102).toBeLessThanOrEqual(104);
		expect(ruleIn(five, ".ut-lg-row .ut-lg-k,\n\t\t.ut-lg-row .ut-lg-u")).toContain(
			"display: none;",
		);
		const four = narrow(520);
		const dense = ruleIn(four, ".ut-row.ut-lg-row");
		// The cost cell holds "est." and a figure under ten dollars (73px) in one column down the list; a longer figure
		// widens its own row's cell, and the model gives the room.
		expect(dense).toContain(
			"grid-template-columns: 102px minmax(0, 1fr) 80px minmax(76px, max-content);",
		);
		// The capsule is tighter there, so a ten-letter status ("unresolved") fits its 80px whole.
		const tight = ruleIn(four, ".ut-lg-s .ut-badge");
		expect(tight).toContain("gap: 4px;");
		expect(tight).toContain("letter-spacing: 0;");
		expect(10 * 6 + 6 + 4 + 2 * 4).toBeLessThanOrEqual(80);
		expect(dense).toContain("gap: 6px;");
		expect(dense).toContain("padding: 0 6px;");
		expect(ruleIn(four, ".ut-lg-row .ut-lg-a")).toContain("display: none;");
		expect(ruleIn(four, ".ut-lg-row .ut-lg-t")).toContain("font-size: 11px;");
		expect(dense).toContain("left: 2px;");
		expect(dense).toContain("right: 2px;");
		// The narrowest row's fixed columns, gaps and padding leave the model room at 340px: nothing scrolls sideways.
		const fixed = 102 + 80 + 76 + 3 * 6 + 2 * 6 + 2 * 2;
		expect(340 - fixed).toBeGreaterThanOrEqual(48);
		// A row keeps its height at every width.
		expect(`${five}${four}`).not.toMatch(/[^-]height:|white-space/);
		// Where a row scrolled to stops under the phone's sort bar is the list's to measure: no figure for it here.
		expect(css).not.toContain("scroll-margin");
	});

	it("what a dropped cell alone said moves to a cell that stays: est. beside the cost, the kind of a record with no model", () => {
		// Hidden while the usage cell and the kind cell are there, so no row says either thing twice.
		const mark = rule(".ut-lg-row .ut-lg-est");
		for (const decl of [
			"display: none;",
			"margin-right: 4px;",
			"color: var(--info);",
			"font: 600 10px/1 var(--sans);",
		]) {
			expect(mark, decl).toContain(decl);
		}
		const kin = rule(".ut-lg-m .ut-lg-kin");
		for (const decl of [
			"display: none;",
			"min-width: 0;",
			"overflow: hidden;",
			"text-overflow: ellipsis;",
			"color: var(--dk-label);",
			"font-family: var(--fig);",
		]) {
			expect(kin, decl).toContain(decl);
		}
		// Shown from the width that drops those two cells, and so at every narrower one.
		const five = narrow(600);
		expect(ruleIn(five, ".ut-lg-row .ut-lg-est")).toContain("display: inline;");
		expect(ruleIn(five, ".ut-lg-m .ut-lg-kin")).toContain("display: block;");
		// The kind takes the place of the dash that stood for no model.
		expect(ruleIn(five, ".ut-lg-m .ut-lg-kin + .ut-lg-name")).toContain("display: none;");
		expect(five).toContain(".ut-lg-row .ut-lg-k,\n\t\t.ut-lg-row .ut-lg-u {");
		// Nowhere else: the base rule that hides each, the show in that block, and the show in the docked panel's
		// block (the test of its own), where the same two cells are dropped. All after the rules that hide them.
		expect(css.match(/\.ut-lg-row \.ut-lg-est \{/g)).toHaveLength(3);
		expect(css.match(/\.ut-lg-m \.ut-lg-kin \{/g)).toHaveLength(3);
		const tier = css.indexOf("@container (max-width: 600px)");
		expect(css.indexOf(".ut-lg-row .ut-lg-est {")).toBeLessThan(tier);
		expect(css.indexOf(".ut-lg-m .ut-lg-kin {")).toBeLessThan(tier);
		expect(narrow(520)).not.toMatch(/ut-lg-est|ut-lg-kin/);
	});

	it("the record's actions sit in one wrapping row", () => {
		const actions = rule(".ut-lg-actions");
		expect(actions).toContain("display: flex");
		expect(actions).toContain("flex-wrap: wrap");
		expect(actions).toMatch(/gap: \d+px/);
	});

	/** The body of the first block that opens with `head` (an at-rule's prelude), braces balanced. */
	const blockOf = (head: string, from = 0): string => {
		const at = css.indexOf(`${head} {`, from);
		if (at < 0) return "";
		let depth = 1;
		let i = at + head.length + 2;
		const start = i;
		while (i < css.length && depth > 0) {
			if (css[i] === "{") depth++;
			if (css[i] === "}") depth--;
			i++;
		}
		return css.slice(start, i - 1);
	};
	/** Every block that opens with `head`, joined. */
	const blocksOf = (head: string): string => {
		const out: string[] = [];
		for (let at = css.indexOf(`${head} {`); at >= 0; at = css.indexOf(`${head} {`, at + 1)) {
			out.push(blockOf(head, at));
		}
		return out.join("\n");
	};
	/** The numbers of one declaration (`inset: -3px -1px` gives [-3, -1]); none when it is absent. */
	const px = (decls: string, prop: string): number[] => {
		const value = new RegExp(`(?:^|[\\s;{])${prop}: ([^;]+);`).exec(decls)?.[1];
		return value === undefined ? [] : value.trim().split(/\s+/).map(Number.parseFloat);
	};

	it("starts its rules inside the components layer", () => {
		expect(css.trim().startsWith("@layer components {")).toBe(true);
		expect(css.trim().endsWith("}")).toBe(true);
	});

	it("filled, a row is nine columns, Transaction and Hash between the kind and the usage, still 30px", () => {
		const full = rule('[data-win="ledger"] .ut-lg-row[data-full="true"]');
		expect(full).toContain(
			"grid-template-columns: 118px minmax(0, 1.2fr) minmax(0, 1fr) 64px 100px 104px 60px 92px minmax(96px, 0.8fr);",
		);
		expect(full).not.toMatch(/[^-]height:/);
		// The two cells are muted figures, as the time and the kind are.
		const ids = rule(".ut-lg-row .ut-lg-x,\n\t.ut-lg-row .ut-lg-h");
		expect(ids).toContain("font-family: var(--fig);");
		expect(ids).toContain("color: var(--dk-label);");
		expect(ids).toContain("font-variant-numeric: tabular-nums;");
		// A list made narrow by the docked panel drops the two cells first, then the rest as an unfilled list does.
		const docked = narrow(900);
		expect(ruleIn(docked, '[data-win="ledger"] .ut-lg-row[data-full="true"]')).toContain(
			"grid-template-columns: 118px minmax(0, 1.3fr) minmax(0, 1fr) 64px 60px 92px minmax(96px, 0.9fr);",
		);
		expect(ruleIn(docked, ".ut-lg-row .ut-lg-x,\n\t\t.ut-lg-row .ut-lg-h")).toContain(
			"display: none;",
		);
		expect(ruleIn(narrow(600), '[data-win="ledger"] .ut-lg-row[data-full="true"]')).toContain(
			"grid-template-columns: 118px minmax(0, 1.3fr) minmax(0, 1fr) 92px minmax(96px, 0.9fr);",
		);
		expect(ruleIn(narrow(520), '[data-win="ledger"] .ut-lg-row[data-full="true"]')).toContain(
			"grid-template-columns: 102px minmax(0, 1fr) 76px 70px;",
		);
	});

	it("docked, the list drops the kind, the usage and the actor so the model keeps its whole name", () => {
		const docked = narrow(800);
		const body = '.ut-lg-body[data-detail="true"]';
		const gridRule = ruleIn(
			docked,
			`${body} .ut-row.ut-lg-row,\n\t\t[data-win="ledger"] ${body} .ut-lg-row[data-full="true"]`,
		);
		expect(gridRule).toContain(
			"grid-template-columns: 118px minmax(0, 1fr) 116px minmax(104px, max-content);",
		);
		expect(
			ruleIn(
				docked,
				`${body} .ut-lg-row .ut-lg-k,\n\t\t${body} .ut-lg-row .ut-lg-u,\n\t\t${body} .ut-lg-row .ut-lg-a`,
			),
		).toContain("display: none;");
		// What the dropped usage and kind cells said moves to cells that stay, as in the 600px block.
		expect(ruleIn(docked, `${body} .ut-lg-row .ut-lg-est`)).toContain("display: inline;");
		expect(ruleIn(docked, `${body} .ut-lg-m .ut-lg-kin`)).toContain("display: block;");
		// Only while the panel is docked: an undocked list keeps its seven columns above 600px.
		expect(docked.replace(/\s+/g, " ")).not.toMatch(/(^|[,}] )\.ut-row\.ut-lg-row \{/);
		// The model's whole name is not cut at 1050px with the panel open. Measured in Chrome (1000, 1050, 1100 and
		// 1200px, a fixture vault): the docked list is the screen minus 444px, its row 18px narrower, and the longest
		// model ("claude-sonnet-5-5") needs 108px, its dash 10px and the gap 7px. This is the arithmetic of those
		// measurements: the model's cell is what the row leaves after its padding, its three gaps and the other columns.
		const NAME = 108 + 10 + 7;
		// The other columns' widths are read from the sheet itself, so a wider one fails here.
		const others = [...gridRule.matchAll(/(\d+)px/g)].reduce((sum, m) => sum + Number(m[1]), 0);
		expect(others).toBe(118 + 116 + 104);
		const modelCell = (screen: number): number => screen - 444 - 18 - 24 - 3 * 10 - others;
		expect(modelCell(1000)).toBe(146);
		expect(modelCell(1050)).toBe(196);
		for (const screen of [1000, 1050, 1100, 1200, 1244]) {
			expect(modelCell(screen), `${screen}px`).toBeGreaterThanOrEqual(NAME);
		}
		// 1245px is a 801px list: the block ends at 800px, and the seven columns give the model 148px there (measured).
		expect(1245 - 444).toBeGreaterThan(800);
	});

	it("the open row's ring is the list's one ring: the list's own is transparent while that row is drawn", () => {
		const own = rule('[data-win="ledger"] .ut-list:focus-visible:has(.ut-row.act)');
		expect(own).toContain("outline-color: transparent;");
		// Transparent, not removed: the desk-tokens guard forbids `outline: none`, and forced colours draw it.
		expect(own).not.toMatch(/outline:\s*(none|0)/);
	});

	it("filled, the record docks in a second column that opens to 400px over .26s, and is 0 wide with nothing open", () => {
		const fill = rule('.ut-lg-body[data-fill="ledger"]');
		expect(fill).toContain("display: grid;");
		expect(fill).toContain("grid-template-columns: minmax(0, 1fr) 0px;");
		expect(fill).toContain("column-gap: 0;");
		expect(fill).toContain("grid-template-columns 0.26s cubic-bezier(0.16, 0.84, 0.3, 1)");
		expect(fill).toContain("column-gap 0.26s cubic-bezier(0.16, 0.84, 0.3, 1)");
		const open = rule('.ut-lg-body[data-fill="ledger"][data-detail="true"]');
		expect(open).toContain("grid-template-columns: minmax(0, 1fr) 400px;");
		expect(open).toContain("column-gap: 10px;");
		const panel = rule('.ut-lg-body[data-fill="ledger"] > .ut-insp');
		expect(panel).toContain("min-width: 0;");
		// Cut sideways while its column opens, and still a scroller downwards: never `overflow: hidden`.
		expect(panel).toContain("overflow-x: hidden;");
		expect(panel).not.toMatch(/[^-]overflow: hidden|overflow-y: hidden/);
		// The panel over the list is placed against the window's body.
		expect(rule(".ut-lg-body")).toContain("position: relative;");
		const glass = rule(".ut-glass.ut-lg-peek");
		for (const d of ["top: 8px;", "right: 8px;", "bottom: 8px;", "width: min(400px, 86%);"]) {
			expect(glass).toContain(d);
		}
	});

	it("below the desk's width (999px) either panel is a bottom sheet", () => {
		const compact = blockOf("@media (max-width: 999px)");
		for (const sel of [".ut-glass.ut-lg-peek", '.ut-lg-body[data-fill="ledger"] > .ut-insp']) {
			const sheet = ruleIn(compact, sel);
			expect(sheet, sel).toContain("position: fixed;");
			expect(sheet, sel).toContain("inset: auto 0 0 0;");
			expect(sheet, sel).toContain("max-height: 80dvh;");
			// Over the page's other windows, which the floating panel's own 20 is not.
			expect(px(sheet, "z-index"), sel).toEqual([40]);
		}
		// The glass sheet spans the screen, not the floating panel's width, and is rounded only at its top.
		const glass = ruleIn(compact, ".ut-glass.ut-lg-peek");
		expect(glass).toContain("width: auto;");
		expect(glass).toContain("border-radius: var(--dk-radius) var(--dk-radius) 0 0;");
	});

	it("one fade on the data container when the filters or the range change, and no motion when it is reduced", () => {
		const fade = "0.22s cubic-bezier(0.16, 0.84, 0.3, 1)";
		expect(rule('.ut-lg-body[data-gen="a"]')).toContain(`animation: ut-lg-gen-a ${fade};`);
		expect(rule('.ut-lg-body[data-gen="b"]')).toContain(`animation: ut-lg-gen-b ${fade};`);
		for (const name of ["ut-lg-gen-a", "ut-lg-gen-b"]) {
			expect(css).toMatch(
				new RegExp(`@keyframes ${name}\\s*\\{\\s*from\\s*\\{\\s*opacity: 0\\.55;`),
			);
		}
		// On the container only: no row, cell or panel is animated by it, and nothing in the sheet runs on a resize.
		const gens = [...css.matchAll(/([^{}]*)\{[^{}]*ut-lg-gen-[ab][^{}]*\}/g)].map((m) =>
			(m[1] ?? "").trim(),
		);
		expect(gens).toEqual(['.ut-lg-body[data-gen="a"]', '.ut-lg-body[data-gen="b"]']);
		expect(css).not.toMatch(/ut-lg-row[^{}]*\{[^{}]*animation/);
		// Reduced motion, by the system or by the page's own switch: no fade, no slide, no column transition.
		for (const reduced of [
			blocksOf("@media (prefers-reduced-motion: reduce)"),
			rule(
				':root[data-motion="reduced"] .ut-lg-body,\n\t:root[data-motion="reduced"] .ut-glass.ut-lg-peek',
			),
		]) {
			expect(reduced).toMatch(/animation: none/);
		}
		const media = blocksOf("@media (prefers-reduced-motion: reduce)");
		// As specific as the rules it cancels, and after them.
		const still = ruleIn(media, '.ut-lg-body[data-gen],\n\t\t.ut-lg-body[data-fill="ledger"]');
		expect(still).toContain("animation: none;");
		expect(still).toContain("transition: none;");
		expect(ruleIn(media, ".ut-glass.ut-lg-peek")).toContain("animation: none;");
		expect(
			rule(
				':root[data-motion="reduced"] .ut-lg-body,\n\t:root[data-motion="reduced"] .ut-glass.ut-lg-peek',
			),
		).toContain("transition: none;");
	});

	it("the record's buttons are tier 3: 28px tall in desk tokens, with a hit area of 32px, 44px on a phone", () => {
		const t3 = rule('[data-win="ledger"] .ut-t3');
		expect(t3).toContain("height: 28px;");
		expect(t3).toContain("box-sizing: border-box;");
		expect(t3).toContain("position: relative;");
		expect(t3).toContain("color: var(--dk-legend);");
		expect(t3).toContain("font: 500 12.5px/1 var(--sans);");
		// The height the button computes to: the border box the sheet gives it, whatever its label.
		const border = px(t3, "border")[0] ?? 0;
		expect(px(t3, "height")).toEqual([28]);
		const hit = rule('[data-win="ledger"] .ut-t3::after');
		expect(hit).toContain('content: "";');
		expect(hit).toContain("position: absolute;");
		expect(hit).not.toMatch(/background|border|color|shadow|outline/);
		const reach = (decls: string): number => -(px(decls, "inset")[0] ?? 0);
		const phone = ruleIn(blockOf("@media (max-width: 760px)"), '[data-win="ledger"] .ut-t3::after');
		expect(28 - 2 * border + 2 * reach(hit)).toBeGreaterThanOrEqual(32);
		expect(28 - 2 * border + 2 * reach(phone)).toBeGreaterThanOrEqual(44);
		// Two rows of buttons keep their areas apart: each reaches past its edge by less than half the row gap.
		const rowGap = (decls: string): number =>
			px(decls, "row-gap")[0] ?? px(decls, "gap")[0] ?? Number.NaN;
		expect(2 * (reach(hit) - border)).toBeLessThanOrEqual(rowGap(rule(".ut-lg-actions")));
		expect(2 * (reach(phone) - border)).toBeLessThanOrEqual(
			rowGap(ruleIn(blockOf("@media (max-width: 760px)"), ".ut-lg-actions")),
		);
		// Sideways the area stays within the button.
		expect(-(px(hit, "inset")[1] ?? 0)).toBeLessThanOrEqual(border);
		expect(-(px(phone, "inset")[1] ?? 0)).toBeLessThanOrEqual(border);
		const hover = rule('[data-win="ledger"] .ut-t3:hover');
		expect(hover).toContain("background: var(--dk-hover);");
		expect(hover).toContain("color: var(--dk-text);");
		// The rest of the button's shape: a centred one-line label, its padding and its corners, and a short ease.
		for (const decl of [
			"display: inline-flex;",
			"align-items: center;",
			"padding: 0 9px;",
			"border-radius: 7px;",
			"white-space: nowrap;",
			"background-color 0.12s ease,",
			"\tcolor 0.12s ease,",
			"border-color 0.12s ease;",
		]) {
			expect(t3, decl).toContain(decl);
		}
	});

	it("an Only button that is pressed looks pressed, in gold, over its hover", () => {
		const pressed = rule('[data-win="ledger"] .ut-t3[aria-pressed="true"]');
		expect(pressed).toContain("color: var(--dk-gold);");
		expect(pressed).toContain("background: color-mix(in srgb, var(--dk-gold) 10%, transparent);");
		expect(pressed).toContain("border-color: color-mix(in srgb, var(--dk-gold) 45%, transparent);");
		expect(css.indexOf('[data-win="ledger"] .ut-t3[aria-pressed="true"] {')).toBeGreaterThan(
			css.indexOf('[data-win="ledger"] .ut-t3:hover {'),
		);
		// A resting button is not gold.
		expect(rule('[data-win="ledger"] .ut-t3')).not.toContain("--dk-gold");
	});
});

describe("the Ledger window's wiring", () => {
	const src = appFile("windows/ledger/ledger-window.tsx");

	it("imports no sheet and reads no screen query", () => {
		expect(src).not.toMatch(/import\s+["'][^"']+\.css["']/);
		expect(src).not.toMatch(/matchMedia|useMedia|DOCK_QUERY|InspectorHint/);
	});

	it("feeds the list the open record, the pin, the hour, the reset key and the filled columns", () => {
		expect(src).toContain("selected={openHash}");
		expect(src).toContain("pinnedPos={resolvedPin(at, resolvedPos)}");
		expect(src).toContain("hourSpan={hourSpan}");
		expect(src).toContain("full={filled}");
		expect(src).toContain("stepRef={stepRef}");
		expect(src).toContain("onHover={onHover}");
		expect(src).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a line of the source, quoted as it is written
			'const resetKey = `${JSON.stringify(filters)}|${list.at?.pos ?? "live"}`;',
		);
		// A chart's hover first, else the pin's hour from the header's position.
		expect(src).toMatch(
			/\(\) => hover\?\.span \?\? \(pinMs === null \? null : hourSpanOf\(pinMs\)\),\s*\[hover, pinMs\],/,
		);
		expect(src).toContain('useHoverMoment("ledger")');
		expect(src).toContain("const pinAt = shown === null ? Number.NaN : Date.parse(shown.ts);");
		expect(src).toContain("const pinMs = Number.isFinite(pinAt) ? pinAt : null;");
	});

	it("publishes the hovered record's hour as the Ledger's, and nothing once it leaves or the window goes", () => {
		expect(src).toContain('setHoverMoment({ ms, span: hourSpanOf(ms), from: "ledger" });');
		expect(
			src.match(/setHoverMoment\(\{ ms: null, span: null, from: "ledger" \}\);/g),
		).toHaveLength(2);
		// Leaving says nothing unless a record was said, so a pointer moving over gaps does not clear another window's
		// hover; a record said is remembered before it is published.
		expect(src).toMatch(
			/if \(ms === null\) \{\s*if \(!published\.current\) return;\s*published\.current = false;\s*setHoverMoment\(\{ ms: null, span: null, from: "ledger" \}\);\s*return;\s*\}\s*published\.current = true;\s*setHoverMoment\(\{ ms, span: hourSpanOf\(ms\), from: "ledger" \}\);/,
		);
		// The effect's cleanup, from its comment to its empty list of dependencies.
		const from = src.indexOf("// Unmounted");
		const unmount = src.slice(from, src.indexOf("[],", from));
		expect(from).toBeGreaterThan(0);
		expect(unmount).toMatch(
			/\(\) => \(\) => \{\s*if \(published\.current\) setHoverMoment\(\{ ms: null, span: null, from: "ledger" \}\);\s*\},\s*$/,
		);
	});

	it("the panel steps through the list's order, and gets the record's lines and actions", () => {
		expect(src).toMatch(
			/const step = useCallback\(\(dir: -1 \| 1\) => stepRef\.current\?\.\(dir\), \[\]\);/,
		);
		expect(src).toContain("rows={list.shownRows}");
		expect(src).toContain("budget={budgetOf(summary, shown)}");
		expect(src).toContain("onPin={setAt}");
		expect(src).toContain("onFilters={setFilters}");
		expect(src).toContain("filters={filters}");
	});

	it("the fade's generation moves only when the filters or the range change", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a line of the source, quoted as it is written
		expect(src).toContain("const fadeOn = `${JSON.stringify(filters)}|${range}`;");
		expect(src).toContain("if (fade.on !== fadeOn) setFade({ on: fadeOn, n: fade.n + 1 });");
		expect(src).toContain('data-gen={fade.n === 0 ? undefined : fade.n % 2 === 1 ? "a" : "b"}');
	});
});
