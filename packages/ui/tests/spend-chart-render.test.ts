// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Spend chart's marks as static markup. The frame cases are here; the chart's own cases (cursor, keys, pin,
 * headline) are added below in their own groups.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { LAYERS, type LayerZ, type SpendLayer } from "../src/app/windows/spend/layers.js";
import { formatUsdAxis } from "../src/shared/format.js";
import {
	AREA_STOPS,
	areaFadeTop,
	drawSeries,
	LINE_RECIPE,
	niceTicks,
} from "../src/shared/spend-scale.js";
import { appExport, type Component } from "./helpers/day-one.js";
import { type ChartFixture, chartFixture } from "./helpers/spend-fixture.js";

interface FrameProps {
	ctx: ChartFixture["ctx"];
	geo: ChartFixture["geo"];
	series: ChartFixture["series"];
	ticks: ChartFixture["ticks"];
	layers: readonly SpendLayer[];
	live: boolean;
	pin: { x: number; y: number } | null;
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
			ticks: fx.ticks,
			layers: [],
			live: false,
			pin: null,
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

	it("draws the over layer before the pin mark and the live dot", () => {
		const both = frame(fx, { layers, live: true, pin: { x: 40, y: 50 } });
		expect(both.indexOf("knee-over")).toBeLessThan(both.indexOf('class="ut-sp-pin"'));
		expect(both.indexOf('class="ut-sp-pin"')).toBeLessThan(both.indexOf("ut-sp-live"));
	});
});

describe("chart frame: the grid", () => {
	const fx = chartFixture();

	it("draws a supplied tick at its drawn height with its own label", () => {
		const html = frame(fx, { ticks: [{ drawn: 50, label: 80 }] });
		const y = fx.geo.yOfDrawn(50);
		expect(html).toMatch(new RegExp(`<line[^>]*class="ut-sp-grid"[^>]*y1="${y}"`));
		expect(html).toContain(`>${formatUsdAxis(80)}<`);
	});

	it("draws one line and one label for each plain tick it is given", () => {
		const plain = niceTicks(fx.geo.top);
		expect(plain.length).toBeGreaterThan(0);
		const html = frame(fx, { ticks: plain.map((t) => ({ drawn: t, label: t })) });
		expect([...html.matchAll(/class="ut-sp-grid"/g)].length).toBe(plain.length);
		for (const t of plain) expect(html).toContain(`>${formatUsdAxis(t)}<`);
	});

	it("names the unit once", () => {
		expect([...frame(fx).matchAll(/\$\/h/g)].length).toBe(1);
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

	it("draws the pin mark only when there is a pin", () => {
		expect(frame(fx)).not.toContain("ut-sp-pin");
		const html = frame(fx, { pin: { x: 120.5, y: 60 } });
		expect(html).toMatch(/<circle[^>]*class="ut-sp-pin"[^>]*cx="120.5"[^>]*cy="60"/);
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

	it("gives the pin mark the same 1.5px ring", () => {
		const html = frame(fx, { pin: { x: 10, y: 20 } });
		expect(attrOf(html, "ut-sp-pin", "stroke-width")).toBe("1.5");
		expect(attrOf(html, "ut-sp-pin", "r")).toBe("4.5");
	});

	it("draws the unit, the tick labels and every stroke with their own colour, join and cap", () => {
		const html = frame(fx, {
			ticks: [{ drawn: 50, label: 80 }],
			live: true,
			pin: { x: 10, y: 20 },
		});
		expect(attrOf(html, "ut-sp-unit", "x")).toBe("4");
		expect(attrOf(html, "ut-sp-unit", "y")).toBe("10");
		expect(attrOf(html, "ut-sp-unit", "style")).toBe("fill:var(--dk-label)");
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
		expect(attrOf(html, "ut-sp-pin", "style")).toBe("fill:var(--sp-ink);stroke:var(--dk-pane)");
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
