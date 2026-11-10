// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Share of spend window: a ring and a legend of where spend went, by the dimension the switch picks. It reads the
 * chart's rows over the range to now, so a pin never cuts it short; at a pinned or hovered moment it shows that
 * moment's bucket and says so. (This file was the day-one test of the window's three bar lists.)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { breakdown } from "../src/shared/breakdown.js";
import { LINE_BUCKETS } from "../src/shared/chart-window.js";
import { SHARE_EMPTY } from "../src/shared/donut.js";
import { EMPTY_FILTERS } from "../src/shared/filters.js";
import { formatUsdTotal, formatUtcMinute } from "../src/shared/format.js";
import { categoryBus, momentBus } from "../src/shared/hover-bus.js";
import { LEVEL_SUBTITLE, roleCaption, SUBTITLE_DRILL } from "../src/shared/level.js";
import type { LedgerRow } from "../src/shared/rows.js";
import { appExport } from "./helpers/day-one.js";
import { withDesk } from "./helpers/desk.js";
import {
	attr,
	CHART,
	eightLanes,
	HOUR,
	innerOf,
	legendFigures,
	pinnedData,
	shareData,
	spend,
	tagsOf,
	text,
} from "./helpers/share.js";

const SHARE = join(import.meta.dirname, "..", "src", "app", "windows", "share");

let ShareWindow: React.ComponentType;

beforeAll(async () => {
	ShareWindow = await appExport("windows/share/share-window", "ShareWindow");
});

afterEach(() => {
	categoryBus.set(null);
	momentBus.set(null);
});

const win = (o: Parameters<typeof withDesk>[1] = {}): Promise<string> =>
	withDesk(createElement(ShareWindow), o);

const centre = (
	html: string,
): { name: string | null; amount: string | null; sub: string | null } => ({
	name: innerOf(html, /<text class="c1"[^>]*>(<title>[^<]*<\/title>)?/),
	amount: innerOf(html, /<text class="c2"[^>]*>/),
	sub: innerOf(html, /<text class="c3"[^>]*>/),
});
const subtitle = (html: string): string | null => innerOf(html, /<span class="ut-win-sub"[^>]*>/);
const ringLabel = (html: string): string =>
	attr(tagsOf(html, "ut-sh-ring")[0] ?? "", "aria-label") ?? "";
const sliceKeys = (html: string): Array<string | null> =>
	tagsOf(html, "ut-sh-slice").map((t) => attr(t, "data-key"));
const percents = (html: string): string[] =>
	[...html.matchAll(/<span class="p">(.*?)<\/span>/g)].map((m) => text(m[1] ?? ""));
const sum = (figures: Array<[string, number]>): number => figures.reduce((a, [, ut]) => a + ut, 0);
const iso = (ms: number): string => new Date(ms).toISOString();
/** The start of bucket `k` of the chart's window at 1W. */
const bucketStart = (k: number): number => CHART.startMs + k * LINE_BUCKETS["1w"];
const posOf = (rows: LedgerRow[], actor: string, hour: number): LedgerRow =>
	rows.find(
		(r) => r.actor === actor && r.ts === iso(CHART.startMs + hour * HOUR + 60_000),
	) as LedgerRow;

describe("the Share of spend window", () => {
	it("is the Share window, and holds the switch, the ring and the legend in place of the three lists", async () => {
		const html = await win({ data: shareData(eightLanes()) });
		expect(html).toContain('aria-label="Share of spend"');
		expect(html.match(/data-win="share"/g)).toHaveLength(1);
		expect(tagsOf(html, "ut-sh")).toHaveLength(1);
		expect(tagsOf(html, "ut-seg")).toHaveLength(1);
		expect(tagsOf(html, "ut-sh-ring")).toHaveLength(1);
		expect(tagsOf(html, "ut-sh-legend")).toHaveLength(1);
		expect(html).not.toContain("ut-split");
		expect(html).not.toContain("by kind, model and job type");
	});

	it("names its level in the subtitle, from the level's own constants", async () => {
		const lanes = await win({ data: shareData(eightLanes()) });
		expect(subtitle(lanes)).toBe(LEVEL_SUBTITLE.lane);
		const models = await win({ data: shareData(eightLanes()), view: { dim: "model" } });
		expect(subtitle(models)).toBe(LEVEL_SUBTITLE.model);

		const twoProviders = [spend("a", 1, 500), spend("b", 1, 300, { model: "gpt-5" })];
		const providers = await win({ data: shareData(twoProviders), view: { dim: "provider" } });
		expect(subtitle(providers)).toBe(LEVEL_SUBTITLE.provider);
		expect(sliceKeys(providers)).toEqual(["Anthropic", "OpenAI"]);

		// One provider is followed down to its models, and one model to its lanes: the subtitle says which.
		const twoModels = [spend("a", 1, 500), spend("b", 1, 300, { model: "claude-fable-5" })];
		const drilled = await win({ data: shareData(twoModels), view: { dim: "provider" } });
		expect(subtitle(drilled)).toBe(`${SUBTITLE_DRILL.model} · Anthropic`);
		expect(sliceKeys(drilled)).toEqual(["claude-sonnet-5", "claude-fable-5"]);
		const oneModel = await win({ data: shareData(eightLanes()), view: { dim: "provider" } });
		expect(subtitle(oneModel)).toBe(`${SUBTITLE_DRILL.lane} · claude-sonnet-5`);
		expect(sliceKeys(oneModel)).toHaveLength(8);
		// The switch still shows what was chosen, not the level it was followed down to.
		expect(oneModel).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Provider<\/button>/);
	});

	it("says roles are declared, not checked, at the role level only", async () => {
		const rows = [
			spend("a", 1, 500, { jobType: "review", typeSource: "explicit" }),
			spend("b", 1, 300, { jobType: "build", typeSource: "explicit" }),
		];
		const roles = await win({ data: shareData(rows), view: { dim: "role" } });
		expect(subtitle(roles)).toBe(LEVEL_SUBTITLE.role);
		const caption = innerOf(roles, /<p class="ut-sh-cap"[^>]*>/);
		expect(caption).toBe(roleCaption(new Map([["explicit", 2]])));
		expect(caption).toBe("Roles as declared by the caller, not checked");
		expect(sliceKeys(roles)).toEqual(["review", "build"]);
		for (const dim of ["lane", "model", "kind", "provider"] as const) {
			expect(await win({ data: shareData(rows), view: { dim } })).not.toContain("ut-sh-cap");
		}
	});

	it("prints whole percentages small and one decimal when it fills the desk", async () => {
		const rows = [spend("a", 1, 577), spend("b", 1, 423)];
		const small = await win({ data: shareData(rows) });
		expect(attr(tagsOf(small, "ut-sh")[0] ?? "", "data-filled")).toBe("false");
		expect(percents(small)).toEqual(["58%", "42%"]);
		const filled = await win({ data: shareData(rows), fill: "share" });
		expect(attr(tagsOf(filled, "ut-sh")[0] ?? "", "data-filled")).toBe("true");
		expect(percents(filled)).toEqual(["57.7%", "42.3%"]);
	});

	it("opens the range on a bucket mark, so a record a minute into the first hour is counted", async () => {
		const early = spend("early", 0, 500, { ts: iso(CHART.startMs + 30_000) });
		const rows = [early, spend("a", 5, 700)];
		const html = await win({ data: shareData(rows) });
		expect(centre(html).amount).toBe(formatUsdTotal(1_200));
		expect(sum(legendFigures(html))).toBe(1_200);
	});

	it("at rest shows the range: the centre is the total, and the legend adds up to it", async () => {
		const rows = eightLanes();
		const html = await win({ data: shareData(rows) });
		const total = breakdown(rows, CHART, "lane").totalUt;
		expect(total).toBe(36_000 + 3_600 + 56);
		expect(centre(html)).toEqual({
			name: "This range",
			amount: formatUsdTotal(total),
			sub: "8 lanes",
		});
		expect(sliceKeys(html)).toEqual(["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"]);
		expect(tagsOf(html, "ut-sh-row")).toHaveLength(5);
		expect(tagsOf(html, "ut-sh-other")).toHaveLength(1);
		const figures = legendFigures(html);
		expect(figures.map(([key]) => key)).toEqual(["k0", "k1", "k2", "k3", "k4", "Other"]);
		expect(figures[0]?.[1]).toBe(8_000 + 807);
		expect(sum(figures)).toBe(total);
		expect(attr(tagsOf(html, "ut-sh-legend")[0] ?? "", "data-when")).toBe("range");
		expect(ringLabel(html)).toMatch(/^Share of spend by lane, this range: k0 \$0\.88, 22\.2%; /);
		expect(ringLabel(html)).toContain("; Other ");
		expect(ringLabel(html)).not.toContain("status:");
	});

	it("at a pinned record shows that record's bucket and says when, and still counts what came after", async () => {
		const rows = eightLanes();
		const pin = posOf(rows, "k3", 2);
		const html = await win({ data: pinnedData(rows, pin), view: { at: pin.pos } });
		expect(centre(html)).toEqual({
			name: `At ${formatUtcMinute(iso(bucketStart(2)))}`,
			amount: formatUsdTotal(36_000),
			sub: "8 lanes",
		});
		const figures = legendFigures(html);
		expect(figures).toEqual([
			["k0", 8_000],
			["k1", 7_000],
			["k2", 6_000],
			["k3", 5_000],
			["k4", 4_000],
			["Other", 6_000],
		]);
		expect(formatUsdTotal(sum(figures))).toBe(centre(html).amount);
		expect(attr(tagsOf(html, "ut-sh-legend")[0] ?? "", "data-when")).toBe(iso(bucketStart(2)));
		expect(sliceKeys(html)).toEqual(["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"]);
		expect(ringLabel(html)).toContain(`, at ${formatUtcMinute(iso(bucketStart(2)))}: k0 `);
		expect(html).not.toMatch(/up to/i);
		expect(html).not.toMatch(/verified/i);

		// A pin on a later bucket reads that bucket: records stamped after an earlier pin are all still held.
		const late = posOf(rows, "k0", 30);
		const later = await win({ data: pinnedData(rows, late), view: { at: late.pos } });
		expect(centre(later).name).toBe(`At ${formatUtcMinute(iso(bucketStart(30)))}`);
		expect(sum(legendFigures(later))).toBe(3_600 + 56);
	});

	it("shows the whole range, to now, for a pin it cannot place", async () => {
		const old = spend("k0", -5, 999);
		const rows = [old, ...eightLanes()];
		const total = breakdown(rows, CHART, "lane").totalUt;
		expect(total).toBe(36_000 + 3_600 + 56);
		// A pin before the range began: the records after it are all still counted.
		const before = await win({ data: pinnedData(rows, old), view: { at: old.pos } });
		expect(centre(before)).toEqual({
			name: "This range",
			amount: formatUsdTotal(total),
			sub: "8 lanes",
		});
		expect(sum(legendFigures(before))).toBe(total);
		expect(attr(tagsOf(before, "ut-sh-legend")[0] ?? "", "data-when")).toBe("range");
		expect(before).not.toMatch(/up to/i);
		expect(before).not.toMatch(/verified/i);
		// A pin on a record the page does not hold.
		const absent = await win({ data: shareData(rows), view: { at: 9_999_999 } });
		expect(centre(absent)).toEqual({
			name: "This range",
			amount: formatUsdTotal(total),
			sub: "8 lanes",
		});
		// A pinned record whose time cannot be read.
		const broken = spend("k0", 3, 0, { ts: "not a time" });
		const unread = await win({ data: shareData([...rows, broken]), view: { at: broken.pos } });
		expect(centre(unread).name).toBe("This range");
		expect(unread).not.toMatch(/NaN/);
	});

	it("reads a pin at the very end of the range in the last bucket", async () => {
		const last = Math.ceil((CHART.endMs - CHART.startMs) / HOUR) - 1;
		const edge = spend("k0", 0, 0, { ts: iso(CHART.endMs), kind: "info" });
		const rows = [spend("a", last, 700, { ts: iso(CHART.endMs - 1_000) }), spend("b", 1, 300), edge];
		const html = await win({ data: shareData(rows), view: { at: edge.pos } });
		expect(centre(html).name).toBe(`At ${formatUtcMinute(iso(bucketStart(last)))}`);
		expect(legendFigures(html)).toEqual([
			["a", 700],
			["b", 0],
		]);
		expect(percents(html)).toEqual(["100%", "0%"]);
	});

	it("follows another window's hovered moment, which wins over a pin, and never reorders", async () => {
		const rows = eightLanes();
		momentBus.set({ ms: bucketStart(30) + 5 * 60_000, span: [0, 1], from: "spend" });
		const hovered = await win({ data: shareData(rows) });
		expect(centre(hovered)).toEqual({
			name: `At ${formatUtcMinute(iso(bucketStart(30)))}`,
			amount: formatUsdTotal(3_600 + 56),
			sub: "8 lanes",
		});
		expect(legendFigures(hovered)[0]).toEqual(["k0", 807]);
		expect(sum(legendFigures(hovered))).toBe(3_600 + 56);
		expect(sliceKeys(hovered)).toEqual(["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"]);

		const pin = posOf(rows, "k3", 2);
		const both = await win({ data: pinnedData(rows, pin), view: { at: pin.pos } });
		expect(centre(both).name).toBe(`At ${formatUtcMinute(iso(bucketStart(30)))}`);
		// Its own moment is not another window's: it stays on the pin.
		momentBus.set({ ms: bucketStart(30), span: [0, 1], from: "share" });
		const own = await win({ data: pinnedData(rows, pin), view: { at: pin.pos } });
		expect(centre(own).name).toBe(`At ${formatUtcMinute(iso(bucketStart(2)))}`);
		// A moment outside the range shows the range.
		momentBus.set({ ms: CHART.startMs - 1, span: [0, 1], from: "spend" });
		expect(centre(await win({ data: shareData(rows) })).name).toBe("This range");
	});

	it("puts a lit category in the centre, with its share and when it was read", async () => {
		const rows = eightLanes();
		const picked = { ...EMPTY_FILTERS, actors: ["k1"] };
		const idle = await win({ data: shareData(rows, picked), view: { filters: picked } });
		// The selected lane is still drawn among the others, at the number it had before the click.
		expect(sliceKeys(idle)).toHaveLength(8);
		expect(centre(idle)).toEqual({
			name: "k1",
			amount: formatUsdTotal(7_707),
			sub: "19.4% this range",
		});
		expect(attr(tagsOf(idle, "c2")[0] ?? "", "data-key")).toBe("k1");

		const pin = posOf(rows, "k3", 2);
		const at = `at ${formatUtcMinute(iso(bucketStart(2)))}`;
		const pinned = await win({
			data: pinnedData(rows, pin, picked),
			view: { filters: picked, at: pin.pos },
		});
		expect(centre(pinned)).toEqual({
			name: "k1",
			amount: formatUsdTotal(7_000),
			sub: `19.4% ${at}`,
		});
		const row = tagsOf(pinned, "ut-sh-row").find((r) => attr(r, "data-key") === "k1") ?? "";
		expect(attr(row, "title")).toContain(`19.4% ${at}. Click to filter the desk to it.`);

		// A hovered category wins over the selected one; a hover on another level lights nothing here.
		categoryBus.set({ dim: "lane", key: "k4", from: "spend" });
		expect(
			centre(await win({ data: shareData(rows, picked), view: { filters: picked } })).name,
		).toBe("k4");
		categoryBus.set({ dim: "model", key: "k4", from: "spend" });
		expect(centre(await win({ data: shareData(rows) })).name).toBe("This range");
		// Two selected: neither is the one, so the centre is the total.
		const pair = { ...EMPTY_FILTERS, actors: ["k1", "k2"] };
		categoryBus.set(null);
		expect(centre(await win({ data: shareData(rows, pair), view: { filters: pair } })).name).toBe(
			"This range",
		);
	});

	it("says a status filter narrows it, in the reader's word for the status", async () => {
		const rows = [
			spend("a", 1, 500, { status: "ambiguous" }),
			spend("b", 1, 300, { status: "ambiguous" }),
			spend("c", 1, 900),
		];
		const narrowed = { ...EMPTY_FILTERS, statuses: ["ambiguous", "failed"] };
		const html = await win({ data: shareData(rows, narrowed), view: { filters: narrowed } });
		expect(sliceKeys(html)).toEqual(["a", "b"]);
		expect(ringLabel(html)).toMatch(/, status: unresolved, failed$/);
		expect(html).not.toMatch(/ambiguous/);
		const plain = await win({ data: shareData(rows) });
		expect(plain).not.toContain("status:");
	});

	it("with no spend shows the hairline, the empty line and zero dollars, and no NaN", async () => {
		for (const data of [shareData([]), shareData([spend("a", 1, 0, { kind: "info" })])]) {
			for (const dim of ["lane", "role", "model", "kind", "provider"] as const) {
				const html = await win({ data, view: { dim } });
				expect(tagsOf(html, "ut-sh-hair")).toHaveLength(1);
				expect(tagsOf(html, "ut-sh-slice")).toHaveLength(0);
				expect(innerOf(html, /<li class="ut-sh-none"[^>]*>/)).toBe(SHARE_EMPTY);
				expect(centre(html).amount).toBe("$0.00");
				expect(centre(html).name).toBe("This range");
				// With nothing to follow down, Provider keeps its own level.
				expect(subtitle(html)).toBe(LEVEL_SUBTITLE[dim]);
				expect(html).not.toMatch(/NaN/);
			}
		}
		expect(centre(await win({ data: shareData([]) })).sub).toBe("0 lanes");
	});

	it("draws one kind as a whole ring at 100%", async () => {
		const html = await win({ data: shareData(eightLanes()), view: { dim: "kind" } });
		expect(sliceKeys(html)).toEqual(["llm_call"]);
		expect(tagsOf(html, "body")).toHaveLength(1);
		expect(percents(html)).toEqual(["100%"]);
		expect(centre(html).sub).toBe("1 kind");
	});

	it("reads the chart's rows and nothing that ends at the pin, and nothing of the browser while rendering", () => {
		const source = readFileSync(join(SHARE, "share-window.tsx"), "utf-8").replace(
			/\/\*[\s\S]*?\*\/|\/\/.*/g,
			"",
		);
		expect(source).not.toMatch(/useBreakdown|shownRows|\.shown\b|list\.filtered/);
		expect(source).not.toMatch(
			/[^/\w-]window\.|matchMedia|[^/\w-]document\.|requestAnimationFrame|performance\./,
		);
		expect(source).not.toMatch(/\.css["']/);
	});
});
