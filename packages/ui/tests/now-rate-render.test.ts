// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Rate now as it is drawn: the heading that never changes, the figure with its hook, the words, and the 24 hour line
 * with its colour, its shaded usual range (small form only) and its dot (unusual only).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { formatUsdTotal } from "../src/shared/format.js";
import { NOW_COPY } from "../src/shared/now-copy.js";
import { RATE_HOURS, type RateNowView } from "../src/shared/now-rate.js";
import { appExport, type Component } from "./helpers/day-one.js";

let RateNow: Component<{ view: RateNowView; color: string | null; filled: boolean }>;
beforeAll(async () => {
	RateNow = await appExport("windows/now/rate-now", "RateNow");
});

/**
 * A view whose last hours are `tail` (the newest last) and whose range is defined for the last `banded` hours, from
 * `lo` to `hi`.
 */
function view(
	over: {
		tail?: number[];
		known?: boolean;
		unusual?: boolean;
		banded?: number;
		lo?: number;
		hi?: number;
	} = {},
): RateNowView {
	const tail = over.tail ?? [1_000];
	const hours = new Float64Array(RATE_HOURS);
	hours.set(tail, RATE_HOURS - tail.length);
	const known = over.known ?? true;
	const banded = known ? (over.banded ?? RATE_HOURS - 6) : 0;
	const edge = (v: number): Float64Array => {
		const a = new Float64Array(RATE_HOURS).fill(Number.NaN);
		a.fill(v, RATE_HOURS - banded);
		return a;
	};
	return {
		hours,
		ratePerHourUt: hours[RATE_HOURS - 1] as number,
		known,
		unusual: over.unusual ?? false,
		band: { mid: edge(0), lo: edge(over.lo ?? 0), hi: edge(over.hi ?? 0) },
	};
}

const draw = (v: RateNowView, color: string | null = null, filled = false): string =>
	renderToStaticMarkup(createElement(RateNow, { view: v, color, filled }));

const text = (html: string): string => html.replace(/<[^>]*>/g, "");

/** The line's points as the path gives them: the move, then each curve's end. */
function points(html: string): [number, number][] {
	const d = /<path class="ut-nw-line" d="([^"]*)"/.exec(html)?.[1] ?? "";
	const out: [number, number][] = [];
	const move = /^M(\S+) (\S+?)(?=C|$)/.exec(d);
	if (move) out.push([Number(move[1]), Number(move[2])]);
	for (const c of d.split("C").slice(1)) {
		const n = c.split(" ").map(Number);
		out.push([n[4] as number, n[5] as number]);
	}
	return out;
}

describe("Rate now", () => {
	it("the heading is always Rate now", () => {
		for (const v of [view(), view({ known: false }), view({ unusual: true })]) {
			const html = draw(v);
			expect(html).toContain("<b>Rate now</b>");
			expect(text(html)).not.toContain("Rate at this point");
		}
	});

	it("is a fact of the grid, marked unusual or not", () => {
		expect(draw(view())).toMatch(/^<div class="ut-fact ut-nw-rate" data-unusual="false">/);
		expect(draw(view({ unusual: true }))).toMatch(
			/^<div class="ut-fact ut-nw-rate" data-unusual="true">/,
		);
	});

	it("the figure is the last hour's spend per hour, with its hook", () => {
		const html = draw(view({ tail: [9_000, 1_000] }));
		expect(html).toContain(
			`<span class="v" data-fig="now.rate">${formatUsdTotal(1_000)}<small>/h</small></span>`,
		);
		expect(text(html)).not.toContain(formatUsdTotal(9_000));
	});

	it("a steady rate reads normal, with what it is read against in a tooltip", () => {
		const html = draw(view());
		expect(text(html)).toContain("normal rate");
		expect(html).toContain(
			`<span class="ut-nw-words" title="${NOW_COPY.rateTip.replaceAll("'", "&#x27;")}">`,
		);
		expect(html).toContain("var(--dk-text)");
		expect(html).not.toContain("var(--dk-gold)");
		expect(html).not.toContain("ut-nw-dot");
	});

	it("an unusual rate says so, in gold, with a dot on the last hour", () => {
		const html = draw(view({ tail: [0, 5_000], unusual: true, hi: 100 }));
		expect(text(html)).toContain("unusual spend rate");
		expect(html).toContain('style="stroke:var(--dk-gold)"');
		const dot = /<circle class="ut-nw-dot" cx="([^"]*)" cy="([^"]*)" r="2.5">/.exec(html);
		const end = points(html).at(-1);
		expect(dot).not.toBeNull();
		expect([Number(dot?.[1]), Number(dot?.[2])]).toEqual(end);
		expect(text(html)).not.toMatch(/runaway|loop|anomaly/i);
	});

	it("too little history says so, and nothing about the rate: no gold, no dot, no shading", () => {
		const html = draw(view({ tail: [0, 5_000], known: false }));
		expect(text(html)).toContain("too little history to call");
		expect(text(html)).not.toMatch(/unusual|normal/);
		expect(html).not.toContain("ut-nw-dot");
		expect(html).not.toContain("var(--dk-gold)");
		expect(html).not.toContain("ut-nw-band");
	});

	it("a category tint recolours the line; unusual stays gold", () => {
		expect(draw(view(), "#BE804D")).toContain('style="stroke:#BE804D"');
		expect(draw(view(), "#BE804D")).not.toContain("var(--dk-text)");
		expect(draw(view(), null)).toContain('style="stroke:var(--dk-text)"');
		const unusual = draw(view({ unusual: true }), "#BE804D");
		expect(unusual).toContain('style="stroke:var(--dk-gold)"');
		expect(unusual).not.toContain("#BE804D");
	});

	it("the usual range is shaded in the small form only, and only when there is one", () => {
		expect(draw(view({ hi: 500 }))).toContain('<path class="ut-nw-band" d="M');
		expect(draw(view({ hi: 500 }), null, true)).not.toContain("ut-nw-band");
		expect(draw(view({ known: false }))).not.toContain("ut-nw-band");
		expect(draw(view({ known: false }), null, true)).not.toContain("ut-nw-band");
	});

	it("the shading covers the hours that have a range, back from the last, and needs two of them", () => {
		// The range's top edge left to right, then its bottom edge back, closed.
		const three = /<path class="ut-nw-band" d="([^"]*)"/.exec(
			draw(view({ tail: [0], banded: 3, lo: 250, hi: 500 })),
		)?.[1];
		expect(three).toBe("M86.0 2.0L90.0 2.0L94.0 2.0L94.0 16.0L90.0 16.0L86.0 16.0Z");
		expect(draw(view({ banded: 2, hi: 500 }))).toContain("ut-nw-band");
		expect(draw(view({ banded: 1, hi: 500 }))).not.toContain("ut-nw-band");
		// Never more than the 24 hours drawn, however long the range runs.
		const all = /<path class="ut-nw-band" d="([^"]*)"/.exec(draw(view({ hi: 500 })))?.[1] ?? "";
		expect(all.startsWith("M2.0 ")).toBe(true);
		expect(all.match(/L/g)).toHaveLength(47);
	});

	it("a gap in the range ends the shading there", () => {
		const v = view({ tail: [0], banded: 10, lo: 250, hi: 500 });
		v.band.hi[RATE_HOURS - 4] = Number.NaN;
		const d = /<path class="ut-nw-band" d="([^"]*)"/.exec(draw(v))?.[1] ?? "";
		expect(d.startsWith("M86.0 ")).toBe(true);
		const w = view({ tail: [0], banded: 10, lo: 250, hi: 500 });
		w.band.lo[RATE_HOURS - 4] = Number.NaN;
		expect(/<path class="ut-nw-band" d="([^"]*)"/.exec(draw(w))?.[1]?.startsWith("M86.0 ")).toBe(
			true,
		);
		expect(draw(v)).not.toContain("NaN");
		expect(draw(w)).not.toContain("NaN");
	});

	it("the line is the last 24 hours, evenly spaced across the box, from zero to their peak", () => {
		const tail: number[] = new Array(30).fill(0);
		tail[6] = 800;
		tail[29] = 400;
		// Hour 5 of the tail is outside the 24 drawn: its 9,000 must not set the scale.
		tail[5] = 9_000;
		const html = draw(view({ tail, known: false }));
		const pts = points(html);
		expect(pts).toHaveLength(24);
		expect(pts[0]).toEqual([2, 2]);
		expect(pts.at(-1)).toEqual([94, 16]);
		expect(pts[1]).toEqual([6, 30]);
		expect(html).toContain('width="96" height="32" viewBox="0 0 96 32"');
		expect(html).toContain('role="img" aria-label="The past 24 hours, hour by hour"');
	});

	it("the shaded range's top sets the scale in the small form, and not in the filled one", () => {
		const v = view({ tail: [500], hi: 1_000 });
		expect(points(draw(v)).at(-1)).toEqual([94, 16]);
		expect(points(draw(v, null, true)).at(-1)).toEqual([94, 2]);
	});

	it("the path is drawn from real numbers, for a vault with no spend too", () => {
		for (const v of [view(), view({ tail: [0] }), view({ tail: [0], known: false })]) {
			const html = draw(v);
			expect(html).toMatch(/<path class="ut-nw-line" d="M/);
			expect(html).not.toContain("NaN");
		}
		// No spend: a flat line on the floor, never a division by zero.
		expect(points(draw(view({ tail: [0], known: false }))).every(([, y]) => y === 30)).toBe(true);
		// Under 1 UT at the peak, the scale stays 1 UT: half a UT is half the height.
		expect(points(draw(view({ tail: [0.5], known: false }))).at(-1)).toEqual([94, 16]);
	});
});
