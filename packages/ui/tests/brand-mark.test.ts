// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetDisplay } from "../src/shared/budget-display.js";

const PKG = join(import.meta.dirname, "..");
const BRAND = join(PKG, "brand");

/**
 * The sha256 of the ONE brand file this repository may hold, `brand/usertrust-mark.svg`. Pinned, so a modified mark
 * fails here: the mark is not Apache-2.0, a fork that edits it has to remove it (TRADEMARKS.md), and a resized,
 * recoloured or re-encoded copy would otherwise pass as "the logo". Changing the mark is a decision for the owner of
 * the brand; the new hash goes here in the same change.
 */
const MARK_SHA256 = "e1136ed9518bbc08d6d92259ac9575b536c28c88c6261698ee2e250962f5c2b7";

/**
 * There is no skip when the file is absent: a missing mark fails loudly, because a header that imports a file that
 * is not there cannot build.
 */
describe("the bundled usertrust mark", () => {
	it("the brand folder holds exactly the mark and its LICENSE", () => {
		expect(readdirSync(BRAND).sort()).toEqual(["LICENSE", "usertrust-mark.svg"]);
	});

	it("the mark is the pinned file, byte for byte", () => {
		const sha = createHash("sha256")
			.update(readFileSync(join(BRAND, "usertrust-mark.svg")))
			.digest("hex");
		expect(sha).toBe(MARK_SHA256);
	});

	it("the only URL inside the mark is the SVG namespace, which is a name and never fetched", () => {
		const urls = readFileSync(join(BRAND, "usertrust-mark.svg"), "utf-8").match(
			/https?:\/\/[^\s"'<>]+/g,
		);
		expect(urls).toEqual(["http://www.w3.org/2000/svg"]);
	});

	it("the LICENSE says the mark is not Apache-2.0", () => {
		expect(readFileSync(join(BRAND, "LICENSE"), "utf-8").trim()).toBe(
			"© Usertools, Inc. All rights reserved. This file is not licensed under Apache-2.0. usertrust and the usertrust logo are trademarks of Usertools, Inc.",
		);
	});

	it("the mark travels inside dist, not as a brand/ folder: the release assembler takes dist/ and root files only", () => {
		const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8")) as {
			files: string[];
		};
		// Listing "brand" here makes `release.sh` refuse the package ("not a regular file"), and its tarball check
		// refuses package/brand/*. The mark is inlined into the bundled page, so dist carries it; the README and
		// NOTICE, which every package ships, say it is not Apache-2.0.
		expect(manifest.files).not.toContain("brand");
		expect(manifest.files).toContain("dist");
		expect(readFileSync(join(PKG, "NOTICE"), "utf-8").replace(/\s+/g, " ")).toContain(
			"not licensed under Apache-2.0",
		);
	});

	it("the header bundles the mark as inline data: it imports it, and names no URL", () => {
		const tsx = readFileSync(join(PKG, "src", "app", "summary-strip.tsx"), "utf-8");
		expect(tsx).toContain('from "../../brand/usertrust-mark.svg?inline"');
		expect(tsx).toContain("src={markUrl}");
		expect(tsx.match(/https?:\/\//g) ?? []).toEqual([]);
	});
});

/** usertrust gold on the header rule and the budget bar; the bar's three colours exist as CSS variables. */
describe("usertrust gold", () => {
	const css = readFileSync(join(PKG, "src", "app", "styles.css"), "utf-8");
	const defined = (name: string): string | undefined =>
		css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();

	it("gold is #E8B54B", () => {
		expect(defined("gold")?.toLowerCase().startsWith("#e8b54b")).toBe(true);
	});

	it("the rule beside the title is gold", () => {
		expect(css).toMatch(/\.ut-title::before\s*\{[^}]*background:\s*var\(--gold\)/);
	});

	it("every fill the budget bar can take is a defined CSS variable", () => {
		const fills = new Set(
			[1_000, 200, 199, 50, 49, -1].map((remainingUt) => {
				const shown = budgetDisplay({ budget: 1_000, remainingUt, budgetProvenance: "P" });
				return shown.kind === "known" ? shown.fill : "";
			}),
		);
		expect([...fills].sort()).toEqual(["danger", "gold", "warn"]);
		expect(defined("gold")).toBeDefined();
		expect(defined("danger")).toBeDefined();
		expect(defined("warn")).toBe("var(--alert)");
		expect(defined("alert")).toBe("#ff7a2f");
		const strip = readFileSync(join(PKG, "src", "app", "summary-strip.tsx"), "utf-8");
		expect(strip).toMatch(/var\(--\$\{budget\.fill\}\)/);
		// The bar FILLS with what is used: its width reads usedPct, never the remaining pct the figure prints.
		// (Built by concatenation: the needles are source text containing a literal `${`.)
		const width = (field: string): string => `width: \`$\{budget.${field}}%\``;
		expect(strip).toContain(width("usedPct"));
		expect(strip).not.toContain(width("pct"));
	});
});
