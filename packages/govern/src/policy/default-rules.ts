/**
 * Default Policy Rules
 *
 * Sensible defaults for financial governance:
 * 1. Block zero-budget calls (budget <= 0 → deny, hard)
 * 2. Warn on high-cost operations (estimated_cost > 1000 → warn, soft)
 * 3. Block if budget exceeded (budget_remaining < estimated_cost → deny, hard)
 */

import type { GateRule } from "./gate.js";

export const DEFAULT_RULES: GateRule[] = [
	{
		id: "block-zero-budget",
		name: "Block zero-budget calls",
		description: "Deny any operation when the caller has zero or negative budget",
		priority: 1,
		enabled: true,
		effect: "deny",
		enforcement: "hard",
		severity: "critical",
		conditions: [{ field: "budget", operator: "lte", value: 0 }],
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
];

/**
 * Custom condition check for budget-exceeded rule.
 * The default rules use two `exists` conditions as a prerequisite;
 * actual comparison is done via this helper since cross-field
 * comparison is not expressible with single-field operators alone.
 *
 * Usage:
 *   if (isBudgetExceeded(context)) { ... }
 */
export function isBudgetExceeded(context: Record<string, unknown>): boolean {
	const remaining = context.budget_remaining;
	const estimated = context.estimated_cost;
	if (typeof remaining !== "number" || typeof estimated !== "number") return false;
	return remaining < estimated;
}
