// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The views drawn from the list's input, while that is held (the moment after a new position lands): the inspector,
 * Export and the facets are marked, dimmed and busy, like the list, and the inspector never presents the position's
 * status as the one the header names.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { AtPayload } from "../src/shared/api.js";
import { EMPTY_FILTERS, type FilterState } from "../src/shared/filters.js";
import type { LedgerRow } from "../src/shared/rows.js";

// The components are .tsx, which the tests' typecheck (no jsx) cannot import statically: load them by a computed
// path, typed here by what these tests pass.
type Component<P> = (props: P) => React.JSX.Element;
async function load<P>(file: string, name: string): Promise<Component<P>> {
	const mod = (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as Record<
		string,
		Component<P>
	>;
	return mod[name] as Component<P>;
}

let RowPanel: Component<{ row: LedgerRow; docked: boolean; held?: boolean; onClose(): void }>;
let ExportButton: Component<{
	count: number;
	at: AtPayload | null;
	newestOf: number | undefined;
	held: boolean;
	onExport(): void;
}>;
let FilterBar: Component<{
	rows: never[];
	filters: FilterState;
	held?: boolean;
	onChange(): void;
}>;
beforeAll(async () => {
	RowPanel = await load("row-panel", "RowPanel");
	ExportButton = await load("export-button", "ExportButton");
	FilterBar = await load("filter-bar", "FilterBar");
});

const row: LedgerRow = {
	seq: 7,
	pos: 7,
	id: "id-7",
	ts: "2026-10-12T17:59:02.770Z",
	kind: "llm_call",
	actor: "local",
	hash: "7".padStart(64, "0"),
	previousHash: "0".repeat(64),
	integrity: "verified",
	status: "settled",
};

const panel = (docked: boolean, held: boolean): string =>
	renderToStaticMarkup(createElement(RowPanel, { row, docked, held, onClose: () => {} }));

describe("the inspector while the list is held", () => {
	it("is marked, docked or as a drawer: dimmed and busy", () => {
		expect(panel(true, true)).toMatch(
			/<aside[^>]*class="ut-insp"[^>]*data-held="true"[^>]*aria-busy="true"/,
		);
		expect(panel(false, true)).toMatch(
			/<aside[^>]*class="ut-drawer"[^>]*data-held="true"[^>]*aria-busy="true"/,
		);
	});

	it("does not present the held row's status as the position's: it reads updating", () => {
		const held = panel(true, true);
		expect(held).toContain("updating…");
		expect(held).not.toMatch(/<span class="ut-pill"[^>]*><i><\/i>settled<\/span>/);
		// Unheld, it is the row's own status, unmarked.
		const live = panel(true, false);
		expect(live).toMatch(/<span class="ut-pill"[^>]*><i><\/i>settled<\/span>/);
		expect(live).not.toContain("updating…");
		expect(live).toMatch(/data-held="false"/);
		expect(live).toMatch(/aria-busy="false"/);
	});
});

describe("Export while the list is held", () => {
	const button = (held: boolean): string =>
		renderToStaticMarkup(
			createElement(ExportButton, {
				count: 12,
				at: null,
				newestOf: undefined,
				held,
				onExport: () => {},
			}),
		);

	it("is marked: dimmed and busy", () => {
		expect(button(true)).toMatch(
			/<button[^>]*data-held="true"[^>]*aria-busy="true"[^>]*>Export 12 rows/,
		);
		expect(button(false)).toMatch(/data-held="false"[^>]*aria-busy="false"/);
	});

	it("names the position it would export, which is the list's", () => {
		const html = renderToStaticMarkup(
			createElement(ExportButton, {
				count: 1,
				at: { pos: 40 } as AtPayload,
				newestOf: undefined,
				held: true,
				onExport: () => {},
			}),
		);
		expect(html).toContain("as recorded at record 41");
		expect(html).toContain("Export 1 row<");
	});
});

describe("Export's title at a past position states its scope", () => {
	const title = (at: Partial<AtPayload>): string => {
		const html = renderToStaticMarkup(
			createElement(ExportButton, {
				count: 5,
				at: at as AtPayload,
				newestOf: 100,
				held: false,
				onExport: () => {},
			}),
		);
		return /title="([^"]*)"/.exec(html)?.[1] ?? "";
	};

	it("a window that starts at the first record adds nothing", () => {
		expect(title({ pos: 40, windowStartPos: 0 })).toBe(
			"Download the records in view as CSV, as recorded at record 41",
		);
	});

	it("a window that starts later says where the list starts, counted from 1 like the record numbers", () => {
		const t = title({ pos: 400, windowStartPos: 250 });
		expect(t).toContain("as recorded at record 401");
		expect(t).toContain("the list holds records from position 251 only");
	});
});

describe("the facets while the list is held", () => {
	it("are marked: the bar is busy, and its facets dimmed", () => {
		const held = renderToStaticMarkup(
			createElement(FilterBar, {
				rows: [],
				filters: EMPTY_FILTERS,
				held: true,
				onChange: () => {},
			}),
		);
		expect(held).toMatch(/class="ut-bar"[^>]*data-held="true"[^>]*aria-busy="true"/);
		const free = renderToStaticMarkup(
			createElement(FilterBar, { rows: [], filters: EMPTY_FILTERS, onChange: () => {} }),
		);
		expect(free).toMatch(/class="ut-bar"[^>]*data-held="false"[^>]*aria-busy="false"/);
	});
});
