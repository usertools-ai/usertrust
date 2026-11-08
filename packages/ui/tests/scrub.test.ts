// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { COMMIT_IDLE_MS, Scrubber, type ScrubIo } from "../src/shared/scrub.js";

/** Frames and timers the test runs by hand. */
function harness() {
	const frames: Array<() => void> = [];
	const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	const io: ScrubIo = {
		frame(fn) {
			frames.push(fn);
			return () => {
				const i = frames.indexOf(fn);
				if (i >= 0) frames.splice(i, 1);
			};
		},
		later(fn, ms) {
			const t = { fn, ms, cancelled: false };
			timers.push(t);
			return () => {
				t.cancelled = true;
			};
		},
	};
	const previews: number[] = [];
	const commits: number[] = [];
	const active: boolean[] = [];
	const scrub = new Scrubber(
		io,
		(p) => previews.push(p),
		(p) => commits.push(p),
		(a) => active.push(a),
	);
	const runFrame = (): void => {
		for (const fn of frames.splice(0)) fn();
	};
	const runIdle = (): void => {
		for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
	};
	return { scrub, frames, timers, previews, commits, active, runFrame, runIdle };
}

describe("Scrubber", () => {
	it("a drag is previewed at most once a frame, with the latest position", () => {
		const h = harness();
		h.scrub.move(10);
		h.scrub.move(11);
		h.scrub.move(12);
		expect(h.frames).toHaveLength(1);
		expect(h.previews).toEqual([]);
		h.runFrame();
		expect(h.previews).toEqual([12]);
		h.scrub.move(13);
		h.runFrame();
		expect(h.previews).toEqual([12, 13]);
		// Nothing is written to the address while the drag goes on.
		expect(h.commits).toEqual([]);
	});

	it("release commits the latest position once, and a second release does nothing", () => {
		const h = harness();
		h.scrub.move(10);
		h.scrub.move(20);
		h.scrub.release();
		expect(h.previews).toEqual([20]);
		expect(h.commits).toEqual([20]);
		// The frame that was pending is cancelled: it does not preview again.
		expect(h.frames).toHaveLength(0);
		h.scrub.release();
		expect(h.commits).toEqual([20]);
	});

	it(`${COMMIT_IDLE_MS} ms without a move commits on its own`, () => {
		const h = harness();
		h.scrub.move(5);
		h.scrub.move(6);
		// Each move re-arms the idle timer; only the last one is live.
		expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(1);
		expect(h.timers.every((t) => t.ms === COMMIT_IDLE_MS)).toBe(true);
		h.runIdle();
		expect(h.commits).toEqual([6]);
	});

	it("cancel drops a pending move: going live while dragging writes nothing", () => {
		const h = harness();
		h.scrub.move(5);
		h.scrub.cancel();
		h.runFrame();
		h.runIdle();
		expect(h.previews).toEqual([]);
		expect(h.commits).toEqual([]);
		expect(h.scrub.pending).toBeNull();
	});

	it("an outside change to the address (Back, Forward, a link) drops a pending commit", () => {
		const h = harness();
		h.scrub.move(5);
		// The address moved to 30 without this drag writing it.
		h.scrub.sync(30);
		h.runFrame();
		h.runIdle();
		expect(h.commits).toEqual([]);
		expect(h.scrub.pending).toBeNull();
	});

	it("its own commit coming back as the address is not an outside change", () => {
		const h = harness();
		h.scrub.move(5);
		h.runIdle();
		expect(h.commits).toEqual([5]);
		// The drag goes on, then the address catches up with the commit it wrote.
		h.scrub.move(6);
		h.scrub.sync(5);
		h.scrub.release();
		expect(h.commits).toEqual([5, 6]);
	});

	it("says when a drag starts and ends: once each, on the first move and on release, idle, cancel or an outside change", () => {
		const h = harness();
		h.scrub.move(1);
		h.scrub.move(2);
		expect(h.active).toEqual([true]);
		h.scrub.release();
		expect(h.active).toEqual([true, false]);
		h.scrub.move(3);
		h.runIdle();
		expect(h.active).toEqual([true, false, true, false]);
		h.scrub.move(4);
		h.scrub.cancel();
		h.scrub.move(5);
		h.scrub.sync(40);
		expect(h.active).toEqual([true, false, true, false, true, false, true, false]);
		// Nothing pending: a release or cancel says nothing.
		h.scrub.release();
		h.scrub.cancel();
		expect(h.active).toHaveLength(8);
	});
});

describe("Scrubber: an external navigation", () => {
	it("drops a pending move even when the address's position is the one the drag started from (both entries live)", () => {
		const h = harness();
		// Live Audit to live Trends: the address says "live" (null) before and after.
		h.scrub.sync(null);
		h.scrub.move(5);
		h.scrub.navigated(null);
		h.runFrame();
		h.runIdle();
		expect(h.previews).toEqual([]);
		expect(h.commits).toEqual([]);
		expect(h.scrub.pending).toBeNull();
		expect(h.active).toEqual([true, false]);
	});

	it("drops a pending move when the destination holds the same position the drag last wrote", () => {
		const h = harness();
		h.scrub.move(5);
		h.scrub.release();
		expect(h.commits).toEqual([5]);
		h.scrub.move(9);
		h.scrub.navigated(5);
		h.runFrame();
		h.runIdle();
		expect(h.commits).toEqual([5]);
		expect(h.scrub.pending).toBeNull();
	});

	it("says nothing when nothing was pending, and a later drag is a new gesture that commits", () => {
		const h = harness();
		h.scrub.navigated(null);
		expect(h.active).toEqual([]);
		h.scrub.move(7);
		h.runIdle();
		expect(h.commits).toEqual([7]);
	});

	it("the address catching up with the destination afterwards is not a second cancel of a new drag", () => {
		const h = harness();
		h.scrub.move(3);
		h.scrub.navigated(40);
		h.scrub.move(41);
		// The page's own sync effect for the same destination runs after the drag restarted.
		h.scrub.sync(40);
		expect(h.scrub.pending).toBe(41);
		h.scrub.release();
		expect(h.commits).toEqual([41]);
	});
});
