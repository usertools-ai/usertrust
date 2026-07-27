// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Budget-aware policy tiers (T3).
 *
 * Two things are pinned here:
 *
 * 1. `budgetFractionRemaining` and `budgetRunwayHours` are declared, typed,
 *    OPTIONAL numbers on PolicyContext, so a tier ladder is expressible with the
 *    operators that already exist (`lt`/`lte`/`gte` + `in`). No new operator.
 *
 * 2. The evaluator does NOT special-case them. A budget field resolves through
 *    the same dot-notation path as any other caller-supplied field, and an
 *    ABSENT budget field inherits the existing indeterminate split unchanged:
 *    hard rules fail CLOSED (the guard still fires), soft rules stay lenient.
 *    Both directions are asserted against the live evaluator rather than
 *    assumed, and a differential case proves the new names get no special
 *    handling.
 *
 * `escalate` is not a PolicyEffect — the union is `deny | warn`. The escalation
 * tier is therefore expressed as `effect: "warn"` + `enforcement: "soft"`, which
 * is the "surface it to a human, do not block" signal the gate already emits.
 *
 * SECURITY (D17): never log a whole PolicyContext in test or debug output.
 * PolicyContext extends `Record<string, unknown>` and upstream callers populate
 * it with request-shaped data — prompt text, tool arguments, actor identifiers.
 * Dumping one into CI output can leak secrets that are hard to unpublish.
 * Assert on individual fields; never `console.log(ctx)` or snapshot a context.
 */

import { describe, expect, it } from "vitest";
import { evaluatePolicy, type GateRule, type PolicyContext } from "../../src/policy/gate.js";
import type { PolicyEnforcement } from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// The tier ladder under test
// ---------------------------------------------------------------------------

/** Tier 1 — hard stop: no frontier model once the allocation is nearly gone. */
const DENY_FRONTIER_BELOW_30: GateRule = {
	id: "budget-tier-frontier",
	name: "frontier-model-below-30pct",
	description: "Frontier models are blocked below 30% of the cost center's allocation",
	effect: "deny",
	enforcement: "hard",
	severity: "high",
	conditions: [
		{ field: "budgetFractionRemaining", operator: "lt", value: 0.3 },
		{ field: "model", operator: "in", value: ["claude-opus-4-6"] },
	],
};

/** Tier 2 — escalate: warn a human when less than half a day of runway is left. */
const ESCALATE_BELOW_12H: GateRule = {
	id: "budget-tier-runway",
	name: "runway-below-12h",
	description: "Under 12h of projected runway — escalate before continuing",
	effect: "warn",
	enforcement: "soft",
	severity: "medium",
	conditions: [{ field: "budgetRunwayHours", operator: "lt", value: 12 }],
};

/** A rule that touches no budget field at all — the "behaves as today" control. */
const DENY_PII: GateRule = {
	id: "pii-block",
	name: "pii-block",
	effect: "deny",
	enforcement: "hard",
	conditions: [{ field: "containsPii", operator: "eq", value: true }],
};

// ---------------------------------------------------------------------------
// Tier 1 — budgetFractionRemaining gates a model class
// ---------------------------------------------------------------------------

describe("budgetFractionRemaining tier", () => {
	it("denies a frontier call at 0.2 remaining", () => {
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30], {
			budgetFractionRemaining: 0.2,
			model: "claude-opus-4-6",
		});

		expect(result.decision).toBe("deny");
		expect(result.hardViolations.map((v) => v.name)).toEqual(["frontier-model-below-30pct"]);
		expect(result.reasons).toEqual([
			"[budget-tier-frontier] Frontier models are blocked below 30% of the cost center's allocation",
		]);
	});

	it("does not match at 0.9 remaining", () => {
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30], {
			budgetFractionRemaining: 0.9,
			model: "claude-opus-4-6",
		});

		expect(result.decision).toBe("allow");
		expect(result.matched).toHaveLength(0);
		expect(result.reasons).toEqual([]);
	});

	it("does not match a cheap model even when the budget is nearly gone", () => {
		// Both conditions are ANDed: the tier gates a model CLASS, not all spend.
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30], {
			budgetFractionRemaining: 0.05,
			model: "claude-haiku-4-5",
		});

		expect(result.decision).toBe("allow");
		expect(result.matched).toHaveLength(0);
	});

	it("treats the threshold as strict — exactly 0.3 does not match", () => {
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30], {
			budgetFractionRemaining: 0.3,
			model: "claude-opus-4-6",
		});

		expect(result.decision).toBe("allow");
		expect(result.matched).toHaveLength(0);
	});

	it("denies at an exhausted budget (0 remaining)", () => {
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30], {
			budgetFractionRemaining: 0,
			model: "claude-opus-4-6",
		});

		expect(result.decision).toBe("deny");
	});
});

// ---------------------------------------------------------------------------
// Tier 2 — budgetRunwayHours escalates
// ---------------------------------------------------------------------------

describe("budgetRunwayHours tier", () => {
	it("escalates below 12h of runway without blocking the call", () => {
		const result = evaluatePolicy([ESCALATE_BELOW_12H], { budgetRunwayHours: 6 });

		expect(result.decision).toBe("allow");
		expect(result.hasWarnings).toBe(true);
		expect(result.softViolations.map((v) => v.name)).toEqual(["runway-below-12h"]);
		expect(result.hardViolations).toEqual([]);
		expect(result.reasons).toEqual([
			"[WARN] [budget-tier-runway] Under 12h of projected runway — escalate before continuing",
		]);
	});

	it("stays quiet with plenty of runway", () => {
		const result = evaluatePolicy([ESCALATE_BELOW_12H], { budgetRunwayHours: 48 });

		expect(result.decision).toBe("allow");
		expect(result.hasWarnings).toBe(false);
		expect(result.matched).toHaveLength(0);
	});

	it("escalates and denies independently on the same context", () => {
		// The full ladder: a frontier call at 5% budget with 2h of runway trips
		// both tiers — deny wins the decision, the warning still surfaces.
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30, ESCALATE_BELOW_12H], {
			budgetFractionRemaining: 0.05,
			budgetRunwayHours: 2,
			model: "claude-opus-4-6",
		});

		expect(result.decision).toBe("deny");
		expect(result.hasWarnings).toBe(true);
		expect(result.matched.map((m) => m.name)).toEqual([
			"frontier-model-below-30pct",
			"runway-below-12h",
		]);
	});
});

// ---------------------------------------------------------------------------
// Absent budget fields — the existing behaviour, pinned rather than assumed
// ---------------------------------------------------------------------------

describe("absent budget fields", () => {
	it("does not match a SOFT budget rule when the field is absent", () => {
		// `lt` on a missing field is indeterminate; soft rules stay lenient.
		const result = evaluatePolicy([ESCALATE_BELOW_12H], { model: "claude-opus-4-6" });

		expect(result.matched).toHaveLength(0);
		expect(result.hasWarnings).toBe(false);
		expect(result.decision).toBe("allow");
	});

	it("MATCHES a HARD budget rule when the field is absent (fail closed)", () => {
		// Pinned, not assumed. `evaluateFieldCondition` returns "indeterminate"
		// for a numeric operator on a missing field, and `ruleMatches` SKIPS an
		// indeterminate condition for hard rules so the guard still fires. A hard
		// budget tier therefore DENIES on a context that never populated budget
		// data — the caller must supply the field or gate the rule with `exists`.
		const result = evaluatePolicy([DENY_FRONTIER_BELOW_30], { model: "claude-opus-4-6" });

		expect(result.decision).toBe("deny");
		expect(result.hardViolations.map((v) => v.name)).toEqual(["frontier-model-below-30pct"]);
	});

	it("lets an `exists` guard keep a hard tier from firing on a budget-less context", () => {
		// `exists` returns a real boolean (never indeterminate), so it short-
		// circuits the rule before the fail-closed numeric condition is reached.
		// This is the pattern the PolicyContext doc comment points callers at.
		const guarded: GateRule = {
			id: "budget-tier-guarded",
			name: "guarded-frontier-tier",
			effect: "deny",
			enforcement: "hard",
			conditions: [
				{ field: "budgetFractionRemaining", operator: "exists" },
				{ field: "budgetFractionRemaining", operator: "lt", value: 0.3 },
			],
		};

		expect(evaluatePolicy([guarded], { model: "claude-opus-4-6" }).decision).toBe("allow");
		expect(evaluatePolicy([guarded], { budgetFractionRemaining: 0.2 }).decision).toBe("deny");
		expect(evaluatePolicy([guarded], { budgetFractionRemaining: 0.9 }).decision).toBe("allow");
	});

	it("treats an absent budget field identically to any other absent field", () => {
		// Differential: the same rule shape pointed at a budget field and at a
		// field name the evaluator has never heard of. Identical verdicts under
		// BOTH enforcement levels prove the new names get no special handling —
		// this is what "behaves exactly as today" means for the evaluator.
		const enforcements: PolicyEnforcement[] = ["hard", "soft"];

		for (const enforcement of enforcements) {
			const onBudgetField: GateRule = {
				name: "probe",
				effect: "deny",
				enforcement,
				conditions: [{ field: "budgetFractionRemaining", operator: "lt", value: 0.3 }],
			};
			const onUnknownField: GateRule = {
				name: "probe",
				effect: "deny",
				enforcement,
				conditions: [{ field: "someFieldNobodyDeclared", operator: "lt", value: 0.3 }],
			};

			const budget = evaluatePolicy([onBudgetField], { model: "claude-opus-4-6" });
			const unknown = evaluatePolicy([onUnknownField], { model: "claude-opus-4-6" });

			expect(budget.decision).toBe(unknown.decision);
			expect(budget.matched).toHaveLength(unknown.matched.length);
			expect(budget.reasons).toEqual(unknown.reasons);
		}
	});

	it("leaves non-budget rules working on a context with no budget fields", () => {
		expect(evaluatePolicy([DENY_PII], { containsPii: true }).decision).toBe("deny");
		expect(evaluatePolicy([DENY_PII], { containsPii: false }).decision).toBe("allow");
		expect(evaluatePolicy([DENY_PII], { containsPii: false }).matched).toHaveLength(0);
	});

	it("evaluates a mixed rule set unchanged when no budget data is supplied", () => {
		// A soft budget tier alongside an unrelated hard rule: the budget tier is
		// silent, the unrelated rule decides — exactly as before this change.
		const result = evaluatePolicy([ESCALATE_BELOW_12H, DENY_PII], { containsPii: true });

		expect(result.decision).toBe("deny");
		expect(result.hasWarnings).toBe(false);
		expect(result.matched.map((m) => m.name)).toEqual(["pii-block"]);
	});
});

// ---------------------------------------------------------------------------
// Type surface
// ---------------------------------------------------------------------------

describe("PolicyContext budget fields", () => {
	it("exposes both fields as typed optional numbers", () => {
		const ctx: PolicyContext = { budgetFractionRemaining: 0.42, budgetRunwayHours: 7.5 };

		// These assignments only compile because the fields are DECLARED as
		// `number | undefined`. Without the declaration they fall through the
		// `Record<string, unknown>` index signature and resolve to `unknown`,
		// which is not assignable to `number`.
		const fraction: number = ctx.budgetFractionRemaining ?? 1;
		const runway: number = ctx.budgetRunwayHours ?? Number.POSITIVE_INFINITY;

		expect(fraction).toBeCloseTo(0.42);
		expect(runway).toBeCloseTo(7.5);
	});

	it("keeps both fields optional", () => {
		const ctx: PolicyContext = { scope: ["llm:*"] };

		expect(ctx.budgetFractionRemaining).toBeUndefined();
		expect(ctx.budgetRunwayHours).toBeUndefined();
	});
});
