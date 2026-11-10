// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * What the record panel shows about one charge: each tier's tokens, rate and product, the sum beside the charged
 * cost, and the lines the Ledger window adds under the status. Rendered to static markup, so what is asserted is
 * what a reader sees.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { budgetOf } from "../src/shared/peek.js";
import type { LedgerRow } from "../src/shared/rows.js";

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
beforeAll(async () => {
	ChargeTable = await load("windows/ledger/charge-table", "ChargeTable");
	PeekExtra = await load("windows/ledger/peek-extra", "PeekExtra");
	RowPanel = await load("row-panel", "RowPanel");
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
			"Sum 3 UT. Recorded 4 UT: the cost was computed in floating point, came out a hair above 3, and costs round up.",
		);
		expect(html).not.toMatch(/Charged|the charge was|charges round up/);
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
			"Sum 3 UT. Recorded 4 UT: the cost was computed in floating point, came out a hair above 3, and costs round up.",
		);
		expect(residue).not.toMatch(/Charged|the charge was|charges round up/);
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
		const names = "lg-charge lg-sums lg-part lg-src lg-extra lg-unusual lg-share lg-peek chainnote";
		for (const name of names.split(" ")) {
			expect(css, name).toMatch(new RegExp(`\\.ut-${name}[^{}]*\\{`));
		}
		expect(rule(".ut-lg-sums td")).toContain("text-align: right");
		expect(rule(".ut-lg-sums td")).toContain("font-variant-numeric: tabular-nums");
		expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
	});
});
