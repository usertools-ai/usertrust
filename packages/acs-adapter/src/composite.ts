import type { TrustReceipt } from "usertrust";
import { InsufficientBalanceError, PolicyDeniedError } from "usertrust";
import type { Authorization, Governor } from "usertrust/headless";
import { actionIdentity } from "./identity.js";
import type { AcsBudgetsEnvelope, AcsVerdict } from "./vocabulary.js";
import { ACS_BUDGET_REASONS, isAcsDecision, runtimeError } from "./vocabulary.js";

export interface AcsAction {
	kind: string;
	model: string;
	input?: unknown;
	estimatedInputTokens?: number | undefined;
	maxOutputTokens?: number | undefined;
	actor?: string | undefined;
}

export type PolicyDecider = (
	action: AcsAction,
	context: { inputIdentity: string; budgets: AcsBudgetsEnvelope },
) => AcsVerdict | Promise<AcsVerdict>;

export interface CompositeResult {
	verdict: AcsVerdict;
	enforced: boolean;
	authorization: Authorization | null;
	inputIdentity: string;
	budgets: AcsBudgetsEnvelope;
}

/**
 * Runtime validation of the policy's output: a policy that returns anything
 * other than an object with a known ACS decision fails CLOSED (deny).
 */
function asValidVerdict(raw: unknown): AcsVerdict | null {
	if (typeof raw !== "object" || raw === null) return null;
	return isAcsDecision((raw as { decision?: unknown }).decision) ? (raw as AcsVerdict) : null;
}

/**
 * The SpendGuard-slot composite contract: a stateless policy decides
 * allow/deny FIRST; on allow the usertrust ledger atomically reserves
 * (two-phase PENDING); denied actions never consume a reservation.
 * Composition shape adapted from the Microsoft Agent Governance Toolkit's
 * documented composite-evaluator integration point (MIT — see NOTICE).
 */
export class CompositeEvaluator {
	private readonly policy: PolicyDecider;
	private readonly governor: Governor;
	private readonly mode: "enforce" | "evaluate_only";
	private readonly clock: () => number;
	private readonly startedAt: number;
	/** Results already settled or aborted — a result is one-shot. */
	private readonly finished = new WeakSet<CompositeResult>();
	private toolCallCount = 0;
	private tokenCount = 0;
	private costTotal = 0;

	constructor(opts: {
		policy: PolicyDecider;
		governor: Governor;
		mode?: "enforce" | "evaluate_only";
		clock?: () => number;
	}) {
		this.policy = opts.policy;
		this.governor = opts.governor;
		this.mode = opts.mode ?? "enforce";
		this.clock = opts.clock ?? Date.now;
		this.startedAt = this.clock();
	}

	budgetsEnvelope(): AcsBudgetsEnvelope {
		return {
			tool_call_count: this.toolCallCount,
			token_count: this.tokenCount,
			elapsed_seconds: Math.floor((this.clock() - this.startedAt) / 1000),
			cost_usd: this.costTotal,
		};
	}

	async evaluate(action: AcsAction): Promise<CompositeResult> {
		const inputIdentity = actionIdentity({
			kind: action.kind,
			model: action.model,
			input: action.input ?? null,
		});
		const budgets = this.budgetsEnvelope();
		const raw: unknown = await this.policy(action, { inputIdentity, budgets });
		this.toolCallCount += 1;
		const verdict: AcsVerdict = asValidVerdict(raw) ?? {
			decision: "deny",
			reason: runtimeError("policy_output_invalid"),
		};
		if (verdict.decision !== "allow" && verdict.decision !== "warn") {
			return {
				verdict,
				enforced: this.mode === "enforce",
				authorization: null,
				inputIdentity,
				budgets: this.budgetsEnvelope(),
			};
		}
		if (this.mode === "evaluate_only") {
			return {
				verdict,
				enforced: false,
				authorization: null,
				inputIdentity,
				budgets: this.budgetsEnvelope(),
			};
		}
		try {
			const authorization = await this.governor.authorize({
				model: action.model,
				estimatedInputTokens: action.estimatedInputTokens,
				maxOutputTokens: action.maxOutputTokens,
				params: { acs_kind: action.kind, acs_input_identity: inputIdentity },
				actor: action.actor ?? "acs-adapter",
			});
			return {
				verdict,
				enforced: true,
				authorization,
				inputIdentity,
				budgets: this.budgetsEnvelope(),
			};
		} catch (err) {
			let reason: string;
			if (err instanceof InsufficientBalanceError) {
				reason = ACS_BUDGET_REASONS.cost;
			} else if (err instanceof PolicyDeniedError) {
				reason = `usertrust:policy_denied:${err.reason}`;
			} else {
				throw err;
			}
			return {
				verdict: { decision: "deny", reason },
				enforced: true,
				authorization: null,
				inputIdentity,
				budgets: this.budgetsEnvelope(),
			};
		}
	}

	async settle(
		result: CompositeResult,
		usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined },
	): Promise<TrustReceipt | null> {
		if (!result.authorization || this.finished.has(result)) return null;
		this.finished.add(result);
		try {
			const receipt = await this.governor.settle(result.authorization, usage);
			this.tokenCount += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
			this.costTotal += receipt.cost;
			return receipt;
		} catch (err) {
			// A failed settle stays retryable.
			this.finished.delete(result);
			throw err;
		}
	}

	async abort(result: CompositeResult, error?: unknown): Promise<void> {
		if (!result.authorization || this.finished.has(result)) return;
		this.finished.add(result);
		try {
			await this.governor.abort(result.authorization, error);
		} catch (err) {
			// A failed abort stays retryable.
			this.finished.delete(result);
			throw err;
		}
	}
}
