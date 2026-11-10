// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Spend chart's marks as static markup. The frame cases are here; the chart's own cases (cursor, keys, pin,
 * headline) are added below in their own groups.
 */

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { LAYERS, type LayerZ, type SpendLayer } from "../src/app/windows/spend/layers.js";
import { formatUsdAxis } from "../src/shared/format.js";
import { LINE_BUCKETS } from "../src/shared/spend-model.js";
import {
	AREA_HIGHLIGHT,
	AREA_STOPS,
	areaFadeTop,
	drawSeries,
	HEADROOM,
	LINE_RECIPE,
	MIN_TOP,
	niceTicks,
} from "../src/shared/spend-scale.js";
import { appExport, type Component } from "./helpers/day-one.js";
import { type ChartFixture, chartFixture, HOUR, T0 } from "./helpers/spend-fixture.js";

interface FrameProps {
	ctx: ChartFixture["ctx"];
	geo: ChartFixture["geo"];
	series: ChartFixture["series"];
	ticks: ChartFixture["ticks"] | null;
	layers: readonly SpendLayer[];
	live: boolean;
	hover: boolean;
	pin: { x: number; y: number } | null;
	mark: { x: number; y: number } | null;
	brk: { x: number; y: number } | null;
	ghost: string | null;
	note: string | null;
	idPrefix: string;
}

let ChartFrame: Component<FrameProps>;

beforeAll(async () => {
	ChartFrame = await appExport("windows/spend/chart-frame", "ChartFrame");
});

function frame(fx: ChartFixture, over: Partial<FrameProps> = {}): string {
	return renderToStaticMarkup(
		createElement(ChartFrame, {
			ctx: fx.ctx,
			geo: fx.geo,
			series: fx.series,
			ticks: null,
			layers: [],
			live: false,
			hover: false,
			pin: null,
			mark: null,
			brk: null,
			ghost: null,
			note: null,
			idPrefix: "a",
			...over,
		}),
	);
}

function marker(id: SpendLayer["id"], z: LayerZ): SpendLayer {
	return {
		id,
		z,
		Layer: () => createElement("i", { "data-test": `${id}-${z}` }),
	};
}

/** The opening tag of every element of `tag` whose class list is exactly `cls`. */
function tags(html: string, tag: string, cls: string): string[] {
	return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*class="${cls}"[^>]*>`, "g"))].map(
		(m) => m[0],
	);
}

function attr(tag: string, name: string): string | undefined {
	return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

describe("the fixture", () => {
	const fx = chartFixture();

	it("scales to the smoothed peak and draws the smoothed rates, as the chart does", () => {
		// The drawn line must fill its band, so the top is the smoothed peak; the true peak is higher here.
		expect(fx.model.drawnPeak).toBeLessThan(fx.model.peakRate);
		expect(fx.geo.top).toBe(Math.max(fx.model.drawnPeak * HEADROOM, MIN_TOP));
		expect(fx.series.d).toBe(drawSeries(fx.geo, fx.model.drawn).d);
		expect(fx.series.d).not.toBe(drawSeries(fx.geo, fx.model.rates).d);
	});
});

describe("the seam", () => {
	it("starts with no layers", () => {
		expect(LAYERS).toEqual([]);
	});

	it("is a memo, so a parent's render alone does not redraw the marks", () => {
		expect((ChartFrame as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
	});
});

describe("chart frame: the svg", () => {
	const fx = chartFixture();
	let html = "";
	beforeAll(() => {
		html = frame(fx);
	});

	it("is one css pixel per user unit and hidden from assistive tech", () => {
		expect(html).toContain('width="700"');
		expect(html).toContain('height="220"');
		expect(html).toContain('viewBox="0 0 700 220"');
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain('class="ut-sp-svg"');
	});

	it("draws the glow, the knockout and the line, in that order, all on one path", () => {
		const paths = [...html.matchAll(/<path[^>]*class="(ut-sp-(?:glow|knock|line))"[^>]*>/g)];
		expect(paths.map((m) => m[1])).toEqual(["ut-sp-glow", "ut-sp-knock", "ut-sp-line"]);
		const ds = paths.map((m) => /\sd="([^"]*)"/.exec(m[0] ?? "")?.[1]);
		expect(ds[0]).toBe(fx.series.d);
		expect(new Set(ds).size).toBe(1);
		expect(fx.series.d.length).toBeGreaterThan(0);
	});

	it("blurs only the glow, by 1.2", () => {
		expect(html).toMatch(/<feGaussianBlur[^>]*stdDeviation="1.2"/);
	});

	it("fades the area with exactly the five specified stops", () => {
		const offsets = [...html.matchAll(/<stop[^>]*offset="([^"]+)"/g)].map((m) => Number(m[1]));
		expect(offsets).toEqual([0, 0.2, 0.4, 0.7, 0.9]);
		expect(html).toContain('gradientUnits="userSpaceOnUse"');
	});

	it("draws no line, glow, area or live dot for empty rates", () => {
		const bare = frame({ ...fx, series: drawSeries(fx.geo, new Float64Array(0)) }, { live: true });
		expect(bare).not.toContain("ut-sp-line");
		expect(bare).not.toContain("ut-sp-glow");
		expect(bare).not.toContain("ut-sp-knock");
		expect(bare).not.toContain("ut-sp-area");
		expect(bare).not.toContain("ut-sp-live");
	});

	it("draws no dashed line for an empty line, though the chain's break is marked", () => {
		const bare = frame(
			{ ...fx, series: drawSeries(fx.geo, new Float64Array(0)) },
			{ brk: { x: 10, y: 20 } },
		);
		expect(bare).not.toContain("ut-sp-dashed");
		expect(bare).not.toContain("ut-sp-gap");
		expect(bare).toContain("ut-sp-break");
	});

	it("draws a flat line for a range with no spend", () => {
		const quiet = chartFixture({ rows: [] });
		expect(quiet.series.d).not.toBe("");
		expect(frame(quiet)).toContain("ut-sp-line");
	});

	it("keeps two frames' ids apart", () => {
		const one = frame(fx, { idPrefix: "a" });
		const two = frame(fx, { idPrefix: "b" });
		const idsOf = (s: string): string[] =>
			[...s.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? "");
		const a = idsOf(one);
		const b = idsOf(two);
		expect(a.length).toBeGreaterThanOrEqual(2);
		expect(a.filter((id) => b.includes(id))).toEqual([]);
		expect(a.every((id) => id.startsWith("a"))).toBe(true);
	});
});

describe("chart frame: the layer slots", () => {
	const fx = chartFixture();
	const layers = [
		marker("bands", "under"),
		marker("unusual", "mid"),
		marker("knee", "over"),
		marker("loupe", "overlay"),
	];
	let html = "";
	beforeAll(() => {
		html = frame(fx, { layers });
	});
	const at = (s: string): number => html.indexOf(s);

	it("puts under before the area, mid between the area and the strokes, and over after the line", () => {
		const area = at('class="ut-sp-area"');
		const glow = at('class="ut-sp-glow"');
		const line = at('class="ut-sp-line"');
		expect(area).toBeGreaterThan(-1);
		expect(at("bands-under")).toBeGreaterThan(-1);
		expect(at("bands-under")).toBeLessThan(area);
		expect(at("unusual-mid")).toBeGreaterThan(area);
		expect(at("unusual-mid")).toBeLessThan(glow);
		expect(at("knee-over")).toBeGreaterThan(line);
	});

	it("leaves the overlay to the chart", () => {
		expect(html).not.toContain("loupe-overlay");
	});

	it("draws no layer's Overlay or Note: they are HTML, the chart's to place", () => {
		const extra: SpendLayer = {
			...marker("unusual", "over"),
			Overlay: () => createElement("i", { "data-test": "unusual-overlay-html" }),
			Note: () => createElement("i", { "data-test": "unusual-note" }),
		};
		const got = frame(fx, { layers: [extra] });
		expect(got).toContain("unusual-over");
		expect(got).not.toContain("unusual-overlay-html");
		expect(got).not.toContain("unusual-note");
	});

	it("draws the over layer before the pin mark and the live dot", () => {
		const both = frame(fx, { layers, live: true, pin: { x: 40, y: 50 } });
		expect(both.indexOf("knee-over")).toBeLessThan(both.indexOf('class="ut-sp-pin"'));
		expect(both.indexOf('class="ut-sp-pin"')).toBeLessThan(both.indexOf("ut-sp-live"));
	});
});

describe("chart frame: the grid", () => {
	const fx = chartFixture();
	const DAY_WIN = { startMs: T0, endMs: T0 + 24 * HOUR };
	const day = chartFixture({ win: DAY_WIN, bucket: LINE_BUCKETS["1d"] });

	it("draws a supplied tick at its drawn height, labelled per bucket", () => {
		const html = frame(fx, { ticks: [{ drawn: 50, label: 80 }] });
		const y = fx.geo.yOfDrawn(50);
		expect(html).toMatch(new RegExp(`<line[^>]*class="ut-sp-grid"[^>]*y1="${y}"`));
		// An hour's bucket at 1W: the per-hour label is the bucket's own spend.
		expect(fx.ctx.perHour).toBe(1);
		expect(html).toContain(`>${formatUsdAxis(80)}<`);
	});

	it("draws one line and one label for each plain tick it is given", () => {
		const plain = niceTicks(fx.geo.top);
		expect(plain.length).toBeGreaterThan(0);
		const html = frame(fx, { ticks: plain.map((t) => ({ drawn: t, label: t })) });
		expect([...html.matchAll(/class="ut-sp-grid"/g)].length).toBe(plain.length);
		for (const t of plain) expect(html).toContain(`>${formatUsdAxis(t)}<`);
	});
	it("reads a tick's label as the spend of one 5 min bucket at 1D", () => {
		expect(day.ctx.perHour).toBe(12);
		const html = frame(day, { ticks: [{ drawn: 50, label: 80 }] });
		expect(html).toContain(`>${formatUsdAxis(80 / 12)}<`);
		expect(html).not.toContain(`>${formatUsdAxis(80)}<`);
	});

	it("falls back to plain ticks cut in the labelled unit: one bucket's spend, at 1/2/5 steps", () => {
		expect(day.ctx.perHour).toBeGreaterThan(1);
		for (const f of [fx, day]) {
			const plain = niceTicks(f.geo.top / f.ctx.perHour);
			expect(plain.length).toBeGreaterThan(0);
			const html = frame(f, { ticks: null });
			const lines = tags(html, "line", "ut-sp-grid");
			expect(lines.length).toBe(plain.length);
			expect(lines.map((l) => Number(attr(l, "y1")))).toEqual(
				plain.map((t) => f.geo.yOfDrawn(t * f.ctx.perHour)),
			);
			for (const t of plain) expect(html).toContain(`>${formatUsdAxis(t)}<`);
		}
	});

	it("names no unit on the plot at any range", () => {
		for (const bucket of Object.values(LINE_BUCKETS)) {
			const f = chartFixture({ bucket });
			const html = frame(f);
			expect(html).not.toContain("$/h");
			expect(html).not.toContain("ut-sp-unit");
		}
	});
});

describe("chart frame: the live dot and the pin", () => {
	const fx = chartFixture();

	it("draws one gold dot of radius 4.5 when live", () => {
		const html = frame(fx, { live: true });
		const dots = [...html.matchAll(/<circle[^>]*class="ut-sp-live"[^>]*>/g)];
		expect(dots.length).toBe(1);
		expect(dots[0]?.[0]).toContain('r="4.5"');
		expect(dots[0]?.[0]).toContain("var(--dk-gold)");
	});

	it("draws none when not live", () => {
		expect(frame(fx, { live: false })).not.toContain("ut-sp-live");
	});

	it("draws the pin as a full-height rule and a dot, only when there is a pin", () => {
		expect(frame(fx)).not.toContain("ut-sp-pin");
		const html = frame(fx, { pin: { x: 120.5, y: 60 } });
		const g = /<g class="ut-sp-pin">(.*?)<\/g>/.exec(html)?.[1] ?? "";
		const line = /<line\b[^>]*>/.exec(g)?.[0] ?? "";
		expect(attr(line, "x1")).toBe("120.5");
		expect(attr(line, "x2")).toBe("120.5");
		expect(attr(line, "y1")).toBe("0");
		expect(attr(line, "y2")).toBe(String(fx.h));
		const dot = /<circle\b[^>]*>/.exec(g)?.[0] ?? "";
		expect(attr(dot, "cx")).toBe("120.5");
		expect(attr(dot, "cy")).toBe("60");
		expect(attr(dot, "r")).toBe("4.5");
	});

	it("leaves the pin's paint to the sheet, so its gold is one rule", () => {
		const g = /<g class="ut-sp-pin">.*?<\/g>/.exec(frame(fx, { pin: { x: 40, y: 50 } }))?.[0] ?? "";
		expect(g).not.toContain("style=");
		expect(g).not.toContain("stroke-dasharray");
	});
});

describe("chart frame: the area highlight", () => {
	const fx = chartFixture();
	const opacities = (html: string): number[] =>
		[...html.matchAll(/<stop[^>]*stop-opacity="([^"]+)"/g)].map((m) => Number(m[1]));

	it("is the plain recipe at rest", () => {
		const got = opacities(frame(fx, { hover: false }));
		expect(got[0]).toBe(0.13);
		expect(got).toEqual(AREA_STOPS.map(([, a]) => a));
	});

	it("brightens every stop by the highlight while a cursor is on the plot", () => {
		const got = opacities(frame(fx, { hover: true }));
		expect(got[0]).toBe(0.1625);
		expect(got.length).toBe(AREA_STOPS.length);
		AREA_STOPS.forEach(([, a], i) => {
			expect(got[i]).toBeCloseTo(a * AREA_HIGHLIGHT, 12);
		});
	});
});

describe("chart frame: the area clip", () => {
	const fx = chartFixture();
	const clipper = (id: SpendLayer["id"], d: string | null): SpendLayer => ({
		...marker(id, "under"),
		areaClip: () => d,
	});

	it("clips the base area fill, and only it, to the first path a layer gives", () => {
		const html = frame(fx, {
			layers: [
				clipper("bands", null),
				clipper("unusual", "M0 0H10V10Z"),
				clipper("knee", "M1 1H2V2Z"),
			],
		});
		const area = tags(html, "path", "ut-sp-area")[0] ?? "";
		const ref = /^url\(#([^)]+)\)$/.exec(attr(area, "clip-path") ?? "")?.[1];
		expect(ref).toBeDefined();
		const clip = new RegExp(`<clipPath id="${ref}">(.*?)</clipPath>`).exec(html)?.[1] ?? "";
		expect(clip).toBe('<path d="M0 0H10V10Z"></path>');
		expect(html).not.toContain("M1 1H2V2Z");
		expect(tags(html, "path", "ut-sp-line")[0]).not.toContain("clip-path");
	});

	it("draws no clip at all when no layer gives one", () => {
		for (const layers of [[], [clipper("bands", null)], [marker("bands", "under")]]) {
			const html = frame(fx, { layers });
			expect(html).not.toContain("<clipPath");
			expect(html).not.toContain("clip-path");
		}
	});
});

describe("chart frame: the open record's ring", () => {
	const fx = chartFixture();

	it("draws one ring of radius 6.5 at the record's place, under the pin", () => {
		const html = frame(fx, { mark: { x: 210, y: 77.5 }, pin: { x: 40, y: 50 } });
		const rings = tags(html, "circle", "ut-sp-mark");
		expect(rings.length).toBe(1);
		expect(attr(rings[0] ?? "", "r")).toBe("6.5");
		expect(attr(rings[0] ?? "", "cx")).toBe("210");
		expect(attr(rings[0] ?? "", "cy")).toBe("77.5");
		expect(attr(rings[0] ?? "", "fill")).toBe("none");
		expect(html.indexOf("ut-sp-mark")).toBeLessThan(html.indexOf('class="ut-sp-pin"'));
	});

	it("draws none without an open record", () => {
		expect(frame(fx, { mark: null })).not.toContain("ut-sp-mark");
	});
});

describe("chart frame: the chain break", () => {
	const fx = chartFixture();
	const brk = { x: 300, y: 90 };
	const over = marker("knee", "over");

	it("dashes the line from the break on, with the gap under the dashes", () => {
		const html = frame(fx, { brk, layers: [over] });
		const rect = /<clipPath id="([^"]+)"><rect\b([^>]*)>/.exec(html);
		expect(rect).not.toBeNull();
		const r = rect?.[0] ?? "";
		expect(attr(r, "x")).toBe("300");
		expect(attr(r, "width")).toBe(String(fx.w - 300));
		expect(attr(r, "y")).toBe("0");
		expect(attr(r, "height")).toBe(String(fx.h));
		const g = new RegExp(`<g clip-path="url\\(#${rect?.[1]}\\)">(.*?)</g>`).exec(html)?.[1] ?? "";
		const gap = tags(g, "path", "ut-sp-line ut-sp-gap");
		const dashed = tags(g, "path", "ut-sp-line ut-sp-dashed");
		expect(gap.length).toBe(1);
		expect(dashed.length).toBe(1);
		expect(attr(gap[0] ?? "", "d")).toBe(fx.series.d);
		expect(attr(dashed[0] ?? "", "d")).toBe(fx.series.d);
		expect(g.indexOf("ut-sp-gap")).toBeLessThan(g.indexOf("ut-sp-dashed"));
		// After the three strokes, before the over layers.
		expect(html.indexOf('class="ut-sp-line"')).toBeLessThan(html.indexOf("ut-sp-gap"));
		expect(html.indexOf("ut-sp-dashed")).toBeLessThan(html.indexOf("knee-over"));
	});

	it("keeps the dashed copy's clip no wider than the plot, and its id apart from an area clip's", () => {
		const past = frame(fx, { brk: { x: fx.w + 50, y: 90 } });
		const rect = /<clipPath id="[^"]+"><rect\b([^>]*)>/.exec(past)?.[0] ?? "";
		expect(attr(rect, "width")).toBe("0");
		const both = frame(fx, {
			brk,
			layers: [{ ...marker("unusual", "under"), areaClip: () => "M0 0H10V10Z" }],
		});
		const ids = [...both.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]);
		expect(ids.length).toBe(2);
		expect(new Set(ids).size).toBe(2);
	});

	it("puts the label on the left of the ring when there is no room on the right, and keeps it in the box", () => {
		const right = /<text x="([^"]+)" y="([^"]+)"[^>]*>chain breaks here/.exec(frame(fx, { brk }));
		expect(right?.[1]).toBe("308");
		expect(right?.[2]).toBe("84");
		const edge = frame(fx, { brk: { x: fx.w - 40, y: 3 } });
		const left = /<text x="([^"]+)" y="([^"]+)" text-anchor="end">chain breaks here/.exec(edge);
		expect(left?.[1]).toBe(String(fx.w - 48));
		expect(left?.[2]).toBe("12");
		// Right of the ring while 104px fit after the 8px gap, left from one pixel closer; and the top clamp holds on both sides.
		const side = (x: number, y: number): string =>
			/<text x="[^"]+" y="[^"]+"( text-anchor="end")?>chain breaks here/.exec(
				frame(fx, { brk: { x, y } }),
			)?.[1] === undefined
				? "right"
				: "left";
		expect(side(fx.w - 112, 90)).toBe("right");
		expect(side(fx.w - 111, 90)).toBe("left");
		const top = /<text x="[^"]+" y="([^"]+)"[^>]*>chain breaks here/.exec(
			frame(fx, { brk: { x: 300, y: 3 } }),
		);
		expect(top?.[1]).toBe("12");
	});

	it("rings the break and says so, after the over layers and before the open record's ring", () => {
		const html = frame(fx, { brk, layers: [over], mark: { x: 10, y: 10 } });
		const g = /<g class="ut-sp-break">(.*?)<\/g>/.exec(html)?.[1] ?? "";
		const c = /<circle\b[^>]*>/.exec(g)?.[0] ?? "";
		expect(attr(c, "cx")).toBe("300");
		expect(attr(c, "cy")).toBe("90");
		expect(attr(c, "r")).toBe("4.5");
		const t = /<text\b([^>]*)>([^<]*)<\/text>/.exec(g);
		expect(t?.[2]).toBe("chain breaks here");
		expect(attr(t?.[0] ?? "", "x")).toBe("308");
		expect(attr(t?.[0] ?? "", "y")).toBe("84");
		expect(html.indexOf("knee-over")).toBeLessThan(html.indexOf("ut-sp-break"));
		expect(html.indexOf("ut-sp-break")).toBeLessThan(html.indexOf("ut-sp-mark"));
	});

	it("draws none of it for a clean chain", () => {
		const html = frame(fx, { brk: null });
		expect(html).not.toContain("ut-sp-gap");
		expect(html).not.toContain("ut-sp-dashed");
		expect(html).not.toContain("ut-sp-break");
		expect(html).not.toContain("chain breaks here");
		expect(html).not.toContain("<clipPath");
	});
});

describe("chart frame: all spend under a filter", () => {
	const fx = chartFixture();
	const ghost = "M0 100L700 50";
	const note = "Filtered: xAI · faint line: all spend";
	const mid = marker("unusual", "mid");

	it("draws all spend as a faint line between the mid layers and the glow, with its caption", () => {
		const html = frame(fx, { ghost, note, layers: [mid] });
		const paths = tags(html, "path", "ut-sp-ghost");
		expect(paths.length).toBe(1);
		expect(attr(paths[0] ?? "", "d")).toBe(ghost);
		expect(attr(paths[0] ?? "", "fill")).toBe("none");
		expect(html.indexOf("unusual-mid")).toBeLessThan(html.indexOf("ut-sp-ghost"));
		expect(html.indexOf("ut-sp-ghost")).toBeLessThan(html.indexOf('class="ut-sp-glow"'));
		const cap = /<text\b[^>]*class="ut-sp-fcap"[^>]*>([^<]*)<\/text>/.exec(html);
		expect(cap?.[1]).toBe(note);
		expect(attr(cap?.[0] ?? "", "x")).toBe("4");
		expect(attr(cap?.[0] ?? "", "y")).toBe("30");
		expect(html.indexOf("ut-sp-fcap")).toBeLessThan(html.indexOf('class="ut-sp-glow"'));
	});

	it("draws no caption without a faint line, and none without a note", () => {
		const noGhost = frame(fx, { ghost: null, note });
		expect(noGhost).not.toContain("ut-sp-ghost");
		expect(noGhost).not.toContain("ut-sp-fcap");
		expect(noGhost).not.toContain("Filtered:");
		const noNote = frame(fx, { ghost, note: null });
		expect(noNote).toContain("ut-sp-ghost");
		expect(noNote).not.toContain("ut-sp-fcap");
	});
});

describe("chart frame: the full order", () => {
	const fx = chartFixture();

	it("stacks every mark as specified", () => {
		const html = frame(fx, {
			layers: [marker("bands", "under"), marker("unusual", "mid"), marker("knee", "over")],
			ghost: "M0 1L2 3",
			note: "Filtered: search · faint line: all spend",
			brk: { x: 300, y: 90 },
			mark: { x: 10, y: 10 },
			pin: { x: 40, y: 50 },
			live: true,
		});
		const order = [
			'class="ut-sp-grid"',
			"bands-under",
			'class="ut-sp-area"',
			"unusual-mid",
			'class="ut-sp-ghost"',
			'class="ut-sp-fcap"',
			'class="ut-sp-glow"',
			'class="ut-sp-knock"',
			'class="ut-sp-line"',
			'class="ut-sp-line ut-sp-gap"',
			'class="ut-sp-line ut-sp-dashed"',
			"knee-over",
			'class="ut-sp-break"',
			'class="ut-sp-mark"',
			'class="ut-sp-pin"',
			'class="ut-sp-live"',
		].map((m) => html.indexOf(m));
		expect(order.every((i) => i > -1)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});
});

/** The value of attribute `name` on the first element of `html` whose class is `cls`. */
function attrOf(html: string, cls: string, name: string): string | undefined {
	const tag = new RegExp(`<[a-zA-Z]+[^>]*class="${cls}"[^>]*>`).exec(html)?.[0];
	return tag === undefined ? undefined : new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

describe("chart frame: where each mark sits and how it is drawn", () => {
	const fx = chartFixture({ knee: 40 });

	it("draws a grid line across the box at the tick's drawn height, and its label 4px in and 3px above", () => {
		const html = frame(fx, { ticks: [{ drawn: 50, label: 80 }] });
		const y = fx.geo.yOfDrawn(50);
		expect(y).not.toBe(fx.geo.yOf(50));
		expect(attrOf(html, "ut-sp-grid", "x1")).toBe("0");
		expect(attrOf(html, "ut-sp-grid", "x2")).toBe(String(fx.ctx.w));
		expect(attrOf(html, "ut-sp-grid", "y1")).toBe(String(y));
		expect(attrOf(html, "ut-sp-grid", "y2")).toBe(String(y));
		expect(attrOf(html, "ut-sp-tick", "x")).toBe(String(fx.ctx.w - 4));
		expect(attrOf(html, "ut-sp-tick", "y")).toBe(String(y - 3));
		expect(html).toContain('style="stroke:var(--dk-grid)"');
	});

	it("fades the area from the 95th-percentile height to the base, with each stop's own opacity", () => {
		const html = frame(fx);
		const fade = areaFadeTop(fx.ctx.drawn, fx.ctx.y, fx.ctx.baseY);
		// The fade follows the drawn (smoothed) line, not the true rates behind it.
		expect(fade).not.toBe(areaFadeTop(fx.ctx.rate, fx.ctx.y, fx.ctx.baseY));
		expect(html).toMatch(new RegExp(`<linearGradient[^>]*y1="${fade}"[^>]*y2="${fx.ctx.baseY}"`));
		const stops = [...html.matchAll(/<stop[^>]*stop-opacity="([^"]+)"/g)].map((m) => Number(m[1]));
		expect(stops).toEqual(AREA_STOPS.map(([, o]) => o));
	});

	it("fills the area path with the gradient and draws the area's own outline, not the line's", () => {
		const html = frame(fx, { idPrefix: "q" });
		expect(attrOf(html, "ut-sp-area", "d")).toBe(fx.series.area);
		expect(fx.series.area).not.toBe(fx.series.d);
		expect(attrOf(html, "ut-sp-area", "fill")).toMatch(/^url\(#q[A-Za-z0-9_-]*-area\)$/);
	});

	it("draws the glow, the knockout and the line with their own widths, opacities and filter", () => {
		const html = frame(fx, { idPrefix: "q" });
		expect(attrOf(html, "ut-sp-glow", "stroke-width")).toBe(String(LINE_RECIPE.glowW));
		expect(attrOf(html, "ut-sp-glow", "opacity")).toBe(String(LINE_RECIPE.glowOpacity));
		expect(attrOf(html, "ut-sp-glow", "filter")).toMatch(/^url\(#q[A-Za-z0-9_-]*-glow\)$/);
		expect(attrOf(html, "ut-sp-knock", "stroke-width")).toBe(String(LINE_RECIPE.knockW));
		expect(attrOf(html, "ut-sp-knock", "opacity")).toBe(String(LINE_RECIPE.knockOpacity));
		expect(attrOf(html, "ut-sp-knock", "filter")).toBeUndefined();
		expect(attrOf(html, "ut-sp-line", "stroke-width")).toBe(String(LINE_RECIPE.lineW));
		expect(attrOf(html, "ut-sp-line", "opacity")).toBeUndefined();
	});

	it("puts the live dot on the line's last point, kept 5px inside the box, with a 1.5px ring", () => {
		const html = frame(fx, { live: true });
		const cx = Math.min(fx.series.last, fx.ctx.w - 5);
		expect(cx).toBeLessThan(fx.series.last);
		expect(attrOf(html, "ut-sp-live", "cx")).toBe(String(cx));
		expect(attrOf(html, "ut-sp-live", "cy")).toBe(String(fx.series.curve.at(fx.series.last)));
		expect(attrOf(html, "ut-sp-live", "stroke-width")).toBe("1.5");
	});

	it("draws the tick labels and every stroke with their own colour, join and cap", () => {
		const html = frame(fx, {
			ticks: [{ drawn: 50, label: 80 }],
			live: true,
			pin: { x: 10, y: 20 },
		});
		expect(attrOf(html, "ut-sp-tick", "text-anchor")).toBe("end");
		expect(attrOf(html, "ut-sp-tick", "style")).toBe("fill:var(--dk-label)");
		for (const cls of ["ut-sp-glow", "ut-sp-knock", "ut-sp-line"]) {
			expect(attrOf(html, cls, "stroke-linejoin")).toBe("round");
			expect(attrOf(html, cls, "stroke-linecap")).toBe("round");
			expect(attrOf(html, cls, "fill")).toBe("none");
		}
		expect(attrOf(html, "ut-sp-glow", "style")).toBe("stroke:var(--sp-glow)");
		expect(attrOf(html, "ut-sp-knock", "style")).toBe("stroke:var(--dk-pane)");
		expect(attrOf(html, "ut-sp-line", "style")).toBe("stroke:var(--sp-ink)");
		expect(attrOf(html, "ut-sp-area", "stroke")).toBe("none");
		expect(attrOf(html, "ut-sp-live", "style")).toBe("fill:var(--dk-gold);stroke:var(--dk-pane)");
	});

	it("draws the gradient straight down in the line's ink, and the glow's filter box wider than the line", () => {
		const html = frame(fx);
		expect(html).toMatch(/<linearGradient[^>]*x1="0"[^>]*x2="0"/);
		const stops = [...html.matchAll(/<stop[^>]*style="([^"]*)"/g)].map((m) => m[1]);
		expect(stops.length).toBe(AREA_STOPS.length);
		for (const st of stops) expect(st).toBe("stop-color:var(--sp-ink)");
		expect(html).toMatch(/<filter[^>]*x="-5%"[^>]*y="-50%"[^>]*width="110%"[^>]*height="200%"/);
	});
});

describe("chart frame: the sheet", () => {
	const sheet = readFileSync(
		new URL("../src/app/windows/spend/spend.css", import.meta.url),
		"utf8",
	);
	const fx = chartFixture();

	it("names every class the frame's marks use that it does not paint inline", () => {
		const html = frame(fx, {
			brk: { x: 300, y: 90 },
			mark: { x: 10, y: 10 },
			pin: { x: 40, y: 50 },
			ghost: "M0 100L700 50",
			note: "n",
		});
		for (const cls of ["gap", "dashed", "break", "ghost", "fcap", "mark", "pin"]) {
			expect(html).toContain(`ut-sp-${cls}`);
			expect(sheet).toMatch(new RegExp(`\\.ut-sp-${cls}(?![\\w-])`));
		}
	});

	/** The declarations of the sheet's rule for `selector`. */
	const rule = (selector: string): string => {
		const at = sheet.indexOf(`${selector} {`);
		return at < 0 ? "" : sheet.slice(at, sheet.indexOf("}", at));
	};

	it("paints the dashed copy itself, since the main line's paint is inline on the main line", () => {
		const dashed = rule(".ut-sp-line.ut-sp-dashed");
		expect(dashed).toContain("stroke: var(--sp-ink)");
		expect(dashed).toMatch(/stroke-width: [\d.]+/);
		expect(dashed).toContain("stroke-dasharray");
		const gap = rule(".ut-sp-line.ut-sp-gap");
		expect(gap).toContain("stroke: var(--dk-pane)");
		expect(gap).toMatch(/stroke-width: [\d.]+/);
		// The gap under the dashes is wider than the dashes, or it would not hide the solid line.
		const w = (r: string): number => Number(/stroke-width: ([\d.]+)/.exec(r)?.[1]);
		expect(w(gap)).toBeGreaterThan(w(dashed));
	});
});
