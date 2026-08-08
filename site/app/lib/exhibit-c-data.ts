/**
 * Exhibit C's denial artifact — the REAL error usertrust throws when a hold
 * would overshoot the budget.
 *
 * Why a thrown error and not an audit event: a policy denial writes NOTHING to
 * the audit chain today. Verified empirically against this worktree — a
 * dry-run client with a 50,000-ut budget, one baseline call, then one
 * deliberately overshooting call: `PolicyDeniedError` is thrown and
 * `.usertrust/audit/events.jsonl` stays at exactly one entry. The deny gate
 * (packages/core/src/govern.ts) throws out of a `finally`-only try, never
 * entering the `catch` that emits `llm_call_failed`. So the honest artifact of
 * a denial is the throw itself: the request throws, the ledger never moves.
 * (Product gap filed separately, 2026-08-07 — not fixed here.)
 *
 * This module lives OUTSIDE app/components/sections/ on purpose: the
 * check-facts prebuild gate scans sections/*.tsx for digit literals, and the
 * captured message carries digits (`1000 tokens`) that are the SDK's words,
 * not marketing copy. Sections import the string from here; they never retype
 * it.
 *
 * Re-capture (do not hand-edit — reproduce and paste):
 *   const c = await trust(fakeAnthropic(), { budget: 50_000, vaultBase: tmp, dryRun: true });
 *   await c.messages.create({ model: "claude-sonnet-4-6", max_tokens: 4_000_000,
 *     messages: [{ role: "user", content: "runaway retry — this call must be denied" }] });
 *   // catch (err) → err.name, err.message
 */

export interface ThrownDenial {
	/** Error class name, exactly as the runtime reports it. */
	name: string;
	/** `Error.message`, verbatim — reason clause, hint, and docs line included. */
	message: string;
	/** How the throw was reproduced. */
	capturedFrom: string;
	/** The build it was reproduced against. */
	capturedWith: string;
}

export const THROWN_DENIAL: ThrownDenial = {
	name: "PolicyDeniedError",
	message:
		"Policy denied: [block-budget-overshoot] Deny pre-spend when estimated cost would drive remaining budget below zero; [WARN] [warn-high-cost] Emit a warning when estimated cost exceeds 1000 tokens\n\n  Hint: A budget rule denied this call: increase the budget in trust() options or reduce the call's max_tokens, and review your budget_remaining / budget_remaining_after tiers.\n  Docs: https://usertrust.ai/docs/errors/policy-denied",
	capturedFrom:
		"dry-run client, budget 50,000 ut (DEFAULT_BUDGET); one baseline call, then one call with max_tokens 4,000,000",
	capturedWith: "usertrust 3.1.0 @ 9de06a5",
};

/** Exactly what a terminal prints for the uncaught throw. */
export function denialThrowText(): string {
	return `${THROWN_DENIAL.name}: ${THROWN_DENIAL.message}`;
}

/**
 * Counterfactual-replay media. The paths live here for the same reason the
 * intro's sources live in sections/intro-video-sources.ts (Task 5b): a
 * container extension is a literal digit inside a scanned section file, and
 * the answer is to move the plumbing out of sections/ rather than to loosen
 * the gate.
 */
export const REPLAY_VIDEO = {
	src: "/demo/runaway-agent.mp4",
	poster: "/demo/runaway-agent-poster.jpg",
} as const;
