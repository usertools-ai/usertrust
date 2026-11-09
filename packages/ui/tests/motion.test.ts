// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { afterEach, describe, expect, it, vi } from "vitest";
import { FADE_MS, FILL_EASE, FILL_MS, motionStill } from "../src/shared/motion.js";

afterEach(() => vi.unstubAllGlobals());

describe("motion constants", () => {
	it("pin the fill and fade timings", () => {
		expect(FILL_MS).toBe(340);
		expect(FADE_MS).toBe(270);
		expect(FILL_EASE).toBe("cubic-bezier(.2,.8,.2,1)");
	});
});

describe("motionStill", () => {
	it("is true when the reader asks for reduced motion", () => {
		const matchMedia = vi.fn((q: string) => ({
			matches: q === "(prefers-reduced-motion: reduce)",
		}));
		vi.stubGlobal("window", { matchMedia });
		expect(motionStill()).toBe(true);
		expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
	});

	it("is false when the reader does not", () => {
		vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
		expect(motionStill()).toBe(false);
	});

	it("is false with no window", () => {
		vi.stubGlobal("window", undefined);
		expect(motionStill()).toBe(false);
	});

	it("is false when matchMedia is missing", () => {
		vi.stubGlobal("window", {});
		expect(motionStill()).toBe(false);
	});
});
