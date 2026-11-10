// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	type Arc,
	blendArcs,
	easeOutCubic,
	HALF_GAP,
	INNER,
	type Pt,
	rimPath,
	ringEdges,
	ringPath,
	SLIVER,
	sliceAngles,
} from "../src/shared/donut.js";

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
});
