// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The audit list is ONE tab stop (a listbox that names its active row), not one per row, and the inspector can be
 * reached from it. There is no DOM here, so this renders the markup with react-dom/server and reads the sources the
 * key handling lives in. The movement itself is row-nav.test.ts.
 */

import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PersistedAuditEvent } from "usertrust";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { popoverOwnsEscape } from "../src/shared/row-nav.js";
import { toLedgerRows } from "../src/shared/rows.js";

// The components are .tsx files, which the tests' tsconfig (no `jsx`) cannot resolve statically: load them by a
// computed path, typed here by what the tests use.
type Row = ReturnType<typeof toLedgerRows>[number];
type TableProps = {
	rows: Row[];
	total: number;
	phase: "loading" | "ready" | "failed";
	chain: "empty" | "ok" | "broken" | null;
	selected: string | null;
	onOpen(row: Row, viaKeyboard: boolean): void;
	onClearFilters(): void;
};
type RowProps = {
	row: Row;
	index: number;
	setSize: number;
	active: boolean;
	selected: boolean;
	fresh: boolean;
	onClick(): void;
};
async function table() {
	const file = "audit-table";
	return (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as {
		AuditTable: (p: TableProps) => React.JSX.Element;
		AuditRow: (p: RowProps) => React.JSX.Element;
	};
}
async function panel() {
	const file = "row-panel";
	return (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as {
		RowPanel: (p: {
			row: Row;
			docked: boolean;
			onClose(returnFocus: boolean): void;
			focusNonce?: number;
		}) => React.JSX.Element;
	};
}
const source = (name: string) => readFile(new URL(`../src/app/${name}`, import.meta.url), "utf8");

function rows(n: number): Row[] {
	const events: PersistedAuditEvent[] = Array.from({ length: n }, (_, i) => ({
		id: `id-${i}`,
		timestamp: "2026-07-27T10:00:00.000Z",
		previousHash: "0".repeat(64),
		hash: `${i}`.padStart(64, "b"),
		kind: "llm_call",
		actor: "local",
		data: { model: "gpt-5", cost: 100 + i },
		sequence: i,
	}));
	return toLedgerRows(events, { valid: true, breakIndex: null }, undefined, 0);
}
const noop = () => {};
const tabStops = (html: string) => [...html.matchAll(/tabindex="(-?\d+)"/gi)].map((m) => m[1]);

describe("the audit list is one tab stop", () => {
	// Since the phone layout, the list asks window.matchMedia whether it is on a phone as it first renders; these tests run
	// without a browser, so the answer is stubbed: a desktop window.
	beforeEach(() => {
		vi.stubGlobal("window", {
			matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});
	it("a list with rows is a named listbox with exactly one tab stop", async () => {
		const { AuditTable } = await table();
		const html = renderToStaticMarkup(
			createElement(AuditTable, {
				rows: rows(60),
				total: 60,
				phase: "ready",
				chain: "ok",
				selected: null,
				onOpen: noop,
				onClearFilters: noop,
			}),
		);
		// mutant: the old list, whose rows were buttons and each a tab stop, had no listbox and no list-level stop
		expect(html).toContain('role="listbox"');
		expect(html).toContain('aria-label="Audit records"');
		expect(tabStops(html)).toEqual(["0"]);
		expect(html).not.toContain('class="ut-row');
	});

	it("an empty list (skeleton, no-rows message) offers no listbox and no tab stop", async () => {
		const { AuditTable } = await table();
		const html = renderToStaticMarkup(
			createElement(AuditTable, {
				rows: [],
				total: 0,
				phase: "loading",
				chain: null,
				selected: null,
				onOpen: noop,
				onClearFilters: noop,
			}),
		);
		expect(html).not.toContain('role="listbox"');
		expect(tabStops(html)).toEqual([]);
	});

	it("a row is an option that is not itself a tab stop, and says its position and its name", async () => {
		const { AuditRow } = await table();
		const list = rows(3);
		const html = list
			.map((row, index) =>
				renderToStaticMarkup(
					createElement(AuditRow, {
						row,
						index,
						setSize: 60,
						active: index === 1,
						selected: index === 2,
						fresh: false,
						onClick: noop,
					}),
				),
			)
			.join("\n");
		expect(tabStops(html)).toEqual([]);
		expect(html.match(/role="option"/g)).toHaveLength(3);
		// only the open row is selected
		expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
		expect(html.match(/aria-selected="false"/g)).toHaveLength(2);
		expect(html).toContain('aria-posinset="2"');
		expect(html).toContain('aria-setsize="60"');
		expect(html).toMatch(/aria-label="gpt-5, 100 UT, \$[\d.]+, 07-27 10:00:00Z, unknown"/);
		// the active row is marked for the focus ring; the others are not
		expect(html.match(/ act"/g)).toHaveLength(1);
	});
});

describe("the inspector takes focus from the list", () => {
	it("its heading is focusable by script (tabindex -1) and not a tab stop", async () => {
		const { RowPanel } = await panel();
		const [row] = rows(1);
		const html = renderToStaticMarkup(
			createElement(RowPanel, { row: row as Row, docked: true, onClose: noop, focusNonce: 1 }),
		);
		expect(html).toMatch(/<h2 tabindex="-1">gpt-5<\/h2>/);
	});

	it("opening with the keyboard moves focus to the heading; Escape hands it back to the row", async () => {
		const src = await source("row-panel.tsx");
		expect(src).toContain("headingRef.current?.focus()");
		// Escape from inside the docked inspector (or from nowhere) returns focus; from the search box it does not
		expect(src).toMatch(/onClose\(docked && inside\)/);
		const app = await source("app.tsx");
		expect(app).toContain("setRestoreFocus");
		const tableSrc = await source("audit-table.tsx");
		expect(tableSrc).toContain("parentRef.current?.focus(");
	});

	it("Escape belongs to an open popover first, in the capture phase, so one key does not do both", async () => {
		const src = await source("row-panel.tsx");
		expect(src).toContain("if (popoverOwnsEscape(document)) return;");
		expect(src).not.toContain(`button[aria-expanded="true"]`);
		expect(src).toContain('addEventListener("keydown", onKey, true)');
	});

	// A page stub: which selectors would match. The real popovers render a `.ut-pop` only while open; the phone's
	// Details and Filters toggles are expanded buttons that render none.
	const page = (...present: string[]) => ({
		querySelector: (sel: string) => (present.includes(sel) ? ({} as Element) : null),
	});

	it("an open filter popover or explainer takes the first Escape: the inspector stays", () => {
		expect(popoverOwnsEscape(page(".ut-pop", 'button[aria-expanded="true"]'))).toBe(true);
	});

	it("red-first (Details open, a record open, Escape did nothing): an expanded toggle that is not a popover does not take Escape, so the inspector closes", () => {
		// The phone's Details disclosure is open (aria-expanded) but shows no popover; Escape must close the inspector.
		expect(popoverOwnsEscape(page('button[aria-expanded="true"]'))).toBe(false);
		expect(popoverOwnsEscape(page())).toBe(false);
	});

	it("the active row is scrolled back into the rendered window when keyboard focus returns, and when it moves while focused", async () => {
		const src = await source("audit-table.tsx");
		// the listbox takes onFocus; keyboard focus (focus-visible) scrolls the active row in, a mouse focus does not
		const onFocus = src.slice(src.indexOf("const onFocus"), src.indexOf("const moveTo"));
		expect(onFocus).toContain(':focus-visible")) virtualizer.scrollToIndex(activeIndex)');
		expect(src).toMatch(/onKeyDown,\s*onFocus,/);
		// while focused, a sort, filter or insert that moves the active row scrolls it in
		expect(src).toMatch(
			/if \(activeRow !== undefined && listFocused\(\)\) virtualizer\.scrollToIndex\(activeIndex\);\s*\}, \[activeIndex, sorted\]\);/,
		);
		// the active row is resolved by hash (see resolveActiveIndex in row-nav.test.ts)
		expect(src).toContain("resolveActiveIndex(sorted, activeHash, props.selected)");
	});

	it("red-first (a keyboard open replayed on remount): the focus request is cleared once handled", async () => {
		// Enter opens a row, Trends and back remounts the inspector: a request still set would take focus from the tab.
		const panel = await source("row-panel.tsx");
		expect(panel).toMatch(/headingRef\.current\?\.focus\(\);\s*onFocusHandled\?\.\(\);/);
		const app = await source("app.tsx");
		expect(app).toContain("onFocusHandled={() => setKbOpen(undefined)}");
	});

	it("PageUp and PageDown move by the measured rows in view, not a fixed row height", async () => {
		const src = await source("audit-table.tsx");
		expect(src).toContain(
			"pageSizeFromItems(virtualizer.getVirtualItems(), el.scrollTop, el.clientHeight)",
		);
		// On a phone the page is the scroller (the list flows in it), so a screenful is the window's, not the list's.
		// ...below the sort bar, which sticks to the top of the window over the rows (its height, capH): a row the keyboard
		// brings into view is placed below the bar, and a screenful counts only the rows below it.
		expect(src).toMatch(
			/phone\s*\?\s*pageSizeFromItems\(\s*virtualizer\.getVirtualItems\(\),\s*window\.scrollY \+ capH,\s*window\.innerHeight - capH,?\s*\)/,
		);
		expect(src).toMatch(/useWindowVirtualizer<Element>\(\{[^}]*scrollPaddingStart: capH/);
		expect(src).toContain('<div className="ut-cap" ref={capRef}>');
		expect(src).not.toContain("ROW_HEIGHT");
	});

	it("moving the active row never opens it: only Enter and Space call onOpen from a key", async () => {
		const src = await source("audit-table.tsx");
		const keys = src.slice(
			src.indexOf("const onKeyDown"),
			src.indexOf("// Focus returns to the list"),
		);
		expect(keys.match(/props\.onOpen\(/g)).toHaveLength(1);
		expect(keys).toMatch(/e\.key === "Enter" \|\| e\.key === " "/);
	});
});

describe("the count is a live region", () => {
	it("the record count in the header is a polite status, so a filter's effect is announced", async () => {
		const src = await source("app.tsx");
		expect(src).toMatch(/<span className="ut-label" role="status"[^>]*>\s*\{count\}/);
	});
});
