// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	categoryBus,
	createBus,
	frameLimited,
	type HoverMoment,
	momentBus,
} from "../src/shared/hover-bus.js";

// use-hover is a .ts file under src/app, which the tests' tsconfig does not cover: load it by a computed path.
interface UseHover {
	useHoverMoment(self: string): { ms: number; span: [number, number] } | null;
	useHoverCategory(): { dim: string; key: string } | null;
	setHoverMoment(m: HoverMoment): void;
}
let hover: UseHover;
beforeAll(async () => {
	hover = (await import(/* @vite-ignore */ "../src/app/desk/use-hover.js")) as UseHover;
});

afterEach(() => {
	momentBus.set(null);
	categoryBus.set(null);
	vi.unstubAllGlobals();
});

describe("createBus", () => {
	it("starts empty", () => {
		expect(createBus<{ a: number }>().get()).toBeNull();
	});

	it("does not notify when the value set has the same fields", () => {
		const bus = createBus<HoverMoment>();
		const fn = vi.fn();
		bus.subscribe(fn);
		bus.set({ ms: 1, span: [0, 2], from: "a" });
		bus.set({ ms: 1, span: [0, 2], from: "a" });
		expect(fn).toHaveBeenCalledTimes(1);
		bus.set(null);
		bus.set(null);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("notifies each subscriber once per different value", () => {
		const bus = createBus<HoverMoment>();
		const one = vi.fn();
		const two = vi.fn();
		bus.subscribe(one);
		bus.subscribe(two);
		bus.set({ ms: 1, span: null, from: "a" });
		bus.set({ ms: 2, span: null, from: "a" });
		bus.set({ ms: 2, span: null, from: "b" });
		expect(one).toHaveBeenCalledTimes(3);
		expect(two).toHaveBeenCalledTimes(3);
	});

	it("stops notifying after unsubscribe", () => {
		const bus = createBus<HoverMoment>();
		const fn = vi.fn();
		const off = bus.subscribe(fn);
		bus.set({ ms: 1, span: null, from: "a" });
		off();
		bus.set({ ms: 2, span: null, from: "a" });
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("returns the identical object until the next different set", () => {
		const bus = createBus<HoverMoment>();
		bus.set({ ms: 1, span: [0, 2], from: "a" });
		const first = bus.get();
		expect(bus.get()).toBe(first);
		bus.set({ ms: 1, span: [0, 2], from: "a" });
		expect(bus.get()).toBe(first);
		bus.set({ ms: 1, span: [0, 3], from: "a" });
		expect(bus.get()).not.toBe(first);
	});
});

describe("frameLimited", () => {
	it("publishes only the last of three sets made before the frame, once", () => {
		const bus = createBus<HoverMoment>();
		const fn = vi.fn();
		bus.subscribe(fn);
		const queue: Array<() => void> = [];
		const set = frameLimited(bus, (f) => queue.push(f));
		set({ ms: 1, span: null, from: "a" });
		set({ ms: 2, span: null, from: "a" });
		set({ ms: 3, span: null, from: "a" });
		expect(fn).not.toHaveBeenCalled();
		for (const f of queue.splice(0)) f();
		expect(fn).toHaveBeenCalledTimes(1);
		expect(bus.get()).toEqual({ ms: 3, span: null, from: "a" });
	});

	it("publishes again in the next frame", () => {
		const bus = createBus<HoverMoment>();
		const queue: Array<() => void> = [];
		const set = frameLimited(bus, (f) => queue.push(f));
		set({ ms: 1, span: null, from: "a" });
		for (const f of queue.splice(0)) f();
		set(null);
		for (const f of queue.splice(0)) f();
		expect(bus.get()).toBeNull();
	});
});

describe("use-hover", () => {
	function probe(self: string): string {
		const Probe = (): React.JSX.Element => {
			const m = hover.useHoverMoment(self);
			return createElement("span", null, m === null ? "" : String(m.ms));
		};
		return renderToStaticMarkup(createElement(Probe));
	}

	it("gives another window the moment, and the sender nothing", () => {
		momentBus.set({ ms: 5, span: [0, 10], from: "a" });
		expect(probe("b")).toBe("<span>5</span>");
		expect(probe("a")).toBe("<span></span>");
	});

	it("gives nothing when no moment is hovered any more", () => {
		momentBus.set({ ms: null, span: null, from: "a" });
		expect(probe("b")).toBe("<span></span>");
	});

	it("gives nothing before any hover", () => {
		expect(probe("b")).toBe("<span></span>");
	});

	it("reads the category without its sender", () => {
		categoryBus.set({ dim: "lane", key: "x", from: "share" });
		const Probe = (): React.JSX.Element => {
			const c = hover.useHoverCategory();
			return createElement("span", null, c === null ? "" : `${c.dim}:${c.key}`);
		};
		expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>lane:x</span>");
	});

	it("publishes at once with no requestAnimationFrame", () => {
		vi.stubGlobal("requestAnimationFrame", undefined);
		hover.setHoverMoment({ ms: 7, span: [0, 10], from: "a" });
		expect(momentBus.get()).toEqual({ ms: 7, span: [0, 10], from: "a" });
	});

	it("publishes in the next frame where there is one", () => {
		const queue: Array<() => void> = [];
		vi.stubGlobal("requestAnimationFrame", (f: () => void) => queue.push(f));
		hover.setHoverMoment({ ms: 8, span: [0, 10], from: "a" });
		expect(momentBus.get()).toBeNull();
		for (const f of queue.splice(0)) f();
		expect(momentBus.get()?.ms).toBe(8);
	});
});
