// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { detectCanaryLeak, generateCanary, injectCanary } from "../../src/policy/canary.js";

// ===========================================================================
// generateCanary
// ===========================================================================

describe("generateCanary", () => {
	it("returns a 32-char hex token", () => {
		const { token } = generateCanary();
		expect(token).toMatch(/^[a-f0-9]{32}$/);
	});

	it("returns marker as HTML comment containing the token", () => {
		const { token, marker } = generateCanary();
		expect(marker).toBe(`<!-- ${token} -->`);
	});

	it("produces unique tokens across multiple calls", () => {
		const tokens = new Set(Array.from({ length: 20 }, () => generateCanary().token));
		expect(tokens.size).toBe(20);
	});
});

// ===========================================================================
// injectCanary
// ===========================================================================

describe("injectCanary", () => {
	it("prepends marker + newline to system prompt", () => {
		const canary = generateCanary();
		const result = injectCanary("You are a helpful assistant.", canary);
		expect(result).toBe(`${canary.marker}\nYou are a helpful assistant.`);
	});

	it("preserves original prompt content", () => {
		const canary = generateCanary();
		const prompt = "Line 1\nLine 2\nLine 3";
		const result = injectCanary(prompt, canary);
		expect(result).toContain(prompt);
	});

	it("works with an empty system prompt", () => {
		const canary = generateCanary();
		const result = injectCanary("", canary);
		expect(result).toBe(`${canary.marker}\n`);
	});
});

// ===========================================================================
// detectCanaryLeak
// ===========================================================================

describe("detectCanaryLeak", () => {
	it("returns true when token appears in output", () => {
		const canary = generateCanary();
		expect(detectCanaryLeak(canary.token, canary)).toBe(true);
	});

	it("returns false when token is absent", () => {
		const canary = generateCanary();
		expect(detectCanaryLeak("nothing suspicious here", canary)).toBe(false);
	});

	it("returns false for empty output", () => {
		const canary = generateCanary();
		expect(detectCanaryLeak("", canary)).toBe(false);
	});

	it("detects token even when surrounded by other text", () => {
		const canary = generateCanary();
		const output = `Here is some text before ${canary.token} and after it.`;
		expect(detectCanaryLeak(output, canary)).toBe(true);
	});

	it("does not false-positive on a partial token match", () => {
		const canary = generateCanary();
		const partial = canary.token.slice(0, 16);
		expect(detectCanaryLeak(partial, canary)).toBe(false);
	});
});
