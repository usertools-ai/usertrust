// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Helpers for DRAWING a line. Pure. Every number the page shows is computed from the records, never read off these
 * curves, so nothing here changes a figure: it only changes how a series of points is drawn.
 *
 * - `lttb`: Largest-Triangle-Three-Buckets thinning. It keeps the shape of a long series (and always its peaks) when
 *   there are more points than the screen has room for.
 * - `monotone`: a monotone cubic through the points. It never overshoots, so it never dips below a valley or invents a
 *   peak between two points; `path` draws it and `at` reads the same curve, so a marker sits exactly on the stroke.
 */

/**
 * The indices LTTB keeps from a series of `target` points or more: always the first and the last, and from each bucket
 * between them the point that makes the largest triangle with its neighbours (so a lone spike survives). With `target`
 * at or above the series length, every index is kept; below three, only the two ends.
 */
export function lttb(xs: ArrayLike<number>, ys: ArrayLike<number>, target: number): number[] {
	const n = Math.min(xs.length, ys.length);
	if (n <= 2 || target >= n) return Array.from({ length: n }, (_, i) => i);
	if (target < 3) return [0, n - 1];
	const keep = [0];
	const every = (n - 2) / (target - 2);
	let a = 0;
	for (let b = 0; b < target - 2; b++) {
		// The average point of the next bucket: the far corner of every triangle in this one.
		const nextStart = Math.floor((b + 1) * every) + 1;
		const nextEnd = Math.min(n, Math.floor((b + 2) * every) + 1);
		let cx = 0;
		let cy = 0;
		for (let j = nextStart; j < nextEnd; j++) {
			cx += xs[j] as number;
			cy += ys[j] as number;
		}
		const count = Math.max(1, nextEnd - nextStart);
		cx /= count;
		cy /= count;
		const start = Math.floor(b * every) + 1;
		const end = Math.min(n - 1, Math.floor((b + 1) * every) + 1);
		const ax = xs[a] as number;
		const ay = ys[a] as number;
		let best = -1;
		let bestAt = start;
		for (let j = start; j < end; j++) {
			const area = Math.abs(
				(ax - cx) * ((ys[j] as number) - ay) - (ax - (xs[j] as number)) * (cy - ay),
			);
			if (area > best) {
				best = area;
				bestAt = j;
			}
		}
		keep.push(bestAt);
		a = bestAt;
	}
	keep.push(n - 1);
	return keep;
}

export interface MonotoneCurve {
	/** The curve as SVG path data: a move to the first point, then one cubic bezier per segment. "" for no points. */
	path(): string;
	/** The curve's y at `x`: the same cubic `path` draws, held flat beyond the first and last point. */
	at(x: number): number;
}

const fixed = (v: number): string => (Math.round(v * 100) / 100).toString();

/**
 * A monotone cubic Hermite curve through the points, which must be in increasing x (a repeated x is tolerated). The
 * tangents are Fritsch-Butland: a flat tangent at every turn or flat side, so the curve never leaves the range of the
 * two points it runs between.
 */
export function monotone(xs: ArrayLike<number>, ys: ArrayLike<number>): MonotoneCurve {
	const n = Math.min(xs.length, ys.length);
	const X = Float64Array.from({ length: n }, (_, i) => xs[i] as number);
	const Y = Float64Array.from({ length: n }, (_, i) => ys[i] as number);
	const M = new Float64Array(n);
	if (n >= 2) {
		const slope = new Float64Array(n - 1);
		for (let i = 0; i < n - 1; i++) {
			const h = (X[i + 1] as number) - (X[i] as number);
			slope[i] = h > 0 ? ((Y[i + 1] as number) - (Y[i] as number)) / h : 0;
		}
		M[0] = slope[0] as number;
		M[n - 1] = slope[n - 2] as number;
		for (let i = 1; i < n - 1; i++) {
			const a = slope[i - 1] as number;
			const b = slope[i] as number;
			if (a * b <= 0) {
				M[i] = 0;
				continue;
			}
			const h0 = (X[i] as number) - (X[i - 1] as number);
			const h1 = (X[i + 1] as number) - (X[i] as number);
			const w1 = 2 * h1 + h0;
			const w2 = h1 + 2 * h0;
			M[i] = (w1 + w2) / (w1 / a + w2 / b);
		}
		// Never steeper than three times either neighbouring slope: the bound that keeps each segment monotone.
		for (let i = 0; i < n - 1; i++) {
			const d = slope[i] as number;
			if (d === 0) {
				M[i] = 0;
				M[i + 1] = 0;
				continue;
			}
			const p = (M[i] as number) / d;
			const q = (M[i + 1] as number) / d;
			const s = p * p + q * q;
			if (s > 9) {
				const t = 3 / Math.sqrt(s);
				M[i] = t * p * d;
				M[i + 1] = t * q * d;
			}
		}
	}

	return {
		path(): string {
			if (n === 0) return "";
			let d = `M${fixed(X[0] as number)} ${fixed(Y[0] as number)}`;
			for (let i = 0; i < n - 1; i++) {
				const x0 = X[i] as number;
				const x1 = X[i + 1] as number;
				const y0 = Y[i] as number;
				const y1 = Y[i + 1] as number;
				const h = (x1 - x0) / 3;
				d += `C${fixed(x0 + h)} ${fixed(y0 + h * (M[i] as number))} ${fixed(x1 - h)} ${fixed(y1 - h * (M[i + 1] as number))} ${fixed(x1)} ${fixed(y1)}`;
			}
			return d;
		},
		at(x: number): number {
			if (n === 0) return 0;
			if (x <= (X[0] as number)) return Y[0] as number;
			if (x >= (X[n - 1] as number)) return Y[n - 1] as number;
			let lo = 0;
			let hi = n - 1;
			while (hi - lo > 1) {
				const mid = (lo + hi) >>> 1;
				if ((X[mid] as number) <= x) lo = mid;
				else hi = mid;
			}
			const h = (X[hi] as number) - (X[lo] as number);
			if (h <= 0) return Y[lo] as number;
			const t = (x - (X[lo] as number)) / h;
			const t2 = t * t;
			const t3 = t2 * t;
			return (
				(2 * t3 - 3 * t2 + 1) * (Y[lo] as number) +
				(t3 - 2 * t2 + t) * h * (M[lo] as number) +
				(-2 * t3 + 3 * t2) * (Y[hi] as number) +
				(t3 - t2) * h * (M[hi] as number)
			);
		},
	};
}
