import type {
	AbortOutcome,
	Authorization,
	AuthorizeParams,
	EnvelopeStatus,
	Governor,
	ReleaseOutcome,
	SettleParams,
	TrustReceipt,
	UnheldSettlementOutcome,
	UnheldSettlementParams,
} from "usertrust";
import {
	InsufficientBalanceError,
	PolicyDeniedError,
	UnheldSettlementRateLimitedError,
} from "usertrust";

export interface FakeGovernorHandle {
	governor: Governor;
	calls: {
		authorized: string[];
		settled: string[];
		aborted: string[];
		released: string[];
		releaseReasons: Array<string | undefined>;
		settleParams: Array<SettleParams | undefined>;
		authorizeParams: AuthorizeParams[];
		unheld: UnheldSettlementParams[];
	};
}

export function createFakeGovernor(
	opts: {
		budget?: number;
		denyReason?: string;
		/** Stamped on every handle, as a ledger-backed governor does (`LEDGER_HOLD_TIMEOUT_MS`). */
		holdTimeoutMs?: number;
		/** Runs inside `authorize`, after the server's request has arrived: a clock step, say. */
		duringAuthorize?: () => void;
		/**
		 * How `release` answers. By default it ends the hold. `notHeld` answers as a governor
		 * that no longer holds it; `voidError` as one whose ledger void failed; `throws` as
		 * one that failed outright.
		 */
		release?: { notHeld?: boolean; voidError?: string; throws?: boolean };
		/** How `abort` answers, by the same three options as `release`. */
		abort?: { notHeld?: boolean; voidError?: string; throws?: boolean };
		/** How `recordUnheldSettlement` answers: as one that fails to append, or one that already recorded it. */
		/** A slow ledger void: `release` resolves this long after it starts, and the id reads `held` meanwhile. */
		releaseDelayMs?: number;
		/** Pad every minted transferId to this length (a custom factory issuing long ids). */
		idLength?: number;
		unheld?: {
			throws?: boolean;
			recorded?: boolean;
			held?: boolean;
			/** Answer `held` for this many calls, then unrecoverable: a hold mid-release. */
			heldFor?: number;
			rateLimited?: boolean;
		};
	} = {},
): FakeGovernorHandle {
	let budget = opts.budget ?? 10_000;
	let seq = 0;
	const pending = new Map<string, Authorization>();
	// ids whose release is in flight: the governor still HOLDS them until it lands.
	const releasing = new Set<string>();
	const calls = {
		authorized: [] as string[],
		settled: [] as string[],
		aborted: [] as string[],
		released: [] as string[],
		releaseReasons: [] as Array<string | undefined>,
		settleParams: [] as Array<SettleParams | undefined>,
		authorizeParams: [] as AuthorizeParams[],
		unheld: [] as UnheldSettlementParams[],
	};

	const governor: Governor = {
		async authorize(params: AuthorizeParams): Promise<Authorization> {
			calls.authorizeParams.push(params);
			opts.duringAuthorize?.();
			if (opts.denyReason) throw new PolicyDeniedError(opts.denyReason);
			const estimatedCost = (params.estimatedInputTokens ?? 100) + (params.maxOutputTokens ?? 4096);
			if (estimatedCost > budget) {
				throw new InsufficientBalanceError("fake", estimatedCost, budget);
			}
			seq += 1;
			const auth: Authorization = {
				transferId: `tx_fake_${seq}`.padEnd(opts.idLength ?? 0, "x"),
				estimatedCost,
				model: params.model,
				createdAt: Date.now(),
				...(opts.holdTimeoutMs !== undefined ? { holdTimeoutMs: opts.holdTimeoutMs } : {}),
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
		async abort(auth: Authorization): Promise<AbortOutcome> {
			if (opts.abort?.throws === true) throw new Error("fake abort failed");
			if (opts.abort?.notHeld === true) return { aborted: false };
			pending.delete(auth.transferId);
			budget += auth.estimatedCost;
			calls.aborted.push(auth.transferId);
			const voidError = opts.abort?.voidError;
			return voidError === undefined ? { aborted: true } : { aborted: true, voidError };
		},
		async release(auth: Authorization, reason?: string): Promise<ReleaseOutcome> {
			calls.releaseReasons.push(reason);
			if (opts.releaseDelayMs !== undefined) {
				releasing.add(auth.transferId);
				await new Promise((resolve) => setTimeout(resolve, opts.releaseDelayMs));
				releasing.delete(auth.transferId);
			}
			if (opts.release?.throws === true) throw new Error("fake release failed");
			if (opts.release?.notHeld === true) return { released: false };
			pending.delete(auth.transferId);
			budget += auth.estimatedCost;
			calls.released.push(auth.transferId);
			const voidError = opts.release?.voidError;
			return voidError === undefined ? { released: true } : { released: true, voidError };
		},
		async recordUnheldSettlement(params: UnheldSettlementParams): Promise<UnheldSettlementOutcome> {
			calls.unheld.push(params);
			if (opts.unheld?.throws === true) throw new Error("fake record failed");
			if (opts.unheld?.rateLimited === true) throw new UnheldSettlementRateLimitedError(30_000);
			// A real pool gives each tenant its own governor, so another tenant's hold is never "held"
			// here; a test that wants the answer asks for it.
			if (opts.unheld?.held === true || releasing.has(params.transferId)) {
				return { outcome: "held", transferId: params.transferId };
			}
			if (opts.unheld?.heldFor !== undefined && calls.unheld.length <= opts.unheld.heldFor) {
				return { outcome: "held", transferId: params.transferId };
			}
			return { outcome: "unrecoverable", recorded: opts.unheld?.recorded ?? true };
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
