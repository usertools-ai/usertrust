// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Breakdown, breakdown, categoryRows } from "../src/shared/breakdown.js";
import {
	type Arc,
	atTime,
	atWhen,
	blendArcs,
	bucketAt,
	bucketStartMs,
	centreOf,
	easeOutCubic,
	FADE,
	FADE_HOT,
	formatShare,
	GROW,
	HALF_GAP,
	INNER,
	LEGEND_ROWS,
	legendOf,
	legendTitle,
	OUTLINE_INSET,
	type Pt,
	RIM_W,
	RIM_W_HOT,
	rimPath,
	ringEdges,
	ringPath,
	SHARE_EMPTY,
	type ShareValues,
	SLIVER,
	shareValues,
	sliceAngles,
	TWEEN_MS,
	VB,
} from "../src/shared/donut.js";
import type { LedgerRow } from "../src/shared/rows.js";

const TAU = Math.PI * 2;
const C = 150;
const RO = 137;
const RI = RO * INNER;

/** Signed distance of `p` from the ray at angle `a` out of the centre: positive on its clockwise side. */
function side(p: Pt, a: number): number {
	return Math.sin(a) * (p.y - C) + Math.cos(a) * (p.x - C);
}

const apart = (p: Pt, q: Pt): number => Math.hypot(p.x - q.x, p.y - q.y);

function edges(arc: Arc): NonNullable<ReturnType<typeof ringEdges>> {
	const e = ringEdges(C, C, RO, RI, arc.a0, arc.a1, HALF_GAP);
	if (e === null) throw new Error("no edges");
	return e;
}

describe("donut geometry", () => {
	it("cuts equal parallel gaps: every facing edge sits half a gap from the boundary, at both radii", () => {
		const [a, b] = sliceAngles([30, 70]) as [Arc, Arc];
		expect(a.a1).toBe(b.a0);
		const ea = edges(a);
		const eb = edges(b);
		for (const p of [ea.o1, ea.i1]) expect(side(p, a.a1)).toBeCloseTo(-HALF_GAP, 9);
		for (const p of [eb.o0, eb.i0]) expect(side(p, a.a1)).toBeCloseTo(HALF_GAP, 9);
		// And the leading edge of A against B's far boundary (12 o'clock), the same.
		expect(side(ea.o0, 0)).toBeCloseTo(HALF_GAP, 9);
		expect(side(eb.o1, TAU)).toBeCloseTo(-HALF_GAP, 9);
	});

	it("draws one category as a full annulus: two circles, no gap, no straight edge", () => {
		expect(sliceAngles([5])).toEqual([{ a0: 0, a1: TAU }]);
		const full = sliceAngles([5, 0])[0] as Arc;
		expect(full).toEqual({ a0: 0, a1: TAU });
		const d = ringPath(C, C, RO, RI, full.a0, full.a1, HALF_GAP);
		expect(d.match(/M/g)?.length).toBe(2);
		expect(d.match(/A/g)?.length).toBe(4);
		expect(d.match(/Z/g)?.length).toBe(2);
		expect(d).not.toContain("L");
		const rim = rimPath(C, C, RO, full.a0, full.a1, HALF_GAP);
		expect(rim).not.toBe("");
		expect(rim).not.toContain("L");
	});

	it("keeps a tiny slice as a sliver SLIVER wide at both radii, centred on its mid-angle", () => {
		const tiny = sliceAngles([998, 2])[1] as Arc;
		const d = ringPath(C, C, RO, RI, tiny.a0, tiny.a1, HALF_GAP);
		expect(d).not.toBe("");
		expect(d).not.toMatch(/NaN/);
		expect(rimPath(C, C, RO, tiny.a0, tiny.a1, HALF_GAP)).not.toBe("");
		const e = edges(tiny);
		const mid = (tiny.a0 + tiny.a1) / 2;
		expect(apart(e.o0, e.o1)).toBeCloseTo(SLIVER, 9);
		expect(apart(e.i0, e.i1)).toBeCloseTo(SLIVER, 9);
		expect(side(e.o0, mid)).toBeCloseTo(-SLIVER / 2, 9);
		expect(side(e.i1, mid)).toBeCloseTo(SLIVER / 2, 9);
	});

	it("narrows to a sliver only where the body would be thinner than one: the outer edges keep the gap", () => {
		// 0.06 rad: at the inner radius the gap leaves less than SLIVER, at the outer radius more.
		const arc = { a0: 1, a1: 1.06 };
		const e = edges(arc);
		expect(side(e.o0, arc.a0)).toBeCloseTo(HALF_GAP, 9);
		expect(side(e.o1, arc.a1)).toBeCloseTo(-HALF_GAP, 9);
		expect(apart(e.o0, e.o1)).toBeGreaterThan(SLIVER);
		expect(apart(e.i0, e.i1)).toBeCloseTo(SLIVER, 9);
	});

	it("collapses a zero value at its start and draws nothing for it", () => {
		const arcs = sliceAngles([1, 0, 1]);
		expect(arcs[1]).toEqual({ a0: Math.PI, a1: Math.PI });
		expect(ringEdges(C, C, RO, RI, Math.PI, Math.PI, HALF_GAP)).toBeNull();
		expect(ringPath(C, C, RO, RI, Math.PI, Math.PI, HALF_GAP)).toBe("");
		expect(rimPath(C, C, RO, Math.PI, Math.PI, HALF_GAP)).toBe("");
	});

	it("has no NaN with nothing to draw, and closes the ring exactly at 2π", () => {
		expect(sliceAngles([])).toEqual([]);
		expect(sliceAngles([0, 0])).toEqual([
			{ a0: 0, a1: 0 },
			{ a0: 0, a1: 0 },
		]);
		const arcs = sliceAngles([1, 1, 2]);
		expect(arcs.map((a) => [a.a0, a.a1])).toEqual([
			[0, TAU / 4],
			[TAU / 4, TAU / 2],
			[TAU / 2, TAU],
		]);
		expect(arcs.at(-1)?.a1).toBe(TAU);
		expect(sliceAngles([-5, 5])).toEqual([
			{ a0: 0, a1: 0 },
			{ a0: 0, a1: TAU },
		]);
	});

	it("eases out: 0 at 0, 1 at 1, ahead of linear in between", () => {
		expect(easeOutCubic(0)).toBe(0);
		expect(easeOutCubic(1)).toBe(1);
		expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
		expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 12);
	});

	it("blends arcs from the shown ones to the target; a new key grows from its target's midpoint", () => {
		const from = new Map<string, Arc>([
			["a", { a0: 0, a1: 1 }],
			["gone", { a0: 1, a1: 2 }],
		]);
		const to = new Map<string, Arc>([
			["a", { a0: 0.1, a1: 0.3 }],
			["new", { a0: 2, a1: 3 }],
		]);
		expect(blendArcs(from, to, 0).get("a")).toEqual({ a0: 0, a1: 1 });
		expect(blendArcs(from, to, 1)).toEqual(to);
		expect(blendArcs(from, to, 0).get("new")).toEqual({ a0: 2.5, a1: 2.5 });
		const half = blendArcs(from, to, 0.5);
		expect(half.get("a")?.a1).toBeCloseTo(0.65, 12);
		expect(half.has("gone")).toBe(false);
	});

	it("pins the drawing box, the widths, the tween and the shading tables", () => {
		expect(VB).toBe(300);
		expect(INNER).toBe(0.62);
		expect(GROW).toBe(7);
		expect(HALF_GAP).toBe(2.2);
		expect(OUTLINE_INSET).toBe(0.5);
		expect(SLIVER).toBe(2);
		expect(RIM_W).toBe(2.2);
		expect(RIM_W_HOT).toBe(3);
		expect(TWEEN_MS).toBe(240);
		expect(LEGEND_ROWS).toBe(5);
		expect(FADE).toEqual([
			[0, 0.56],
			[0.35, 0.32],
			[0.7, 0.18],
			[1, 0.1],
		]);
		expect(FADE_HOT).toEqual([
			[0, 0.8],
			[0.35, 0.5],
			[0.7, 0.3],
			[1, 0.17],
		]);
		for (const table of [FADE, FADE_HOT]) {
			// From the outer edge (0) to the inner (1), fading but never to nothing.
			expect(table[0]?.[0]).toBe(0);
			expect(table.at(-1)?.[0]).toBe(1);
			for (let i = 1; i < table.length; i++) {
				const [p0, o0] = table[i - 1] as readonly [number, number];
				const [p1, o1] = table[i] as readonly [number, number];
				expect(p1).toBeGreaterThan(p0);
				expect(o1).toBeLessThan(o0);
			}
			for (const [, o] of table) expect(o).toBeGreaterThan(0);
		}
		// In focus it rises at every stop, at the same positions.
		expect(FADE_HOT).toHaveLength(FADE.length);
		for (const [i, [p, o]] of FADE.entries()) {
			expect(FADE_HOT[i]?.[0]).toBe(p);
			expect(FADE_HOT[i]?.[1]).toBeGreaterThan(o);
		}
	});

	it("writes a slice's body and rim exactly: two decimals, rotation 0, sweep clockwise out and back in", () => {
		const H = Math.PI / 2;
		expect(ringPath(150, 150, 100, 50, 0, H, 0)).toBe(
			"M150,50A100,100 0 0 1 250,150L200,150A50,50 0 0 0 150,100Z",
		);
		expect(rimPath(150, 150, 100, 0, H, 0)).toBe("M150,50A100,100 0 0 1 250,150");
		// A slice that starts past 12 o'clock: the large-arc flag reads the arc's span, not where it sits.
		expect(ringPath(150, 150, 100, 50, H, Math.PI, 0)).toBe(
			"M250,150A100,100 0 0 1 150,250L150,200A50,50 0 0 0 200,150Z",
		);
		expect(rimPath(150, 150, 100, H, Math.PI, 0)).toBe("M250,150A100,100 0 0 1 150,250");
		expect(rimPath(150, 150, 100, 2, 3, 0)).toMatch(/^M[\d.,]+A100,100 0 0 1 [\d.,]+$/);
		// sin 1 = 0.84147..., cos 1 = 0.54030...: rounded to the nearest hundredth, not cut.
		expect(rimPath(150, 150, 100, 0, 1, 0)).toBe("M150,50A100,100 0 0 1 234.15,95.97");
	});

	it("sets the large-arc flag only past half a turn: exactly π is not large, a hair over is", () => {
		const P = Math.PI;
		const notLarge = "M150,50A100,100 0 0 1 150,250L150,200A50,50 0 0 0 150,100Z";
		const large = "M150,50A100,100 0 1 1 150,250L150,200A50,50 0 1 0 150,100Z";
		expect(ringPath(150, 150, 100, 50, 0, P - 1e-9, 0)).toBe(notLarge);
		expect(ringPath(150, 150, 100, 50, 0, P, 0)).toBe(notLarge);
		expect(ringPath(150, 150, 100, 50, 0, P + 1e-9, 0)).toBe(large);
		expect(rimPath(150, 150, 100, 0, P - 1e-9, 0)).toBe("M150,50A100,100 0 0 1 150,250");
		expect(rimPath(150, 150, 100, 0, P, 0)).toBe("M150,50A100,100 0 0 1 150,250");
		expect(rimPath(150, 150, 100, 0, P + 1e-9, 0)).toBe("M150,50A100,100 0 1 1 150,250");
	});

	it("draws a whole turn as closed circles from 12 o'clock, from exactly the full-turn threshold", () => {
		const FULL = TAU - 1e-6;
		const outer = "M150,50A100,100 0 1 1 150,250A100,100 0 1 1 150,50Z";
		const inner = "M150,100A50,50 0 1 1 150,200A50,50 0 1 1 150,100Z";
		expect(ringPath(150, 150, 100, 50, 0, TAU, 0)).toBe(outer + inner);
		expect(ringPath(150, 150, 100, 50, 0, FULL, HALF_GAP)).toBe(outer + inner);
		expect(rimPath(150, 150, 100, 0, TAU, HALF_GAP)).toBe(outer);
		expect(rimPath(150, 150, 100, 0, FULL, HALF_GAP)).toBe(outer);
		// A hair short of the threshold is a slice: its gap, its straight edges, one arc each way.
		const short = ringPath(150, 150, 100, 50, 0, FULL - 1e-9, HALF_GAP);
		expect(short).toContain("L");
		expect(short.match(/A/g)?.length).toBe(2);
		const shortRim = rimPath(150, 150, 100, 0, FULL - 1e-9, HALF_GAP);
		expect(shortRim.match(/A/g)?.length).toBe(1);
		expect(shortRim).not.toContain("Z");
		// Rounded, not cut, to two decimals: 139.994, 160.006 and 10.006; 144.996, 155.004 and 5.004.
		expect(ringPath(150, 150, 10.006, 5.004, 0, TAU, 0)).toBe(
			"M150,139.99A10.01,10.01 0 1 1 150,160.01A10.01,10.01 0 1 1 150,139.99Z" +
				"M150,145A5,5 0 1 1 150,155A5,5 0 1 1 150,145Z",
		);
	});

	it("keeps a body while it is a sliver wide or more, and centres a sliver on its own mid-angle", () => {
		const d = Math.asin(HALF_GAP / RO);
		const s = Math.asin(SLIVER / 2 / RO);
		// One and a quarter slivers of body left at the outer radius: still a body, half a gap in at both ends.
		const body = { a0: 1, a1: 1 + 2 * d + 2.5 * s };
		const eb = edges(body);
		expect(side(eb.o0, body.a0)).toBeCloseTo(HALF_GAP, 9);
		expect(side(eb.o1, body.a1)).toBeCloseTo(-HALF_GAP, 9);
		// A sliver away from 12 o'clock, at both radii, on the mid-angle of its own two ends.
		const thin = { a0: 1, a1: 1.01 };
		const et = edges(thin);
		const mid = 1.005;
		expect(side(et.o0, mid)).toBeCloseTo(-SLIVER / 2, 9);
		expect(side(et.o1, mid)).toBeCloseTo(SLIVER / 2, 9);
		expect(side(et.i0, mid)).toBeCloseTo(-SLIVER / 2, 9);
		expect(side(et.i1, mid)).toBeCloseTo(SLIVER / 2, 9);
		expect(Math.atan2(et.o0.x - C, C - et.o0.y)).toBeCloseTo(mid - s, 9);
	});

	it("splits a total below one like any other", () => {
		expect(sliceAngles([0.125, 0.375])).toEqual([
			{ a0: 0, a1: TAU / 4 },
			{ a0: TAU / 4, a1: TAU },
		]);
	});

	it("clamps the ease outside 0..1", () => {
		expect(easeOutCubic(-1)).toBe(0);
		expect(easeOutCubic(-0.25)).toBe(0);
		expect(easeOutCubic(1.25)).toBe(1);
		expect(easeOutCubic(2)).toBe(1);
	});
});

const T0 = Date.parse("2026-11-07T00:00:00.000Z");
const HOUR = 3_600_000;
const WIN = { startMs: T0, endMs: T0 + 24 * HOUR };

function row(actor: string, hour: number, costUt: number, kind = "llm_call"): LedgerRow {
	return {
		seq: 1,
		pos: 0,
		id: `${actor}-${hour}-${costUt}`,
		ts: new Date(T0 + hour * HOUR + 60_000).toISOString(),
		kind,
		actor,
		hash: "a".repeat(64),
		previousHash: "0".repeat(64),
		integrity: "verified",
		costUt,
	};
}

/** `n` categories with distinct spends, highest first. */
function valuesOf(n: number): ShareValues {
	const keys = Array.from({ length: n }, (_, i) => `k${i}`);
	const values = keys.map((_, i) => (n - i) * 10 + 3);
	return { keys, values, total: values.reduce((a, v) => a + v, 0) };
}

describe("share values, legend, percentages and centre", () => {
	it("folds the legend to the top five plus Other only when two or more are left", () => {
		const eight = legendOf(valuesOf(8));
		expect(eight.rows.map((r) => r.key)).toEqual(["k0", "k1", "k2", "k3", "k4"]);
		expect(eight.other?.count).toBe(3);
		expect(eight.other?.spendUt).toBe(33 + 23 + 13);
		const sum = eight.rows.reduce((a, r) => a + r.spendUt, 0) + (eight.other?.spendUt ?? 0);
		expect(sum).toBe(valuesOf(8).total);
		expect(eight.other?.share).toBeCloseTo(69 / valuesOf(8).total, 12);
		expect(eight.rows[0]?.share).toBeCloseTo(83 / valuesOf(8).total, 12);
		const six = legendOf(valuesOf(6));
		expect(six.rows).toHaveLength(6);
		expect(six.other).toBeNull();
		const seven = legendOf(valuesOf(7));
		expect(seven.rows).toHaveLength(5);
		expect(seven.other?.count).toBe(2);
		const one = legendOf(valuesOf(1));
		expect(one.rows).toEqual([{ key: "k0", spendUt: 13, share: 1 }]);
		expect(one.other).toBeNull();
		expect(legendOf(valuesOf(3), 2).other).toBeNull();
		expect(legendOf(valuesOf(4), 2).other?.count).toBe(2);
	});

	it("lists the keys that spent in the range, in spend order, idle and at a bucket alike", () => {
		const rows = [
			row("a", 0, 50),
			row("a", 2, 1),
			row("b", 2, 7),
			row("b", 5, 30),
			row("c", 2, 4),
			row("c", 9, 2),
			row("d", 3, 9),
			row("a", 2, 100, "info"),
			row("z", 2, 0),
		];
		const bd = breakdown(rows, WIN, "lane");
		// "z" made a call that cost nothing: the breakdown counts it, the window does not list it.
		expect(bd.keys).toEqual(["a", "b", "d", "c", "z"]);
		const idle = shareValues(bd, null, null);
		expect(idle.keys).toEqual(["a", "b", "d", "c"]);
		expect(idle.values).toEqual([51, 37, 9, 6]);
		expect(idle.total).toBe(bd.totalUt);
		const buckets = categoryRows(rows, WIN, "lane", HOUR);
		const at2 = shareValues(bd, buckets, 2);
		// The range fixes the list: "d" spent nothing in bucket 2 and still reads 0 there.
		expect(at2.keys).toEqual(idle.keys);
		expect(at2.values).toEqual([1, 7, 0, 4]);
		expect(at2.total).toBe(12);
		expect(shareValues(bd, buckets, null)).toEqual(idle);
		expect(shareValues(bd, null, 2)).toEqual(idle);
		expect(shareValues(bd, new Map(), 2).values).toEqual([0, 0, 0, 0]);
	});

	it("places a moment in its bucket, clamping the end and refusing anything outside the window", () => {
		const n = 24;
		expect(bucketAt(WIN.startMs - 1, WIN, HOUR, n)).toBeNull();
		expect(bucketAt(WIN.startMs, WIN, HOUR, n)).toBe(0);
		expect(bucketAt(WIN.startMs + HOUR - 1, WIN, HOUR, n)).toBe(0);
		expect(bucketAt(WIN.startMs + HOUR, WIN, HOUR, n)).toBe(1);
		expect(bucketAt(WIN.endMs, WIN, HOUR, n)).toBe(n - 1);
		expect(bucketAt(WIN.endMs + 1, WIN, HOUR, n)).toBeNull();
		expect(bucketAt(WIN.startMs, WIN, HOUR, 0)).toBeNull();
		expect(bucketAt(WIN.startMs + 15 * HOUR, WIN, HOUR, 10)).toBe(9);
		expect(bucketAt(Number.NaN, WIN, HOUR, n)).toBeNull();
	});

	it("never prints a nonzero share as zero", () => {
		expect(formatShare(0.423, 0)).toBe("42%");
		expect(formatShare(0.423, 1)).toBe("42.3%");
		expect(formatShare(0.002, 0)).toBe("<1%");
		expect(formatShare(0.0004, 1)).toBe("<0.1%");
		expect(formatShare(0.002, 1)).toBe("0.2%");
		expect(formatShare(0, 0)).toBe("0%");
		expect(formatShare(0, 1)).toBe("0.0%");
		expect(formatShare(1, 0)).toBe("100%");
		expect(formatShare(1, 1)).toBe("100.0%");
		expect(formatShare(0.4256, 0)).toBe("43%");
		expect(formatShare(0.4256, 1)).toBe("42.6%");
	});

	it("never prints a share that is not all of it as 100%", () => {
		expect(formatShare(0.9996, 0)).toBe(">99%");
		expect(formatShare(0.9996, 1)).toBe(">99.9%");
		expect(formatShare(0.996, 0)).toBe(">99%");
		expect(formatShare(0.99951, 1)).toBe(">99.9%");
		expect(formatShare(0.994999, 0)).toBe("99%");
		expect(formatShare(0.994999, 1)).toBe("99.5%");
		expect(formatShare(0.9994, 1)).toBe("99.9%");
		expect(formatShare(1, 0)).toBe("100%");
		expect(formatShare(1, 1)).toBe("100.0%");
	});

	it("shows no spend as $0.00 and an empty legend, with no NaN", () => {
		const empty = shareValues(breakdown([], WIN, "lane"), null, null);
		expect(empty).toEqual({ keys: [], values: [], total: 0 });
		expect(legendOf(empty)).toEqual({ rows: [], other: null });
		// A bucket with no spend at all: the range's keys stay listed, at a share of 0, never NaN.
		expect(legendOf({ keys: ["a"], values: [0], total: 0 }).rows).toEqual([
			{ key: "a", spendUt: 0, share: 0 },
		]);
		const c = centreOf({ hot: null, total: 0, spending: 0, noun: "lane", startMs: null });
		expect(c).toEqual({ name: "This range", amount: "$0.00", sub: "0 lanes" });
		const hot = centreOf({
			hot: { key: "a", spendUt: 0 },
			total: 0,
			spending: 0,
			noun: "lane",
			startMs: null,
		});
		expect(hot.sub).toBe("0.0% this range");
		expect(JSON.stringify([c, hot])).not.toMatch(/NaN/);
		expect(SHARE_EMPTY).toBe("No spend in this range");
	});

	it("words the centre for the range and for a bucket, lit or not", () => {
		const at = T0 + 2 * HOUR;
		const base = { total: 10_000, spending: 3, noun: "lane" };
		const lit = { key: "a", spendUt: 4_230 };
		expect(centreOf({ ...base, hot: lit, startMs: null })).toEqual({
			name: "a",
			amount: "$0.42",
			sub: "42.3% this range",
		});
		expect(centreOf({ ...base, hot: lit, startMs: at }).sub).toBe("42.3% at 2026-11-07 02:00Z");
		expect(centreOf({ ...base, hot: null, startMs: at })).toEqual({
			name: "At 2026-11-07 02:00Z",
			amount: "$1.00",
			sub: "3 lanes",
		});
		expect(centreOf({ ...base, hot: null, startMs: null }).name).toBe("This range");
		expect(centreOf({ ...base, spending: 1, hot: null, startMs: null }).sub).toBe("1 lane");
		const src = readFileSync(join(import.meta.dirname, "..", "src", "shared", "donut.ts"), "utf-8");
		expect(src).not.toMatch(/up to/i);
	});

	it("labels a moment and titles a legend row", () => {
		expect(bucketStartMs(WIN, 3_600_000, 2)).toBe(WIN.startMs + 7_200_000);
		expect(atTime(T0 + 2 * HOUR)).toBe("At 2026-11-07 02:00Z");
		expect(atWhen(T0 + 2 * HOUR)).toBe("at 2026-11-07 02:00Z");
		expect(atWhen(null)).toBe("this range");
		expect(legendTitle("a", 1.5e9, 0.423, "this range")).toBe(
			"a: $150,000.00, 42.3% this range. Click to filter the desk to it.",
		);
		expect(legendTitle("b", 4, 0.0004, atWhen(T0 + 2 * HOUR))).toBe(
			"b: $0.0004, <0.1% at 2026-11-07 02:00Z. Click to filter the desk to it.",
		);
	});

	it("lists a key that spent less than one unit, and not a key the breakdown has no entry for", () => {
		const bd: Breakdown = {
			dim: "lane",
			keys: ["half", "ghost"],
			byKey: new Map([["half", { spendUt: 0.5, calls: 1 }]]),
			totalUt: 0.5,
			calls: 1,
		};
		expect(shareValues(bd, null, null)).toEqual({ keys: ["half"], values: [0.5], total: 0.5 });
		const buckets = new Map([["half", Float64Array.of(0.25, 0.25)]]);
		expect(shareValues(bd, buckets, 1)).toEqual({ keys: ["half"], values: [0.25], total: 0.25 });
	});

	it("shares out a total below one, and reads a key with no value as 0", () => {
		expect(legendOf({ keys: ["a", "b"], values: [0.375, 0.125], total: 0.5 }).rows).toEqual([
			{ key: "a", spendUt: 0.375, share: 0.75 },
			{ key: "b", spendUt: 0.125, share: 0.25 },
		]);
		expect(legendOf({ keys: ["a", "b"], values: [3], total: 3 }).rows).toEqual([
			{ key: "a", spendUt: 3, share: 1 },
			{ key: "b", spendUt: 0, share: 0 },
		]);
		const hot = { key: "a", spendUt: 0.25 };
		expect(centreOf({ hot, total: 0.5, spending: 1, noun: "lane", startMs: null }).sub).toBe(
			"50.0% this range",
		);
	});

	it("refuses each bucket width and window edge it cannot bucket by, on its own", () => {
		const n = 24;
		expect(bucketAt(T0 + 1, WIN, 0, n)).toBeNull();
		expect(bucketAt(T0 + 1, WIN, -HOUR, n)).toBeNull();
		expect(bucketAt(T0 + 1, WIN, Number.NaN, n)).toBeNull();
		expect(bucketAt(T0, WIN, HOUR, -1)).toBeNull();
		const toForever = { startMs: T0, endMs: Number.POSITIVE_INFINITY };
		expect(bucketAt(T0, toForever, HOUR, n)).toBeNull();
		const fromForever = { startMs: Number.NEGATIVE_INFINITY, endMs: T0 + HOUR };
		expect(bucketAt(T0, fromForever, HOUR, n)).toBeNull();
		expect(bucketAt(T0, { startMs: Number.NaN, endMs: T0 + HOUR }, HOUR, n)).toBeNull();
		// One bucket is enough, and a bucket narrower than a millisecond is still a bucket.
		expect(bucketAt(T0, WIN, HOUR, 1)).toBe(0);
		expect(bucketAt(WIN.endMs, WIN, HOUR, 1)).toBe(0);
		expect(bucketAt(T0 + 1, { startMs: T0, endMs: T0 + 10 }, 0.5, 20)).toBe(2);
	});

	it("offers no additive click", async () => {
		const mod = await import("../src/shared/donut.js");
		expect(Object.keys(mod)).not.toContain("additive");
	});
});
