// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "../../src/policy/default-rules.js";
import { evaluatePolicy } from "../../src/policy/gate.js";

describe("DEFAULT_RULES pre-spend budget enforcement", () => {
	it("denies a single call that would overshoot remaining budget", () => {
		// Budget not yet exhausted (remaining > 0) but this call costs more than remains.
		const ctx = {
			budget_remaining: 100,
			estimated_cost: 5000,
			budget_remaining_after: 100 - 5000,
		};
		const result = evaluatePolicy(DEFAULT_RULES, ctx);
		expect(result.decision).toBe("deny");
		expect(result.hardViolations.map((v) => v.name)).toContain(
			"Block calls that would exceed remaining budget",
		);
	});

	it("allows a call fully covered by remaining budget", () => {
		const ctx = {
			budget_remaining: 100,
			estimated_cost: 40,
			budget_remaining_after: 60,
		};
		expect(evaluatePolicy(DEFAULT_RULES, ctx).decision).toBe("allow");
	});

	it("denies when budget already exhausted", () => {
		const ctx = { budget_remaining: 0, estimated_cost: 1, budget_remaining_after: -1 };
		expect(evaluatePolicy(DEFAULT_RULES, ctx).decision).toBe("deny");
	});

	it("no longer carries the dead block-zero-budget rule", () => {
		expect(DEFAULT_RULES.find((r) => r.id === "block-zero-budget")).toBeUndefined();
	});
});
