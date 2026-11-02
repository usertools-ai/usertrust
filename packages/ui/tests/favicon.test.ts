// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { faviconPlugin } from "../favicon-plugin.js";
import { cropMarkToChip, faviconHref } from "../src/shared/favicon.js";

const PKG = join(import.meta.dirname, "..");
const MARK = join(PKG, "brand", "usertrust-mark.svg");
const mark = readFileSync(MARK, "utf-8");

/** The `href` of each `<link rel="icon">` in an HTML page ("" for one with no href). */
function iconHrefs(html: string): string[] {
	return [...html.matchAll(/<link\b[^>]*\brel="icon"[^>]*>/g)].map(
		(m) => m[0].match(/\bhref="([^"]*)"/)?.[1] ?? "",
	);
}

const decode = (href: string): string =>
	decodeURIComponent(href.replace(/^data:image\/svg\+xml,/, ""));

describe("the dashboard's tab icon", () => {
	it("is the mark cropped to its left square: only the root viewBox differs", () => {
		const chip = cropMarkToChip(mark);
		expect(chip).not.toBe(mark);
		expect(chip.replace('viewBox="0 0 256 256"', 'viewBox="0 0 942 256"')).toBe(mark);
		// the gold chip is the first path, and the name's pill starts at x = 276, outside the crop
		expect(chip).toContain('fill="#E8B54B"');
		expect(chip).toContain("M344.92 0H814");
	});

	it("refuses a mark whose box is not the one the crop was cut for", () => {
		expect(() =>
			cropMarkToChip(mark.replace('viewBox="0 0 942 256"', 'viewBox="0 0 900 256"')),
		).toThrow(/chip crop was cut for that box/);
	});

	it("index.html names no icon: a hand-inlined copy would drift from the pinned mark", () => {
		const html = readFileSync(join(PKG, "src", "app", "index.html"), "utf-8");
		expect(iconHrefs(html)).toEqual([]);
		expect(html).not.toContain("data:image");
		expect(html).not.toMatch(/<svg\b/);
	});

	it("is read from the file it is given, not copied: a different mark gives a different icon", () => {
		// The control for "equals the derived icon": a plugin that returned a baked-in copy of the pinned mark
		// would pass the build test below, and fails here.
		const dir = mkdtempSync(join(tmpdir(), "ui-favicon-"));
		const other = join(dir, "other.svg");
		writeFileSync(other, mark.replace("#E8B54B", "#123456"));
		const hook = faviconPlugin(other).transformIndexHtml as unknown as () => Array<{
			attrs: { href: string };
		}>;
		const href = hook()[0]?.attrs.href ?? "";
		expect(decode(href)).toContain('fill="#123456"');
		expect(decode(href)).not.toContain("#E8B54B");
	});

	it("the built page carries exactly the derived icon", async () => {
		const out = mkdtempSync(join(tmpdir(), "ui-favicon-build-"));
		await build({
			configFile: join(PKG, "vite.config.ts"),
			root: join(PKG, "src", "app"), // the config's `root` is relative to the working directory
			logLevel: "silent",
			build: { outDir: out, emptyOutDir: true },
		});
		const hrefs = iconHrefs(readFileSync(join(out, "index.html"), "utf-8"));
		expect(hrefs).toEqual([faviconHref(mark)]);
		expect(decode(hrefs[0] ?? "")).toBe(cropMarkToChip(mark).trim());
	}, 120_000);
});
