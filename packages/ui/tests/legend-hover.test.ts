// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/** Which hover the Share window's legend owns: it clears only one it published, and shows the pointer's row before the focused one. */

import { describe, expect, it } from "vitest";
import { isOurs, LEGEND_FROM, rowToShow } from "../src/app/windows/share/legend-hover.js";

describe("the legend's hover", () => {
	it("shows the row under the pointer, else the focused row, else none", () => {
		expect(rowToShow("b", "a")).toBe("b");
		expect(rowToShow("b", null)).toBe("b");
		expect(rowToShow(null, "a")).toBe("a");
		expect(rowToShow(null, null)).toBeNull();
	});

	it("owns the hover on the bus only when it is the one it published, at its level", () => {
		const ours = { dim: "lane", key: "a", from: LEGEND_FROM } as const;
		expect(isOurs(ours, "lane", "a")).toBe(true);
		expect(isOurs(null, "lane", "a")).toBe(false);
		expect(isOurs(ours, "lane", null)).toBe(false);
		// A hover another window or the ring set is not the legend's to clear, even on the same key.
		expect(isOurs({ ...ours, from: "share" }, "lane", "a")).toBe(false);
		expect(isOurs({ ...ours, from: "spend" }, "lane", "a")).toBe(false);
		expect(isOurs({ ...ours, key: "b" }, "lane", "a")).toBe(false);
		expect(isOurs({ ...ours, dim: "model" }, "lane", "a")).toBe(false);
		expect(LEGEND_FROM).not.toBe("share");
	});
});
