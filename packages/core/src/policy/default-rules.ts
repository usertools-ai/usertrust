// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Default Policy Rules
 *
 * Sensible defaults for financial governance:
 * 1. Block calls that would overshoot remaining budget PRE-spend
 *    (budget_remaining_after < 0 → deny, hard). budget_remaining_after is the
 *    derived field budget_remaining - estimated_cost, injected by the governor.
 * 2. Block if budget already exhausted (budget_remaining <= 0 → deny, hard).
 * 3. Warn on high-cost operations (estimated_cost > 1000 → warn, soft).
 */

import type { GateRule } from "./gate.js";

export const DEFAULT_RULES: GateRule[] = [
	{
		id: "block-budget-overshoot",
		name: "Block calls that would exceed remaining budget",
		description: "Deny pre-spend when estimated cost would drive remaining budget below zero",
		priority: 1,
		enabled: true,
		effect: "deny",
		enforcement: "hard",
		severity: "critical",
		// budget_remaining_after = budget_remaining - estimated_cost (governor-supplied).
		// As a hard rule this fails CLOSED: if the governor fails to supply the
		// derived field, evaluation is indeterminate and the call is denied.
		conditions: [{ field: "budget_remaining_after", operator: "lt", value: 0 }],
	},
	{
		id: "block-budget-exhausted",
		name: "Block if budget exhausted",
		description: "Deny operation when remaining budget is zero or negative",
		priority: 2,
		enabled: true,
		effect: "deny",
		enforcement: "hard",
		severity: "high",
		conditions: [{ field: "budget_remaining", operator: "lte", value: 0 }],
	},
	{
		id: "warn-high-cost",
		name: "Warn on high-cost operations",
		description: "Emit a warning when estimated cost exceeds 1000 tokens",
		priority: 50,
		enabled: true,
		effect: "warn",
		enforcement: "soft",
		severity: "medium",
		conditions: [{ field: "estimated_cost", operator: "gt", value: 1000 }],
	},
];

/**
 * Merge platform default rules with user-supplied rules.
 *
 * Contract: **defaults are ALWAYS enforced.** This is a safe concat —
 * `[...defaults, ...userRules]` — so user policy can only ADD deny/warn rules on
 * top of the platform guarantees; it can never remove or disable a default.
 *
 * There is deliberately NO id-based override or `enabled: false` escape hatch
 * for defaults: a user rule that reuses a default's id is simply appended as an
 * additional rule and the original default remains active. Priority still
 * governs evaluation order inside {@link evaluatePolicy}.
 */
export function mergePolicies(defaults: GateRule[], userRules: GateRule[]): GateRule[] {
	return [...defaults, ...userRules];
}
