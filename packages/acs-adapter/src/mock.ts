import { createHash } from "node:crypto";
import type { TrustReceipt } from "usertrust";
import { InsufficientBalanceError } from "usertrust";
import type {
	Authorization,
	AuthorizeParams,
	EnvelopeStatus,
	Governor,
	SettleParams,
} from "usertrust/headless";
import type { PolicyDecider } from "./composite.js";
import { CompositeEvaluator } from "./composite.js";

/**
 * In-memory Governor for demos and tests: real two-phase semantics
 * (hold/settle/void against a budget) with no TigerBeetle and no disk.
 * Cost model: 1 token = 1 usertoken.
 */
export function createMockGovernor(opts: { budget?: number } = {}): { governor: Governor } {
	let budget = opts.budget ?? 10_000;
	let seq = 0;
	const holds = new Map<string, Authorization>();

	const governor: Governor = {
		async authorize(params: AuthorizeParams): Promise<Authorization> {
			const estimatedCost = (params.estimatedInputTokens ?? 100) + (params.maxOutputTokens ?? 4096);
			if (estimatedCost > budget) {
				throw new InsufficientBalanceError("mock", estimatedCost, budget);
			}
			seq += 1;
			const auth: Authorization = {
				transferId: `tx_mock_${seq}`,
				estimatedCost,
				model: params.model,
				createdAt: Date.now(),
			};
			budget -= estimatedCost;
			holds.set(auth.transferId, auth);
			return auth;
		},
		async settle(auth: Authorization, params?: SettleParams): Promise<TrustReceipt> {
			holds.delete(auth.transferId);
			const actual = (params?.inputTokens ?? 0) + (params?.outputTokens ?? 0);
			const cost = actual > 0 ? actual : auth.estimatedCost;
			budget += auth.estimatedCost - cost;
			return {
				transferId: auth.transferId,
				cost,
				budgetRemaining: budget,
				auditHash: createHash("sha256").update(auth.transferId).digest("hex"),
				chainPath: "mock://chain",
				receiptUrl: null,
				settled: true,
				model: auth.model,
				provider: "mock",
				timestamp: new Date().toISOString(),
			};
		},
		async abort(auth: Authorization): Promise<void> {
			if (holds.delete(auth.transferId)) {
				budget += auth.estimatedCost;
			}
		},
		async destroy(): Promise<void> {
			for (const auth of holds.values()) {
				budget += auth.estimatedCost;
			}
			holds.clear();
		},
		estimateCost(_model: string, inputTokens: number, outputTokens: number): number {
			return inputTokens + outputTokens;
		},
		estimateInputTokens(messages: unknown[]): number {
			return Math.ceil(JSON.stringify(messages).length / 4);
		},
		budgetRemaining(): number {
			return budget;
		},
		/**
		 * No ledger and no `parentUserId`, so there are no envelopes to report on —
		 * the same empty answer the real governor gives for a dry-run or identity-less
		 * one. Faking scarcity numbers here would put a demo's invented percentages in
		 * front of a model as though they came from TigerBeetle.
		 */
		async budgetContext(): Promise<EnvelopeStatus[]> {
			return [];
		},
		// biome-ignore lint/suspicious/noExplicitAny: mock config, never read by the adapter
		config: {} as any,
	};
	return { governor };
}

/** Deny actions whose kind is listed; allow everything else. */
export function mockPolicyDecider(denyKinds: string[]): PolicyDecider {
	return (action) =>
		denyKinds.includes(action.kind)
			? { decision: "deny", reason: `demo_policy:kind_${action.kind}_denied` }
			: { decision: "allow" };
}

export interface DemoStep {
	label: string;
	decision: string;
	reason?: string | undefined;
	budgetRemaining: number;
}

/**
 * Infrastructure-free demo of the composite contract: allow+settle, a policy
 * deny that provably consumes no reservation, then budget exhaustion.
 */
export async function runDemo(): Promise<DemoStep[]> {
	const { governor } = createMockGovernor({ budget: 60 });
	const evaluator = new CompositeEvaluator({
		policy: mockPolicyDecider(["exfiltrate"]),
		governor,
	});
	const transcript: DemoStep[] = [];

	const allowed = await evaluator.evaluate({
		kind: "tool_call",
		model: "mock-1",
		estimatedInputTokens: 20,
		maxOutputTokens: 20,
	});
	await evaluator.settle(allowed, { inputTokens: 20, outputTokens: 10 });
	transcript.push({
		label: "governed tool call settles at actual usage",
		decision: allowed.verdict.decision,
		budgetRemaining: governor.budgetRemaining(),
	});

	const denied = await evaluator.evaluate({
		kind: "exfiltrate",
		model: "mock-1",
		estimatedInputTokens: 5,
		maxOutputTokens: 5,
	});
	transcript.push({
		label: "policy deny consumes no reservation",
		decision: denied.verdict.decision,
		reason: denied.verdict.reason,
		budgetRemaining: governor.budgetRemaining(),
	});

	const broke = await evaluator.evaluate({
		kind: "tool_call",
		model: "mock-1",
		estimatedInputTokens: 500,
		maxOutputTokens: 500,
	});
	transcript.push({
		label: "reservation failure denies with ACS budget reason",
		decision: broke.verdict.decision,
		reason: broke.verdict.reason,
		budgetRemaining: governor.budgetRemaining(),
	});

	return transcript;
}
