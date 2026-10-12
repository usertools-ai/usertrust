// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT_MARK_URL } from "../src/shared/kit.js";

const SRC = join(import.meta.dirname, "..", "src");

function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
		d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)],
	);
}

/**
 * The product name is lowercase wherever this UI prints it (the header once read "USERTRUST · LEDGER"), and the UI
 * ships no font: it names families and the browser uses them only where they are installed. A font, inline or
 * fetched, would also send the page to the network, and this UI is loopback-only.
 */
describe("ui source: brand", () => {
	const sources = files(SRC).map((path) => ({ path, text: readFileSync(path, "utf-8") }));

	// A path is not a name: ".USERTRUST" in a comment is the vault directory, case-folded.
	it("red-first ('USERTRUST · LEDGER'): never a capitalised product name", () => {
		for (const { path, text } of sources) {
			expect({ path, hits: text.match(/(?<!\.)(?:USERTRUST|UserTrust|Usertrust)/g) ?? [] }).toEqual(
				{
					path,
					hits: [],
				},
			);
		}
	});

	// Loopback-only, with one opt-in exception: the kit mark. Any other remote URL in the code the BROWSER runs
	// (src/app, and src/shared, which the SPA bundles) is a new network request a reviewer has to see. The SVG
	// namespace is a name, never fetched.
	it("the only remote URL the page can load is the opt-in kit mark", () => {
		const allowed = new Set([KIT_MARK_URL, "http://www.w3.org/2000/svg"]);
		const browser = sources.filter(({ path }) => /[/\\]src[/\\](app|shared)[/\\]/.test(path));
		expect(browser.length).toBeGreaterThan(0);
		for (const { path, text } of browser) {
			const urls = (text.match(/https?:\/\/[^\s"'`)<>]+/g) ?? []).filter((u) => !allowed.has(u));
			expect({ path, urls }).toEqual({ path, urls: [] });
		}
	});

	it("the kit mark is fetched with no cookies and no referrer", () => {
		const users = sources.filter(
			({ path, text }) => /[/\\]src[/\\]app[/\\]/.test(path) && text.includes("KIT_MARK_URL"),
		);
		expect(users.map(({ path }) => path.slice(path.lastIndexOf("src")))).toEqual([
			"src/app/summary-strip.tsx",
		]);
		const tsx = users[0]?.text ?? "";
		expect(tsx).toContain('crossOrigin="anonymous"');
		expect(tsx).toContain('referrerPolicy="no-referrer"');
	});

	it("no font is embedded or fetched: no @font-face, no font data URL, no remote url()", () => {
		for (const { path, text } of sources) {
			expect({
				path,
				hits: text.match(/@font-face|data:font\/|url\(\s*["']?https?:/g) ?? [],
			}).toEqual({
				path,
				hits: [],
			});
		}
	});
});
