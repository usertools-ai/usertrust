// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
