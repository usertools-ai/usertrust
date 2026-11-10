// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/** The Share window's sheet: every rule in the components layer under its own prefix, and what the ring and rows get from it. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allCss } from "./helpers/css.js";

const SHARE = join(import.meta.dirname, "..", "src", "app", "windows", "share");
const SHEET = readFileSync(join(SHARE, "share.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the sheet's rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
	const at = SHEET.split("}").find((chunk) => {
		const brace = chunk.lastIndexOf("{");
		if (brace < 0) return false;
		const head = chunk.slice(0, brace);
		const sel = head.slice(Math.max(head.lastIndexOf("{"), head.lastIndexOf(";")) + 1);
		return sel.replace(/\s+/g, " ").trim() === selector;
	});
	return at === undefined ? "" : at.slice(at.lastIndexOf("{") + 1);
}

describe("the Share window's sheet", () => {
	it("keeps every rule in the components layer, under its own prefix", () => {
		expect(SHEET.trim().startsWith("@layer components {")).toBe(true);
		const selectors = [...SHEET.matchAll(/(?:^|[{}])\s*([^{}@;]+?)\s*\{/g)]
			.flatMap((m) => (m[1] ?? "").split(","))
			.map((s) => s.trim())
			.filter((s) => s !== "" && !/^(from|to|\d+%)$/.test(s));
		expect(selectors.length).toBeGreaterThan(20);
		for (const s of selectors) expect(s).toMatch(/^(\.ut-sh\b|\[data-win="share"\])/);
		// The sheet is on the page: `allCss()` reads it.
		expect(allCss()).toContain(".ut-sh-ring");
	});

	it("sizes the ring in CSS: 180px small, up to 360px filled, drawn once", () => {
		expect(rule(".ut-sh-ring")).toMatch(/width:\s*min\(100%, 180px\)/);
		expect(rule(".ut-sh-ring")).toMatch(/aspect-ratio:\s*1 \/ 1/);
		expect(rule(".ut-sh-ring")).toMatch(/overflow:\s*visible/);
		expect(rule('.ut-sh[data-filled="true"] .ut-sh-ring')).toMatch(/width:\s*min\(100%, 360px\)/);
	});

	it("dims the slices that are not chosen to .4 and their rows to .45", () => {
		expect(rule('.ut-sh-slice[data-lit="dim"]')).toMatch(/opacity:\s*0\.4;/);
		expect(rule('.ut-sh-row[data-lit="dim"]')).toMatch(/opacity:\s*0\.45;/);
	});

	it("keeps a long name on one line", () => {
		const n = rule(".ut-sh-row .n, .ut-sh-other .n");
		expect(n).toMatch(/white-space:\s*nowrap/);
		expect(n).toMatch(/overflow:\s*hidden/);
		expect(n).toMatch(/text-overflow:\s*ellipsis/);
	});

	it("fades the data in on a change, on the container only, and not at all under reduced motion", () => {
		const fades = [...SHEET.matchAll(/([^{}]+)\{([^{}]*animation:[^{}]*)\}/g)].map((m) => [
			(m[1] ?? "").replace(/\s+/g, " ").trim(),
			m[2] ?? "",
		]);
		const timed = fades.filter(([, decls]) => /0\.22s/.test(decls ?? ""));
		expect(timed.map(([sel]) => sel)).toEqual(['.ut-sh[data-gen="a"]', '.ut-sh[data-gen="b"]']);
		for (const [, decls] of timed) {
			expect(decls).toMatch(/0\.22s cubic-bezier\(0\.16, 0\.84, 0\.3, 1\)/);
		}
		const reduced = SHEET.slice(SHEET.indexOf("@media (prefers-reduced-motion: reduce)"));
		expect(reduced.length).toBeGreaterThan(0);
		expect(reduced).toMatch(/\.ut-sh\[data-gen\][^{]*\{[^}]*animation:\s*none/);
		expect(reduced).toMatch(/transition:\s*none/);
	});

	it("never animates a path's shape in CSS: the ring's tween owns it", () => {
		const transitions = [...SHEET.matchAll(/transition:([^;]*);/g)].map((m) => m[1] ?? "");
		expect(transitions.length).toBeGreaterThan(0);
		for (const t of transitions) expect(t).not.toMatch(/(^|[\s,])(d|all)([\s,]|$)/);
	});
});
