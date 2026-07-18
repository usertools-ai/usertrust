/**
 * ACS-compatible verdict vocabulary.
 *
 * The decision set, the reserved `runtime_error:*` reason namespace, and the
 * `envelope.budgets` counter names are adapted from the Microsoft Agent
 * Governance Toolkit's Agent Control Specification (MIT License) so that
 * usertrust can act as the stateful backend behind an ACS-style stateless
 * policy layer. See the repository NOTICE file for attribution.
 */

export const ACS_DECISIONS = ["allow", "warn", "deny", "escalate", "transform"] as const;
export type AcsDecision = (typeof ACS_DECISIONS)[number];

export interface AcsVerdict {
	decision: AcsDecision;
	reason?: string | undefined;
}

export function isAcsDecision(value: unknown): value is AcsDecision {
	return typeof value === "string" && (ACS_DECISIONS as readonly string[]).includes(value);
}

const RUNTIME_ERROR_CODE = /^[a-z][a-z0-9_]*$/;

/** Build a reason string in the reserved `runtime_error:*` namespace. */
export function runtimeError(code: string): string {
	if (!RUNTIME_ERROR_CODE.test(code)) {
		throw new TypeError(`invalid runtime_error code: ${JSON.stringify(code)}`);
	}
	return `runtime_error:${code}`;
}

/** Deny-reason names matching the ACS envelope.budgets counter vocabulary. */
export const ACS_BUDGET_REASONS = {
	toolCalls: "budget_tool_call_count_exceeded",
	tokens: "budget_token_count_exceeded",
	elapsed: "budget_elapsed_seconds_exceeded",
	cost: "budget_cost_usd_exceeded",
} as const;

/**
 * ACS envelope.budgets counters. Counter names follow the ACS schema.
 * Note: usertrust meters in usertokens; `cost_usd` carries the usertoken cost
 * unless the deployment configures a conversion.
 */
export interface AcsBudgetsEnvelope {
	tool_call_count: number;
	token_count: number;
	elapsed_seconds: number;
	cost_usd: number;
}
