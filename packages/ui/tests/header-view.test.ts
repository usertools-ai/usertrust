// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A6: a hover on the Spend chart previews the page header only. The list, the rows and every window read the
 * COMMITTED position; `preview(null)` puts the header back on it and never goes live by itself.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AtView, LIVE_VIEW } from "../src/shared/at-follow.js";
import { headerView } from "../src/shared/header-view.js";

function viewAt(pos: number): AtView {
	return { ...LIVE_VIEW, at: { pos } as unknown as NonNullable<AtView["at"]> };
}

describe("headerView", () => {
	const pinned = viewAt(4);
	const hovered = viewAt(9);

	it("shows the previewed position in the header while a preview has answered, over a pin", () => {
		expect(headerView(9, pinned, hovered)).toBe(hovered);
	});

	it("restores the committed position when the preview ends (the pin, not live)", () => {
		expect(headerView(null, pinned, hovered)).toBe(pinned);
	});

	it("restores live when nothing is pinned", () => {
		expect(headerView(null, LIVE_VIEW, hovered)).toBe(LIVE_VIEW);
	});

	it("keeps the committed header until the preview's own answer lands, never flashing live", () => {
		expect(headerView(9, pinned, LIVE_VIEW)).toBe(pinned);
	});
});

describe("the provider's list reads the committed position only", () => {
	const src = readFileSync(join(__dirname, "../src/app/desk/desk-state.tsx"), "utf8");

	it("feeds the list, rows and windows from the committed view and the header from headerView", () => {
		expect(src).toContain("headerView(previewPos, atView, previewView)");
		expect(src).toMatch(/const shownAt = atView\.at;/);
		const list = /const listInput = useMemo<ListInput>\(([\s\S]*?)\n\t\);/.exec(src)?.[1] ?? "";
		expect(list).toContain("at: shownAt");
		expect(list).not.toMatch(/header|previewView|previewPos/);
		expect(src).toMatch(/at: shownAt,\n\t\t\theadAt: header\.at,/);
	});

	it("a navigation clears the preview", () => {
		expect(src).toMatch(/setPreviewPos\(null\)/);
	});
});
