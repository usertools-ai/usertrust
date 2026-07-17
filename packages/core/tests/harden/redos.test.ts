// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { type GateRule, evaluatePolicy } from "../../src/policy/gate.js";

const CATASTROPHIC = ["(a+)+$", "(.*)*$", "(\\d+)+$", "(a|a)*$", "(a|ab)*$"];

describe("safeRegExp structural ReDoS guard", () => {
	for (const pat of CATASTROPHIC) {
		it(`neutralises catastrophic pattern ${pat} within a hard time bound`, () => {
			const rules: GateRule[] = [
				{
					name: "redos",
					effect: "deny",
					enforcement: "hard",
					conditions: [{ field: "text", operator: "regex", value: pat }],
				},
			];
			// Classic backtracking trigger: many 'a' then a non-matching tail.
			const evil = `${"a".repeat(50)}!`;
			const start = Date.now();
			const result = evaluatePolicy(rules, { text: evil });
			const elapsed = Date.now() - start;
			// Pattern is rejected as unsafe → condition never matches → allow, fast.
			expect(elapsed).toBeLessThan(1000);
			expect(result.decision).toBe("allow");
		});
	}

	it("still allows a safe regex to match", () => {
		const rules: GateRule[] = [
			{
				name: "safe",
				effect: "deny",
				enforcement: "hard",
				conditions: [{ field: "text", operator: "regex", value: "^gpt-4" }],
			},
		];
		expect(evaluatePolicy(rules, { text: "gpt-4o" }).decision).toBe("deny");
	});

	it("caps the input length scanned by the regex engine (defense-in-depth)", () => {
		// A safe-but-linear pattern against an enormous input must not scan
		// beyond the input cap; correctness of the cap is asserted via a match
		// that only appears past the cap boundary being ignored.
		const rules: GateRule[] = [
			{
				name: "tail-anchor",
				effect: "deny",
				enforcement: "hard",
				conditions: [{ field: "text", operator: "regex", value: "NEEDLE$" }],
			},
		];
		// NEEDLE sits well beyond MAX_REGEX_INPUT (4096); after slicing it is gone.
		const haystack = `${"x".repeat(10000)}NEEDLE`;
		expect(evaluatePolicy(rules, { text: haystack }).decision).toBe("allow");
	});
});
