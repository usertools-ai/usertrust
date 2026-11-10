// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/** Which hover the Share window's legend owns: it clears only one it published, and shows the pointer's row before the focused one. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { latestHoverCategory, setHoverCategory } from "../src/app/desk/use-hover.js";
import {
	createHoverOwner,
	type HoverIo,
	isOurs,
	LEGEND_FROM,
	rowToShow,
} from "../src/app/windows/share/legend-hover.js";
import type { HoverCategory } from "../src/shared/hover-bus.js";
import { categoryBus } from "../src/shared/hover-bus.js";

describe("the legend's hover", () => {
	it("shows the row under the pointer, else the focused row, else none", () => {
		expect(rowToShow("b", "a")).toBe("b");
		expect(rowToShow("b", null)).toBe("b");
		expect(rowToShow(null, "a")).toBe("a");
		expect(rowToShow(null, null)).toBeNull();
	});

	it("owns the hover on the bus only when it is the one it published, at its level", () => {
		const ours = { dim: "lane", key: "a", from: LEGEND_FROM } as const;
		expect(isOurs(ours, "lane", "a")).toBe(true);
		expect(isOurs(null, "lane", "a")).toBe(false);
		expect(isOurs(ours, "lane", null)).toBe(false);
		// A hover another window or the ring set is not the legend's to clear, even on the same key.
		expect(isOurs({ ...ours, from: "share" }, "lane", "a")).toBe(false);
		expect(isOurs({ ...ours, from: "spend" }, "lane", "a")).toBe(false);
		expect(isOurs({ ...ours, key: "b" }, "lane", "a")).toBe(false);
		expect(isOurs({ ...ours, dim: "model" }, "lane", "a")).toBe(false);
		expect(LEGEND_FROM).not.toBe("share");
	});
});

/** A bus whose writes land a frame late, as the desk's do: `sent` is what was handed over, `shown` what the frame flushed. */
function deferredIo(): {
	io: HoverIo;
	sent: Array<HoverCategory | null>;
	shown: () => HoverCategory | null;
	flush: () => void;
	other: (c: HoverCategory | null) => void;
} {
	const sent: Array<HoverCategory | null> = [];
	let latest: HoverCategory | null = null;
	let shown: HoverCategory | null = null;
	const set = (c: HoverCategory | null): void => {
		sent.push(c);
		latest = c;
	};
	return {
		io: { set, latest: () => latest },
		sent,
		shown: () => shown,
		flush: () => {
			shown = latest;
		},
		other: set,
	};
}

const mine = (key: string): HoverCategory => ({ dim: "lane", key, from: LEGEND_FROM });

describe("the legend's hover owner", () => {
	it("clears a hover the pointer set and left inside one frame, before the frame shows it", () => {
		const t = deferredIo();
		const owner = createHoverOwner(t.io, "lane");
		owner.enter("a");
		owner.leave();
		t.flush();
		expect(t.sent).toEqual([mine("a"), null]);
		expect(t.shown()).toBeNull();
	});

	it("leaves a hover another window or the ring set, even one still waiting for its frame", () => {
		const t = deferredIo();
		const owner = createHoverOwner(t.io, "lane");
		owner.focus("a");
		t.other({ dim: "lane", key: "slice", from: "share" });
		owner.blur();
		t.flush();
		expect(t.sent).toEqual([mine("a"), { dim: "lane", key: "slice", from: "share" }]);
		expect(t.shown()).toEqual({ dim: "lane", key: "slice", from: "share" });
	});

	it("shows the pointer's row over the focused one and falls back to the one still held", () => {
		const t = deferredIo();
		const owner = createHoverOwner(t.io, "lane");
		owner.focus("a");
		owner.enter("b");
		expect(t.sent.at(-1)).toEqual(mine("b"));
		owner.leave();
		expect(t.sent.at(-1)).toEqual(mine("a"));
		owner.enter("b");
		owner.blur();
		expect(t.sent.at(-1)).toEqual(mine("b"));
		owner.leave();
		expect(t.sent.at(-1)).toBeNull();
	});

	it("hands the hover on, or clears it, when the row it shows is gone", () => {
		const t = deferredIo();
		const owner = createHoverOwner(t.io, "lane");
		owner.enter("a");
		owner.focus("b");
		owner.rows(["b", "c"]);
		expect(t.sent.at(-1)).toEqual(mine("b"));
		owner.rows(["c"]);
		expect(t.sent.at(-1)).toBeNull();
		const n = t.sent.length;
		owner.rows(["c", "d"]);
		expect(t.sent).toHaveLength(n);
	});

	it("clears its own hover when disposed, and only then", () => {
		const t = deferredIo();
		const owner = createHoverOwner(t.io, "lane");
		owner.dispose();
		expect(t.sent).toEqual([]);
		owner.enter("a");
		owner.dispose();
		expect(t.sent).toEqual([mine("a"), null]);
	});
});

describe("the hover the desk is about to show", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		categoryBus.set(null);
	});

	it("is the last one set, before the frame has put it on the bus", () => {
		const queue: Array<() => void> = [];
		vi.stubGlobal("requestAnimationFrame", (fn: () => void) => queue.push(fn));
		const c: HoverCategory = { dim: "lane", key: "x", from: "spend" };
		setHoverCategory(c);
		expect(latestHoverCategory()).toEqual(c);
		expect(categoryBus.get()).toBeNull();
		for (const fn of queue.splice(0)) fn();
		expect(categoryBus.get()).toEqual(c);
		setHoverCategory(null);
		expect(latestHoverCategory()).toBeNull();
		expect(categoryBus.get()).toEqual(c);
		for (const fn of queue.splice(0)) fn();
		expect(categoryBus.get()).toBeNull();
	});
});
