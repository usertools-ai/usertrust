// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The four windows: registered in grid order, each a labelled section that knows its own id, and each able to draw
 * an empty or still-loading vault without throwing or printing NaN. These cases hold for whatever a window draws
 * inside; the day-one content is checked in one file per window.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowId } from "../src/shared/desk-layout.js";
import { EMPTY_FILTERS } from "../src/shared/filters.js";
import { listView } from "../src/shared/list-view.js";
import { appExport, type Component, dayOneSummary, loadedData, noIds } from "./helpers/day-one.js";
import { withDesk } from "./helpers/desk.js";

let WINDOWS: readonly { id: WindowId; Component: React.ComponentType }[];
let SummaryStrip: Component<{
	summary: ReturnType<typeof dayOneSummary> | null;
	live: "live";
	at?: null;
	part: "facts";
}>;

beforeAll(async () => {
	WINDOWS = await appExport("desk/windows", "WINDOWS");
	SummaryStrip = await appExport("summary-strip", "SummaryStrip");
});

// The Ledger window's list asks whether it is on a phone (window.matchMedia) as it first renders; there is no browser here.
beforeEach(() => {
	vi.stubGlobal("window", {
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
});

const LABELS: Record<WindowId, string> = {
	spend: "Spend",
	share: "Share of spend",
	ledger: "Ledger",
	now: "Now",
};

async function drawn(id: WindowId, o: Parameters<typeof withDesk>[1] = {}): Promise<string> {
	const w = WINDOWS.find((x) => x.id === id);
	if (w === undefined) throw new Error(`no window ${id}`);
	return withDesk(createElement(w.Component), o);
}

describe("the registry", () => {
	it("lists the windows in grid order", () => {
		expect(WINDOWS.map((w) => w.id)).toEqual(["spend", "share", "ledger", "now"]);
	});

	it("draws each as a section carrying its id and its name", async () => {
		for (const w of WINDOWS) {
			const html = await drawn(w.id);
			expect(html).toContain(`<section`);
			expect(html).toContain(`data-win="${w.id}"`);
			expect(html).toContain(`aria-label="${LABELS[w.id]}"`);
		}
	});

	it("draws exactly one window per component", async () => {
		for (const w of WINDOWS) {
			const html = await drawn(w.id);
			expect(html.match(/data-win="/g)?.length).toBe(1);
		}
	});
});

describe("an empty or still-loading vault", () => {
	it("draws all four with no throw and no NaN", async () => {
		const loading = {
			list: listView({
				rows: [],
				at: null,
				filters: EMPTY_FILTERS,
				phase: "loading",
				summary: null,
			}),
		};
		for (const w of WINDOWS) {
			const html = await drawn(w.id, { data: loading });
			expect(html).not.toContain("NaN");
		}
	});

	it("Now shows its loading facts while the summary has not landed", async () => {
		const html = await drawn("now", { data: { summary: null } });
		expect(html).toContain("vault summary loading");
	});

	it("draws all four for a loaded vault with no records", async () => {
		for (const w of WINDOWS) {
			const html = await drawn(w.id, { data: { summary: dayOneSummary() } });
			expect(html).not.toContain("NaN");
		}
	});
});

describe("Now", () => {
	it("holds the summary strip's facts for the same props", async () => {
		const data = loadedData();
		const html = await drawn("now", { data });
		const facts = renderToStaticMarkup(
			createElement(SummaryStrip, { summary: data.summary ?? null, live: "live", part: "facts" }),
		);
		expect(facts.length).toBeGreaterThan(0);
		expect(noIds(html)).toContain(noIds(facts));
	});
});
