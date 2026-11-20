// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Ledger window as the desk draws it: the dense list, the record panel floating over it in glass (or docked beside
 * it when the Ledger fills the desk), and the hour marked from a chart's hover or from the pin. Rendered to static
 * markup inside the desk's contexts, so what is asserted is what a reader sees.
 */

import { createElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AtPayload } from "../src/shared/api.js";
import { EMPTY_FILTERS } from "../src/shared/filters.js";
import { momentBus } from "../src/shared/hover-bus.js";
import { listView } from "../src/shared/list-view.js";
import type { LedgerRow } from "../src/shared/rows.js";
import { appExport, dayOneSummary, loadedData } from "./helpers/day-one.js";
import { type WithDeskOptions, withDesk } from "./helpers/desk.js";

let LedgerWindow: React.ComponentType;

beforeAll(async () => {
	LedgerWindow = await appExport("windows/ledger/ledger-window", "LedgerWindow");
});

// The list asks whether it is on a phone (window.matchMedia) as it first renders; there is no browser here, so the
// answer is stubbed: not a phone.
beforeEach(() => {
	vi.stubGlobal("window", {
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	});
});

afterEach(() => {
	momentBus.set(null);
	vi.unstubAllGlobals();
});

const T0 = Date.parse("2026-11-07T00:00:00.000Z");
const RATES = { inputPer1k: 30, outputPer1k: 150, cacheReadPer1k: 3, cacheWritePer1k: 37.5 };

/** `n` priced calls `stepMin` minutes apart from midnight, oldest first; the list draws the newest first. */
function many(n: number, stepMin = 1): LedgerRow[] {
	return Array.from({ length: n }, (_, i) => ({
		seq: i,
		pos: i,
		id: `id-${i}`,
		ts: new Date(T0 + i * stepMin * 60_000).toISOString(),
		kind: "llm_call",
		actor: "a",
		model: "m",
		hash: `${i}`.padStart(64, "c"),
		previousHash: "0".repeat(64),
		integrity: "verified" as const,
		status: "settled" as const,
		costUt: 115,
		usageSource: "provider" as const,
		usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 },
		appliedRates: RATES,
		pricingTableVersion: "2026-11-02",
		...(i % 2 === 0 ? { transferId: `t${i}` } : {}),
	}));
}

function data(rows: LedgerRow[]): NonNullable<WithDeskOptions["data"]> {
	const summary = dayOneSummary(
		rows.length === 0
			? {
					rowCount: 0,
					chain: { events: 0, valid: true, empty: true, breakIndex: null, errors: [] },
				}
			: {},
	);
	return loadedData({
		rows,
		head: rows.length - 1,
		list: listView({ rows, at: null, filters: EMPTY_FILTERS, phase: "loaded", summary }),
	});
}

const draw = (o: WithDeskOptions): Promise<string> => withDesk(createElement(LedgerWindow), o);

const count = (html: string, needle: string): number => html.split(needle).length - 1;
/** The opening tag of a record's row. */
const tagOf = (html: string, r: LedgerRow): string =>
	new RegExp(`<div[^>]*id="ut-row-${r.hash}"[^>]*>`).exec(html)?.[0] ?? "";
/** The opening tag of the window's data container. */
const bodyTag = (html: string): string => /<div class="ut-lg-body"[^>]*>/.exec(html)?.[0] ?? "";

describe("the Ledger window", () => {
	it("draws the list in a labelled window, and no panel while nothing is open", async () => {
		const html = await draw({ data: data(many(40)) });
		expect(html).toMatch(/<section[^>]*data-win="ledger"/);
		expect(html).toContain('aria-label="Ledger"');
		expect(count(html, 'role="option"')).toBeGreaterThan(0);
		expect(html).not.toContain("ut-lg-peek");
		expect(html).not.toContain("<aside");
		expect(html).not.toContain("Select a record");
		expect(html).not.toContain("ut-insp-hint");
	});

	it("an open record floats over the list in glass, with its chain line, its arithmetic, its lines and its actions", async () => {
		const rows = many(400);
		const open = rows[399] as LedgerRow;
		const html = await draw({ data: data(rows), view: { openHash: open.hash } });
		expect(html).toContain('<aside class="ut-lg-peek ut-glass"');
		expect(html).toContain("Tamper-evident chain intact through this record");
		expect(html).toContain('data-fig="ledger.panel-cost">115 UT<');
		expect(html).toContain("Recorded cost");
		expect(html).not.toMatch(/\bCharged\b/);
		// The lines under the status read the budget from the summary while live.
		expect(html).toMatch(/<p class="ut-lg-share">0\.01\d% of the budget\. <span class="prov">/);
		expect(html).toContain("Budget: from the vault config.");
		// The actions, one row of small buttons.
		expect(html).toContain('<div class="ut-lg-actions">');
		expect(html).toContain(">Show on chart<");
		expect(html).toContain(">Only a<");
		expect(html).toContain(">Only m<");
		// Not the docked column, not a modal and no hint.
		expect(bodyTag(html)).not.toContain("data-fill");
		expect(html).not.toContain('class="ut-insp"');
		expect(html).not.toContain("ut-drawer");
		expect(html).not.toContain('aria-modal="true"');
		expect(html).not.toContain("ut-scrim");
		expect(html).not.toContain("Select a record");
		// Not filled: the rows carry no Transaction or Hash cells.
		expect(html).not.toContain("ut-lg-x");
		expect(html).not.toContain('data-full="true"');
	});

	it("filled with a record open: the panel is docked in the second column, solid, and the rows carry Transaction and Hash", async () => {
		const rows = many(40);
		const open = rows[39] as LedgerRow;
		const html = await draw({ data: data(rows), fill: "ledger", view: { openHash: open.hash } });
		const body = bodyTag(html);
		expect(body).toContain('data-fill="ledger"');
		expect(body).toContain('data-detail="true"');
		expect(html).toContain('<aside class="ut-insp"');
		expect(html).not.toContain("ut-lg-peek");
		expect(html).not.toContain("ut-glass");
		// The docked panel keeps the record's lines and actions, and has no chain line of its own.
		expect(html).toContain(">Show on chart<");
		expect(html).toContain("% of the budget");
		expect(html).not.toContain("ut-chainnote");
		// The list draws the rows near the screen (not all 40); each one it draws carries the two cells.
		const drawn = count(html, 'role="option"');
		expect(drawn).toBeGreaterThan(0);
		expect(count(html, 'data-full="true"')).toBe(drawn);
		expect(count(html, 'class="ut-lg-x"')).toBe(drawn);
		expect(html).not.toContain("ut-insp-hint");
		expect(html).not.toContain("Select a record");
	});

	it("filled with nothing open: the second column is empty, with no panel and no hint", async () => {
		const html = await draw({ data: data(many(40)), fill: "ledger" });
		const body = bodyTag(html);
		expect(body).toContain('data-fill="ledger"');
		expect(body).toContain('data-detail="false"');
		expect(html).not.toContain("<aside");
		expect(html).not.toContain("Select a record");
	});

	it("red-first (an inert window still listening for keys): while another window fills the desk, the open record draws no panel", async () => {
		const rows = many(40);
		const open = rows[39] as LedgerRow;
		for (const other of ["spend", "share", "now"] as const) {
			const html = await draw({ data: data(rows), fill: other, view: { openHash: open.hash } });
			expect(html, other).toContain("data-dim");
			expect(html, other).not.toContain("<aside");
			expect(html, other).not.toContain('aria-modal="true"');
		}
	});

	it("an empty vault shows the first-run text, not a blank window", async () => {
		for (const fill of [null, "ledger"] as const) {
			const html = await draw({ data: data([]), fill });
			expect(html, String(fill)).toContain("No governed calls yet");
			expect(html, String(fill)).not.toContain("<aside");
		}
	});
});

describe("the hour the Ledger marks", () => {
	// Every 10 minutes from midnight, four hours of it: 02:00, 02:10 ... 02:50 are the six records of 02:00 UTC. The
	// list draws only the rows near the screen (about 26), so the whole set is drawn.
	const rows = many(24, 10);
	const inHour = (r: LedgerRow): boolean => r.ts >= "2026-11-07T02:" && r.ts < "2026-11-07T03:";
	const pinned = rows.find((r) => r.ts === "2026-11-07T02:20:00.000Z") as LedgerRow;
	const shown = { pos: pinned.pos, ts: "2026-11-07T02:20:00Z" } as unknown as AtPayload;
	const marked = (html: string): string[] =>
		rows.filter((r) => tagOf(html, r).includes('data-hour="true"')).map((r) => r.ts);

	it("with a pin and no hover, the pin's UTC hour, and only it", async () => {
		const html = await draw({ data: { ...data(rows), headAt: shown }, view: { at: pinned.pos } });
		expect(marked(html)).toEqual(rows.filter(inHour).map((r) => r.ts));
		expect(marked(html)).toHaveLength(6);
		expect(tagOf(html, pinned)).toContain('data-pinned="true"');
		expect(count(html, "data-pinned")).toBe(1);
	});

	it("an address past the vault's end is answered with the head: the head's record is the one pinned, as on the chart", async () => {
		const head = rows[rows.length - 1] as LedgerRow;
		const headAt = { pos: head.pos, ts: head.ts } as unknown as AtPayload;
		const past = await draw({
			data: { ...data(rows), headAt, resolvedPos: head.pos },
			view: { at: 9_999 },
		});
		expect(tagOf(past, head)).toContain('data-pinned="true"');
		expect(count(past, "data-pinned")).toBe(1);
		expect(tagOf(past, head)).toContain('data-hour="true"');
		// An answer held from before, with nothing pinned now, marks no record as pinned.
		const stale = await draw({ data: { ...data(rows), resolvedPos: head.pos } });
		expect(stale).not.toContain("data-pinned");
	});

	it("a chart's hover takes over from the pin: only its span is marked", async () => {
		const from = Date.parse("2026-11-07T03:00:00.000Z");
		momentBus.set({ ms: from + 60_000, span: [from, from + 3_600_000], from: "spend" });
		const html = await draw({ data: { ...data(rows), headAt: shown }, view: { at: pinned.pos } });
		expect(marked(html)).toEqual(
			rows.filter((r) => r.ts >= "2026-11-07T03:" && r.ts < "2026-11-07T04:").map((r) => r.ts),
		);
	});

	it("the Ledger's own hover marks nothing: the pin's hour stays, and with no pin no hour", async () => {
		const from = Date.parse("2026-11-07T03:00:00.000Z");
		momentBus.set({ ms: from + 60_000, span: [from, from + 3_600_000], from: "ledger" });
		const pinnedHtml = await draw({
			data: { ...data(rows), headAt: shown },
			view: { at: pinned.pos },
		});
		expect(marked(pinnedHtml)).toEqual(rows.filter(inHour).map((r) => r.ts));
		const live = await draw({ data: data(rows) });
		expect(live).not.toContain("data-hour");
		expect(live).not.toContain("data-pinned");
	});
});
