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
import { describe, expect, it } from "vitest";
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
	return toLedgerRows(events, { valid: true, breakIndex: null });
}
const noop = () => {};
const tabStops = (html: string) => [...html.matchAll(/tabindex="(-?\d+)"/gi)].map((m) => m[1]);

describe("the audit list is one tab stop", () => {
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
		expect(src).toContain(`document.querySelector('button[aria-expanded="true"]') !== null`);
		expect(src).toContain('addEventListener("keydown", onKey, true)');
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
		expect(src).toMatch(/<span className="ut-label" role="status">\s*\{count\}/);
	});
});
