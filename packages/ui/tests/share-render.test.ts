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
	atWhen,
	FADE,
	FADE_HOT,
	formatShare,
	GROW,
	HALF_GAP,
	INNER,
	legendOf,
	legendTitle,
	OUTLINE_INSET,
	RIM_W,
	RIM_W_HOT,
	rimPath,
	ringPath,
	ringShape,
	SHARE_EMPTY,
	type ShareValues,
	VB,
} from "../src/shared/donut.js";
import { EMPTY_FILTERS } from "../src/shared/filters.js";
import { formatUsdTotal } from "../src/shared/format.js";
import { categoryBus } from "../src/shared/hover-bus.js";
import { appExport } from "./helpers/day-one.js";
import { withDesk } from "./helpers/desk.js";
import {
	attr,
	CHART,
	HOUR,
	innerOf,
	legendFigures,
	shareData,
	spend,
	tagsOf,
	text,
} from "./helpers/share.js";

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

interface LegendProps {
	values: ShareValues;
	level: Dimension;
	decimals: 0 | 1;
	whenLabel: string;
	startMs: number | null;
}

let ShareDonut: React.ComponentType<DonutProps>;
let amountSize: (chars: number) => number;
let ShareLegend: React.ComponentType<LegendProps>;
let DimSwitch: React.ComponentType;

beforeAll(async () => {
	ShareDonut = await appExport("windows/share/donut", "ShareDonut");
	amountSize = await appExport("windows/share/donut", "amountSize");
	ShareLegend = await appExport("windows/share/legend", "ShareLegend");
	DimSwitch = await appExport("windows/share/dim-switch", "DimSwitch");
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

	it("paints each slice with its own gradient, in its colour, hot or at rest, and a rim of the right width", async () => {
		const filters = { ...EMPTY_FILTERS, actors: ["b"] };
		const html = await withDesk(donut(), { data: shareData(ROWS, filters), view: { filters } });
		const colors = rankColors(ROWS, "lane");
		const sliceOf = (key: string): string => {
			const at = html.indexOf(`data-key="${key}"`);
			const next = html.indexOf('class="ut-sh-slice"', at + 1);
			return html.slice(at, next < 0 ? undefined : next);
		};
		const ids: string[] = [];
		for (const [key, table, width] of [
			["a", FADE, RIM_W],
			["b", FADE_HOT, RIM_W_HOT],
			["c", FADE, RIM_W],
		] as const) {
			const part = sliceOf(key);
			const grad = /<radialGradient[^>]*>/.exec(part)?.[0] ?? "";
			const id = attr(grad, "id") ?? "";
			expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
			ids.push(id);
			expect(attr(grad, "gradientUnits")).toBe("userSpaceOnUse");
			expect(attr(grad, "cx")).toBe(String(VB / 2));
			expect(attr(grad, "cy")).toBe(String(VB / 2));
			expect(attr(grad, "r")).toBe(String(RO));
			const stops = [...part.matchAll(/<stop [^>]*>/g)].map((m) => m[0]);
			expect(stops).toHaveLength(table.length);
			[...table].reverse().forEach(([band, opacity], i) => {
				expect(attr(stops[i] ?? "", "stop-color")).toBe(colors.of(key));
				expect(attr(stops[i] ?? "", "stop-opacity")).toBe(String(opacity));
				expect(attr(stops[i] ?? "", "offset")).toBe(String(1 - band * (1 - INNER)));
			});
			const body = /<path class="body"[^>]*>/.exec(part)?.[0] ?? "";
			expect(attr(body, "fill")).toBe(`url(#${id})`);
			const rim = /<path class="rim"[^>]*>/.exec(part)?.[0] ?? "";
			expect(attr(rim, "style")).toContain(`stroke-width:${width}`);
		}
		expect(new Set(ids).size).toBe(3);
		expect(FADE_HOT).not.toEqual(FADE);
		expect(RIM_W).not.toBe(RIM_W_HOT);
	});

	it("gives every slice of two rings in one tree its own gradient", async () => {
		const html = await withDesk(createElement("div", null, donut(), donut()), {
			data: shareData(ROWS),
		});
		const ids = [...html.matchAll(/<radialGradient[^>]*\sid="([^"]*)"/g)].map((m) => m[1]);
		expect(ids).toHaveLength(6);
		expect(new Set(ids).size).toBe(6);
	});

	it("draws no rim for a slice with nothing, and dims nothing for a hover on a key the ring does not hold", async () => {
		const empty = await withDesk(donut({ values: [500, 0, 200] }), { data: shareData(ROWS) });
		expect(empty.match(/<path class="rim"/g)).toHaveLength(2);
		categoryBus.set({ dim: "lane", key: "not-in-the-ring", from: "spend" });
		const html = await withDesk(donut(), { data: shareData(ROWS) });
		expect(attr(tagsOf(html, "ut-sh-slices")[0] ?? "", "data-hot")).toBe("false");
	});

	it("keeps a name of 24 characters whole with no title, cuts a longer one, and centres the first line", async () => {
		const whole = "x".repeat(24);
		const at = async (name: string): Promise<string> =>
			withDesk(donut({ centre: { name, amount: "$0.05", sub: "50.0% this range", key: null } }), {
				data: shareData(ROWS),
			});
		const kept = await at(whole);
		const c1 = /<text class="c1"[^>]*>(.*?)<\/text>/.exec(kept)?.[1] ?? "";
		expect(c1).toBe(whole);
		expect(c1).not.toContain("<title>");
		expect(attr(/<text class="c1"[^>]*>/.exec(kept)?.[0] ?? "", "text-anchor")).toBe("middle");
		const cut = /<text class="c1"[^>]*>(.*?)<\/text>/.exec(await at(`${whole}y`))?.[1] ?? "";
		expect(cut).toContain("<title>");
	});

	it("sets a long amount smaller so it stays inside the hole, and a short one at 30", async () => {
		const at = async (amount: string): Promise<number> => {
			const html = await withDesk(
				donut({ centre: { name: "This range", amount, sub: "3 lanes", key: null } }),
				{ data: shareData(ROWS) },
			);
			const style = attr(/<text class="c2"[^>]*>/.exec(html)?.[0] ?? "", "style") ?? "";
			return Number(/font-size:([\d.]+)px/.exec(style)?.[1]);
		};
		expect(await at("$0.10")).toBe(30);
		expect(await at("$12,345.67")).toBeLessThan(30);
		for (const amount of ["$12,345.67", "$123,456.78", "$1,234,567.89", "$12,345,678.90"]) {
			// The widest the text can be, at about 0.58 em a character, is inside the hole's 173 units.
			expect(amount.length * 0.58 * (await at(amount))).toBeLessThanOrEqual(2 * RO * INNER);
		}
		expect(await at("$1,234,567.89")).toBeLessThan(await at("$123,456.78"));
	});

	it("sizes the amount by its length: 30 up to nine characters, then smaller, never NaN", () => {
		expect([0, 1, 5, 9].map(amountSize)).toEqual([30, 30, 30, 30]);
		expect(amountSize(Number.NaN)).toBe(30);
		expect([10, 13, 14, 20].map(amountSize)).toEqual([27, 21, 19, 13]);
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

/** `n` categories `k0`..., the first the highest. */
function valuesOf(n: number): ShareValues {
	const keys = Array.from({ length: n }, (_, i) => `k${i}`);
	const values = keys.map((_, i) => (n - i) * 1_000 + 3);
	return { keys, values, total: values.reduce((a, v) => a + v, 0) };
}

const two = (a: number, b: number, names: [string, string] = ["a", "b"]): ShareValues => ({
	keys: names,
	values: [a, b],
	total: a + b,
});

function legend(values: ShareValues, over: Partial<LegendProps> = {}): React.ReactElement {
	return createElement(ShareLegend, {
		values,
		level: "lane",
		decimals: 0,
		whenLabel: atWhen(null),
		startMs: null,
		...over,
	});
}

/** The printed percentages, in row order. */
function percents(html: string): string[] {
	return [...html.matchAll(/<span class="p">(.*?)<\/span>/g)].map((m) => text(m[1] ?? ""));
}

describe("the legend", () => {
	it("lists the top five and folds the rest into one Other line only when two or more are left", async () => {
		const eight = await withDesk(legend(valuesOf(8)));
		expect(tagsOf(eight, "ut-sh-row")).toHaveLength(5);
		expect(tagsOf(eight, "ut-sh-row").every((t) => t.startsWith("<button"))).toBe(true);
		const other = tagsOf(eight, "ut-sh-other");
		expect(other).toHaveLength(1);
		expect(other[0]).toMatch(/^<li/);
		expect(attr(other[0] ?? "", "data-fold")).toBe("true");
		const figures = legendFigures(eight);
		expect(figures.map(([key]) => key)).toEqual(["k0", "k1", "k2", "k3", "k4", "Other"]);
		expect(figures[5]?.[1]).toBe(3_003 + 2_003 + 1_003);
		// The folded line is not a control: nothing in it can be clicked.
		const folded = eight.slice(eight.indexOf('class="ut-sh-other"'));
		expect(folded).not.toContain("<button");
		expect(text(folded)).toContain("Other");

		const seven = await withDesk(legend(valuesOf(7)));
		expect(tagsOf(seven, "ut-sh-row")).toHaveLength(5);
		expect(tagsOf(seven, "ut-sh-other")).toHaveLength(1);
		const six = await withDesk(legend(valuesOf(6)));
		expect(tagsOf(six, "ut-sh-row")).toHaveLength(6);
		expect(tagsOf(six, "ut-sh-other")).toHaveLength(0);
	});

	it("titles the Other line with its count, its dollars and its share to one decimal, even in whole percents", async () => {
		const v = valuesOf(8);
		const html = await withDesk(legend(v, { decimals: 0, whenLabel: "this range" }));
		const other = legendOf(v).other;
		expect(other).not.toBeNull();
		if (other === null) return;
		const title = attr(tagsOf(html, "ut-sh-other")[0] ?? "", "title");
		expect(title).toBe(
			`${other.count} more: ${formatUsdTotal(other.spendUt)}, ${formatShare(other.share, 1)} this range`,
		);
		expect(formatShare(other.share, 1)).not.toBe(formatShare(other.share, 0));
	});

	it("reads a bucket start that is not a finite time as the range, without throwing", async () => {
		const html = await withDesk(legend(valuesOf(3), { startMs: Number.NaN }));
		expect(attr(tagsOf(html, "ut-sh-legend")[0] ?? "", "data-when")).toBe("range");
	});

	it("prints the Other line's dollars and percent, whole when small and one decimal when filled", async () => {
		const v = valuesOf(8);
		const other = legendOf(v).other;
		expect(other).not.toBeNull();
		if (other === null) return;
		for (const decimals of [0, 1] as const) {
			const html = await withDesk(legend(v, { decimals }));
			expect(innerOf(html, /<span class="v"[^>]*data-fold="true"[^>]*>/)).toBe(
				formatUsdTotal(other.spendUt),
			);
			expect(percents(html).at(-1)).toBe(formatShare(other.share, decimals));
			expect(percents(html).at(-1)).not.toBe(
				formatShare(legendOf(v).rows[0]?.share ?? 0, decimals),
			);
		}
		expect(formatShare(other.share, 0)).not.toBe(formatShare(other.share, 1));
		expect(formatUsdTotal(other.spendUt)).not.toBe(formatUsdTotal(0));
	});

	it("paints each row's swatch from the level's colour map, a different colour for each", async () => {
		const swatches = (html: string, keys: string[]): string[] =>
			keys.map(
				(k) =>
					new RegExp(`data-key="${k}"[^>]*><i style="background:([^"]*)"`).exec(html)?.[1] ?? "",
			);
		const lanes = await withDesk(legend(two(500, 300)), { data: shareData(ROWS) });
		const laneColors = rankColors(ROWS, "lane");
		expect(swatches(lanes, ["a", "b"])).toEqual([laneColors.of("a"), laneColors.of("b")]);
		expect(laneColors.of("a")).not.toBe(laneColors.of("b"));
		// The level picks the map: the same key is coloured by the model ranking, not the lane one.
		const modelKey = "claude-sonnet-5";
		const models = await withDesk(
			legend(two(500, 300, [modelKey, "other-model"]), { level: "model" }),
			{
				data: shareData(ROWS),
			},
		);
		const modelColors = rankColors(ROWS, "model");
		expect(swatches(models, [modelKey])).toEqual([modelColors.of(modelKey)]);
		expect(modelColors.of(modelKey)).not.toBe(laneColors.of(modelKey));
	});

	it("says a hover is on only for this level and a key the legend holds, and presses only the selected row", async () => {
		const hot = async (hover: { dim: Dimension; key: string }): Promise<string | null> => {
			categoryBus.set({ ...hover, from: "spend" });
			const html = await withDesk(legend(valuesOf(3)));
			return attr(tagsOf(html, "ut-sh-legend")[0] ?? "", "data-hot");
		};
		expect(await hot({ dim: "model", key: "k0" })).toBe("false");
		expect(await hot({ dim: "lane", key: "not-in-the-legend" })).toBe("false");
		expect(await hot({ dim: "model", key: "not-in-the-legend" })).toBe("false");
		expect(await hot({ dim: "lane", key: "k0" })).toBe("true");
		// A hovered row is lit but not pressed: only a selection presses.
		categoryBus.set({ dim: "lane", key: "k2", from: "spend" });
		const html = await withDesk(legend(valuesOf(3)));
		expect(tagsOf(html, "ut-sh-row").map((r) => attr(r, "aria-pressed"))).toEqual([
			"false",
			"false",
			"false",
		]);
	});

	it("shows the no-spend line only when there are no rows", async () => {
		const html = await withDesk(legend(valuesOf(3)));
		expect(html).not.toContain("ut-sh-none");
		expect(html).not.toContain(SHARE_EMPTY);
	});

	it("says which percent setting it is drawn with, for the sheet's wider column", async () => {
		const whole = await withDesk(legend(valuesOf(3), { decimals: 0 }));
		expect(attr(tagsOf(whole, "ut-sh-legend")[0] ?? "", "data-decimals")).toBe("0");
		const tenth = await withDesk(legend(valuesOf(3), { decimals: 1 }));
		expect(attr(tagsOf(tenth, "ut-sh-legend")[0] ?? "", "data-decimals")).toBe("1");
	});

	it("adds up exactly: every row and Other sum to the total", async () => {
		for (const n of [1, 6, 7, 8, 12]) {
			const v = valuesOf(n);
			const html = await withDesk(legend(v));
			expect(legendFigures(html).reduce((a, [, ut]) => a + ut, 0)).toBe(v.total);
		}
	});

	it("prints each figure as dollars, on the element that carries its exact value", async () => {
		const html = await withDesk(legend(two(15_000, 5_000)));
		const fig = /<span class="v"[^>]*data-key="a"[^>]*>/.exec(html)?.[0] ?? "";
		expect(attr(fig, "data-fig")).toBe("share.legend");
		expect(attr(fig, "data-ut")).toBe("15000");
		expect(innerOf(html, /<span class="v"[^>]*data-key="a"[^>]*>/)).toBe("$1.50");
	});

	it("prints whole percentages small and one decimal filled, and never 0% for a category that spent", async () => {
		expect(percents(await withDesk(legend(two(577, 423))))).toEqual(["58%", "42%"]);
		expect(percents(await withDesk(legend(two(577, 423), { decimals: 1 })))).toEqual([
			"57.7%",
			"42.3%",
		]);
		expect(percents(await withDesk(legend(two(9_980, 20))))).toEqual([">99%", "<1%"]);
		expect(percents(await withDesk(legend(two(99_996, 4), { decimals: 1 })))).toEqual([
			">99.9%",
			"<0.1%",
		]);
		// At a moment a key with nothing in the bucket keeps its row and reads zero.
		const zero = await withDesk(legend(two(500, 0)));
		expect(percents(zero)).toEqual(["100%", "0%"]);
		expect(innerOf(zero, /<span class="v"[^>]*data-key="b"[^>]*>/)).toBe("$0.00");
	});

	it("marks the selected row pressed and dims the others; with no selection every row is at rest", async () => {
		const rest = await withDesk(legend(valuesOf(3)));
		const rows = tagsOf(rest, "ut-sh-row");
		expect(rows.map((r) => attr(r, "data-lit"))).toEqual(["rest", "rest", "rest"]);
		expect(rows.map((r) => attr(r, "aria-pressed"))).toEqual(["false", "false", "false"]);
		expect(attr(tagsOf(rest, "ut-sh-legend")[0] ?? "", "data-hot")).toBe("false");

		const picked = await withDesk(legend(valuesOf(3)), {
			view: { filters: { ...EMPTY_FILTERS, actors: ["k1"] } },
		});
		const lit = tagsOf(picked, "ut-sh-row");
		expect(lit.map((r) => attr(r, "data-key"))).toEqual(["k0", "k1", "k2"]);
		expect(lit.map((r) => attr(r, "data-lit"))).toEqual(["dim", "selected", "dim"]);
		expect(lit.map((r) => attr(r, "aria-pressed"))).toEqual(["false", "true", "false"]);
		// The level decides which filter field is the selection: a lane filter lights nothing at the model level.
		const models = await withDesk(legend(valuesOf(3), { level: "model" }), {
			view: { filters: { ...EMPTY_FILTERS, actors: ["k1"] } },
		});
		expect(tagsOf(models, "ut-sh-row").every((r) => attr(r, "data-lit") === "rest")).toBe(true);
	});

	it("lights the hovered row and says a hover is on", async () => {
		categoryBus.set({ dim: "lane", key: "k2", from: "spend" });
		const html = await withDesk(legend(valuesOf(3)));
		expect(tagsOf(html, "ut-sh-row").map((r) => attr(r, "data-lit"))).toEqual([
			"rest",
			"rest",
			"hover",
		]);
		expect(attr(tagsOf(html, "ut-sh-legend")[0] ?? "", "data-hot")).toBe("true");
	});

	it("keeps a long name on one line, whole in its title, and titles the row with its figures and when", async () => {
		const long = `claude-${"x".repeat(53)}`;
		expect(long).toHaveLength(60);
		const v = two(577, 423, [long, "b"]);
		const idle = await withDesk(legend(v, { level: "model" }));
		const row = tagsOf(idle, "ut-sh-row")[0] ?? "";
		expect(attr(row, "title")).toBe(legendTitle(long, 577, 0.577, "this range"));
		expect(attr(row, "title")).toContain("57.7% this range. Click to filter the desk to it.");
		const first = idle.slice(idle.indexOf("<button"), idle.indexOf("</button>"));
		expect(first.match(/<span class="n"/g)).toHaveLength(1);
		expect(attr(/<span class="n"[^>]*>/.exec(first)?.[0] ?? "", "title")).toBe(long);
		expect(attr(tagsOf(idle, "ut-sh-legend")[0] ?? "", "data-when")).toBe("range");

		const startMs = CHART.startMs + 2 * HOUR;
		const pinned = await withDesk(
			legend(v, { level: "model", startMs, whenLabel: atWhen(startMs) }),
		);
		expect(attr(tagsOf(pinned, "ut-sh-row")[0] ?? "", "title")).toBe(
			legendTitle(long, 577, 0.577, atWhen(startMs)),
		);
		expect(attr(tagsOf(pinned, "ut-sh-row")[0] ?? "", "title")).toMatch(
			/ at \d{4}-\d\d-\d\d \d\d:\d\dZ\. /,
		);
		expect(attr(tagsOf(pinned, "ut-sh-legend")[0] ?? "", "data-when")).toBe(
			new Date(startMs).toISOString(),
		);
	});

	it("says there is no spend, from the one constant, with no NaN", async () => {
		const html = await withDesk(legend({ keys: [], values: [], total: 0 }));
		const none = tagsOf(html, "ut-sh-none");
		expect(none).toHaveLength(1);
		expect(innerOf(html, /<li class="ut-sh-none"[^>]*>/)).toBe(SHARE_EMPTY);
		expect(tagsOf(html, "ut-sh-row")).toHaveLength(0);
		expect(html).not.toMatch(/NaN/);
		// The range's keys with nothing in this bucket: zeros, never NaN.
		const quiet = await withDesk(legend({ keys: ["a", "b"], values: [0, 0], total: 0 }));
		expect(percents(quiet)).toEqual(["0%", "0%"]);
		expect(quiet).not.toMatch(/NaN/);
	});

	it("tells a real category named Other from the folded line", async () => {
		const v = valuesOf(8);
		v.keys[1] = "Other";
		const html = await withDesk(legend(v, { level: "provider" }));
		const real = tagsOf(html, "ut-sh-row").find((r) => attr(r, "data-key") === "Other") ?? "";
		expect(real).toMatch(/^<button/);
		expect(attr(real, "data-fold")).toBeNull();
		const figs = [...html.matchAll(/<span class="v"[^>]*data-key="Other"[^>]*>/g)].map((m) => m[0]);
		expect(figs.map((f) => attr(f, "data-fold"))).toEqual([null, "true"]);
	});

	it("has no modifier-key path: a click is one plain toggle", () => {
		expect(source("legend.tsx")).not.toMatch(/shiftKey|metaKey|ctrlKey|altKey/);
		expect(source("legend.tsx")).toMatch(/toggleCategory\(filters, level, row\.key, false\)/);
	});
});

describe("the dimension switch", () => {
	const buttons = (html: string): Array<[string, string | null]> =>
		[...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => [
			text(m[1] ?? ""),
			attr(m[0].slice(0, m[0].indexOf(">") + 1), "aria-pressed"),
		]);

	it("offers the five dimensions in order, Lane pressed by default", async () => {
		const html = await withDesk(createElement(DimSwitch));
		const group = tagsOf(html, "ut-seg")[0] ?? "";
		expect(attr(group, "role")).toBe("group");
		expect(attr(group, "aria-label")).toBe("Share by");
		expect(buttons(html)).toEqual([
			["Lane", "true"],
			["Role (declared)", "false"],
			["Model", "false"],
			["Kind", "false"],
			["Provider", "false"],
		]);
	});

	it("presses the chosen dimension and no other", async () => {
		const html = await withDesk(createElement(DimSwitch), { view: { dim: "provider" } });
		expect(buttons(html).filter(([, pressed]) => pressed === "true")).toEqual([
			["Provider", "true"],
		]);
	});
});
