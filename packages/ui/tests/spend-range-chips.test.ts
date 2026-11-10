// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/** The Spend window's six range chips as static markup. */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { RangeId } from "../src/shared/spend-series.js";
import { appExport, type Component } from "./helpers/day-one.js";

interface Chip {
	id: RangeId;
	label: string;
	title: string;
}

let RangeChips: Component<{ range: RangeId; onRange(r: RangeId): void }>;
let RANGE_CHIPS: readonly Chip[];

beforeAll(async () => {
	RangeChips = await appExport("windows/spend/range-chips", "RangeChips");
	RANGE_CHIPS = await appExport("windows/spend/range-chips", "RANGE_CHIPS");
});

function html(range: RangeId): string {
	return renderToStaticMarkup(createElement(RangeChips, { range, onRange: () => undefined }));
}

function buttons(markup: string): string[] {
	return [...markup.matchAll(/<button\b[^>]*>[^<]*<\/button>/g)].map((m) => m[0]);
}

describe("RANGE_CHIPS", () => {
	it("lists the six ranges in order with their labels and titles", () => {
		expect(RANGE_CHIPS).toEqual([
			{ id: "1d", label: "1D", title: "Last 24 hours" },
			{ id: "1w", label: "1W", title: "Last 7 days" },
			{ id: "1m", label: "1M", title: "Last 30 days" },
			{ id: "3m", label: "3M", title: "Last 90 days" },
			{ id: "ytd", label: "YTD", title: "Since Jan 1 (UTC)" },
			{ id: "1y", label: "1Y", title: "Last 365 days" },
		]);
	});
});

describe("RangeChips presses", () => {
	it("each chip's press reports its own range", () => {
		const seen: RangeId[] = [];
		const el = RangeChips({ range: "1d", onRange: (r) => seen.push(r) }) as unknown as {
			props: { children: Array<{ props: { onClick(): void } }> };
		};
		for (const b of el.props.children) b.props.onClick();
		expect(seen).toEqual(["1d", "1w", "1m", "3m", "ytd", "1y"]);
	});
});

describe("RangeChips", () => {
	it("draws six buttons in order, with a title each", () => {
		const bs = buttons(html("3m"));
		expect(bs.length).toBe(6);
		expect(bs.map((b) => />([^<]*)</.exec(b)?.[1])).toEqual(["1D", "1W", "1M", "3M", "YTD", "1Y"]);
		for (const b of bs) expect(b).toMatch(/\stitle="[^"]+"/);
		for (const b of bs) expect(b).toContain('type="button"');
	});

	it("presses exactly the chip for the range", () => {
		for (const c of RANGE_CHIPS) {
			const bs = buttons(html(c.id));
			const pressed = bs.filter((b) => b.includes('aria-pressed="true"'));
			expect(pressed.length).toBe(1);
			expect(pressed[0]).toContain(`>${c.label}<`);
			expect(bs.filter((b) => b.includes('aria-pressed="false"')).length).toBe(5);
		}
	});

	it("is a labelled glass group", () => {
		const m = html("1w");
		expect(m).toMatch(/^<div\b[^>]*class="ut-sp-chips ut-glass"/);
		expect(m).toContain('role="group"');
		expect(m).toContain('aria-label="Range"');
	});
});
