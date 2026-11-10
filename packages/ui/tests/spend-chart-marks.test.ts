// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Where the pin and the chain break are drawn on the Spend chart. The plot has no width under a server render, so
 * every x would be 0; this file gives the plot a width and reads each mark against the record it stands for.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SpendLayer } from "../src/app/windows/spend/layers.js";
import { formatUsdTotal } from "../src/shared/format.js";
import { msToX } from "../src/shared/hit.js";
import { LINE_BUCKETS } from "../src/shared/spend-model.js";
import { appExport, type Component } from "./helpers/day-one.js";
import { HOUR, spendRow, T0, WEEK_WIN } from "./helpers/spend-fixture.js";

const W = 700;
/** The plot's measured width: a test sets 0 to read what is drawn before the plot has a box. */
const box = vi.hoisted(() => ({ w: 700 }));

vi.mock("../src/app/desk/use-box-size.js", () => ({
	boxOf: (e: { contentRect: { width: number; height: number } }) => ({
		w: e.contentRect.width,
		h: e.contentRect.height,
	}),
	useBoxSize: () => ({ w: box.w, h: 240 }),
	useViewportWidth: () => 1200,
}));

afterEach(() => {
	box.w = W;
});

let SpendChart: Component<Record<string, unknown>>;
beforeAll(async () => {
	SpendChart = await appExport("windows/spend/spend-chart", "SpendChart");
});

/** Twelve spend records six hours apart, positions 0 to 11. */
const rows = Array.from({ length: 12 }, (_, pos) =>
	spendRow(pos, { ts: new Date(T0 + pos * 6 * HOUR).toISOString(), costUt: (pos + 1) * 1000 }),
);

function chart(over: Record<string, unknown> = {}): string {
	return renderToStaticMarkup(
		createElement(SpendChart, {
			rows,
			win: WEEK_WIN,
			totalUt: null,
			filtered: false,
			truncated: false,
			pinnedPos: null,
			at: null,
			head: 11,
			ink: null,
			allRows: null,
			filterNote: null,
			markMs: null,
			breakPos: null,
			settling: false,
			range: "1w",
			bucket: LINE_BUCKETS["1w"],
			filterKey: "{}",
			onPin: () => undefined,
			onPreview: () => undefined,
			...over,
		}),
	);
}

describe("spend chart marks, with a plot width", () => {
	it("rings the open record at its time, and labels the peak at rest", () => {
		const markMs = T0 + 4 * 6 * HOUR;
		const html = chart({ markMs });
		const ring = /<circle class="ut-sp-mark" cx="([^"]+)"/.exec(html);
		expect(Number(ring?.[1])).toBeCloseTo(msToX(markMs, WEEK_WIN, W), 3);
		expect(chart()).not.toContain("ut-sp-mark");
		expect(html).toMatch(/<div class="ut-sp-peak"[^>]*>peak \$\S+\/h<\/div>/);
		// Out of the window there is no ring.
		expect(chart({ markMs: T0 - 99 * HOUR })).not.toContain("ut-sp-mark");
	});

	it("puts the pin rule and its dot at the pinned record's time", () => {
		const html = chart({ pinnedPos: 4 });
		const m =
			/<g class="ut-sp-pin"><line x1="([^"]+)" x2="([^"]+)"[^>]*>(?:<\/line>)?<circle cx="([^"]+)"/.exec(
				html,
			);
		expect(m).not.toBeNull();
		const want = msToX(T0 + 4 * 6 * HOUR, WEEK_WIN, W);
		expect(want).toBeGreaterThan(0);
		for (const v of [m?.[1], m?.[2], m?.[3]]) expect(Number(v)).toBeCloseTo(want, 3);
	});
	it("puts the chain break's ring in the bucket of the break record, at that bucket's centre", () => {
		const html = chart({ breakPos: 5 });
		const m =
			/<circle cx="([^"]+)" cy="[^"]+" r="[^"]+"\/?>(?:<\/circle>)?<text[^>]*>chain breaks here/.exec(
				html,
			);
		expect(m).not.toBeNull();
		// Position 5 is 30 hours in; the line's buckets are an hour, so it sits in bucket 30, centred half an hour on.
		const want = msToX(T0 + 30 * HOUR + HOUR / 2, WEEK_WIN, W);
		expect(want).toBeGreaterThan(0);
		expect(Number(m?.[1])).toBeCloseTo(want, 3);
	});
});

describe("the open record's ring: where it may be drawn", () => {
	it("draws it at both ends of the window and nowhere past either", () => {
		const ringed = (markMs: number): boolean => chart({ markMs }).includes("ut-sp-mark");
		expect(ringed(WEEK_WIN.startMs)).toBe(true);
		expect(ringed(WEEK_WIN.endMs)).toBe(true);
		expect(ringed(WEEK_WIN.startMs - 1)).toBe(false);
		expect(ringed(WEEK_WIN.endMs + 1)).toBe(false);
	});
	it("draws none before the plot has a width", () => {
		box.w = 0;
		expect(chart({ markMs: T0 + 4 * 6 * HOUR })).not.toContain("ut-sp-mark");
	});
});

describe("the open record's ring for a record written out of order", () => {
	it("sits where the line and the cursor put a spend record: at the running latest time", () => {
		const late = T0 + 30 * HOUR;
		const own = T0 + 20 * HOUR;
		const out = [
			spendRow(0, { ts: new Date(T0 + 10 * HOUR).toISOString(), costUt: 1000 }),
			spendRow(1, { ts: new Date(late).toISOString(), costUt: 1000 }),
			spendRow(2, { ts: new Date(own).toISOString(), costUt: 1000 }),
		];
		const cx = (html: string): number =>
			Number(/<circle class="ut-sp-mark" cx="([^"]+)"/.exec(html)?.[1]);
		expect(cx(chart({ rows: out, markMs: own, markPos: 2 }))).toBeCloseTo(
			msToX(late, WEEK_WIN, W),
			3,
		);
		// With no position the record's own time places it.
		expect(cx(chart({ rows: out, markMs: own }))).toBeCloseTo(msToX(own, WEEK_WIN, W), 3);
	});
});

describe("the open record's ring for a record that is not spend", () => {
	it("sits at the record's own time, not at the nearest spend record's", () => {
		const own = T0 + 20 * HOUR;
		const mixed = [
			spendRow(0, { ts: new Date(T0 + 10 * HOUR).toISOString(), costUt: 1000 }),
			spendRow(1, { ts: new Date(own).toISOString(), kind: "policy_decision" }),
			spendRow(2, { ts: new Date(T0 + 30 * HOUR).toISOString(), costUt: 1000 }),
		];
		const cx = /<circle class="ut-sp-mark" cx="([^"]+)"/.exec(
			chart({ rows: mixed, markMs: own, markPos: 1 }),
		)?.[1];
		expect(Number(cx)).toBeCloseTo(msToX(own, WEEK_WIN, W), 3);
	});
});

describe("the peak label", () => {
	/** The label's anchor, its transform's pieces and its text, or null when there is none. */
	function label(html: string): {
		anchor: string;
		x: number;
		y: number;
		shift: string;
		text: string;
		hidden: boolean;
	} | null {
		const m =
			/<div class="ut-sp-peak"( aria-hidden="true")? data-anchor="([^"]+)" style="transform:translate\(([-\d.]+)px, ([-\d.]+)px\) translate\(([^,]+), -100%\)">([^<]*)<\/div>/.exec(
				html,
			);
		return m === null
			? null
			: {
					hidden: m[1] !== undefined,
					anchor: m[2] as string,
					x: Number(m[3]),
					y: Number(m[4]),
					shift: m[5] as string,
					text: m[6] as string,
				};
	}
	const only = (pos: number, ms: number, costUt: number) => [
		spendRow(pos, { ts: new Date(ms).toISOString(), costUt }),
	];

	it("is hidden from assistive tech", () => {
		expect(label(chart())?.hidden).toBe(true);
	});
	it("names the peak's exact figure in the line's own bucket: an hour in a week, 5 minutes in a day", () => {
		const hour = chart({ rows: only(0, T0 + 66 * HOUR + 10 * 60_000, 12_000_000) });
		expect(label(hour)?.text).toBe(`peak ${formatUsdTotal(12_000_000)}/h`);
		const day = chart({
			rows: only(0, T0 + 5 * HOUR + 7 * 60_000, 12_000_000),
			win: { startMs: T0, endMs: T0 + 24 * HOUR },
			range: "1d",
			bucket: LINE_BUCKETS["1d"],
		});
		expect(label(day)?.text).toBe(`peak ${formatUsdTotal(12_000_000)}/5 min`);
	});
	it("sits over the peak: its x is the peak bucket's centre and its y is on the line, not the baseline", () => {
		const peakMs = T0 + 66 * HOUR;
		const l = label(chart({ rows: only(0, peakMs + 10 * 60_000, 12_000_000) }));
		expect(l?.x).toBeCloseTo(msToX(peakMs + HOUR / 2, WEEK_WIN, W), 0);
		expect(l?.y).toBeGreaterThanOrEqual(10);
		expect(l?.y).toBeLessThan(120);
		expect(l?.anchor).toBe("middle");
		expect(l?.shift).toBe("-50%");
	});
	it("hangs from the end near the right edge and from the start near the left", () => {
		const right = label(chart({ rows: only(0, WEEK_WIN.endMs - 20 * 60_000, 12_000_000) }));
		expect(right?.anchor).toBe("end");
		expect(right?.shift).toBe("-100%");
		const left = label(chart({ rows: only(0, T0 + 20 * 60_000, 12_000_000) }));
		expect(left?.anchor).toBe("start");
		expect(left?.shift).toBe("0");
	});
	it("is not drawn when a layer's ring already marks the peak", () => {
		const ring: SpendLayer = {
			id: "loupe",
			z: "overlay",
			Layer: () => null,
			marksPeak: () => true,
		};
		expect(chart({ layers: [ring] })).not.toContain("ut-sp-peak");
		expect(chart()).toContain("ut-sp-peak");
	});
	it("is not drawn before the plot has a width", () => {
		box.w = 0;
		expect(chart()).not.toContain("ut-sp-peak");
	});
});
