// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { lttb, monotone } from "../src/shared/curve.js";

/** A flat series with one spike at `at`. */
function spiky(n: number, at: number, height: number): { xs: number[]; ys: number[] } {
	const xs = Array.from({ length: n }, (_, i) => i);
	const ys = xs.map((i) => (i === at ? height : (i % 3) * 0.1));
	return { xs, ys };
}

describe("lttb", () => {
	it("keeps a lone spike next to the last point, for every length and target", () => {
		const lost: string[] = [];
		for (let n = 10; n <= 120; n++) {
			const xs = Array.from({ length: n }, (_, i) => i);
			for (let target = 4; target < n; target++) {
				for (const at of [n - 2, n - 3]) {
					const ys = xs.map((i) => (i === at ? 100 : 0));
					const kept = lttb(xs, ys, target);
					expect(kept.length).toBe(target);
					if (!kept.includes(at)) lost.push(`n=${n} target=${target} at=${at}`);
				}
			}
		}
		expect(lost).toEqual([]);
	});

	it("keeps the spike in the case that divides unevenly (17 points, 13 kept)", () => {
		const xs = Array.from({ length: 17 }, (_, i) => i);
		const ys = xs.map((i) => (i === 15 ? 100 : 0));
		expect(lttb(xs, ys, 13)).toContain(15);
	});

	it("keeps the global maximum of a series with one spike", () => {
		for (const at of [7, 250, 499, 733]) {
			const { xs, ys } = spiky(1000, at, 500);
			const kept = lttb(xs, ys, 60);
			expect(kept).toContain(at);
			expect(Math.max(...kept.map((i) => ys[i] as number))).toBe(500);
		}
	});

	it("always keeps the first and last point, in order, and no more than asked", () => {
		const { xs, ys } = spiky(1000, 400, 50);
		const kept = lttb(xs, ys, 40);
		expect(kept[0]).toBe(0);
		expect(kept[kept.length - 1]).toBe(999);
		expect(kept.length).toBe(40);
		for (let i = 1; i < kept.length; i++) expect(kept[i]).toBeGreaterThan(kept[i - 1] as number);
	});

	it("returns every index when there is nothing to thin", () => {
		const { xs, ys } = spiky(10, 4, 9);
		expect(lttb(xs, ys, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(lttb(xs, ys, 500)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(lttb([], [], 5)).toEqual([]);
		expect(lttb([3], [1], 5)).toEqual([0]);
	});

	it("keeps just the two ends when asked for fewer than three", () => {
		const { xs, ys } = spiky(100, 50, 9);
		expect(lttb(xs, ys, 2)).toEqual([0, 99]);
	});
});

describe("monotone", () => {
	const xs = [0, 10, 20, 30, 40, 50, 60];
	const ys = [0, 0, 8, 8, 1, 1, 30];

	it("stays within the range of its two neighbouring points", () => {
		const c = monotone(xs, ys);
		for (let i = 0; i < xs.length - 1; i++) {
			const lo = Math.min(ys[i] as number, ys[i + 1] as number);
			const hi = Math.max(ys[i] as number, ys[i + 1] as number);
			for (let s = 0; s <= 20; s++) {
				const x = (xs[i] as number) + ((xs[i + 1] as number) - (xs[i] as number)) * (s / 20);
				const y = c.at(x);
				expect(y).toBeGreaterThanOrEqual(lo - 1e-9);
				expect(y).toBeLessThanOrEqual(hi + 1e-9);
			}
		}
	});

	it("passes through every point and holds the ends flat beyond them", () => {
		const c = monotone(xs, ys);
		for (let i = 0; i < xs.length; i++)
			expect(c.at(xs[i] as number)).toBeCloseTo(ys[i] as number, 9);
		expect(c.at(-5)).toBe(0);
		expect(c.at(500)).toBe(30);
	});

	it("never dips below zero for non-negative data", () => {
		const c = monotone([0, 1, 2, 3, 4], [0, 0, 100, 0, 0]);
		for (let x = 0; x <= 4; x += 0.05) expect(c.at(x)).toBeGreaterThanOrEqual(0);
	});

	it("draws one move and one cubic per segment", () => {
		const d = monotone(xs, ys).path();
		expect(d.startsWith("M0 0")).toBe(true);
		expect(d.match(/C/g)?.length).toBe(xs.length - 1);
		expect(d).not.toMatch(/NaN|Infinity/);
	});

	it("handles no points, one point and a repeated x without NaN", () => {
		expect(monotone([], []).path()).toBe("");
		expect(monotone([], []).at(3)).toBe(0);
		const one = monotone([5], [7]);
		expect(one.path()).toBe("M5 7");
		expect(one.at(0)).toBe(7);
		const same = monotone([0, 5, 5, 10], [0, 1, 4, 4]);
		expect(same.path()).not.toMatch(/NaN|Infinity/);
		for (let x = 0; x <= 10; x += 0.5) expect(Number.isFinite(same.at(x))).toBe(true);
	});
});
