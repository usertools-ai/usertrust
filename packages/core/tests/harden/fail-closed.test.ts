// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { evaluatePolicy, type GateRule } from "../../src/policy/gate.js";

describe("hard numeric rules fail closed on missing/mistyped fields", () => {
	const hardRule: GateRule = {
		id: "budget-guard",
		name: "budget guard",
		effect: "deny",
		enforcement: "hard",
		conditions: [{ field: "budget_remaining_after", operator: "lt", value: 0 }],
	};

	it("denies when the guarded field is missing (fail closed)", () => {
		// budget_remaining_after absent — engine failed to supply it.
		expect(evaluatePolicy([hardRule], { model: "x" }).decision).toBe("deny");
	});

	it("denies when the guarded field is non-numeric", () => {
		expect(evaluatePolicy([hardRule], { budget_remaining_after: "oops" }).decision).toBe("deny");
	});

	it("allows when the field is present and satisfies the bound", () => {
		expect(evaluatePolicy([hardRule], { budget_remaining_after: 5 }).decision).toBe("allow");
	});

	it("still denies when the field is present and violates the bound", () => {
		expect(evaluatePolicy([hardRule], { budget_remaining_after: -1 }).decision).toBe("deny");
	});

	it("soft rule with missing field stays lenient (no warning)", () => {
		const soft: GateRule = {
			name: "soft",
			effect: "warn",
			enforcement: "soft",
			conditions: [{ field: "estimated_cost", operator: "gt", value: 1000 }],
		};
		const r = evaluatePolicy([soft], { model: "x" });
		expect(r.hasWarnings).toBe(false);
		expect(r.decision).toBe("allow");
	});

	it("soft rule with non-numeric field stays lenient", () => {
		const soft: GateRule = {
			name: "soft",
			effect: "warn",
			enforcement: "soft",
			conditions: [{ field: "estimated_cost", operator: "gt", value: 1000 }],
		};
		expect(evaluatePolicy([soft], { estimated_cost: "lots" }).hasWarnings).toBe(false);
	});
});
