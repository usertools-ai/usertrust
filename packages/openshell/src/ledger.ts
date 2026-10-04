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

import { TBTransferError, TrustTBClient, XFER_SPEND } from "usertrust";

export type TransferRole = "reserve" | "post" | "void" | "overage" | "late";

/** The ledger transfer id for one role of one hold. */
export function transferIdFor(holdKey: string, role: TransferRole): bigint {
	return TrustTBClient.deriveTransferId(holdKey, role);
}

/** A post: done, or the pending transfer the ledger itself expired (its timeout passed first). */
export type PostOutcome = "done" | "expired";

/**
 * A void of the hold's pending transfer:
 * - `done`: voided now, or already voided;
 * - `expired`: the ledger's own timeout released it first;
 * - `not_found`: no pending transfer under the reserve id — never placed, OR an abandoned
 *   placement that has not landed yet (the journal decides by its placement horizon);
 * - `posted`: the hold was already posted — nothing to void.
 */
export type VoidOutcome = "done" | "expired" | "not_found" | "posted";

export interface LedgerPort {
	/**
	 * Usertokens the budget can still reserve, EXCLUDING the pending transfer this hold may
	 * already have placed (an orphan of a lost journal COMMIT must not count against its own
	 * retry — the journal's `availableCredit` contract).
	 */
	available(budgetId: string, holdKey: string): Promise<number>;
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
	}): Promise<void>;
}

// CreateTransferStatus (tigerbeetle-node 0.17).
const PENDING_TRANSFER_NOT_FOUND = 25;
const PENDING_TRANSFER_ALREADY_POSTED = 33;
const PENDING_TRANSFER_ALREADY_VOIDED = 34;
const PENDING_TRANSFER_EXPIRED = 35;

export interface TigerBeetleLedgerOptions {
	/** The budget's spending wallet (a balance-constrained account). */
	walletFor: (budgetId: string) => bigint;
	/** Where holds and debt are credited. */
	treasuryId: bigint;
}

/** A budget's debt account label: deterministic, so every process finds the same account. */
export function debtAccountLabel(budgetId: string): string {
	return `openshell-debt.${budgetId}`;
}

export class TigerBeetleLedger implements LedgerPort {
	constructor(
		private readonly tb: TrustTBClient,
		private readonly opts: TigerBeetleLedgerOptions,
	) {}

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
			if (err instanceof TBTransferError && err.code === PENDING_TRANSFER_EXPIRED) return "expired";
			throw err;
		}
	}

	async release(p: { holdKey: string }): Promise<VoidOutcome> {
		try {
			await this.tb.voidTransfer(transferIdFor(p.holdKey, "reserve"), {
				transferId: transferIdFor(p.holdKey, "void"),
			});
			return "done";
		} catch (err) {
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

	async chargeDebt(p: {
		budgetId: string;
		holdKey: string;
		role: "overage" | "late";
		amount: number;
	}): Promise<void> {
		const debtAccount = await this.tb.ensureEscrowAccount(debtAccountLabel(p.budgetId));
		await this.tb.immediateTransfer({
			debitAccountId: debtAccount,
			creditAccountId: this.opts.treasuryId,
			amount: p.amount,
			code: XFER_SPEND,
			transferId: transferIdFor(p.holdKey, p.role),
		});
	}
}
