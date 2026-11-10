// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { hourSpanOf, msToX, nearestIndex, snapPx, xToMs } from "../src/shared/hit.js";

const HOUR = 3_600_000;

describe("nearestIndex", () => {
	const xs = [0, 10, 20];
	it("picks the closest, the earlier on a tie, and clamps at both ends", () => {
		expect(nearestIndex(xs, 4)).toBe(0);
		expect(nearestIndex(xs, 5)).toBe(0);
		expect(nearestIndex(xs, 6)).toBe(1);
		expect(nearestIndex(xs, -9)).toBe(0);
		expect(nearestIndex(xs, 99)).toBe(2);
	});
	it("returns -1 for an empty list or a NaN", () => {
		expect(nearestIndex([], 3)).toBe(-1);
		expect(nearestIndex(xs, Number.NaN)).toBe(-1);
	});
	it("reads a single value and a typed array", () => {
		expect(nearestIndex([7], 1000)).toBe(0);
		expect(nearestIndex(Float64Array.from([1, 2, 3, 4]), 3.4)).toBe(2);
	});
});

describe("time and pixel mapping", () => {
	const win = { startMs: Date.UTC(2026, 10, 1), endMs: Date.UTC(2026, 10, 8) };
	it("round-trips x through ms", () => {
		for (const x of [0, 13.5, 250, 481.25, 700]) {
			expect(msToX(xToMs(x, win, 700), win, 700)).toBeCloseTo(x, 6);
		}
	});
	it("clamps to the box", () => {
		expect(msToX(win.startMs - 5, win, 700)).toBe(0);
		expect(msToX(win.endMs + 5, win, 700)).toBe(700);
		expect(xToMs(-10, win, 700)).toBe(win.startMs);
		expect(xToMs(9999, win, 700)).toBe(win.endMs);
	});
	it("a zero-width box reads as the window's start", () => {
		expect(xToMs(5, win, 0)).toBe(win.startMs);
		expect(xToMs(0, win, 0)).toBe(win.startMs);
	});
	it("does not divide by zero on an empty box or window", () => {
		expect(Number.isFinite(msToX(win.startMs, win, 0))).toBe(true);
		expect(Number.isFinite(msToX(5, { startMs: 5, endMs: 5 }, 100))).toBe(true);
		expect(Number.isFinite(xToMs(5, win, 0))).toBe(true);
	});
});

describe("snapPx", () => {
	it("rounds to a device pixel", () => {
		expect(snapPx(10.3, 2)).toBe(10.5);
		expect(snapPx(10.3, 1)).toBe(10);
	});
	it("is never more than half a device pixel away", () => {
		let s = 12345;
		const rnd = () => {
			s = (s * 1664525 + 1013904223) % 4294967296;
			return s / 4294967296;
		};
		for (let i = 0; i < 50; i++) {
			const x = rnd() * 900;
			for (const d of [1, 1.25, 2]) {
				expect(Math.abs(snapPx(x, d) - x)).toBeLessThanOrEqual(0.5 / d + 1e-9);
			}
		}
	});
});

describe("hourSpanOf", () => {
	it("is the UTC hour holding the time", () => {
		expect(hourSpanOf(Date.UTC(2026, 10, 7, 13, 42, 5))).toEqual([
			Date.UTC(2026, 10, 7, 13),
			Date.UTC(2026, 10, 7, 14),
		]);
	});
	it("an exact boundary gives the hour that starts there", () => {
		expect(hourSpanOf(Date.UTC(2026, 10, 7, 14))).toEqual([
			Date.UTC(2026, 10, 7, 14),
			Date.UTC(2026, 10, 7, 15),
		]);
	});
	it("is always one hour wide, whole hours, never a slice of a bucket", () => {
		for (const ms of [0, 1, HOUR - 1, HOUR, Date.UTC(2026, 10, 7, 13, 59, 59, 999)]) {
			const [a, b] = hourSpanOf(ms);
			expect(b - a).toBe(HOUR);
			expect(a % HOUR).toBe(0);
			expect(a <= ms && ms < b).toBe(true);
		}
		// A 13-minute bucket straddling 14:00 starting 13:55: the cursor's record at 14:03 gets the 14:00 hour.
		expect(hourSpanOf(Date.UTC(2026, 10, 7, 14, 3))[0]).toBe(Date.UTC(2026, 10, 7, 14));
	});
});
