// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Trends card is operable and readable without a mouse: the bucket switch is a toggle (a group of pressed
 * buttons, not tabs with no panel), and the cost chart has a text alternative (a label and a table) beside its SVG.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PersistedAuditEvent } from "usertrust";
import { describe, expect, it } from "vitest";
import type { LedgerRow } from "../src/shared/rows.js";
import { toLedgerRows } from "../src/shared/rows.js";

// The component is a .tsx file, which the tests' tsconfig (no `jsx`) cannot resolve statically: load it by a
// computed path, typed here by what the tests use.
type TrendsComponent = (props: {
	rows: LedgerRow[];
	newestOf: number | undefined;
}) => React.JSX.Element;
async function load(): Promise<TrendsComponent> {
	const file = "trends";
	const mod = (await import(/* @vite-ignore */ `../src/app/${file}.js`)) as {
		Trends: TrendsComponent;
	};
	return mod.Trends;
}

function evt(n: number, timestamp: string, cost: number): PersistedAuditEvent {
	return {
		id: `id-${n}`,
		timestamp,
		previousHash: "0".repeat(64),
		hash: "a".repeat(64),
		kind: "llm_call",
		actor: "local",
		data: { cost, model: "claude-sonnet-5" },
		sequence: n,
	};
}

/** Three days of cost: 1,500 UT, 28,000 UT, 9,000 UT. */
function threeDays(): LedgerRow[] {
	return toLedgerRows(
		[
			evt(1, "2026-11-01T10:00:00.000Z", 1_500),
			evt(2, "2026-11-02T10:00:00.000Z", 28_000),
			evt(3, "2026-11-03T10:00:00.000Z", 9_000),
		],
		{ valid: true, breakIndex: null },
	);
}

async function render(rows: LedgerRow[]): Promise<string> {
	const Trends = await load();
	return renderToStaticMarkup(createElement(Trends, { rows, newestOf: undefined }));
}

describe("the bucket switch is a toggle", () => {
	it("a labelled group of two aria-pressed buttons; no tablist, no tab, no aria-selected", async () => {
		const html = await render(threeDays());
		expect(html).toContain('role="group" aria-label="Bucket size"');
		const group = /<div class="ut-seg small"[^>]*>(.*?)<\/div>/s.exec(html)?.[1] ?? "";
		const buttons = [...group.matchAll(/<button\b[^>]*>(.*?)<\/button>/gs)];
		expect(buttons).toHaveLength(2);
		expect(group).toContain('aria-pressed="true"');
		expect(group).toContain('aria-pressed="false"');
		// by day is the default: it is the pressed one
		expect(/<button[^>]*aria-pressed="true"[^>]*>By day</.test(group)).toBe(true);
		expect(/<button[^>]*aria-pressed="false"[^>]*>By hour</.test(group)).toBe(true);
		expect(html).not.toContain('role="tab"');
		expect(html).not.toContain('role="tablist"');
		expect(html).not.toContain("aria-selected");
	});
});

describe("the cost chart has a text alternative", () => {
	it("the chart's container is an image with the sentence for a label", async () => {
		const html = await render(threeDays());
		expect(html).toContain('role="img"');
		expect(html).toContain(
			'aria-label="Cost per day, 3 days with records, highest $2.8000 (28,000 UT) on 2026-11-02 (UTC)"',
		);
	});

	it("a hidden table lists one row per bucket, dollars before UT, under a caption", async () => {
		const html = await render(threeDays());
		const table = /<table class="ut-sr-only">(.*?)<\/table>/s.exec(html)?.[1] ?? "";
		expect(table).toContain("<caption>Cost per day, UTC</caption>");
		const body = /<tbody>(.*?)<\/tbody>/s.exec(table)?.[1] ?? "";
		const rows = [...body.matchAll(/<tr>(.*?)<\/tr>/gs)].map((m) =>
			[...(m[1] ?? "").matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/g)].map((c) => c[1]),
		);
		expect(rows).toEqual([
			["2026-11-01 (UTC)", "$0.1500", "1,500 UT"],
			["2026-11-02 (UTC)", "$2.8000", "28,000 UT"],
			["2026-11-03 (UTC)", "$0.9000", "9,000 UT"],
		]);
	});

	it("the table sits outside the image, whose children a screen reader does not expose", async () => {
		const html = await render(threeDays());
		const img = html.indexOf('role="img"');
		const table = html.indexOf('<table class="ut-sr-only">');
		expect(img).toBeGreaterThan(-1);
		expect(table).toBeGreaterThan(img);
		// the container closes before the table opens: no table inside the image's element
		const between = html.slice(img, table);
		expect(between.match(/<div\b/g)?.length ?? 0).toBeLessThan(
			between.match(/<\/div>/g)?.length ?? 0,
		);
	});

	it("no rows: no chart and no table (the empty card says so)", async () => {
		const html = await render([]);
		expect(html).toContain("No records in view");
		expect(html).not.toContain("ut-sr-only");
		expect(html).not.toContain('role="img"');
	});
});
