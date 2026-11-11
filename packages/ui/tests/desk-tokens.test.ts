// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MUTED, PROVIDER_COLOR, SERIES } from "../src/shared/colors.js";
import { COMPACT_QUERY, DESK_MIN_WIDTH } from "../src/shared/desk-layout.js";
import { PHONE_MAX_WIDTH } from "../src/shared/layout.js";
import { allCss, contrast, deskCss, deskCssFiles, legacyCss } from "./helpers/css.js";

const APP = join(import.meta.dirname, "..", "src", "app");
const TOKENS = readFileSync(join(APP, "desk", "desk-tokens.css"), "utf-8").replace(
	/\/\*[\s\S]*?\*\//g,
	"",
);

/** A desk stylesheet's text (`file` from src/app), comments removed. */
const sheet = (file: string): string =>
	readFileSync(join(APP, file), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The text of the first `@media (max-width: <w>px)` block in `css`, braces matched. */
function mediaBlock(css: string, w: number): string {
	const start = css.indexOf(`@media (max-width: ${w}px) {`);
	if (start < 0) return "";
	let depth = 0;
	for (let i = css.indexOf("{", start); i < css.length; i++) {
		if (css[i] === "{") depth++;
		else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
	}
	return "";
}

/** The declarations of the first rule in `css` whose selector is exactly `sel`. */
const ruleOf = (css: string, sel: string): string =>
	new RegExp(`(?:^|[}\\s])${sel.replace(/[.[\]"=]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ??
	"";

const EXPECTED: Record<string, string> = {
	"--dk-page": "#0b0b0a",
	"--dk-pane": "#111110",
	"--dk-raised": "#181816",
	"--dk-hover": "#201f1d",
	"--dk-grid": "#272624",
	"--dk-base": "#3a3835",
	"--dk-muted": "#66635d",
	"--dk-label": "#8a877f",
	"--dk-legend": "#b7b4ab",
	"--dk-text": "#ece9e1",
	"--dk-gold": "#F0C462",
	"--dk-gold-mid": "#C2922F",
	"--dk-gold-deep": "#5E420E",
	"--dk-gold-hi": "#FFF2C8",
	"--dk-s0": "#BE804D",
	"--dk-s1": "#5D6775",
	"--dk-s2": "#C8CCD3",
	"--dk-s3": "#7095C1",
	"--dk-a0": "#E8B54B",
	"--dk-series-muted": "#8A877F",
	"--dk-pane-a": "1",
	"--dk-radius": "14px",
	"--dk-gap": "16px",
};

/** A custom property's value in the token sheet. */
function token(name: string): string {
	const m = new RegExp(`(?:^|[\\s;{])${name}\\s*:\\s*([^;}]+)`).exec(TOKENS);
	if (!m) throw new Error(`no token ${name}`);
	return (m[1] ?? "").trim();
}

interface Rule {
	selectors: string[];
	decls: Map<string, string>;
	layer: string | undefined;
}

/** Rules of one sheet with their cascade layer (undefined when unlayered). Nested at-rules other than `@layer` and
 * `@media` are skipped whole. */
function parseRules(source: string): Rule[] {
	const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
	const rules: Rule[] = [];
	let i = 0;
	const block = (layer: string | undefined): void => {
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
			i = j + 1;
			if (prelude.startsWith("@layer")) block(prelude.slice("@layer".length).trim());
			else if (prelude.startsWith("@media")) block(layer);
			else if (prelude.startsWith("@")) {
				let depth = 1;
				while (i < css.length && depth > 0) {
					if (css[i] === "{") depth++;
					if (css[i] === "}") depth--;
					i++;
				}
			} else {
				const end = css.indexOf("}", i);
				const decls = new Map<string, string>();
				for (const d of css.slice(i, end).split(";")) {
					const colon = d.indexOf(":");
					if (colon < 0) continue;
					decls.set(d.slice(0, colon).trim(), d.slice(colon + 1).trim());
				}
				rules.push({ selectors: prelude.split(",").map((s) => s.trim()), decls, layer });
				i = end + 1;
			}
		}
	};
	block(undefined);
	return rules;
}

describe("the desk's colour tokens", () => {
	it("has every token, with exactly the spec's value", () => {
		for (const [name, value] of Object.entries(EXPECTED)) {
			expect(token(name).toLowerCase(), name).toBe(value.toLowerCase());
		}
	});

	it("keeps the series colours equal to the data's: SERIES, MUTED and the four providers", () => {
		for (let k = 0; k < 4; k++) {
			expect(token(`--dk-s${k}`).toLowerCase()).toBe((SERIES[k] as string).toLowerCase());
		}
		expect(token("--dk-a0").toLowerCase()).toBe((SERIES[4] as string).toLowerCase());
		expect(token("--dk-series-muted").toLowerCase()).toBe(MUTED.toLowerCase());
		expect(token("--dk-s0").toLowerCase()).toBe(PROVIDER_COLOR.Anthropic.toLowerCase());
		expect(token("--dk-s1").toLowerCase()).toBe(PROVIDER_COLOR.OpenAI.toLowerCase());
		expect(token("--dk-s2").toLowerCase()).toBe(PROVIDER_COLOR.xAI.toLowerCase());
		expect(token("--dk-s3").toLowerCase()).toBe(PROVIDER_COLOR.Google.toLowerCase());
		// The series grey and the neutral grey are different colours on purpose.
		expect(token("--dk-series-muted").toLowerCase()).not.toBe(token("--dk-muted").toLowerCase());
	});

	it("keeps the legacy faint text readable on the desk's pane (4.5:1)", () => {
		expect(contrast("#7e7e88", token("--dk-pane"))).toBeGreaterThanOrEqual(4.5);
	});

	it("bridges the legacy page, surface and raised tokens inside .ut-dk only", () => {
		const bridge = parseRules(TOKENS).find((r) => r.selectors.includes(".ut-dk"));
		expect(bridge?.layer).toBe("components");
		expect(bridge?.decls.get("--page")).toBe("var(--dk-page)");
		expect(bridge?.decls.get("--surface")).toBe("var(--dk-pane)");
		expect(bridge?.decls.get("--raised")).toBe("var(--dk-raised)");
		expect([...(bridge?.decls.keys() ?? [])].sort()).toEqual(["--page", "--raised", "--surface"]);
	});
});

describe("the desk's stylesheets", () => {
	it("are the shell's two and the four windows', one each", () => {
		expect(deskCssFiles()).toEqual([
			"desk/desk-tokens.css",
			"desk/desk.css",
			"windows/ledger/ledger.css",
			"windows/now/now.css",
			"windows/share/share.css",
			"windows/spend/spend.css",
		]);
	});

	it("enter through desk.css: the tokens, then each window's sheet", () => {
		const entry = readFileSync(join(APP, "desk", "desk.css"), "utf-8");
		const imports = [...entry.matchAll(/@import\s+"([^"]+)"\s*;/g)].map((m) => m[1]);
		expect(imports).toEqual([
			"./desk-tokens.css",
			"../windows/spend/spend.css",
			"../windows/share/share.css",
			"../windows/ledger/ledger.css",
			"../windows/now/now.css",
		]);
		expect(entry.indexOf("@layer components")).toBeGreaterThan(entry.lastIndexOf("@import"));
	});

	it("put every rule inside @layer components, except the one :root token block", () => {
		for (const file of deskCssFiles()) {
			const rules = parseRules(readFileSync(join(APP, file), "utf-8"));
			for (const r of rules) {
				if (r.layer === undefined) {
					expect(r.selectors, `${file}: an unlayered rule`).toEqual([":root"]);
					expect(file).toBe("desk/desk-tokens.css");
				} else {
					expect(r.layer, `${file}: ${r.selectors.join(", ")}`).toBe("components");
				}
			}
		}
		const roots = parseRules(TOKENS).filter((r) => r.layer === undefined);
		expect(roots).toHaveLength(1);
	});

	/** Every width a sheet's `@media (max-width: …px)` blocks are written at, in order. */
	const maxWidths = (css: string): number[] =>
		[...css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)].map((m) => Number(m[1]));

	it("use only the breakpoints the page has: 760px, the desk's 999px, and the older sheet's 900px", () => {
		expect(maxWidths(allCss()).filter((w) => w !== 760 && w !== 900 && w !== 999)).toEqual([]);
	});

	it("red-first (the column kept to 900 px while the desk starts at 1000): no desk or window sheet is written at 900px", () => {
		expect(/max-width:\s*900px/.test(deskCss())).toBe(false);
		// The desk's sheets know two widths: the phone's, and the last one under the desk's first.
		expect(DESK_MIN_WIDTH - 1).toBe(999);
		expect(COMPACT_QUERY).toBe("(max-width: 999px)");
		for (const file of deskCssFiles()) {
			const others = maxWidths(sheet(file)).filter((w) => w !== PHONE_MAX_WIDTH);
			expect(
				others.every((w) => w === DESK_MIN_WIDTH - 1),
				`${file}: ${others.join(", ")}`,
			).toBe(true);
		}
		// The three sheets that lay the column out each do it at that width, once.
		for (const file of ["desk/desk.css", "windows/spend/spend.css", "windows/now/now.css"]) {
			expect(
				maxWidths(sheet(file)).filter((w) => w === 999),
				file,
			).toHaveLength(1);
			expect(sheet(file), file).toContain(`@media ${COMPACT_QUERY} {`);
		}
		// The older sheet is not the desk's: its own 900px step (the summary's) stays where it was.
		expect(maxWidths(legacyCss()).filter((w) => w !== PHONE_MAX_WIDTH)).toEqual([900]);
	});

	it("red-first: on a narrow screen no window is squeezed, and the Ledger's list keeps a real height above the phone width", () => {
		const desk = sheet("desk/desk.css");
		const narrow = mediaBlock(desk, 999);
		expect(narrow.length).toBeGreaterThan(0);
		// The column takes its content's height and scrolls with the page: neither the desk nor a window's slot shrinks
		// to fit the screen (they did, and the windows' contents ran into each other).
		expect(ruleOf(narrow, ".ut-dk-desk")).toMatch(/flex:\s*0 0 auto/);
		expect(ruleOf(narrow, ".ut-win-slot")).toMatch(/flex:\s*0 0 auto/);
		// The Ledger's list has a scroller of its own above the phone width, so its box needs a height (it had none,
		// and drew no rows).
		expect(ruleOf(narrow, '[data-win="ledger"] .ut-lg-body')).toMatch(/height:\s*\d+dvh/);
		// On a phone the list flows in the page and the window is its scroller: its box takes its content's height.
		expect(ruleOf(mediaBlock(desk, 760), '[data-win="ledger"] .ut-lg-body')).toMatch(
			/height:\s*auto/,
		);
	});

	it("red-first (rows that ran past a short desk were cut off): the desk scrolls its rows, never under a filled window, and never in the column", () => {
		const desk = sheet("desk/desk.css");
		// The rows can be taller than the desk (nine above, and all the Now window needs below): the desk scrolls then.
		const wide = ruleOf(desk, ".ut-dk-desk");
		expect(wide).toMatch(/overflow-y:\s*auto;/);
		expect(wide).toMatch(/scrollbar-width:\s*thin;/);
		// A filled window lies over the desk, so the desk is not scrolled under it.
		expect(ruleOf(desk, '.ut-dk-desk[data-filled="true"]')).toMatch(/overflow:\s*hidden;/);
		expect(desk.indexOf('.ut-dk-desk[data-filled="true"]')).toBeLessThan(
			desk.indexOf("@media (max-width: 999px)"),
		);
		// In the column the page is the scroller, filled or not (fill is ignored there): a desk that scrolled on its own
		// would also hold the phone's pinned sort bar, which sticks to the page.
		const narrow = mediaBlock(desk, 999);
		expect(ruleOf(narrow, ".ut-dk-desk")).toMatch(/overflow:\s*visible;/);
		expect(ruleOf(narrow, '.ut-dk-desk[data-filled="true"]')).toMatch(/overflow:\s*visible;/);
		expect(legacyCss()).toMatch(/position:\s*sticky/);
	});

	it("red-first (the Window notice drawn in the top bar with no rule for it there): the alarm and the notice each take the bar's whole width", () => {
		const desk = sheet("desk/desk.css");
		// The top bar draws the header, the chain alarm and the Window notice. The last two are rows of their own under
		// the header: without the rule they sat beside it, squeezed between the mark and Export.
		const decls =
			/\.ut-dk-top > \.ut-alarm,\s*\.ut-dk-top > \.ut-notice\s*\{([^}]*)\}/.exec(desk)?.[1] ?? "";
		expect(decls).toMatch(/flex:\s*1 1 100%;/);
		expect(decls).toMatch(/margin:\s*0;/);
		// The rule is for what the bar draws: the strip's `bar` part holds the notice, and the as-at line is not the
		// bar's (it is the Now window's), so the bar has no rule for it.
		const strip = readFileSync(join(APP, "summary-strip.tsx"), "utf-8");
		expect(strip).toContain('{part === "bar" && noticeLine}');
		expect(strip).toContain('<div className="ut-notice" role="status">');
		expect(desk).not.toContain(".ut-dk-top > .ut-asat");
	});

	it("red-first (rows drawn over the next window): on a phone the Ledger's list flows in the page, as the page's own list does", () => {
		// Above the phone width the list fills the window's body. On a phone it takes its content's height and the page
		// is its scroller (styles.css): the window's override kept it at no height, and its rows ran over the next window.
		const ledger = sheet("windows/ledger/ledger.css");
		expect(ruleOf(ledger, '[data-win="ledger"] .ut-list')).toMatch(/flex:\s*1 1 0/);
		expect(ruleOf(mediaBlock(ledger, 760), '[data-win="ledger"] .ut-list')).toMatch(
			/flex:\s*0 0 auto/,
		);
	});

	it("red-first (an empty Spend window): Spend's chart takes the window's height on a wide desk, and a height of its own in the narrow column", () => {
		const spend = sheet("windows/spend/spend.css");
		// Trends, its chart card and the chart's box grow into the window's body. Without them the card was its header,
		// and the chart was clipped in a 62px scroller at every size.
		expect(ruleOf(spend, '[data-win="spend"] .ut-trends')).toMatch(/flex:\s*1 1 0/);
		expect(ruleOf(spend, '[data-win="spend"] .ut-card[data-part="chart"]')).toMatch(
			/flex:\s*1 1 0/,
		);
		const box = ruleOf(spend, '[data-win="spend"] .ut-chart-box');
		expect(box).toMatch(/flex:\s*1 1 0/);
		expect(box).toMatch(/min-height:\s*\d+px/);
		// The narrow column takes its content's height, so nothing there has a height to grow into.
		const narrow = mediaBlock(spend, 999);
		expect(ruleOf(narrow, '[data-win="spend"] .ut-trends')).toMatch(/flex:\s*0 0 auto/);
		expect(ruleOf(narrow, '[data-win="spend"] .ut-card[data-part="chart"]')).toMatch(
			/flex:\s*0 0 auto/,
		);
		expect(ruleOf(narrow, '[data-win="spend"] .ut-chart-box')).toMatch(/height:\s*240px/);
	});

	it("keep the panes opaque, and a window free of anything that traps a fixed drawer", () => {
		expect(token("--dk-pane-a")).toBe("1");
		const trapping = ["transform", "filter", "backdrop-filter", "contain", "will-change"];
		for (const r of parseRules(deskCss())) {
			if (!r.selectors.some((s) => s.startsWith(".ut-win"))) continue;
			for (const p of trapping) {
				expect(r.decls.has(p), `${r.selectors.join(", ")} sets ${p}`).toBe(false);
			}
		}
	});

	it("blur only on .ut-glass", () => {
		for (const r of parseRules(deskCss())) {
			if (r.decls.has("backdrop-filter") || r.decls.has("-webkit-backdrop-filter")) {
				expect(r.selectors.every((s) => s === ".ut-glass" || s.startsWith(".ut-glass"))).toBe(true);
			}
		}
	});
});

/** Whether a rule takes the focus ring away: an outline set to none or to zero width. */
function removesOutline(decls: Map<string, string>): boolean {
	const outline = decls.get("outline");
	return (
		outline === "none" ||
		outline === "0" ||
		decls.get("outline-style") === "none" ||
		decls.get("outline-width") === "0"
	);
}

describe("the focus ring", () => {
	it("is the page's base default: its one global rule sits in @layer base, so a component's own ring wins", () => {
		const global = parseRules(legacyCss().replace(/\/\*[\s\S]*?\*\//g, "")).filter(
			(r) => r.selectors.length === 1 && r.selectors[0] === ":focus-visible",
		);
		expect(global).toHaveLength(1);
		expect(global[0]?.layer).toBe("base");
	});

	it("is never taken away: no stylesheet sets an outline to none or zero", () => {
		const removed = parseRules(allCss().replace(/\/\*[\s\S]*?\*\//g, ""))
			.filter((r) => removesOutline(r.decls))
			.map((r) => r.selectors.join(", "));
		expect(removed).toEqual([]);
	});
});

describe("the reader these checks stand on", () => {
	it("sees a base-layer focus ring and a rule that removes an outline", () => {
		const sheet = parseRules(
			"@layer base { :focus-visible { outline: 2px solid red; } } @layer components { .x:focus { outline: none; } }",
		);
		expect(sheet.find((r) => r.selectors[0] === ":focus-visible")?.layer).toBe("base");
		const x = sheet.find((r) => r.selectors[0] === ".x:focus");
		expect(x !== undefined && removesOutline(x.decls)).toBe(true);
	});

	// A check that has never been shown a violation proves nothing: feed the reader a bad sheet.
	it("sees a unlayered rule, a trapping window rule and a blur outside .ut-glass", () => {
		const bad = parseRules(
			".ut-win-x { transform: none; } @layer components { .ut-win { will-change: opacity; } .ut-pane { backdrop-filter: blur(4px); } }",
		);
		expect(bad.find((r) => r.selectors[0] === ".ut-win-x")?.layer).toBeUndefined();
		expect(bad.find((r) => r.selectors[0] === ".ut-win")?.decls.has("will-change")).toBe(true);
		expect(bad.find((r) => r.selectors[0] === ".ut-pane")?.decls.has("backdrop-filter")).toBe(true);
	});
});
