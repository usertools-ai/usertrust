// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The ledger the hold engine drives, behind a narrow port so the engine is tested
 * against a fake and the TigerBeetle implementation against a real cluster.
 *
 * Every transfer id is DERIVED from the hold key and a role
 * (`TrustTBClient.deriveTransferId`), so a replay after a crash resubmits the SAME
 * id and TigerBeetle answers `exists` (verified by the client) instead of moving
 * money twice.
 */

import { TBTransferError, TransferIdRetiredError, TrustTBClient, XFER_SPEND } from "usertrust";

/**
 * `void-late` voids a placement that LANDED after the `void` id was retired by a not-found
 * attempt (#174 r1): it is tried only once the read-back shows the reserve transfer exists, so
 * its own first attempt cannot be a not-found.
 */
export type TransferRole =
	| "reserve"
	| "post"
	| "void"
	| "void-late"
	| "overage"
	| "overage-retry"
	| "late"
	| "late-retry";

/**
 * A debt charge:
 * - `done`: charged now, or already charged under the role's id or its `-retry` id;
 * - `failed`: BOTH ids are RETIRED and neither transfer exists. A retired id can never succeed
 *   and there is no third, so this is TERMINAL — an incident an operator must act on (the
 *   ledger refuses the charge persistently, e.g. a closed account), never "retry later".
 */
export type ChargeOutcome =
	| "done"
	| { failed: true; role: "overage" | "late"; transferIds: [string, string] };

/** The ledger transfer id for one role of one hold. */
export function transferIdFor(holdKey: string, role: TransferRole): bigint {
	return TrustTBClient.deriveTransferId(holdKey, role);
}

/**
 * A post of the hold's pending transfer:
 * - `done`: posted now, or already posted under the `post` id;
 * - `expired`: the ledger's own timeout released it first;
 * - `voided` / `not_found`: it was voided, or never placed — an incident, nothing to post;
 * - `unknown`: the `post` id is RETIRED (an earlier attempt failed) and the ledger's read-back
 *   cannot yet confirm the outcome — retry later; never a throw loop.
 */
export type PostOutcome = "done" | "expired" | "voided" | "not_found" | "unknown";

/**
 * A void of the hold's pending transfer:
 * - `done`: voided now, or already voided;
 * - `expired`: the ledger's own timeout released it first;
 * - `not_found`: no pending transfer under the reserve id — never placed, OR an abandoned
 *   placement that has not landed yet (the journal decides by its placement horizon);
 * - `posted`: the hold was already posted — nothing to void;
 * - `unknown`: the `void` id is RETIRED and the read-back cannot yet confirm — retry later.
 */
export type VoidOutcome = "done" | "expired" | "not_found" | "posted" | "unknown";

export interface LedgerPort {
	/**
	 * Usertokens the budget can still reserve, EXCLUDING the pending transfer this hold may
	 * already have placed (an orphan of a lost journal COMMIT must not count against its own
	 * retry — the journal's `availableCredit` contract).
	 */
	available(budgetId: string, holdKey: string): Promise<number>;
	/**
	 * Ensure the budget's DEBT account exists and is usable (idempotent). Called by reserve()
	 * BEFORE any placement, so an account a settlement could never charge refuses the
	 * reservation up front rather than failing after the post.
	 */
	ensureDebtAccount(budgetId: string): Promise<void>;
	/** Place the pending hold with the `reserve` id and a TigerBeetle timeout. */
	placeHold(p: {
		budgetId: string;
		holdKey: string;
		amount: number;
		timeoutSeconds: number;
	}): Promise<void>;
	/** Post the hold (capped by the caller at the hold amount) with the `post` id. */
	post(p: { holdKey: string; amount: number }): Promise<PostOutcome>;
	/** Void the hold with the `void` id. */
	release(p: { holdKey: string }): Promise<VoidOutcome>;
	/**
	 * Debit a budget's DEBT account (an account WITHOUT a balance constraint, so the
	 * debit cannot be refused) with the given role's id: overage or late settlement.
	 */
	chargeDebt(p: {
		budgetId: string;
		holdKey: string;
		role: "overage" | "late";
		amount: number;
	}): Promise<ChargeOutcome>;
	/**
	 * Is a late-settlement charge for the hold ON the ledger — its `late` or `late-retry`
	 * transfer? A read: it charges nothing. (The sweep's probe for incident rows, #188.)
	 */
	lateChargeLanded(holdKey: string): Promise<boolean>;
}

// CreateTransferStatus (tigerbeetle-node 0.17).
const PENDING_TRANSFER_NOT_FOUND = 25;
const PENDING_TRANSFER_ALREADY_POSTED = 33;
const PENDING_TRANSFER_ALREADY_VOIDED = 34;
const PENDING_TRANSFER_EXPIRED = 35;
const DEBIT_ACCOUNT_ALREADY_CLOSED = 65;
const ID_ALREADY_FAILED = 68;

export interface TigerBeetleLedgerOptions {
	/** The budget's spending wallet (a balance-constrained account). */
	walletFor: (budgetId: string) => bigint;
	/** Where holds and debt are credited. */
	treasuryId: bigint;
	/**
	 * How far past a pending transfer's own timeout (by its ledger timestamp) the read-back
	 * waits before calling it expired: room for the clock difference between this host and
	 * the cluster. Default 60 s.
	 */
	expirySkewMs?: number;
	now?: () => number;
}

/** A budget id the ledger cannot name a debt account for. */
export class BudgetIdError extends Error {
	constructor(budgetId: string, why: string) {
		super(`budget id ${JSON.stringify(budgetId)} cannot be used: ${why}`);
		this.name = "BudgetIdError";
	}
}

/**
 * A budget's debt account label: deterministic, so every process finds the same account.
 * Throws {@link BudgetIdError} for an id the escrow namespace refuses (core quarantines `::`,
 * `LEGACY_COST_CENTER_SEPARATOR`): such a budget's overage could never be charged, so it is
 * refused BEFORE a hold is placed, never discovered after a post.
 */
export function debtAccountLabel(budgetId: string): string {
	if (budgetId.includes("::")) {
		throw new BudgetIdError(budgetId, '"::" is reserved and cannot name a debt account');
	}
	return `openshell-debt.${budgetId}`;
}

/** What the ledger's own records say about a hold, read back by its derived ids. */
type Observed = "posted" | "voided" | "not_found" | "expired" | "unknown";

export class TigerBeetleLedger implements LedgerPort {
	private readonly now: () => number;
	private readonly expirySkewMs: number;

	constructor(
		private readonly tb: TrustTBClient,
		private readonly opts: TigerBeetleLedgerOptions,
	) {
		this.now = opts.now ?? Date.now;
		this.expirySkewMs = opts.expirySkewMs ?? 60_000;
	}

	/**
	 * A RETIRED id (TigerBeetle answers `id_already_failed` to every attempt after a failed
	 * first one) says nothing about the hold, so its state is read back: our `post` or `void`
	 * transfer exists → posted / voided; no reserve transfer → not found; the reserve's own
	 * timeout (from its ledger timestamp) passed by more than the skew → expired. Anything else
	 * is `unknown`: the caller retries later, and a not-yet-expired hold resolves at its timeout.
	 */
	private async observe(holdKey: string): Promise<Observed> {
		const [reserve, post, voided, voidedLate] = await Promise.all([
			this.tb.lookupTransfer(transferIdFor(holdKey, "reserve")),
			this.tb.lookupTransfer(transferIdFor(holdKey, "post")),
			this.tb.lookupTransfer(transferIdFor(holdKey, "void")),
			this.tb.lookupTransfer(transferIdFor(holdKey, "void-late")),
		]);
		if (post !== null) return "posted";
		if (voided !== null || voidedLate !== null) return "voided";
		if (reserve === null) return "not_found";
		if (reserve.timeout === 0) return "unknown"; // no ledger expiry at all
		const expiresAtNs = reserve.timestamp + BigInt(reserve.timeout) * 1_000_000_000n;
		const nowNs = BigInt(Math.floor(this.now())) * 1_000_000n;
		return nowNs > expiresAtNs + BigInt(this.expirySkewMs) * 1_000_000n ? "expired" : "unknown";
	}

	/**
	 * The wallet's available balance, plus this hold's own reserve amount when a transfer
	 * already exists under its reserve id. Adding it back can never over-admit: a transfer
	 * under that id makes the placement a REPLAY, which the client refuses
	 * (`PendingReplayError`) and the journal commits as `voiding` — so the hold is never
	 * admitted, and the orphan is voided promptly instead of sitting until its timeout.
	 */
	async available(budgetId: string, holdKey: string): Promise<number> {
		const [balance, own] = await Promise.all([
			this.tb.lookupBalance(this.opts.walletFor(budgetId)),
			this.tb.lookupTransfer(transferIdFor(holdKey, "reserve")),
		]);
		return balance.available + (own === null ? 0 : Number(own.amount));
	}

	/**
	 * An ordinary wallet that happens to sit at this label's account id (escrow labels and
	 * wallet names share core's id space) answers `exists_with_different_flags` here: refused
	 * at reservation, not after a post.
	 */
	async ensureDebtAccount(budgetId: string): Promise<void> {
		await this.tb.ensureEscrowAccount(debtAccountLabel(budgetId));
	}

	async placeHold(p: {
		budgetId: string;
		holdKey: string;
		amount: number;
		timeoutSeconds: number;
	}): Promise<void> {
		await this.tb.createPendingTransfer({
			debitAccountId: this.opts.walletFor(p.budgetId),
			creditAccountId: this.opts.treasuryId,
			amount: p.amount,
			code: XFER_SPEND,
			timeoutSeconds: p.timeoutSeconds,
			transferId: transferIdFor(p.holdKey, "reserve"),
		});
	}

	async post(p: { holdKey: string; amount: number }): Promise<PostOutcome> {
		try {
			await this.tb.postTransfer(transferIdFor(p.holdKey, "reserve"), p.amount, {
				transferId: transferIdFor(p.holdKey, "post"),
			});
			return "done";
		} catch (err) {
			if (err instanceof TransferIdRetiredError) {
				const seen = await this.observe(p.holdKey);
				return seen === "posted" ? "done" : seen;
			}
			if (err instanceof TBTransferError) {
				switch (err.code) {
					case PENDING_TRANSFER_EXPIRED:
						return "expired";
					case PENDING_TRANSFER_ALREADY_VOIDED:
						return "voided";
					case PENDING_TRANSFER_NOT_FOUND:
						return "not_found";
				}
			}
			throw err;
		}
	}

	async release(p: { holdKey: string }): Promise<VoidOutcome> {
		return this.voidWith(p.holdKey, "void");
	}

	private async voidWith(holdKey: string, role: "void" | "void-late"): Promise<VoidOutcome> {
		try {
			await this.tb.voidTransfer(transferIdFor(holdKey, "reserve"), {
				transferId: transferIdFor(holdKey, role),
			});
			return "done";
		} catch (err) {
			if (err instanceof TransferIdRetiredError) {
				const seen = await this.observe(holdKey);
				// The reserve exists and is unresolved, but the `void` id was retired by a
				// not-found attempt: the placement landed LATE. Void it now under `void-late`.
				if (seen === "unknown" && role === "void") return this.voidWith(holdKey, "void-late");
				return seen === "voided" ? "done" : seen;
			}
			if (err instanceof TBTransferError) {
				switch (err.code) {
					case PENDING_TRANSFER_ALREADY_VOIDED:
						return "done";
					case PENDING_TRANSFER_EXPIRED:
						return "expired";
					case PENDING_TRANSFER_NOT_FOUND:
						return "not_found";
					case PENDING_TRANSFER_ALREADY_POSTED:
						return "posted";
				}
			}
			throw err;
		}
	}

	async lateChargeLanded(holdKey: string): Promise<boolean> {
		const [late, retry] = await Promise.all([
			this.tb.lookupTransfer(transferIdFor(holdKey, "late")),
			this.tb.lookupTransfer(transferIdFor(holdKey, "late-retry")),
		]);
		return late !== null || retry !== null;
	}

	async chargeDebt(p: {
		budgetId: string;
		holdKey: string;
		role: "overage" | "late";
		amount: number;
	}): Promise<ChargeOutcome> {
		// The reservation ENSURED this account before placement (every account a settlement might
		// touch is ensured then), so the charge debits its derived id directly. A re-ensure here
		// would fail on a CLOSED account before the transfer could answer 65 (#190), leaving the
		// row in flight forever; the transfer's own answer drives the terminal path below.
		const debtAccount = TrustTBClient.deriveAccountId(debtAccountLabel(p.budgetId));
		const charge = (role: TransferRole) =>
			this.tb.immediateTransfer({
				debitAccountId: debtAccount,
				creditAccountId: this.opts.treasuryId,
				amount: p.amount,
				code: XFER_SPEND,
				transferId: transferIdFor(p.holdKey, role),
			});
		// The id can never land, MEASURED on 0.17.9: id_already_failed (68), and a debit from a
		// closed account (65), which fails AND retires the id (#189). Only measured codes: an
		// answer not proven to retire the id is rethrown and retried by the next attempt.
		const retired = (err: unknown) =>
			err instanceof TBTransferError &&
			(err.code === ID_ALREADY_FAILED || err.code === DEBIT_ACCOUNT_ALREADY_CLOSED);
		try {
			await charge(p.role);
			return "done";
		} catch (err) {
			if (!retired(err)) throw err;
		}
		// The role's id is RETIRED (measured on 0.17.9: e.g. debit_account_not_found retires an
		// immediate transfer's id, and every later attempt answers id_already_failed). A failed
		// transfer is never stored, so the read-back proves the debt was not charged under it —
		// and only then is it charged ONCE under the second deterministic id.
		const retryRole: TransferRole = p.role === "overage" ? "overage-retry" : "late-retry";
		if ((await this.tb.lookupTransfer(transferIdFor(p.holdKey, p.role))) !== null) return "done";
		try {
			await charge(retryRole);
			return "done";
		} catch (err) {
			if (!retired(err)) throw err;
			const landed = await this.tb.lookupTransfer(transferIdFor(p.holdKey, retryRole));
			if (landed !== null) return "done";
			return {
				failed: true,
				role: p.role,
				transferIds: [
					transferIdFor(p.holdKey, p.role).toString(),
					transferIdFor(p.holdKey, retryRole).toString(),
				],
			};
		}
	}
}
