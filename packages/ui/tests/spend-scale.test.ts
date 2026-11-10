// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { lttb } from "../src/shared/curve.js";
import { squeeze } from "../src/shared/knee.js";
import {
	AREA_FADE_MAX,
	AREA_HIGHLIGHT,
	AREA_STOPS,
	areaFadeTop,
	bucketCenterMs,
	bucketCount,
	bucketSpanMs,
	drawSeries,
	geometry,
	HEADROOM,
	LINE_RECIPE,
	MIN_TOP,
	niceTicks,
	PAD_B,
	PAD_T,
	peakLabelPlace,
	peakLabelShown,
	rateOf,
} from "../src/shared/spend-scale.js";

const T0 = Date.UTC(2026, 10, 1);
const HOUR = 3_600_000;
const win = { startMs: T0, endMs: T0 + 24 * HOUR };
const base = {
	w: 700,
	h: 220,
	win,
	bucketMs: HOUR,
	peakRate: 1000,
	knee: Number.POSITIVE_INFINITY,
};

describe("constants", () => {
	it("are the pinned values", () => {
		expect([PAD_T, PAD_B, HEADROOM, MIN_TOP, AREA_FADE_MAX]).toEqual([16, 6, 1.08, 1, 200]);
		expect(LINE_RECIPE).toEqual({
			glowW: 3,
			glowOpacity: 0.38,
			glowBlur: 1.2,
			knockW: 3.6,
			knockOpacity: 0.75,
			lineW: 1.6,
		});
		expect(AREA_STOPS).toEqual([
			[0, 0.13],
			[0.2, 0.08],
			[0.4, 0.04],
			[0.7, 0.012],
			[0.9, 0],
		]);
	});
	it("the area brightens by AREA_HIGHLIGHT while a cursor is on the plot", () => {
		expect(AREA_HIGHLIGHT).toBe(1.25);
		expect((AREA_STOPS[0] as readonly [number, number])[1] * AREA_HIGHLIGHT).toBeCloseTo(
			0.1625,
			12,
		);
	});
});

describe("geometry", () => {
	it("runs y from zero to the peak plus headroom", () => {
		const g = geometry(base);
		expect(g.top).toBe(1080);
		expect(g.baseY).toBe(220 - PAD_B);
		expect(g.yOf(0)).toBe(g.baseY);
		expect(g.yOf(1080)).toBe(PAD_T);
	});
	it("falls back to a top of 1 with no spend, and nothing is NaN", () => {
		const g = geometry({ ...base, peakRate: 0 });
		expect(g.top).toBe(1);
		for (const v of [0, 0.5, 1, -3]) expect(Number.isFinite(g.yOf(v))).toBe(true);
		expect(g.yOf(-3)).toBe(g.baseY);
	});
	it("compresses above the knee by exactly the squeeze", () => {
		const g = geometry({ ...base, knee: 100, peakRate: 400 });
		const unit = (g.h - PAD_T - PAD_B) / g.top;
		expect(g.top).toBeCloseTo(squeeze(400, 100) * HEADROOM, 9);
		expect(g.yOf(100) - g.yOf(400)).toBeCloseTo((squeeze(400, 100) - 100) * unit, 9);
		expect(g.yOf(400)).toBeLessThan(g.yOf(100));
		for (const r of [0, 50, 100, 250, 400]) expect(g.yOf(r)).toBe(g.yOfDrawn(squeeze(r, 100)));
	});
	it("is linear with an infinite knee", () => {
		const g = geometry(base);
		for (const v of [0, 17, 500, 999]) expect(g.yOfDrawn(v)).toBe(g.yOf(v));
	});
	it("ignores a NaN or infinite peak", () => {
		expect(geometry({ ...base, peakRate: Number.NaN }).top).toBe(1);
		expect(geometry({ ...base, peakRate: Number.POSITIVE_INFINITY }).top).toBe(1);
	});
	it("spanMs is the bucket's real length, short for a partial last bucket", () => {
		const w = { startMs: T0, endMs: T0 + HOUR + 40 * 60_000 };
		const g = geometry({ ...base, win: w });
		expect(g.spanMs(0)).toBe(HOUR);
		expect(g.spanMs(1)).toBe(40 * 60_000);
	});
	it("takes its top from the peak it is given, not from the rates drawn on it", () => {
		// Under a filter the scale is the unfiltered (smoothed) peak's; the filtered line is drawn against it.
		const g = geometry({ ...base, peakRate: 1000 });
		expect(g.top).toBe(1080);
		const filtered = new Float64Array(24);
		filtered[6] = 100;
		const s = drawSeries(g, filtered);
		expect(g.top).toBe(1080);
		expect(s.curve.at(g.centerX(6))).toBeCloseTo(g.yOf(100), 6);
		expect(g.yOf(100)).toBeGreaterThan(g.yOf(1000));
	});
	it("maps time and buckets to x", () => {
		const g = geometry(base);
		expect(g.xOfMs(win.startMs)).toBe(0);
		expect(g.xOfMs(win.endMs)).toBe(700);
		expect(g.centerX(0)).toBeCloseTo(((0.5 * HOUR) / (24 * HOUR)) * 700, 9);
		expect(g.spanMs(3)).toBe(HOUR);
	});
});

describe("rate and buckets", () => {
	it("rateOf is UT per hour and 0 for no span", () => {
		expect(rateOf(50, 1800_000)).toBe(100);
		expect(rateOf(5, 0)).toBe(0);
		expect(rateOf(5, -1)).toBe(0);
	});
	it("a partial last bucket has its real span", () => {
		const w = { startMs: T0, endMs: T0 + HOUR + 40 * 60_000 };
		expect(bucketCount(w, HOUR)).toBe(2);
		expect(bucketSpanMs(0, w, HOUR)).toBe(HOUR);
		expect(bucketSpanMs(1, w, HOUR)).toBe(40 * 60_000);
		expect(bucketCenterMs(1, w, HOUR)).toBe(T0 + HOUR + 20 * 60_000);
		expect(bucketCenterMs(0, w, HOUR)).toBe(T0 + 30 * 60_000);
	});
	it("a bucket past the window has no span, never a negative one", () => {
		expect(bucketSpanMs(5, { startMs: T0, endMs: T0 + HOUR }, HOUR)).toBe(0);
	});
	it("always has at least one bucket", () => {
		expect(bucketCount({ startMs: 5, endMs: 5 }, HOUR)).toBe(1);
		expect(bucketCount({ startMs: 5, endMs: 6 }, HOUR)).toBe(1);
	});
});

describe("niceTicks", () => {
	it("steps in 1/2/5 multiples, ascending, below top, never 0", () => {
		const t = niceTicks(1080);
		expect(t).toEqual([200, 400, 600, 800, 1000]);
		const small = niceTicks(0.3);
		expect(small.length).toBeGreaterThan(0);
		for (const v of small) {
			expect(Number.isFinite(v)).toBe(true);
			expect(v).toBeGreaterThan(0);
			expect(v).toBeLessThan(0.3);
		}
		const seven = niceTicks(7);
		expect(seven.every((v, i) => v < 7 && (i === 0 || v > (seven[i - 1] as number)))).toBe(true);
	});
	it("picks the step from the band the top lands in", () => {
		expect(niceTicks(5)).toEqual([1, 2, 3, 4]);
		expect(niceTicks(12)).toEqual([2, 4, 6, 8, 10]);
		expect(niceTicks(20)).toEqual([5, 10, 15]);
		expect(niceTicks(32)).toEqual([10, 20, 30]);
		expect(niceTicks(0.3)).toEqual([0.1, 0.2]);
	});
	it("returns clean decimals, not float residue", () => {
		expect(niceTicks(0.5)).toEqual([0.1, 0.2, 0.3, 0.4]);
	});
	it("ends on a top too small to step, and on a count that makes the step vanish", () => {
		expect(niceTicks(Number.MIN_VALUE)).toEqual([]);
		// raw = top / count is above 0 here but its magnitude underflows, so the step is 0: the guard on the step ends it.
		expect(niceTicks(Number.MIN_VALUE, 1)).toEqual([]);
		expect(niceTicks(4 * Number.MIN_VALUE)).toEqual([]);
		expect(niceTicks(1, Number.POSITIVE_INFINITY)).toEqual([]);
		expect(niceTicks(Number.MAX_VALUE, 1)).not.toContain(0);
	});
	it("gives nothing for a useless top", () => {
		expect(niceTicks(0)).toEqual([]);
		expect(niceTicks(Number.NaN)).toEqual([]);
	});
});

describe("areaFadeTop", () => {
	const g = geometry(base);
	it("does not depend on the order of the rates", () => {
		const asc = Array.from({ length: 100 }, (_, i) => i + 1);
		const desc = [...asc].reverse();
		expect(areaFadeTop(desc, g.yOf, g.baseY)).toBe(areaFadeTop(asc, g.yOf, g.baseY));
		expect(areaFadeTop(desc, g.yOf, g.baseY)).toBeCloseTo(g.yOf(95), 9);
	});
	it("falls back to the 12px line when the y is not a number", () => {
		expect(areaFadeTop([1, 2, 3], () => Number.NaN, g.baseY)).toBe(g.baseY - 12);
	});
	it("sits at the 95th percentile rate, clamped to 12..200px above the base", () => {
		const rates = Array.from({ length: 100 }, (_, i) => i + 1);
		expect(areaFadeTop(rates, g.yOf, g.baseY)).toBeCloseTo(g.yOf(95), 9);
		const tall = geometry({ ...base, h: 400 });
		expect(areaFadeTop([1000, 1000, 1000], tall.yOf, tall.baseY)).toBe(tall.baseY - 200);
		expect(areaFadeTop([0, 0, 0], g.yOf, g.baseY)).toBe(g.baseY - 12);
		expect(areaFadeTop([], g.yOf, g.baseY)).toBe(g.baseY - 12);
	});
});

describe("drawSeries", () => {
	const n = 600;
	const w2 = { startMs: T0, endMs: T0 + n * 60_000 };
	const spike = 301;
	const rates = new Float64Array(n);
	for (let i = 0; i < n; i++) rates[i] = 5 + (i % 7);
	rates[spike] = 900;
	const g = geometry({
		w: 700,
		h: 220,
		win: w2,
		bucketMs: 60_000,
		peakRate: 900,
		knee: Number.POSITIVE_INFINITY,
	});

	it("keeps the ends and the peak, ascending, and the curve passes through the peak", () => {
		const s = drawSeries(g, rates);
		expect(s.idx).toContain(spike);
		expect(s.idx[0]).toBe(0);
		expect(s.idx[s.idx.length - 1]).toBe(n - 1);
		for (let i = 1; i < s.idx.length; i++)
			expect(s.idx[i] as number).toBeGreaterThan(s.idx[i - 1] as number);
		expect(s.idx.length).toBeLessThanOrEqual(Math.ceil(700 / 2.5) + 1);
		expect(s.idx.length).toBeGreaterThanOrEqual(Math.ceil(700 / 2.5));
		expect(s.curve.at(g.centerX(spike))).toBeCloseTo(g.yOf(900), 6);
		expect(s.first).toBe(g.centerX(0));
		expect(s.last).toBe(g.centerX(n - 1));
	});
	it("d starts with M and equals the curve; the area closes", () => {
		const s = drawSeries(g, rates);
		expect(s.d.startsWith("M")).toBe(true);
		expect(s.d).toBe(s.curve.path());
		expect(s.area.startsWith(s.d)).toBe(true);
		expect(s.area.endsWith("Z")).toBe(true);
		expect(s.area).toContain(` ${g.baseY}`);
	});
	it("forces the global maximum in even when thinning would drop it", () => {
		// A pattern (pixel rows, smaller is higher) for which the thinning alone drops the first highest point, index 18.
		const rows = [
			97, 94, 100, 91, 91, 100, 97, 94, 94, 91, 91, 100, 94, 91, 94, 94, 100, 97, 88, 94, 88, 91,
			91, 97, 97, 100, 100, 100, 100, 97, 94, 97, 97, 94, 91, 94, 97, 88, 91, 88, 91, 88, 91, 88,
			97, 100, 88, 88, 88, 97, 94, 88, 100, 100, 91, 94, 97, 91, 91, 91,
		];
		const rates = Float64Array.from(rows, (y) => 100 - y);
		const m = rates.length;
		const gg = geometry({
			w: 30,
			h: 220,
			win: { startMs: T0, endMs: T0 + m * 60_000 },
			bucketMs: 60_000,
			peakRate: 12,
			knee: Number.POSITIVE_INFINITY,
		});
		const xs = Float64Array.from({ length: m }, (_, k) => gg.centerX(k));
		const ys = Float64Array.from(rates, (r) => gg.yOf(r));
		expect(lttb(xs, ys, Math.ceil(30 / 2.5))).not.toContain(18);
		const kept = drawSeries(gg, rates).idx;
		expect(kept).toContain(18);
		for (let i = 1; i < kept.length; i++)
			expect(kept[i] as number).toBeGreaterThan(kept[i - 1] as number);
	});
	it("closes the area down from the last point to the base, then back to the first", () => {
		const three = geometry({
			w: 700,
			h: 220,
			win: { startMs: T0, endMs: T0 + 3 * HOUR },
			bucketMs: HOUR,
			peakRate: 20,
			knee: Number.POSITIVE_INFINITY,
		});
		const s = drawSeries(three, Float64Array.from([10, 20, 5]));
		expect(s.idx).toEqual([0, 1, 2]);
		expect(s.area).toBe(`${s.d}L583.33 214L116.67 214Z`);
	});
	it("handles empty and one-point series", () => {
		const e = drawSeries(g, new Float64Array(0));
		expect(e.d).toBe("");
		expect(e.idx).toEqual([]);
		expect(e.area).toBe("");
		const one = geometry({
			w: 700,
			h: 220,
			win: { startMs: T0, endMs: T0 + HOUR },
			bucketMs: HOUR,
			peakRate: 5,
			knee: Number.POSITIVE_INFINITY,
		});
		const s = drawSeries(one, Float64Array.from([5]));
		expect(s.idx).toEqual([0]);
		expect(s.d.startsWith("M")).toBe(true);
		expect(s.d).not.toContain("NaN");
		expect(s.area).not.toContain("NaN");
	});
	it("all-zero rates draw flat at the base with no NaN", () => {
		const z = geometry({ ...base, peakRate: 0 });
		const s = drawSeries(z, new Float64Array(24));
		expect(s.d).not.toContain("NaN");
		expect(s.curve.at(100)).toBe(z.baseY);
	});
});

describe("the peak label", () => {
	it("peakLabelPlace anchors by where the peak is: start near the left, end near the right, else middle", () => {
		expect(peakLabelPlace({ x: 5, y: 100, w: 700 })).toEqual({ x: 5, y: 94, anchor: "start" });
		expect(peakLabelPlace({ x: 300, y: 100, w: 700 })).toEqual({ x: 300, y: 94, anchor: "middle" });
		expect(peakLabelPlace({ x: 695, y: 100, w: 700 })).toEqual({ x: 695, y: 94, anchor: "end" });
		// The edges of the 90px bands are middle: start is BEFORE 90, end is PAST w - 90.
		expect(peakLabelPlace({ x: 90, y: 100, w: 700 }).anchor).toBe("middle");
		expect(peakLabelPlace({ x: 89.5, y: 100, w: 700 }).anchor).toBe("start");
		expect(peakLabelPlace({ x: 610, y: 100, w: 700 }).anchor).toBe("middle");
		expect(peakLabelPlace({ x: 610.5, y: 100, w: 700 }).anchor).toBe("end");
	});
	it("peakLabelPlace clamps x to 4px inside the plot and keeps y at least 10", () => {
		expect(peakLabelPlace({ x: 1, y: 100, w: 700 }).x).toBe(4);
		expect(peakLabelPlace({ x: -20, y: 100, w: 700 }).x).toBe(4);
		expect(peakLabelPlace({ x: 699.5, y: 100, w: 700 }).x).toBe(696);
		expect(peakLabelPlace({ x: 300, y: 12, w: 700 }).y).toBe(10);
		expect(peakLabelPlace({ x: 300, y: 16, w: 700 }).y).toBe(10);
		expect(peakLabelPlace({ x: 300, y: 17, w: 700 }).y).toBe(11);
		// A plot too narrow for both bands: a right-hand peak still ends at the right.
		expect(peakLabelPlace({ x: 50, y: 100, w: 100 }).anchor).toBe("end");
	});

	const rest = {
		w: 700,
		peakRate: 9,
		hasCursor: false,
		morphing: false,
		knee: Number.POSITIVE_INFINITY,
		ringed: false,
	};
	it("peakLabelShown is true at rest with nothing hiding it", () => {
		expect(peakLabelShown(rest)).toBe(true);
		// A knee the peak does not pass leaves the label.
		expect(peakLabelShown({ ...rest, knee: 9 })).toBe(true);
		expect(peakLabelShown({ ...rest, knee: 20 })).toBe(true);
	});
	it("peakLabelShown is false for each hider alone", () => {
		expect(peakLabelShown({ ...rest, w: 0 })).toBe(false);
		expect(peakLabelShown({ ...rest, w: -1 })).toBe(false);
		expect(peakLabelShown({ ...rest, w: Number.NaN })).toBe(false);
		expect(peakLabelShown({ ...rest, peakRate: 0 })).toBe(false);
		expect(peakLabelShown({ ...rest, peakRate: -1 })).toBe(false);
		expect(peakLabelShown({ ...rest, peakRate: Number.NaN })).toBe(false);
		expect(peakLabelShown({ ...rest, hasCursor: true })).toBe(false);
		expect(peakLabelShown({ ...rest, morphing: true })).toBe(false);
		expect(peakLabelShown({ ...rest, knee: 5 })).toBe(false);
		expect(peakLabelShown({ ...rest, ringed: true })).toBe(false);
	});
});
