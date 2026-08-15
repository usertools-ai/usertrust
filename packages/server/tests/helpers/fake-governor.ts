import type {
	Authorization,
	AuthorizeParams,
	EnvelopeStatus,
	Governor,
	SettleParams,
	TrustReceipt,
} from "usertrust";
import { InsufficientBalanceError, PolicyDeniedError } from "usertrust";

export interface FakeGovernorHandle {
	governor: Governor;
	calls: {
		authorized: string[];
		settled: string[];
		aborted: string[];
		settleParams: Array<SettleParams | undefined>;
	};
}

export function createFakeGovernor(
	opts: { budget?: number; denyReason?: string } = {},
): FakeGovernorHandle {
	let budget = opts.budget ?? 10_000;
	let seq = 0;
	const pending = new Map<string, Authorization>();
	const calls = {
		authorized: [] as string[],
		settled: [] as string[],
		aborted: [] as string[],
		settleParams: [] as Array<SettleParams | undefined>,
	};

	const governor: Governor = {
		async authorize(params: AuthorizeParams): Promise<Authorization> {
			if (opts.denyReason) throw new PolicyDeniedError(opts.denyReason);
			const estimatedCost = (params.estimatedInputTokens ?? 100) + (params.maxOutputTokens ?? 4096);
			if (estimatedCost > budget) {
				throw new InsufficientBalanceError("fake", estimatedCost, budget);
			}
			seq += 1;
			const auth: Authorization = {
				transferId: `tx_fake_${seq}`,
				estimatedCost,
				model: params.model,
				createdAt: Date.now(),
			};
			budget -= estimatedCost;
			pending.set(auth.transferId, auth);
			calls.authorized.push(auth.transferId);
			return auth;
		},
		async settle(auth: Authorization, params?: SettleParams): Promise<TrustReceipt> {
			pending.delete(auth.transferId);
			const cost = (params?.inputTokens ?? 0) + (params?.outputTokens ?? 0) || auth.estimatedCost;
			budget += auth.estimatedCost - cost;
			calls.settled.push(auth.transferId);
			calls.settleParams.push(params);
			return {
				transferId: auth.transferId,
				cost,
				budgetRemaining: budget,
				auditHash: `hash_${auth.transferId}`,
				chainPath: "fake://chain",
				receiptUrl: null,
				settled: true,
				model: auth.model,
				provider: "fake",
				timestamp: new Date().toISOString(),
			};
		},
		async abort(auth: Authorization): Promise<void> {
			pending.delete(auth.transferId);
			budget += auth.estimatedCost;
			calls.aborted.push(auth.transferId);
		},
		async destroy(): Promise<void> {
			pending.clear();
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
		 * one. Faking scarcity numbers here would put invented percentages into a
		 * server test's assertions as though they came from TigerBeetle.
		 */
		async budgetContext(): Promise<EnvelopeStatus[]> {
			return [];
		},
		// biome-ignore lint/suspicious/noExplicitAny: minimal config for tests
		config: {} as any,
	};
	return { governor, calls };
}
