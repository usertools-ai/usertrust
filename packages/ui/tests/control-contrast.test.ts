// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(
	join(import.meta.dirname, "..", "src", "app", "styles.css"),
	"utf-8",
).replace(/\/\*[\s\S]*?\*\//g, "");

type Rgba = { r: number; g: number; b: number; a: number };

/** The declaration block of the rule whose selector list contains `selector` exactly (not as a prefix). */
function ruleBody(selector: string): string {
	for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		// An `@import ...;` line sits in the same capture as the first rule: the selector list is what follows the last `;`.
		const list =
			(m[1] ?? "")
				.split(";")
				.pop()
				?.split(",")
				.map((s) => s.trim()) ?? [];
		if (list.includes(selector)) return m[2] ?? "";
	}
	throw new Error(`no rule for ${selector}`);
}

/** The value of one property in a rule. */
function decl(selector: string, property: string): string {
	const m = new RegExp(`(?:^|[\\s;])${property}\\s*:\\s*([^;]+);`).exec(ruleBody(selector));
	if (!m) throw new Error(`${selector} has no ${property}`);
	return (m[1] ?? "").trim();
}

/** A custom property declared in :root. */
function token(name: string): string {
	const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(ruleBody(":root"));
	if (!m) throw new Error(`no token ${name}`);
	return (m[1] ?? "").trim();
}

function parseColour(value: string): Rgba {
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
	if (hex) {
		let h = hex[1] ?? "";
		if (h.length === 3) h = [...h].map((c) => c + c).join("");
		return {
			r: Number.parseInt(h.slice(0, 2), 16),
			g: Number.parseInt(h.slice(2, 4), 16),
			b: Number.parseInt(h.slice(4, 6), 16),
			a: 1,
		};
	}
	const fn = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
	if (!fn) throw new Error(`cannot parse colour ${value}`);
	return {
		r: Number(fn[1]),
		g: Number(fn[2]),
		b: Number(fn[3]),
		a: fn[4] === undefined ? 1 : Number(fn[4]),
	};
}

/** Alpha-composite `top` over an opaque `bottom`. */
function over(top: Rgba, bottom: Rgba): Rgba {
	const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
	return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

/** WCAG 2.x relative luminance. */
function luminance(c: Rgba): number {
	const lin = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

function contrast(a: Rgba, b: Rgba): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

/** Resolve `var(--x)` against the :root tokens, through every level of aliasing (`--accent` is `var(--gold)`). */
function resolve(value: string): string {
	const m = /^var\((--[\w-]+)\)$/.exec(value);
	return m ? resolve(token(m[1] ?? "")) : value;
}

const SURFACES = ["--page", "--surface", "--raised"] as const;

/** Interactive controls: every border here must be the control tier. Value is the property to read. */
const CONTROLS: Array<[selector: string, what: string]> = [
	[".ut-search", "search input"],
	[".ut-field input", "date and cost inputs"],
	[".ut-field-bare", "max cost input"],
	[".ut-chip", "filter chips and facet buttons"],
	[".ut-btn", "Export button"],
	[".ut-ghost", "Clear / ghost buttons"],
	[".ut-x", "close button"],
	[".ut-seg", "Audit/Trends and bucket tablists"],
	[".ut-info-btn", "info button"],
	[".ut-tl-btn", "timeline Live and new-since buttons"],
];

/** Decorative: panel edges, rules, separators and non-interactive labels keep the quiet tier. */
const DECORATIVE: Array<[selector: string, property: string]> = [
	[".ut-work", "border"],
	[".ut-head", "border-bottom"],
	[".ut-bar", "border-bottom"],
	[".ut-active", "border-bottom"],
	[".ut-foot", "border-top"],
	[".ut-insp", "border-left"],
	[".ut-drawer", "border-left"],
	[".ut-facts", "border"],
	[".ut-card", "border"],
	[".ut-pop", "border"],
	[".ut-tag", "border"],
	[".ut-sep", "background"],
];

describe("control borders meet WCAG 1.4.11 non-text contrast", () => {
	const control = parseColour(token("--control-line"));

	for (const name of SURFACES) {
		it(`--control-line composited over ${name} is at least 3:1`, () => {
			const bg = parseColour(token(name));
			expect(bg.a).toBe(1);
			expect(contrast(over(control, bg), bg)).toBeGreaterThanOrEqual(3);
		});
	}

	it("the decorative --line is below 3:1 on the page, so the two tiers differ", () => {
		const bg = parseColour(token("--page"));
		expect(contrast(over(parseColour(token("--line")), bg), bg)).toBeLessThan(3);
	});

	it("--control-line is brighter than --line", () => {
		expect(control.a).toBeGreaterThan(parseColour(token("--line")).a);
	});

	for (const [selector, what] of CONTROLS) {
		it(`${what} (${selector}) draws its border with var(--control-line)`, () => {
			expect(decl(selector, "border")).toBe("1px solid var(--control-line)");
		});
	}

	for (const [selector, property] of DECORATIVE) {
		it(`${selector} stays on the decorative var(--line)`, () => {
			expect(decl(selector, property)).toContain("var(--line)");
			expect(decl(selector, property)).not.toContain("--control-line");
		});
	}

	it("a control's resting border, over its own fill and each surface, is at least 3:1 against that surface", () => {
		const fill = parseColour("rgba(255, 255, 255, 0.04)");
		for (const name of SURFACES) {
			const bg = parseColour(token(name));
			// The fill paints under the border (background-clip: border-box), so the border lands on bg + fill.
			expect(contrast(over(control, over(fill, bg)), bg)).toBeGreaterThanOrEqual(3);
		}
	});

	it("the selected filter chip's border still clears 3:1 on the page", () => {
		const bg = parseColour(token("--page"));
		const border = parseColour(decl(".ut-chip.on", "border-color"));
		expect(contrast(over(border, bg), bg)).toBeGreaterThanOrEqual(3);
	});

	it("hover and open states stay brighter than the new resting border", () => {
		const bg = parseColour(token("--page"));
		const rest = luminance(over(control, bg));
		for (const selector of [
			".ut-btn:hover:not(:disabled)",
			".ut-ghost:hover",
			".ut-chip:hover",
			".ut-x:hover",
			".ut-info-btn:hover",
		]) {
			const hover = parseColour(resolve(decl(selector, "border-color")));
			expect(luminance(over(hover, bg)), selector).toBeGreaterThan(rest);
		}
	});

	it("focus on the inputs still shows a distinct border", () => {
		const bg = parseColour(token("--page"));
		const rest = luminance(over(control, bg));
		for (const selector of [".ut-search:focus", ".ut-field input:focus"]) {
			const focus = parseColour(resolve(decl(selector, "border-color")));
			expect(luminance(over(focus, bg)), selector).toBeGreaterThan(rest);
		}
	});
});

describe("the gold accent meets WCAG AA as text", () => {
	// The accent colours text (the live pill, a counting figure), so it is held to the 4.5:1 of small text.
	for (const name of ["--page", "--surface"] as const) {
		it(`--accent on ${name} is at least 4.5:1`, () => {
			const bg = parseColour(token(name));
			expect(resolve("var(--accent)")).toBe(token("--gold"));
			expect(contrast(parseColour(resolve("var(--accent)")), bg)).toBeGreaterThanOrEqual(4.5);
		});
	}
});

describe("the accent stays off the chart marks and the live pill's states stay apart", () => {
	it("a bar list's meter fill is the chart colour, not the accent", () => {
		expect(decl(".ut-blist .ut-meter i", "background")).toBe("var(--chart)");
		expect(resolve("var(--chart)")).not.toBe(resolve("var(--accent)"));
	});

	it("the live pill is neutral with a gold dot, and its border and fill differ from reconnecting's amber", () => {
		const live = ".ut-live";
		const reconnecting = '.ut-live[data-st="reconnecting"]';
		const liveBorder = resolve(decl(live, "border").replace(/^1px solid /, ""));
		expect(liveBorder).toBe(token("--control-line"));
		expect(liveBorder).not.toBe(resolve(decl(reconnecting, "border-color")));
		expect(decl(live, "background")).not.toBe(decl(reconnecting, "background"));
		expect(decl(live, "color")).toBe("var(--ink)");
		expect(decl('.ut-live[data-st="live"] i', "background")).toBe("var(--accent)");
	});
});
