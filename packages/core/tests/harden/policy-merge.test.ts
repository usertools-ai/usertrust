// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, mergePolicies } from "../../src/policy/default-rules.js";
import { evaluatePolicy, type GateRule } from "../../src/policy/gate.js";

describe("mergePolicies (safe concat — defaults always enforced)", () => {
	it("keeps enforcement defaults when a user supplies unrelated rules", () => {
		const user: GateRule[] = [
			{
				id: "user-block-gpt4",
				name: "no gpt-4",
				effect: "deny",
				enforcement: "hard",
				conditions: [{ field: "model", operator: "eq", value: "gpt-4" }],
			},
		];
		const merged = mergePolicies(DEFAULT_RULES, user);

		// Default overshoot rule survived:
		const ctx = {
			budget_remaining: 10,
			estimated_cost: 999,
			budget_remaining_after: -989,
			model: "claude",
		};
		expect(evaluatePolicy(merged, ctx).decision).toBe("deny");

		// User rule also active:
		const ctx2 = {
			budget_remaining: 1e9,
			estimated_cost: 1,
			budget_remaining_after: 1e9,
			model: "gpt-4",
		};
		expect(evaluatePolicy(merged, ctx2).decision).toBe("deny");
	});

	it("is a pure concat: defaults first, then user rules, none dropped", () => {
		const user: GateRule[] = [
			{
				id: "u1",
				name: "u1",
				effect: "warn",
				enforcement: "soft",
				conditions: [{ field: "x", operator: "exists" }],
			},
		];
		const merged = mergePolicies(DEFAULT_RULES, user);
		expect(merged).toHaveLength(DEFAULT_RULES.length + user.length);
		expect(merged.slice(0, DEFAULT_RULES.length)).toEqual(DEFAULT_RULES);
		expect(merged[merged.length - 1]?.id).toBe("u1");
	});

	it("does NOT let a user disable a default via same-id enabled:false (no escape hatch)", () => {
		// Attempt to neuter the overshoot guard by re-declaring its id disabled.
		const user: GateRule[] = [
			{
				id: "block-budget-overshoot",
				name: "block-budget-overshoot",
				effect: "deny",
				enforcement: "hard",
				enabled: false,
				conditions: [{ field: "budget_remaining_after", operator: "lt", value: 0 }],
			},
		];
		const merged = mergePolicies(DEFAULT_RULES, user);
		// The original enabled default is still present and still enforces.
		const stillEnforced = merged.filter(
			(r) => r.id === "block-budget-overshoot" && (r.enabled ?? true),
		);
		expect(stillEnforced.length).toBeGreaterThanOrEqual(1);
		const ctx = {
			budget_remaining: 10,
			estimated_cost: 999,
			budget_remaining_after: -989,
		};
		expect(evaluatePolicy(merged, ctx).decision).toBe("deny");
	});

	it("does not mutate the defaults array", () => {
		const before = DEFAULT_RULES.length;
		mergePolicies(DEFAULT_RULES, [
			{
				id: "u",
				name: "u",
				effect: "warn",
				enforcement: "soft",
				conditions: [],
			},
		]);
		expect(DEFAULT_RULES).toHaveLength(before);
	});
});
