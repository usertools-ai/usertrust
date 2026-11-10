// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The parts of the Share of spend window, each drawn on its own: the ring, the legend and the dimension switch.
 * The ring is one fixed drawing sized by CSS; the legend gives every figure exactly; a click on either filters the
 * desk to one category.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Dimension } from "../src/shared/breakdown.js";
import { rankColors } from "../src/shared/colors.js";
import {
	FADE,
	GROW,
	HALF_GAP,
	INNER,
	OUTLINE_INSET,
	RIM_W_HOT,
	rimPath,
	ringPath,
	ringShape,
	VB,
} from "../src/shared/donut.js";
import { EMPTY_FILTERS } from "../src/shared/filters.js";
import { categoryBus } from "../src/shared/hover-bus.js";
import { appExport } from "./helpers/day-one.js";
import { withDesk } from "./helpers/desk.js";
import { attr, innerOf, shareData, spend, tagsOf } from "./helpers/share.js";

const SHARE = join(import.meta.dirname, "..", "src", "app", "windows", "share");
const source = (file: string): string => readFileSync(join(SHARE, file), "utf-8");

interface DonutProps {
	keys: readonly string[];
	values: readonly number[];
	level: Dimension;
	centre: { name: string; amount: string; sub: string; key: string | null };
	snapKey: string;
	ariaLabel: string;
}

let ShareDonut: React.ComponentType<DonutProps>;

beforeAll(async () => {
	ShareDonut = await appExport("windows/share/donut", "ShareDonut");
});

afterEach(() => {
	categoryBus.set(null);
});

const RO = VB / 2 - GROW - RIM_W_HOT;
/** The radius a body's outer arc is drawn at, at rest and grown. */
const REST = String(RO - OUTLINE_INSET);
const GROWN = String(RO + GROW - OUTLINE_INSET);

const ROWS = [spend("a", 1, 500), spend("b", 1, 300), spend("c", 1, 200)];

function donut(over: Partial<DonutProps> = {}): React.ReactElement {
	return createElement(ShareDonut, {
		keys: ["a", "b", "c"],
		values: [500, 300, 200],
		level: "lane",
		centre: { name: "This range", amount: "$0.10", sub: "3 lanes", key: null },
		snapKey: "range",
		ariaLabel: "Share of spend by lane, this range: a $0.05, 50.0%",
		...over,
	});
}

/** The `d` of a slice's body path. */
function bodyOf(html: string, key: string): string {
	const at = html.indexOf(`data-key="${key}"`);
	const m = /<path class="body"[^>]*\sd="([^"]*)"/.exec(html.slice(at));
	if (at < 0 || m === null) throw new Error(`no body for ${key}`);
	return m[1] ?? "";
}

describe("the ring", () => {
	it("is one drawing in a fixed 300 box, sized by CSS and never by a measured width", async () => {
		const html = await withDesk(donut(), { data: shareData(ROWS) });
		expect(html.match(/viewBox="0 0 300 300"/g)).toHaveLength(1);
		const svg = /<svg[^>]*>/.exec(html)?.[0] ?? "";
		expect(svg).toContain('class="ut-sh-ring"');
		expect(svg).not.toMatch(/\s(width|height)=/);
		expect(attr(svg, "role")).toBe("img");
		expect(attr(svg, "aria-label")).toBe("Share of spend by lane, this range: a $0.05, 50.0%");
		for (const file of ["donut.tsx", "use-arc-tween.ts"]) {
			expect(source(file)).not.toMatch(/useBoxSize|ResizeObserver/);
		}
	});

	it("draws one slice per key, in key order, with a hairline at the inner radius", async () => {
		const html = await withDesk(donut(), { data: shareData(ROWS) });
		const slices = tagsOf(html, "ut-sh-slice");
		expect(slices.map((s) => attr(s, "data-key"))).toEqual(["a", "b", "c"]);
		expect(slices.every((s) => attr(s, "data-lit") === "rest")).toBe(true);
		const hair = tagsOf(html, "ut-sh-hair")[0] ?? "";
		expect(Number(attr(hair, "r"))).toBeCloseTo(RO * INNER, 9);
		// At rest every body's outer arc is at the rest radius.
		for (const key of ["a", "b", "c"]) expect(bodyOf(html, key)).toContain(`A${REST},${REST} `);
	});

	it("draws a single category as a full ring: two closed circles filled evenodd, no straight edge", async () => {
		const html = await withDesk(donut({ keys: ["a"], values: [500] }), {
			data: shareData(ROWS),
		});
		expect(tagsOf(html, "ut-sh-slice")).toHaveLength(1);
		const d = bodyOf(html, "a");
		expect(d.match(/Z/g)).toHaveLength(2);
		expect(d).not.toContain("L");
		expect(html).toMatch(/<path class="body"[^>]*fill-rule="evenodd"/);
	});

	it("keeps a key with nothing at this moment as a slice with no path, so the order never changes", async () => {
		const html = await withDesk(donut({ values: [500, 0, 200] }), { data: shareData(ROWS) });
		expect(tagsOf(html, "ut-sh-slice").map((s) => attr(s, "data-key"))).toEqual(["a", "b", "c"]);
		expect(html.match(/<path class="body"/g)).toHaveLength(2);
		expect(html).not.toMatch(/NaN/);
	});

	it("grows the selected slice outward by 7, never moves it, and dims the others", async () => {
		const filters = { ...EMPTY_FILTERS, actors: ["b"] };
		const html = await withDesk(donut(), {
			data: shareData(ROWS, filters),
			view: { filters },
		});
		const slices = tagsOf(html, "ut-sh-slice");
		expect(slices.map((s) => attr(s, "data-lit"))).toEqual(["dim", "selected", "dim"]);
		expect(bodyOf(html, "b")).toContain(`A${GROWN},${GROWN} `);
		expect(bodyOf(html, "a")).toContain(`A${REST},${REST} `);
		expect(Number(GROWN) - Number(REST)).toBe(7);
		for (const s of slices) expect(s).not.toMatch(/transform/);
	});

	it("grows the hovered slice too, and ignores a hover on another dimension", async () => {
		categoryBus.set({ dim: "lane", key: "c", from: "spend" });
		const html = await withDesk(donut(), { data: shareData(ROWS) });
		expect(tagsOf(html, "ut-sh-slice").map((s) => attr(s, "data-lit"))).toEqual([
			"rest",
			"rest",
			"hover",
		]);
		expect(bodyOf(html, "c")).toContain(`A${GROWN},${GROWN} `);
		expect(attr(tagsOf(html, "ut-sh-slices")[0] ?? "", "data-hot")).toBe("true");
		categoryBus.set({ dim: "model", key: "c", from: "spend" });
		const other = await withDesk(donut(), { data: shareData(ROWS) });
		expect(bodyOf(other, "c")).toContain(`A${REST},${REST} `);
		expect(attr(tagsOf(other, "ut-sh-slices")[0] ?? "", "data-hot")).toBe("false");
	});

	it("paints each slice in its category's colour, from the level's colour map", async () => {
		const html = await withDesk(donut(), { data: shareData(ROWS) });
		const colors = rankColors(ROWS, "lane");
		expect(colors.of("a")).not.toBe(colors.of("b"));
		for (const key of ["a", "b", "c"]) {
			const at = html.indexOf(`data-key="${key}"`);
			const body = /<path class="body"[^>]*>/.exec(html.slice(at))?.[0] ?? "";
			const rim = /<path class="rim"[^>]*>/.exec(html.slice(at))?.[0] ?? "";
			expect(attr(body, "stroke")).toBe(colors.of(key));
			expect(attr(rim, "stroke")).toBe(colors.of(key));
		}
	});

	it("prints the centre's three lines, the amount as the figure the oracle reads", async () => {
		const idle = await withDesk(donut(), { data: shareData(ROWS) });
		expect(innerOf(idle, /<text class="c1"[^>]*>/)).toBe("This range");
		expect(innerOf(idle, /<text class="c3"[^>]*>/)).toBe("3 lanes");
		const fig = /<text class="c2"[^>]*>/.exec(idle)?.[0] ?? "";
		expect(attr(fig, "data-fig")).toBe("share.centre");
		expect(attr(fig, "data-key")).toBeNull();
		expect(innerOf(idle, /<text class="c2"[^>]*>/)).toBe("$0.10");

		const lit = await withDesk(
			donut({
				centre: { name: "a", amount: "$0.05", sub: "50.0% at 2026-11-07 18:00Z", key: "a" },
			}),
			{ data: shareData(ROWS) },
		);
		expect(innerOf(lit, /<text class="c1"[^>]*>/)).toBe("a");
		expect(innerOf(lit, /<text class="c3"[^>]*>/)).toBe("50.0% at 2026-11-07 18:00Z");
		expect(attr(/<text class="c2"[^>]*>/.exec(lit)?.[0] ?? "", "data-key")).toBe("a");
		const pinned = await withDesk(
			donut({
				centre: { name: "At 2026-11-07 18:00Z", amount: "$0.02", sub: "2 lanes", key: null },
			}),
			{ data: shareData(ROWS) },
		);
		expect(innerOf(pinned, /<text class="c1"[^>]*>/)).toBe("At 2026-11-07 18:00Z");
	});

	it("sets the centre's lines at their heights, and fades each slice out from its outer edge by the fade table", async () => {
		const html = await withDesk(donut(), { data: shareData(ROWS) });
		const ri = RO * INNER;
		const y = (cls: string): string | null =>
			attr(new RegExp(`<text class="${cls}"[^>]*>`).exec(html)?.[0] ?? "", "y");
		expect(y("c1")).toBe(String(VB / 2 - ri * 0.3));
		expect(y("c2")).toBe(String(VB / 2 + ri * 0.12));
		expect(y("c3")).toBe(String(VB / 2 + ri * 0.4));
		const first = html.slice(html.indexOf("<radialGradient"), html.indexOf("</radialGradient>"));
		const offsets = [...first.matchAll(/<stop offset="([^"]*)"/g)].map((m) => m[1]);
		expect(offsets).toEqual([...FADE].reverse().map(([band]) => String(1 - band * (1 - INNER))));
	});

	it("draws a slice's body and rim from the shared geometry, inset from the edge, at rest and grown", async () => {
		const filters = { ...EMPTY_FILTERS, actors: ["b"] };
		const html = await withDesk(donut(), { data: shareData(ROWS, filters), view: { filters } });
		const arcs = ringShape(["a", "b", "c"], [500, 300, 200], () => false).arcs;
		const rimOf = (key: string): string => {
			const m = /<path class="rim"[^>]*\sd="([^"]*)"/.exec(
				html.slice(html.indexOf(`data-key="${key}"`)),
			);
			return m?.[1] ?? "";
		};
		for (const [key, grown] of [
			["a", 0],
			["b", GROW],
		] as const) {
			const arc = arcs.get(key) ?? { a0: 0, a1: 0 };
			expect(bodyOf(html, key)).toBe(
				ringPath(
					VB / 2,
					VB / 2,
					RO + grown - OUTLINE_INSET,
					RO * INNER + OUTLINE_INSET,
					arc.a0,
					arc.a1,
					HALF_GAP + OUTLINE_INSET,
				),
			);
			expect(rimOf(key)).toBe(rimPath(VB / 2, VB / 2, RO + grown - 1, arc.a0, arc.a1, HALF_GAP));
		}
		const opacity = (key: string): string | null =>
			attr(
				/<path class="body"[^>]*>/.exec(html.slice(html.indexOf(`data-key="${key}"`)))?.[0] ?? "",
				"style",
			);
		expect(opacity("a")).toContain("stroke-opacity:0.6");
		expect(opacity("b")).toContain("stroke-opacity:0.9");
	});

	it("shortens a long name in the centre and keeps the whole of it in a title", async () => {
		const long = `model-${"x".repeat(60)}`;
		const html = await withDesk(
			donut({ centre: { name: long, amount: "$0.05", sub: "50.0% this range", key: long } }),
			{ data: shareData(ROWS) },
		);
		const c1 = /<text class="c1"[^>]*>(.*?)<\/text>/.exec(html)?.[1] ?? "";
		expect(c1).toContain(`<title>${long}</title>`);
		expect(c1.replace(/<title>.*<\/title>/, "").length).toBeLessThanOrEqual(24);
	});

	it("has no modifier-key path: a click is one plain toggle", () => {
		expect(source("donut.tsx")).not.toMatch(/shiftKey|metaKey|ctrlKey|altKey/);
		expect(source("donut.tsx")).toMatch(/toggleCategory\(filters, level, \w+, false\)/);
	});

	it("tweens only in effects: nothing of the browser is read while rendering, and the frame loop is cancelled", () => {
		const tween = source("use-arc-tween.ts");
		// The render above ran with no window, document or requestAnimationFrame at all; these pin the rest.
		expect(tween).not.toMatch(/performance\.|document\.|window\./);
		expect(tween).toMatch(/motionStill\(\)/);
		expect(tween).toMatch(/return \(\) => cancelAnimationFrame\(/);
		expect(tween).toMatch(/startTween\(/);
		expect(source("donut.tsx")).not.toMatch(
			/performance\.|document\.|window\.|matchMedia|requestAnimationFrame/,
		);
	});
});
