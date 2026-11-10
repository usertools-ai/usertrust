// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The share window's donut, as numbers: its fixed drawing box, the slice geometry, the tween, and the values, legend,
 * percentages and centre text, all read from one set of values. Pure.
 *
 * The ring is drawn once in a `VB` x `VB` box and sized by CSS. Angles are radians, clockwise from 12 o'clock. The
 * slices' angles have no gaps; the gaps are cut when a slice's path is built, half a gap either side of each boundary
 * at every radius, so the gap between two slices is a band of the same width all the way through the ring.
 */

import type { Breakdown, SpendWindow } from "./breakdown.js";
import { formatUsdTotal, formatUtcMinute } from "./format.js";

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

/**
 * A slice's four corners, outer and inner; null for an empty arc and for a whole turn (which `ringPath` and `rimPath`
 * draw as closed circles, with no straight edge).
 */
export function ringEdges(
	cx: number,
	cy: number,
	ro: number,
	ri: number,
	a0: number,
	a1: number,
	half: number,
): { o0: Pt; o1: Pt; i0: Pt; i1: Pt } | null {
	if (!(a1 > a0) || a1 - a0 >= FULL) return null;
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

/** `v` held to [0, 1]; `nan` when it is not a number. */
function unit(v: number, nan: 0 | 1): number {
	if (Number.isNaN(v)) return nan;
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Fast at first, settling at the end. */
export function easeOutCubic(p: number): number {
	const t = unit(p, 1);
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
	e = unit(e, 1);
	for (const [key, t] of to) {
		const mid = (t.a0 + t.a1) / 2;
		const f = from.get(key) ?? { a0: mid, a1: mid };
		out.set(key, { a0: f.a0 * (1 - e) + t.a0 * e, a1: f.a1 * (1 - e) + t.a1 * e });
	}
	return out;
}

/** What the ring draws: each key's arc, and how far each slice has grown outward. */
export interface RingShape {
	arcs: ReadonlyMap<string, Arc>;
	grow: ReadonlyMap<string, number>;
}

/** The shape at rest for `values` (one per key, in order): `sliceAngles`, and `GROW` for each key in focus. */
export function ringShape(
	keys: readonly string[],
	values: readonly number[],
	grown: (key: string) => boolean,
): RingShape {
	const angles = sliceAngles(keys.map((_, i) => values[i] ?? 0));
	const arcs = new Map<string, Arc>();
	const grow = new Map<string, number>();
	keys.forEach((key, i) => {
		arcs.set(key, angles[i] ?? { a0: 0, a1: 0 });
		grow.set(key, grown(key) ? GROW : 0);
	});
	return { arcs, grow };
}

/** A shape as text: equal for two shapes that draw alike, so a change of target can be told from a redraw. */
export function shapeKey(s: RingShape): string {
	const parts: string[] = [];
	for (const [key, arc] of s.arcs)
		parts.push(`${key}\u0000${arc.a0.toFixed(5)}:${arc.a1.toFixed(5)}:${s.grow.get(key) ?? 0}`);
	return parts.join("\u0001");
}

/**
 * The shape `e` of the way from `from` to `to`: the arcs as `blendArcs`, the growth alongside. A key the ring did not
 * have starts collapsed and not grown.
 */
export function blendShape(from: RingShape, to: RingShape, e: number): RingShape {
	const t = unit(e, 1);
	const grow = new Map<string, number>();
	for (const [key, g] of to.grow) grow.set(key, (from.grow.get(key) ?? 0) * (1 - t) + g * t);
	return { arcs: blendArcs(from.arcs, to.arcs, t), grow };
}

/**
 * A tween from the shape on screen to a new target, as a function of a frame's time. The clock starts at the first
 * frame it is asked for, so that frame draws `from` (no jump); it eases out over `ms` and ends on `to` itself. A time
 * that is not a number ends it, so a frame loop can never run on for ever.
 */
export function startTween(
	from: RingShape,
	to: RingShape,
	ms: number = TWEEN_MS,
): (now: number) => { shape: RingShape; done: boolean } {
	let t0: number | null = null;
	return (now) => {
		if (t0 === null) t0 = now;
		const p = ms > 0 && Number.isFinite(ms) ? (now - t0) / ms : 1;
		if (!(p < 1)) return { shape: to, done: true };
		return { shape: blendShape(from, to, easeOutCubic(p)), done: false };
	};
}

/** What the legend says when nothing in the range is spend. */
export const SHARE_EMPTY = "No spend in this range";

/** The values the window shows, one per key that spent in the range, in spend order; `total` is their sum. */
export interface ShareValues {
	keys: string[];
	values: number[];
	total: number;
}

/**
 * The breakdown's spend per key over its window, or, at a moment, bucket `k` of `buckets` (`categoryRows` over the
 * same rows and window). The keys are the breakdown's that spent more than zero in the range, in its order, at a
 * moment too: a moment never reorders the ring, and a key that spent nothing in that bucket reads 0.
 */
export function shareValues(
	bd: Breakdown,
	buckets: ReadonlyMap<string, Float64Array> | null,
	k: number | null,
): ShareValues {
	const keys = bd.keys.filter((key) => (bd.byKey.get(key)?.spendUt ?? 0) > 0);
	const values = keys.map((key) =>
		buckets === null || k === null
			? (bd.byKey.get(key)?.spendUt ?? 0)
			: (buckets.get(key)?.[k] ?? 0),
	);
	let total = 0;
	for (const v of values) total += v;
	return { keys, values, total };
}

/**
 * The bucket a moment falls in: `floor((ms - startMs) / bucketMs)`, the end of the window (or an index past `n`) in the
 * last bucket. Null outside the window, for a window or bucket that cannot be bucketed, or with no buckets.
 */
export function bucketAt(ms: number, win: SpendWindow, bucketMs: number, n: number): number | null {
	if (n <= 0 || !(bucketMs > 0) || !Number.isFinite(win.startMs) || !Number.isFinite(win.endMs))
		return null;
	if (!(ms >= win.startMs && ms <= win.endMs)) return null;
	return Math.min(n - 1, Math.floor((ms - win.startMs) / bucketMs));
}

/** Bucket `k`'s first instant. */
export function bucketStartMs(win: SpendWindow, bucketMs: number, k: number): number {
	return win.startMs + k * bucketMs;
}

const minute = (ms: number): string => formatUtcMinute(new Date(ms).toISOString());

/** A moment we can name: a finite time inside the range `Date` can print. */
const named = (ms: number | null): ms is number =>
	ms !== null && Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime());

/** The centre's first line at a moment: "At 2026-11-07 18:00Z"; "This range" when the time is not a real one. */
export function atTime(startMs: number): string {
	return named(startMs) ? `At ${minute(startMs)}` : "This range";
}

/** When the values are read: "at 2026-11-07 18:00Z" at a moment, "this range" for the range or an unreal time. */
export function atWhen(startMs: number | null): string {
	return named(startMs) ? `at ${minute(startMs)}` : "this range";
}

export interface LegendRow {
	key: string;
	spendUt: number;
	share: number;
}

/**
 * The legend: every key when at most one would be left over (a lone leftover is shown as itself), else the first
 * `limit` and the rest folded into one Other line. A share is 0 when there is no spend.
 */
export function legendOf(
	v: ShareValues,
	limit = LEGEND_ROWS,
): { rows: LegendRow[]; other: { count: number; spendUt: number; share: number } | null } {
	const share = (ut: number): number => (v.total > 0 ? ut / v.total : 0);
	const shown = v.keys.length <= limit + 1 ? v.keys.length : limit;
	const rows = v.keys.slice(0, shown).map((key, i) => {
		const spendUt = v.values[i] ?? 0;
		return { key, spendUt, share: share(spendUt) };
	});
	if (shown === v.keys.length) return { rows, other: null };
	let rest = 0;
	for (const x of v.values.slice(shown)) rest += x;
	return { rows, other: { count: v.keys.length - shown, spendUt: rest, share: share(rest) } };
}

/**
 * A share as a percent, whole or to one decimal. A nonzero share never prints as zero: it reads "<1%" ("<0.1%"); and
 * a share short of all of it never prints as all of it: it reads ">99%" (">99.9%").
 */
export function formatShare(share: number, decimals: 0 | 1): string {
	share = unit(share, 0);
	if (share === 0) return decimals === 0 ? "0%" : "0.0%";
	const pct = share * 100;
	if (decimals === 0) {
		const whole = Math.round(pct);
		if (whole === 0) return "<1%";
		return share < 1 && whole >= 100 ? ">99%" : `${whole}%`;
	}
	const tenth = pct.toFixed(1);
	if (Number(tenth) === 0) return "<0.1%";
	return share < 1 && Number(tenth) >= 100 ? ">99.9%" : `${tenth}%`;
}

/** A legend row's tooltip: its dollars and share, when they were read, and what a click does. */
export function legendTitle(name: string, spendUt: number, share: number, when: string): string {
	return `${name}: ${formatUsdTotal(spendUt)}, ${formatShare(share, 1)} ${when}. Click to filter the desk to it.`;
}

/**
 * The centre's three lines. With a lit key: its name, its dollars, its share and when. Without: the moment ("At
 * <time>") or "This range", the shown total, and how many categories spent. `startMs` is the shown bucket's start,
 * null for the range.
 */
export function centreOf(a: {
	hot: { key: string; spendUt: number } | null;
	total: number;
	spending: number;
	noun: string;
	startMs: number | null;
}): { name: string; amount: string; sub: string } {
	const { hot, total, startMs } = a;
	if (hot !== null) {
		const share = total > 0 ? hot.spendUt / total : 0;
		return {
			name: hot.key,
			amount: formatUsdTotal(hot.spendUt),
			sub: `${formatShare(share, 1)} ${atWhen(startMs)}`,
		};
	}
	return {
		name: startMs === null ? "This range" : atTime(startMs),
		amount: formatUsdTotal(total),
		sub: `${a.spending} ${a.noun}${a.spending === 1 ? "" : "s"}`,
	};
}
