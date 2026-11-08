// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The dashboard has no slider. The approved design looks back through the Spend chart's pin, so until that lands the
 * past view comes from the address (`#at=N`) alone. These checks read the source: the page mounts no range input, and
 * the files and rules that drew one are gone.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (...p: string[]): string => readFileSync(join(root, ...p), "utf8");
const app = read("src", "app", "app.tsx");
const css = read("src", "app", "styles.css");

describe("the dashboard has no slider", () => {
	it("the page source is read (positive control)", () => {
		expect(app).toContain("<SummaryStrip");
	});

	it.each([["<Timeline"], ['type="range"'], ["Scrubber"], ["ut-tl-range"]])(
		"app.tsx has no %s",
		(needle) => {
			expect(app).not.toContain(needle);
		},
	);

	it("the slider's files are gone", () => {
		expect(existsSync(join(root, "src", "app", "timeline.tsx"))).toBe(false);
		expect(existsSync(join(root, "src", "shared", "scrub.ts"))).toBe(false);
	});

	it.each([
		[".ut-tl-range"],
		[".ut-tl-btn"],
		[".ut-tl-new"],
		[".ut-tl-head"],
		[".ut-tl-label"],
		[".ut-tl-count"],
	])("styles.css has no rule for %s", (sel) => {
		expect(css.includes(`${sel} `) || css.includes(`${sel},`) || css.includes(`${sel}:`)).toBe(
			false,
		);
		expect(css.includes(`${sel}[`)).toBe(false);
		expect(css.includes(`${sel}::`)).toBe(false);
	});

	it("styles.css has no bare .ut-tl rule, and keeps the status note and the held note", () => {
		expect(css).not.toMatch(/\.ut-tl\s*\{/);
		expect(css).not.toMatch(/\.ut-tl\[/);
		expect(css).toContain(".ut-tl-msg");
		expect(css).toContain(".ut-tl-held");
	});
});
