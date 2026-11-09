// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { allCss, legacyCss } from "./helpers/css.js";

/**
 * Small controls keep their look and get a larger tappable area: at least 32px on a desktop, at least 44px at the
 * phone width (WCAG 2.5.8 asks 24px, touch guidance 44px). The area is an invisible `::after` stretched past the
 * control by a negative `inset`, in one block at the end of styles.css. This test reads that stylesheet as text and
 * does the arithmetic from the numbers the stylesheet gives; it has no browser, so a label-defined WIDTH (a chip, a
 * sort button) is not computed here: those controls are checked on their short side, which is the height, and the
 * sideways expansion is only checked against its room.
 */
// The hit-area block is the end of styles.css, and every marker slice below is cut from that file alone: the desk's
// sheets come after it in `allCss()`, and a slice from the marker on must not run into them. The rules a check looks
// up by selector read the whole page (`allCss()`), so a desk rule that restyles a control is measured too.
const CSS = legacyCss();

const DESKTOP_MIN = 32;
const PHONE_MIN = 44;
const PHONE_QUERY = "@media (max-width: 760px)";
const MARKER = "/* ── Hit areas ──";

// ── A small CSS reader: rules in source order, each with its at-rule (media) and cascade-layer context ──────────────────────────────

interface Rule {
	selectors: string[];
	decls: Map<string, string>;
	media: string | undefined;
	/** The cascade layer the rule sits in, or undefined when it is unlayered (an unlayered rule beats every layered one,
	 * whatever its specificity). */
	layer: string | undefined;
}

function parseRules(source: string): Rule[] {
	const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
	const rules: Rule[] = [];
	let i = 0;
	const skipBlock = (): void => {
		let depth = 1;
		i++;
		while (i < css.length && depth > 0) {
			if (css[i] === "{") depth++;
			if (css[i] === "}") depth--;
			i++;
		}
	};
	const block = (media: string | undefined, layer: string | undefined): void => {
		while (i < css.length) {
			while (i < css.length && /\s/.test(css[i] ?? "")) i++;
			if (i >= css.length) return;
			if (css[i] === "}") {
				i++;
				return;
			}
			let j = i;
			while (j < css.length && css[j] !== "{" && css[j] !== ";") j++;
			const prelude = css.slice(i, j).replace(/\s+/g, " ").trim();
			if (css[j] === ";") {
				i = j + 1;
				continue;
			}
			i = j;
			if (prelude.startsWith("@media")) {
				i++;
				block(prelude, layer);
			} else if (prelude.startsWith("@layer")) {
				i++;
				block(media, prelude.slice("@layer".length).trim());
			} else if (prelude.startsWith("@")) {
				skipBlock();
			} else {
				const end = css.indexOf("}", i);
				const decls = new Map<string, string>();
				for (const d of css.slice(i + 1, end).split(";")) {
					const colon = d.indexOf(":");
					if (colon < 0) continue;
					decls.set(
						d.slice(0, colon).trim(),
						d
							.slice(colon + 1)
							.replace(/\s+/g, " ")
							.trim(),
					);
				}
				rules.push({
					selectors: prelude.split(",").map((s) => s.replace(/\s+/g, " ").trim()),
					decls,
					media,
					layer,
				});
				i = end + 1;
			}
		}
	};
	block(undefined, undefined);
	return rules;
}

const RULES = parseRules(allCss());

type Viewport = "desktop" | "phone";

/** The declarations that reach `selector` on this viewport, later source order winning (the selectors are exact). */
function cascade(selector: string, viewport: Viewport): Map<string, string> {
	const out = new Map<string, string>();
	for (const r of RULES) {
		if (!r.selectors.includes(selector)) continue;
		if (r.media !== undefined && !(viewport === "phone" && r.media === PHONE_QUERY)) continue;
		for (const [k, v] of r.decls) out.set(k, v);
	}
	return out;
}

const px = (value: string): number => {
	const m = /^(-?\d+(?:\.\d+)?)(?:px)?$/.exec(value.trim());
	if (m === null) throw new Error(`not a pixel value: ${value}`);
	return Number(m[1]);
};
const pxList = (value: string): number[] => value.trim().split(" ").map(px);

/** `padding` / `padding-block` / `gap` / `inset` shorthands reduced to the longhand a check needs. */
function sides(
	decls: Map<string, string>,
	prop: "padding" | "inset",
): { top: number; right: number } {
	const v = decls.get(prop);
	if (v === undefined) return { top: 0, right: 0 };
	const [a = 0, b = a] = pxList(v);
	// `padding: 6px 10px` and `padding: 16px 16px 28px` both give top = first, right = second.
	return { top: a, right: b };
}
function paddingTop(selector: string, viewport: Viewport): number {
	const d = cascade(selector, viewport);
	const block = d.get("padding-block");
	if (block !== undefined) return pxList(block)[0] ?? 0;
	return sides(d, "padding").top;
}
function gap(selector: string, viewport: Viewport, axis: "row" | "column"): number {
	const d = cascade(selector, viewport);
	const longhand = d.get(`${axis}-gap`);
	if (longhand !== undefined) return px(longhand);
	const g = d.get("gap");
	if (g === undefined) throw new Error(`${selector} has no gap`);
	const [a = 0, b = a] = pxList(g); // `gap: row column`
	return axis === "row" ? a : b;
}

// ── The controls ──────────────────────────────────────────────────────────────────────────────────────────────────

interface Source {
	/** What the room is read from, as a function of the viewport. */
	read: (viewport: Viewport) => number;
	/** `gap` rooms are shared with the neighbour's own area: a sideways expansion may use half, a block one all of it. */
	factor: number;
}

interface Control {
	name: string;
	/** The control's own selector (its visible rules and `position`). */
	host: string;
	/** Where the host's `font` comes from when it says `inherit`. */
	fontFrom?: string;
	/** The selector the stylesheet gives its expander. */
	expander: string;
	/** Rooms the neighbours leave, block axis and inline axis; null = only non-interactive neighbours. */
	blockRoom: Source[] | null;
	inlineRoom: Source[] | null;
	/** The visible size is label-defined on this axis (so only the other axis is computed). */
	labelWidth: boolean;
}

const CONTROLS: Control[] = [
	{
		name: "info button",
		host: ".ut-info-btn",
		expander: ".ut-info-btn::after",
		blockRoom: null,
		inlineRoom: null,
		labelWidth: false,
	},
	{
		name: "close X",
		host: ".ut-x",
		expander: ".ut-x::after",
		blockRoom: [{ read: (v) => paddingTop(".ut-insp-in", v), factor: 1 }],
		inlineRoom: [{ read: (v) => gap(".ut-dhead", v, "column"), factor: 1 }],
		labelWidth: false,
	},
	{
		name: "filter chip",
		host: ".ut-chip",
		expander: ".ut-chip::after",
		blockRoom: [
			{ read: (v) => gap(".ut-bar", v, "row"), factor: 1 },
			{ read: (v) => gap(".ut-active", v, "row"), factor: 1 },
		],
		inlineRoom: [
			{ read: (v) => gap(".ut-bar", v, "column"), factor: 0.5 },
			{ read: (v) => gap(".ut-active", v, "column"), factor: 0.5 },
		],
		labelWidth: true,
	},
	{
		name: "sort button",
		host: ".ut-cap button",
		fontFrom: ".ut-cap",
		expander: ".ut-cap button::after",
		blockRoom: [{ read: (v) => paddingTop(".ut-cap", v), factor: 1 }],
		inlineRoom: [{ read: (v) => gap(".ut-cap", v, "column"), factor: 0.5 }],
		labelWidth: true,
	},
	{
		name: "segmented tab",
		host: ".ut-seg button",
		expander: ".ut-seg button::after",
		blockRoom: [{ read: (v) => paddingTop(".ut-head", v), factor: 1 }],
		inlineRoom: [{ read: (v) => gap(".ut-seg", v, "column"), factor: 0.5 }],
		labelWidth: true,
	},
	{
		name: "small segmented tab",
		host: ".ut-seg.small button",
		expander: ".ut-seg.small button::after",
		blockRoom: [{ read: (v) => paddingTop(".ut-card", v), factor: 1 }],
		inlineRoom: [{ read: (v) => gap(".ut-seg", v, "column"), factor: 0.5 }],
		labelWidth: true,
	},
	{
		name: "button",
		host: ".ut-btn",
		expander: ".ut-btn::after",
		blockRoom: [{ read: (v) => paddingTop(".ut-head", v), factor: 1 }],
		inlineRoom: [{ read: (v) => gap(".ut-head", v, "column"), factor: 1 }],
		labelWidth: true,
	},
	{
		name: "ghost button",
		host: ".ut-ghost",
		expander: ".ut-ghost::after",
		blockRoom: [{ read: (v) => gap(".ut-active", v, "row"), factor: 1 }],
		inlineRoom: [{ read: (v) => gap(".ut-active", v, "column"), factor: 0.5 }],
		labelWidth: true,
	},
];

/** A rule can name a control as part of a comma list (".ut-seg.small button" also matches ".ut-seg button"). */
function visibleDecls(c: Control, viewport: Viewport): Map<string, string> {
	const out = new Map<string, string>();
	const parts = c.host === ".ut-seg.small button" ? [".ut-seg button", c.host] : [c.host];
	for (const p of parts) for (const [k, v] of cascade(p, viewport)) out.set(k, v);
	return out;
}

interface Visible {
	/** The border box, from the stylesheet. */
	height: number;
	width: number | undefined;
	border: number;
}

function visible(c: Control, viewport: Viewport): Visible {
	const d = visibleDecls(c, viewport);
	const borderValue = d.get("border");
	const border =
		borderValue === undefined ? 0 : (pxList(borderValue.replace(/ solid.*$/, ""))[0] ?? 0);
	const explicitHeight = d.get("height");
	const explicitWidth = d.get("width");
	if (explicitHeight !== undefined) {
		return {
			height: px(explicitHeight),
			width: explicitWidth === undefined ? undefined : px(explicitWidth),
			border,
		};
	}
	let font = d.get("font");
	if (font === "inherit") {
		if (c.fontFrom === undefined) throw new Error(`${c.name}: font: inherit with no source`);
		font = cascade(c.fontFrom, viewport).get("font");
	}
	// `font: 500 11.5px/1 var(--sans)`: a unitless line-height of 1, so the content is as tall as the font size.
	const m = /(\d+(?:\.\d+)?)px\/(\d+(?:\.\d+)?)/.exec(font ?? "");
	if (m === null) throw new Error(`${c.name}: cannot read size/line-height from "${font}"`);
	// A later `font-size` (the small switch sets only that) replaces the shorthand's size and keeps its line-height.
	const fontSize = d.get("font-size");
	const content = (fontSize === undefined ? Number(m[1]) : px(fontSize)) * Number(m[2]);
	const padding = d.get("padding");
	if (padding === undefined) throw new Error(`${c.name}: no padding`);
	const [vertical = 0] = pxList(padding);
	return { height: content + 2 * vertical + 2 * border, width: undefined, border };
}

interface Expander {
	block: number;
	inline: number;
}
function expander(c: Control, viewport: Viewport): { decls: Map<string, string>; inset: Expander } {
	const decls = cascade(c.expander, viewport);
	const inset = decls.get("inset");
	if (inset === undefined) throw new Error(`${c.expander} has no inset`);
	const [block = 0, inline = block] = pxList(inset);
	// A negative inset grows the box outward; its size is the padding box plus twice the (negated) inset.
	return { decls, inset: { block: -block, inline: -inline } };
}

describe("hit areas (audit finding F4)", () => {
	for (const c of CONTROLS) {
		describe(c.name, () => {
			it("is positioned, so the expander is placed against it", () => {
				// The host rule is a comma list of the controls; `.ut-seg.small button` is the same elements as
				// `.ut-seg button`, so the shared rule covers both.
				const host = c.host === ".ut-seg.small button" ? ".ut-seg button" : c.host;
				expect(cascade(host, "desktop").get("position")).toBe("relative");
				expect(cascade(host, "phone").get("position")).toBe("relative");
			});

			it("has an expander that is empty, absolute and invisible", () => {
				// An expander is only invisible if nothing paints it: no colour, border, background or image.
				const expanderSelector =
					c.expander === ".ut-seg.small button::after" ? ".ut-seg button::after" : c.expander;
				const d = cascade(expanderSelector, "desktop");
				expect(d.get("content")).toBe('""');
				expect(d.get("position")).toBe("absolute");
				for (const painted of [
					"background",
					"background-color",
					"border",
					"color",
					"box-shadow",
					"outline",
				]) {
					expect(d.has(painted), `${c.expander} paints ${painted}`).toBe(false);
				}
				expect(d.get("pointer-events")).toBeUndefined();
			});

			for (const [viewport, min] of [
				["desktop", DESKTOP_MIN],
				["phone", PHONE_MIN],
			] as const) {
				it(`${viewport}: the hit area is at least ${min}px on the short side`, () => {
					const v = visible(c, viewport);
					const e = expander(c, viewport);
					const paddingBox = v.height - 2 * v.border;
					expect(paddingBox + 2 * e.inset.block).toBeGreaterThanOrEqual(min);
				});
			}

			if (!c.labelWidth) {
				for (const [viewport, min] of [
					["desktop", DESKTOP_MIN],
					["phone", PHONE_MIN],
				] as const) {
					it(`${viewport}: the width is at least ${min}px too (the stylesheet gives it)`, () => {
						const v = visible(c, viewport);
						const e = expander(c, viewport);
						if (v.width === undefined) throw new Error(`${c.name}: no width in the stylesheet`);
						expect(v.width - 2 * v.border + 2 * e.inset.inline).toBeGreaterThanOrEqual(min);
					});
				}
			}

			for (const viewport of ["desktop", "phone"] as const) {
				it(`${viewport}: the expansion stays inside the room the neighbours leave`, () => {
					const v = visible(c, viewport);
					const e = expander(c, viewport);
					// How far the area reaches past the control's visible edge (its border box).
					const beyondBlock = e.inset.block - v.border;
					const beyondInline = e.inset.inline - v.border;
					const room = (sources: Source[]): number =>
						Math.min(...sources.map((s) => s.read(viewport) * s.factor));
					if (c.blockRoom !== null) expect(beyondBlock).toBeLessThanOrEqual(room(c.blockRoom));
					if (c.inlineRoom !== null) expect(beyondInline).toBeLessThanOrEqual(room(c.inlineRoom));
				});
			}
		});
	}

	describe("the block", () => {
		it("sits INSIDE @layer components, as every component rule does, so it competes by specificity", () => {
			// Appended after the layer, the block was unlayered and silently beat every layered rule whatever its
			// specificity (a phone filter sheet lost its own padding, safe-area inset included). Every rule the block
			// adds must carry the components layer.
			expect(CSS.indexOf(MARKER)).toBe(CSS.lastIndexOf(MARKER));
			const block = parseRules(CSS.slice(CSS.indexOf(MARKER)));
			expect(block.length).toBeGreaterThan(0);
			const inFile = RULES.filter((r) =>
				block.some((b) => b.selectors.join(",") === r.selectors.join(",") && b.media === r.media),
			);
			for (const r of inFile)
				expect(r.layer, `${r.selectors.join(", ")} (${r.media ?? "all"})`).toBe("components");
		});

		it("nothing outside the global base and the reduced-motion block is unlayered", () => {
			// The page's base (tokens, body, the universal reset, selection, the focus ring) is deliberately unlayered;
			// every component rule belongs in the layer. A new unlayered rule fails here before it wins a cascade it
			// should not.
			const base = new Set([":root", "html", "body", "*", "::selection", ":focus-visible"]);
			const unlayered = RULES.filter(
				(r) => r.layer === undefined && r.media !== "@media (prefers-reduced-motion: reduce)",
			).flatMap((r) => r.selectors);
			expect(unlayered.filter((sel) => !base.has(sel))).toEqual([]);
		});

		it("only adds position, the expander, the sort row's flex and phone spacing: it restyles nothing", () => {
			const block = parseRules(CSS.slice(CSS.lastIndexOf(MARKER)));
			const allowed = new Set([
				"position",
				"content",
				"inset",
				"flex",
				"row-gap",
				"padding-block",
				"margin-bottom",
			]);
			for (const r of block) {
				for (const prop of r.decls.keys()) {
					expect(allowed.has(prop), `${r.selectors.join(", ")} sets ${prop}`).toBe(true);
				}
			}
			// The spacing properties appear only in the phone query, on the containers that need room: the two filter strips,
			// the sort row, and the phone's filter sheet and its head.
			const spacing = block.filter(
				(r) =>
					r.decls.has("row-gap") || r.decls.has("padding-block") || r.decls.has("margin-bottom"),
			);
			for (const r of spacing) expect(r.media).toBe(PHONE_QUERY);
			expect(spacing.flatMap((r) => r.selectors).sort()).toEqual([
				".ut-active",
				".ut-bar",
				'.ut-bar[data-sheet="true"]',
				'.ut-bar[data-sheet="true"] .ut-sheet-head',
				".ut-cap",
			]);
		});
	});

	// A hit area that the layout clips, or that a neighbour paints over, is not a hit area. These two checks come from
	// a measurement in a browser (elementFromPoint, stepping out from each control) that found the sort buttons at
	// 21px and the phone chips at 35px although each expander was the size the tests above computed.
	describe("the area survives the layout around it", () => {
		const control = (name: string): Control => {
			const c = CONTROLS.find((x) => x.name === name);
			if (c === undefined) throw new Error(name);
			return c;
		};
		const beyond = (name: string, viewport: Viewport): number =>
			expander(control(name), viewport).inset.block - visible(control(name), viewport).border;
		const border = (selector: string, side: "border-bottom"): number => {
			const v = cascade(selector, "phone").get(side);
			return v === undefined ? 0 : (pxList(v.replace(/ solid.*$/, ""))[0] ?? 0);
		};
		// All the paddings here are one or two values (`9px 16px`, or a `padding-block`), so top equals bottom.
		const padding = (selector: string, viewport: Viewport): number =>
			paddingTop(selector, viewport);

		describe("the sort row", () => {
			it("does not shrink: it is a flex item of the column pane and a scroll box, whose automatic minimum height is 0", () => {
				expect(cascade(".ut-pane", "desktop").get("flex-direction")).toBe("column");
				const flex = cascade(".ut-cap", "desktop").get("flex");
				expect(flex, "the sort row needs `flex: 0 0 auto`").toBeDefined();
				// `flex: <grow> <shrink> <basis>`: the shrink factor must be 0.
				expect(flex?.split(" ")[1]).toBe("0");
				expect(cascade(".ut-cap", "phone").get("flex")).toBe(flex);
			});

			it("has no height of its own that could hold it below its content", () => {
				for (const v of ["desktop", "phone"] as const) {
					const d = cascade(".ut-cap", v);
					for (const prop of ["height", "max-height"]) {
						expect(d.has(prop), `.ut-cap sets ${prop}`).toBe(false);
					}
				}
			});

			for (const viewport of ["desktop", "phone"] as const) {
				it(`${viewport}: its padding box (button plus padding) can contain the area`, () => {
					const c = control("sort button");
					const button = visible(c, viewport).height;
					const area = button + 2 * expander(c, viewport).inset.block;
					const box = button + 2 * padding(".ut-cap", viewport);
					expect(box).toBeGreaterThanOrEqual(area);
				});
			}
		});

		// The phone's filter sheet stacks one full-width chip per facet with its own padding (10px) and its own 10px gap;
		// with the strip's expander the chips' areas overlapped 11px and the Done button's met the first chip's (measured in
		// a browser at 390x844). Its chips get their own expander, inside a gap widened for it.
		describe("the phone's filter sheet", () => {
			const SHEET = '.ut-bar[data-sheet="true"]';
			const first = (selector: string, prop: string): number => {
				const v = cascade(selector, "phone").get(prop);
				if (v === undefined) throw new Error(`${selector} has no ${prop}`);
				return Math.abs(pxList(v)[0] ?? 0);
			};
			// Read when a check runs, so a missing rule fails that check by name instead of the whole file.
			const chip = (): Control => control("filter chip");
			// The sheet chip is the strip chip with the sheet's padding: same font, same border.
			const sheetChipHeight = (): number =>
				visible(chip(), "phone").height -
				2 * first(chip().host, "padding") +
				2 * first(`${SHEET} .ut-facet > .ut-chip`, "padding");
			const sheetInset = (): number => first(`${SHEET} .ut-chip::after`, "inset");

			it("a sheet chip's area is at least 44px tall", () => {
				expect(
					sheetChipHeight() - 2 * visible(chip(), "phone").border + 2 * sheetInset(),
				).toBeGreaterThanOrEqual(PHONE_MIN);
			});
			it("two stacked chips' areas stay apart: both fit the sheet's row gap", () => {
				expect(2 * sheetInset()).toBeLessThanOrEqual(gap(SHEET, "phone", "row"));
			});
			it("the head's Done button and the first chip keep their areas apart", () => {
				expect(beyond("button", "phone") + sheetInset()).toBeLessThanOrEqual(
					gap(SHEET, "phone", "row") + first(`${SHEET} .ut-sheet-head`, "margin-bottom"),
				);
			});
		});

		describe("wrapped chips on a phone", () => {
			it("each chip and ghost button owns its whole band: rows are two areas apart", () => {
				const rowGap = Math.min(gap(".ut-bar", "phone", "row"), gap(".ut-active", "phone", "row"));
				expect(2 * beyond("filter chip", "phone")).toBeLessThanOrEqual(rowGap);
				expect(
					beyond("filter chip", "phone") + beyond("ghost button", "phone"),
				).toBeLessThanOrEqual(rowGap);
				// The band is the whole 44px, so a chip's own area is not shortened by the row above or below.
				const chip = control("filter chip");
				const band =
					visible(chip, "phone").height -
					2 * visible(chip, "phone").border +
					2 * expander(chip, "phone").inset.block;
				expect(band).toBeGreaterThanOrEqual(PHONE_MIN);
			});

			it("the strips keep their end rows' areas off what sits next to them", () => {
				const chip = beyond("filter chip", "phone");
				const ghost = beyond("ghost button", "phone");
				const sort = beyond("sort button", "phone");
				const barEdge = padding(".ut-bar", "phone") + border(".ut-bar", "border-bottom");
				const activeEdge = padding(".ut-active", "phone") + border(".ut-active", "border-bottom");
				const capEdge = padding(".ut-cap", "phone");
				// Filter strip above the active-filter strip.
				expect(barEdge + padding(".ut-active", "phone")).toBeGreaterThanOrEqual(2 * chip);
				// Either strip above the sort row.
				expect(barEdge + capEdge).toBeGreaterThanOrEqual(chip + sort);
				expect(activeEdge + capEdge).toBeGreaterThanOrEqual(Math.max(chip, ghost) + sort);
			});
		});
	});

	describe("the reader itself", () => {
		it("reads the visible sizes the report states", () => {
			// The measured sizes from the audit: info 20x20, chip 26, sort 21, seg 24, X 30, Export 30.
			const by = (name: string): Control => {
				const c = CONTROLS.find((x) => x.name === name);
				if (c === undefined) throw new Error(name);
				return c;
			};
			expect(visible(by("info button"), "desktop")).toMatchObject({ height: 20, width: 20 });
			expect(visible(by("close X"), "desktop")).toMatchObject({ height: 30, width: 30 });
			expect(visible(by("filter chip"), "desktop").height).toBe(25.5);
			expect(visible(by("sort button"), "desktop").height).toBe(20.5);
			expect(visible(by("segmented tab"), "desktop").height).toBe(24);
			expect(visible(by("small segmented tab"), "desktop").height).toBe(21);
			expect(visible(by("button"), "desktop").height).toBe(30);
			expect(visible(by("ghost button"), "desktop").height).toBe(27);
		});
	});
});
