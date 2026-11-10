// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Where the pin and the chain break are drawn on the Spend chart. The plot has no width under a server render, so
 * every x would be 0; this file gives the plot a width and reads each mark against the record it stands for.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { msToX } from "../src/shared/hit.js";
import { LINE_BUCKETS } from "../src/shared/spend-model.js";
import { appExport, type Component } from "./helpers/day-one.js";
import { HOUR, spendRow, T0, WEEK_WIN } from "./helpers/spend-fixture.js";

const W = 700;

vi.mock("../src/app/desk/use-box-size.js", () => ({
	boxOf: (e: { contentRect: { width: number; height: number } }) => ({
		w: e.contentRect.width,
		h: e.contentRect.height,
	}),
	useBoxSize: () => ({ w: 700, h: 240 }),
	useViewportWidth: () => 1200,
}));

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
