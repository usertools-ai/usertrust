// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Tests for Levenshtein-based "Did you mean?" suggestions
 * and the command suggestion logic in main.ts.
 */

import { describe, expect, it } from "vitest";
import { COMMANDS, levenshtein, suggestCommand } from "../../src/cli/main.js";

describe("levenshtein distance", () => {
	it("returns 0 for identical strings", () => {
		expect(levenshtein("verify", "verify")).toBe(0);
	});

	it("returns correct distance for single char diff", () => {
		expect(levenshtein("verify", "verifiy")).toBe(1);
	});

	it("returns correct distance for transposition-like", () => {
		expect(levenshtein("inspect", "inpsect")).toBe(2);
	});

	it("returns string length for empty vs non-empty", () => {
		expect(levenshtein("", "init")).toBe(4);
		expect(levenshtein("init", "")).toBe(4);
	});

	it("returns 0 for two empty strings", () => {
		expect(levenshtein("", "")).toBe(0);
	});

	it("handles completely different strings", () => {
		expect(levenshtein("abc", "xyz")).toBe(3);
	});
});

describe("suggestCommand", () => {
	it("suggests 'verify' for 'verifiy'", () => {
		expect(suggestCommand("verifiy")).toBe("verify");
	});

	it("suggests 'init' for 'int'", () => {
		expect(suggestCommand("int")).toBe("init");
	});

	it("suggests 'inspect' for 'inpsect'", () => {
		expect(suggestCommand("inpsect")).toBe("inspect");
	});

	it("suggests 'health' for 'helath'", () => {
		expect(suggestCommand("helath")).toBe("health");
	});

	it("suggests 'snapshot' for 'snapshto'", () => {
		expect(suggestCommand("snapshto")).toBe("snapshot");
	});

	it("suggests 'tb' for 'tb' exactly", () => {
		expect(suggestCommand("tb")).toBe("tb");
	});

	it("returns undefined for gibberish beyond threshold", () => {
		expect(suggestCommand("xyzxyzxyzxyz")).toBeUndefined();
	});

	it("returns closest match for ambiguous input", () => {
		// "in" is distance 2 from "init" and "inspect" (distance 4) and "tb" (distance 2)
		// Should return one of the closest
		const result = suggestCommand("in");
		expect(result).toBeDefined();
		expect(COMMANDS).toContain(result);
	});
});
