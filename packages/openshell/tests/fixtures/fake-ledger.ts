// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import {
	type ChargeOutcome,
	type LedgerPort,
	type PostOutcome,
	transferIdFor,
	type VoidOutcome,
} from "../../src/ledger.js";

/**
 * A ledger fake with TigerBeetle's one property the engine relies on: a transfer
 * id is applied AT MOST ONCE. `crashAfter` makes the next call of that op record
 * its transfer and then throw, the way a process dies after the ledger committed.
 */
export class FakeLedger implements LedgerPort {
	balances = new Map<string, number>();
	applied = new Map<string, number>(); // transfer id → amount (once)
	debt = new Map<string, number>();
	expired = new Set<string>(); // hold keys the ledger's own timeout has voided
	crashAfter: "post" | "chargeDebt" | null = null;
	/** Answer the next post / release with this outcome (a retired id's read-back). */
	postAnswer: PostOutcome | null = null;
	releaseAnswer: VoidOutcome | null = null;
	/** Holds whose release throws (a step that fails for ONE row). */
	releaseThrows = new Set<string>();
	/** ensureDebtAccount throws this (a debt account the ledger refuses), when set. */
	debtAccountRefusal: Error | null = null;
	ensuredDebt: string[] = [];
	/** Run while ensureDebtAccount / post is pending: a caller mutating its own object. */
	onEnsure: (() => void) | null = null;
	onPost: (() => void) | null = null;
	/** Runs inside available(): a slow balance lookup (advances the test clock). */
	onAvailable: (() => void) | null = null;
	/** While set, chargeDebt waits on it: the gap between the claim and the ledger charge. */
	chargeGate: Promise<void> | null = null;
	/** Answer every chargeDebt with this outcome (both ids retired, nothing charged). */
	chargeAnswer: ChargeOutcome | null = null;
	hang: "placeHold" | null = null;

	private once(id: bigint, amount: number): boolean {
		const k = id.toString();
		if (this.applied.has(k)) return false;
		this.applied.set(k, amount);
		return true;
	}
	private crash(op: "post" | "chargeDebt"): void {
		if (this.crashAfter === op) {
			this.crashAfter = null;
			throw new Error(`process died after ${op}`);
		}
	}
	private has(holdKey: string, role: Parameters<typeof transferIdFor>[1]): boolean {
		return this.applied.has(transferIdFor(holdKey, role).toString());
	}
	async ensureDebtAccount(budgetId: string): Promise<void> {
		this.onEnsure?.();
		await Promise.resolve();
		if (this.debtAccountRefusal !== null) throw this.debtAccountRefusal;
		this.ensuredDebt.push(budgetId);
	}
	/** Like the TigerBeetle port: the hold's OWN reserve amount is added back. */
	async available(budgetId: string, holdKey: string): Promise<number> {
		this.onAvailable?.();
		const own = this.applied.get(transferIdFor(holdKey, "reserve").toString()) ?? 0;
		return (this.balances.get(budgetId) ?? 0) + own;
	}
	async placeHold(p: { budgetId: string; holdKey: string; amount: number }): Promise<void> {
		if (this.hang === "placeHold") await new Promise(() => {});
		// Like the client's PendingReplayError: a pending replay is never a live hold.
		if (this.has(p.holdKey, "reserve")) throw new Error("pending replay: reserve under a new id");
		this.once(transferIdFor(p.holdKey, "reserve"), p.amount);
		this.balances.set(p.budgetId, (this.balances.get(p.budgetId) ?? 0) - p.amount);
	}
	async post(p: { holdKey: string; amount: number }): Promise<PostOutcome> {
		this.onPost?.();
		if (this.postAnswer !== null) return this.postAnswer;
		if (this.expired.has(p.holdKey)) return "expired";
		this.once(transferIdFor(p.holdKey, "post"), p.amount);
		this.crash("post");
		return "done";
	}
	async release(p: { holdKey: string }): Promise<VoidOutcome> {
		if (this.releaseThrows.has(p.holdKey)) throw new Error(`release ${p.holdKey} failed`);
		if (this.releaseAnswer !== null) return this.releaseAnswer;
		if (!this.has(p.holdKey, "reserve")) return "not_found";
		if (this.has(p.holdKey, "post")) return "posted";
		if (this.expired.has(p.holdKey)) return "expired";
		this.once(transferIdFor(p.holdKey, "void"), 0);
		return "done";
	}
	async chargeDebt(p: {
		budgetId: string;
		holdKey: string;
		role: "overage" | "late";
		amount: number;
	}): Promise<ChargeOutcome> {
		if (this.chargeGate !== null) await this.chargeGate;
		if (this.chargeAnswer !== null) return this.chargeAnswer;
		if (this.once(transferIdFor(p.holdKey, p.role), p.amount)) {
			this.debt.set(p.budgetId, (this.debt.get(p.budgetId) ?? 0) + p.amount);
		}
		this.crash("chargeDebt");
		return "done";
	}
	/** How many distinct transfers of a role were applied for a hold (0 or 1). */
	count(holdKey: string, role: Parameters<typeof transferIdFor>[1]): number {
		return this.applied.has(transferIdFor(holdKey, role).toString()) ? 1 : 0;
	}
}
