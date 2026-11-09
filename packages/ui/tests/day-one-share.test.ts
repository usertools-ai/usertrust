// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Share of spend on day one holds today's three lists (kind, model, job type) and nothing else. PR 4 renames this file
 * and rewrites its cases when the window gets its donut.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { AtPayload } from "../src/shared/api.js";
import type { LedgerRow } from "../src/shared/rows.js";
import { appExport, type Component, loadedData, noIds } from "./helpers/day-one.js";
import { withDesk } from "./helpers/desk.js";

let ShareWindow: React.ComponentType;
let Trends: Component<{
	rows: LedgerRow[];
	newestOf: number | undefined;
	at?: AtPayload | null;
	part: "lists";
}>;

beforeAll(async () => {
	ShareWindow = await appExport("windows/share/share-window", "ShareWindow");
	Trends = await appExport("trends", "Trends");
});

describe("Share of spend on day one", () => {
	it("holds the lists for the same props, under the subtitle that names them", async () => {
		const data = loadedData();
		const html = await withDesk(createElement(ShareWindow), { data });
		const lists = renderToStaticMarkup(
			createElement(Trends, {
				rows: data.list?.filtered ?? [],
				newestOf: undefined,
				at: null,
				part: "lists",
			}),
		);
		expect(lists.length).toBeGreaterThan(0);
		expect(noIds(html)).toContain(noIds(lists));
		expect(html).toContain('aria-label="Share of spend"');
		expect(html).toContain("by kind, model and job type");
	});

	it("does not draw the chart card", async () => {
		const html = await withDesk(createElement(ShareWindow), { data: loadedData() });
		expect(html).not.toContain("Cost over time");
	});
});
