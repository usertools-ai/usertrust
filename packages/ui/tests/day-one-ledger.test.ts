// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Ledger on day one is today's list and today's record panel. Filled at a wide window, the panel docks beside the
 * list (or a hint takes its place); otherwise the open record opens as the drawer. PR 5 renames this file and rewrites
 * its cases when the window gets its own panel.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerRow } from "../src/shared/rows.js";
import { appExport, type Component, dayOneRows, loadedData, noIds } from "./helpers/day-one.js";
import { withDesk } from "./helpers/desk.js";

type TableProps = {
	rows: LedgerRow[];
	total: number;
	phase: "loading" | "loaded";
	chain: unknown;
	beforeWindow: unknown;
	liveIds: Set<string>;
	selected: string | null;
	restoreFocus: null;
	onOpen(): void;
	onClearFilters(): void;
};

let LedgerWindow: React.ComponentType;
let AuditTable: Component<TableProps>;

beforeAll(async () => {
	LedgerWindow = await appExport("windows/ledger/ledger-window", "LedgerWindow");
	AuditTable = await appExport("audit-table", "AuditTable");
});

// The list asks whether it is on a phone (window.matchMedia) as it first renders; there is no browser here, so the
// answer is stubbed: not a phone. (The dock width is read through a server snapshot that says wide.)
beforeEach(() => {
	vi.stubGlobal("window", {
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the Ledger on day one", () => {
	it("holds the list for the same props", async () => {
		const data = loadedData();
		const list = data.list;
		if (list === undefined) throw new Error("fixture");
		const html = await withDesk(createElement(LedgerWindow), { data });
		const table = renderToStaticMarkup(
			createElement(AuditTable, {
				rows: list.filtered,
				total: list.total,
				phase: list.phase as "loaded",
				chain: list.chain,
				beforeWindow: list.beforeWindow,
				liveIds: new Set<string>(),
				selected: null,
				restoreFocus: null,
				onOpen: () => undefined,
				onClearFilters: () => undefined,
			}),
		);
		expect(table.length).toBeGreaterThan(0);
		expect(noIds(html)).toContain(noIds(table));
		expect(html).toContain('aria-label="Ledger"');
	});

	it("filled with a record open, docks the panel beside the list", async () => {
		const row = dayOneRows()[0] as LedgerRow;
		const html = await withDesk(createElement(LedgerWindow), {
			data: loadedData(),
			fill: "ledger",
			view: { openHash: row.hash },
		});
		expect(html).toContain('<aside class="ut-insp"');
		expect(html).not.toContain("ut-drawer");
		expect(html).toContain('data-docked="true"');
	});

	it("not filled, opens the record as the drawer", async () => {
		const row = dayOneRows()[0] as LedgerRow;
		const html = await withDesk(createElement(LedgerWindow), {
			data: loadedData(),
			fill: null,
			view: { openHash: row.hash },
		});
		expect(html).toContain("ut-drawer");
		expect(html).not.toContain('<aside class="ut-insp"');
		expect(html).not.toContain('data-docked="true"');
	});

	it("red-first (an invisible modal holding the keyboard): while another window fills the desk, the open record draws no drawer", async () => {
		const row = dayOneRows()[0] as LedgerRow;
		for (const other of ["spend", "share", "now"] as const) {
			const html = await withDesk(createElement(LedgerWindow), {
				data: loadedData(),
				fill: other,
				view: { openHash: row.hash },
			});
			// The Ledger is inert then: a modal in it could take no focus, and its Tab handler held the keyboard. The record
			// stays in the address, and its drawer opens when the Ledger shows again (the test above).
			expect(html, other).toContain("data-dim");
			expect(html, other).not.toContain("ut-drawer");
			expect(html, other).not.toContain('aria-modal="true"');
		}
	});

	it("filled with nothing open, shows the hint where the panel will be", async () => {
		const html = await withDesk(createElement(LedgerWindow), {
			data: loadedData(),
			fill: "ledger",
		});
		expect(html).toContain("Select a record");
		expect(html).toContain('<aside class="ut-insp"');
	});

	it("filled but empty, docks nothing: the list takes the width", async () => {
		const html = await withDesk(createElement(LedgerWindow), { fill: "ledger" });
		expect(html).not.toContain("Select a record");
		expect(html).not.toContain('data-docked="true"');
	});
});
