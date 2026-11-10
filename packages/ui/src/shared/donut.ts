// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The share window's donut, as numbers: its fixed drawing box, the slice geometry and the tween. Pure.
 *
 * The ring is drawn once in a `VB` x `VB` box and sized by CSS. Angles are radians, clockwise from 12 o'clock. The
 * slices' angles have no gaps; the gaps are cut when a slice's path is built, half a gap either side of each boundary
 * at every radius, so the gap between two slices is a band of the same width all the way through the ring.
 */

/** The drawing box's side. */
export const VB = 300;
/** The inner radius as a share of the outer. */
export const INNER = 0.62;
/** How far the slice in focus grows outward. */
export const GROW = 7;
/** Half of every gap between slices. */
export const HALF_GAP = 2.2;
/** Every body is outlined in its own hue, inset this far so the outline stays inside it. */
export const OUTLINE_INSET = 0.5;
/** The width of a slice too thin to keep a body, so it can still be seen and clicked. */
export const SLIVER = 2;
/** The rim along a slice's outer edge, at rest and in focus. */
export const RIM_W = 2.2;
export const RIM_W_HOT = 3;
/** The tween between two sets of angles. */
export const TWEEN_MS = 240;
/** The legend lists this many categories, then the rest as one "Other" line. */
export const LEGEND_ROWS = 5;
/**
 * The body's shading: [position in the band (0 outer, 1 inner), opacity]. It never fades to nothing, so every slice
 * keeps its shape; in focus it rises.
 */
export const FADE: ReadonlyArray<readonly [number, number]> = [
	[0, 0.56],
	[0.35, 0.32],
	[0.7, 0.18],
	[1, 0.1],
];
export const FADE_HOT: ReadonlyArray<readonly [number, number]> = [
	[0, 0.8],
	[0.35, 0.5],
	[0.7, 0.3],
	[1, 0.17],
];

const TAU = Math.PI * 2;
/** A slice at least this close to a whole turn is the whole ring. */
const FULL = TAU - 1e-6;

export interface Arc {
	a0: number;
	a1: number;
}

export interface Pt {
	x: number;
	y: number;
}

/**
 * Each value's arc, in order, filling the turn with no gaps. A value that is not positive is collapsed at its start;
 * with nothing positive every arc is `{0, 0}`.
 */
export function sliceAngles(values: readonly number[]): Arc[] {
	const v = values.map((x) => (x > 0 ? x : 0));
	let total = 0;
	for (const x of v) total += x;
	if (!(total > 0) || !Number.isFinite(total)) return v.map(() => ({ a0: 0, a1: 0 }));
	let sum = 0;
	return v.map((x) => {
		const a0 = (sum / total) * TAU;
		sum += x;
		return { a0, a1: x > 0 ? (sum / total) * TAU : a0 };
	});
}

/**
 * The two edge angles of a slice at radius `r`: half a gap in from each boundary (`asin(half / r)`), or, where that
 * leaves the body narrower than `SLIVER`, a sliver `SLIVER` wide centred on the mid-angle.
 */
function edgeAngles(r: number, a0: number, a1: number, half: number): [number, number] {
	const d = Math.asin(Math.min(1, half / r));
	const s = Math.asin(Math.min(1, SLIVER / 2 / r));
	if (a1 - a0 - 2 * d >= 2 * s) return [a0 + d, a1 - d];
	const mid = (a0 + a1) / 2;
	return [mid - s, mid + s];
}

const at = (cx: number, cy: number, r: number, a: number): Pt => ({
	x: cx + r * Math.sin(a),
	y: cy - r * Math.cos(a),
});

/** A number in a path: two decimals at most. */
const num = (v: number): string => String(Math.round(v * 100) / 100);
const pt = (p: Pt): string => `${num(p.x)},${num(p.y)}`;

/** A slice's four corners, outer and inner; null for an empty arc. */
export function ringEdges(
	cx: number,
	cy: number,
	ro: number,
	ri: number,
	a0: number,
	a1: number,
	half: number,
): { o0: Pt; o1: Pt; i0: Pt; i1: Pt } | null {
	if (!(a1 > a0)) return null;
	const [o0, o1] = edgeAngles(ro, a0, a1, half);
	const [i0, i1] = edgeAngles(ri, a0, a1, half);
	return {
		o0: at(cx, cy, ro, o0),
		o1: at(cx, cy, ro, o1),
		i0: at(cx, cy, ri, i0),
		i1: at(cx, cy, ri, i1),
	};
}

/** A whole circle as two half arcs, closed. */
function circle(cx: number, cy: number, r: number): string {
	const top = `${num(cx)},${num(cy - r)}`;
	const bottom = `${num(cx)},${num(cy + r)}`;
	return `M${top}A${num(r)},${num(r)} 0 1 1 ${bottom}A${num(r)},${num(r)} 0 1 1 ${top}Z`;
}

/**
 * A slice's body: the ring between `ri` and `ro` from `a0` to `a1`, gaps cut. A whole turn is the full annulus (two
 * circles, to be filled with `evenodd`, no gap); an empty arc is no path.
 */
export function ringPath(
	cx: number,
	cy: number,
	ro: number,
	ri: number,
	a0: number,
	a1: number,
	half: number,
): string {
	if (a1 - a0 >= FULL) return circle(cx, cy, ro) + circle(cx, cy, ri);
	if (!(a1 > a0)) return "";
	const [o0, o1] = edgeAngles(ro, a0, a1, half);
	const [i0, i1] = edgeAngles(ri, a0, a1, half);
	const R = num(ro);
	const r = num(ri);
	return (
		`M${pt(at(cx, cy, ro, o0))}A${R},${R} 0 ${o1 - o0 > Math.PI ? 1 : 0} 1 ${pt(at(cx, cy, ro, o1))}` +
		`L${pt(at(cx, cy, ri, i1))}A${r},${r} 0 ${i1 - i0 > Math.PI ? 1 : 0} 0 ${pt(at(cx, cy, ri, i0))}Z`
	);
}

/** A slice's rim: the arc at radius `r` between the same gap edges as its body; a whole turn is a whole circle. */
export function rimPath(
	cx: number,
	cy: number,
	r: number,
	a0: number,
	a1: number,
	half: number,
): string {
	if (a1 - a0 >= FULL) return circle(cx, cy, r);
	if (!(a1 > a0)) return "";
	const [b0, b1] = edgeAngles(r, a0, a1, half);
	return `M${pt(at(cx, cy, r, b0))}A${num(r)},${num(r)} 0 ${b1 - b0 > Math.PI ? 1 : 0} 1 ${pt(at(cx, cy, r, b1))}`;
}

/** Fast at first, settling at the end. */
export function easeOutCubic(p: number): number {
	const t = p < 0 ? 0 : p > 1 ? 1 : p;
	return 1 - (1 - t) ** 3;
}

/**
 * The arcs `e` of the way from `from` to `to` (0: `from`, 1: `to`, exactly), for every key of `to`. A key not in
 * `from` starts collapsed at the midpoint of its target; a key not in `to` is gone.
 */
export function blendArcs(
	from: ReadonlyMap<string, Arc>,
	to: ReadonlyMap<string, Arc>,
	e: number,
): Map<string, Arc> {
	const out = new Map<string, Arc>();
	for (const [key, t] of to) {
		const mid = (t.a0 + t.a1) / 2;
		const f = from.get(key) ?? { a0: mid, a1: mid };
		out.set(key, { a0: f.a0 * (1 - e) + t.a0 * e, a1: f.a1 * (1 - e) + t.a1 * e });
	}
	return out;
}
