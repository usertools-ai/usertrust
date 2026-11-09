// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Spend on day one holds today's chart card and nothing else: the markup is what `Trends part="chart"` draws for the
 * same rows, position and head. PR 3a renames this file and rewrites its cases when the window gets its own chart.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { AtPayload } from "../src/shared/api.js";
import type { LedgerRow } from "../src/shared/rows.js";
import { appExport, type Component, loadedData, noIds } from "./helpers/day-one.js";
import { withDesk } from "./helpers/desk.js";

let SpendWindow: React.ComponentType;
let Trends: Component<{
	rows: LedgerRow[];
	newestOf: number | undefined;
	at?: AtPayload | null;
	head?: number;
	part: "chart";
}>;

beforeAll(async () => {
	SpendWindow = await appExport("windows/spend/spend-window", "SpendWindow");
	Trends = await appExport("trends", "Trends");
});

describe("Spend on day one", () => {
	it("is titled Spend and holds the chart card for the same props", async () => {
		const data = loadedData();
		const html = await withDesk(createElement(SpendWindow), { data });
		const chart = renderToStaticMarkup(
			createElement(Trends, {
				rows: data.list?.filtered ?? [],
				newestOf: undefined,
				at: null,
				head: data.head ?? -1,
				part: "chart",
			}),
		);
		expect(chart).toContain("Cost over time");
		expect(noIds(html)).toContain(noIds(chart));
		expect(html).toContain('aria-label="Spend"');
	});

	it("passes the server's window size when the vault is cut", async () => {
		const base = loadedData();
		const summary = {
			...(base.summary as NonNullable<typeof base.summary>),
			truncated: true,
			rowCount: 5_000,
		};
		const html = await withDesk(createElement(SpendWindow), { data: { ...base, summary } });
		const chart = renderToStaticMarkup(
			createElement(Trends, {
				rows: base.list?.filtered ?? [],
				newestOf: 5_000,
				at: null,
				head: base.head ?? -1,
				part: "chart",
			}),
		);
		expect(noIds(html)).toContain(noIds(chart));
	});

	it("has no range chips: a control that does nothing would be a lie", async () => {
		const html = await withDesk(createElement(SpendWindow), { data: loadedData() });
		expect(html).not.toContain('aria-label="Range"');
		expect(html).not.toContain(">1w<");
	});
});
