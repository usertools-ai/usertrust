// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The hold engine: the journal (exactly one terminal per hold) driving the ledger
 * (exactly one transfer per role per hold, by derived ids).
 *
 * Settlement, in order — each step idempotent, so a crash anywhere is replayed by
 * running the same steps again:
 *   1. claim `open → settling`, WRITING the intent (post, overage) with the claim;
 *   2. post the hold (`post` id);
 *   3. charge any overage to the budget's debt account (`overage` id), OUTSIDE any
 *      journal transaction, then record it once (`applyDebt`) in a synchronous one —
 *      a crash between the two replays the charge (same id, verified) and records once;
 *   4. `settling → settled`.
 * The receipt event (step 5) and the late-settlement path are the next slice.
 */

import {
	type HoldJournal,
	type HoldState,
	PlacementHorizonError,
	type Reservation,
} from "./journal.js";
import { debtAccountLabel, type LedgerPort, transferIdFor } from "./ledger.js";

export interface EngineOptions {
	/** The hold's lifetime, in whole seconds: the TigerBeetle pending timeout. */
	holdTtlSeconds: number;
	now?: () => number;
}

/** A ledger call made OUTSIDE the journal's lock did not answer within the journal's deadline. */
export class LedgerTimeoutError extends Error {
	constructor(op: string, ms: number) {
		super(`ledger ${op} did not answer within ${ms} ms`);
		this.name = "LedgerTimeoutError";
	}
}

async function within<T>(op: string, ms: number, work: () => Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new LedgerTimeoutError(op, ms)), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export type ReserveOutcome =
	| { admitted: true; existing: boolean }
	| { admitted: false; reason: Extract<Reservation, { admitted: false }>["reason"] };

export interface SettlementIntent {
	/** What the hold posts: the actual cost, capped at the hold. */
	post: number;
	/** Cost above the hold, to the debt account. */
	overage: number;
}

export type SettleOutcome =
	/** Posted (and any overage charged); the hold is `settled`. */
	| { outcome: "settled"; resumed: boolean }
	/** A duplicate settlement of a hold already settled: no ledger operation. */
	| { outcome: "duplicate" }
	/**
	 * The hold expired first (the sweeper claimed it, or the ledger's own timeout
	 * passed): the actual usage must take the late-settlement path, never a post.
	 */
	| { outcome: "late_required"; state: HoldState }
	/**
	 * The ledger cannot yet confirm the post's outcome (its id is retired and the read-back is
	 * inconclusive): the hold stays `settling`; settle again later — never a throw loop.
	 */
	| { outcome: "in_flight" }
	/**
	 * A settlement against a voided or unknown hold, or one the ledger reports as voided or
	 * never placed: an incident, no ledger operation.
	 */
	| { outcome: "incident"; state: HoldState | "missing" };

export type ReleaseOutcome =
	/** Voided now or before, or the ledger's own timeout released it: nothing was charged. */
	| { outcome: "voided" }
	/**
	 * The ledger has no transfer under the reserve id, and the placement horizon has not
	 * passed: an abandoned placement may still land. The hold stays `voiding` (in flight);
	 * release it again later.
	 */
	| { outcome: "in_flight" }
	| { outcome: "not_open"; state: HoldState | "missing" }
	/** The ledger says the hold was POSTED: no void, and the row is left for an operator. */
	| { outcome: "incident"; state: "voiding" };

export class HoldEngine {
	private readonly now: () => number;

	constructor(
		private readonly journal: HoldJournal,
		private readonly ledger: LedgerPort,
		private readonly opts: EngineOptions,
	) {
		if (!Number.isSafeInteger(opts.holdTtlSeconds) || opts.holdTtlSeconds <= 0) {
			throw new TypeError("hold engine: holdTtlSeconds must be a positive whole number");
		}
		this.now = opts.now ?? Date.now;
	}

	/** The journal's deadline, applied to the ledger calls made outside its lock too. */
	private get ms(): number {
		return this.journal.ledgerTimeoutMs;
	}

	/**
	 * Reserve atomically with the budget's debt. A budget id the ledger cannot name a debt
	 * account for is refused FIRST ({@link BudgetIdError}): its overage could never be charged. The journal bounds both in-lock ledger
	 * calls by its own deadline and commits an ambiguous placement as `voiding`. Throws on
	 * a busy journal or a ledger failure: the request path fails closed on any throw.
	 */
	async reserve(p: { holdKey: string; budgetId: string; amount: number }): Promise<ReserveOutcome> {
		debtAccountLabel(p.budgetId); // throws before anything is placed
		// The ledger's timeout starts when the placement COMMITS — somewhere in
		// [now, now + the journal's placement deadline]. So the hold can be released by the
		// ledger as EARLY as admitBy (now + lifetime): admission is judged against it. ttlAt is
		// the LATEST (for a placement that lands in time): the sweeper's deadline and the
		// placement horizon's base (a later landing is what the placement grace covers).
		const admitBy = this.now() + this.opts.holdTtlSeconds * 1000;
		const r = await this.journal.reserve({
			holdId: p.holdKey,
			budgetId: p.budgetId,
			amount: p.amount,
			admitBy,
			ttlAt: admitBy + this.ms,
			availableCredit: (holdId) => this.ledger.available(p.budgetId, holdId),
			placeHold: () =>
				this.ledger.placeHold({
					budgetId: p.budgetId,
					holdKey: p.holdKey,
					amount: p.amount,
					timeoutSeconds: this.opts.holdTtlSeconds,
				}),
		});
		return r.admitted
			? { admitted: true, existing: r.existing }
			: { admitted: false, reason: r.reason };
	}

	/** Settle a hold to the given intent; the loser of the claim acts BY STATE. */
	async settle(holdKey: string, intent: SettlementIntent): Promise<SettleOutcome> {
		const claim = await this.journal.claimSettlement(holdKey, intent);
		if (claim.won) return this.completeSettlement(holdKey, intent, false);
		switch (claim.state) {
			case "settling":
				// A duplicate of a settlement that never completed (its winner may be gone):
				// resume from the STORED intent; the derived ids make every step idempotent.
				return this.completeSettlement(holdKey, claim.intent as SettlementIntent, true);
			case "settled":
				return { outcome: "duplicate" };
			case "expiring":
			case "expired":
				return { outcome: "late_required", state: claim.state };
			default:
				// open (cannot lose a claim from open), voiding, voided, or missing.
				return { outcome: "incident", state: claim.state };
		}
	}

	/** Steps 2–4, from a claimed `settling` row. */
	private async completeSettlement(
		holdKey: string,
		intent: SettlementIntent,
		resumed: boolean,
	): Promise<SettleOutcome> {
		const row = this.journal.get(holdKey);
		if (row === undefined) return { outcome: "incident", state: "missing" };
		if (row.state === "settled") return { outcome: "duplicate" };
		const posted = await within("post", this.ms, () =>
			this.ledger.post({ holdKey, amount: intent.post }),
		);
		if (posted === "expired") {
			// A CONFIRMED expiry from the ledger: the hold's one terminal is `expired`, and
			// the actual usage goes through the late-settlement path.
			await this.journal.writeTx(() =>
				this.journal.cas(holdKey, "settling", "expired", {
					terminalKind: "hold_expired_unsettled",
				}),
			);
			return { outcome: "late_required", state: "expired" };
		}
		if (posted === "unknown") return { outcome: "in_flight" };
		if (posted === "voided" || posted === "not_found") {
			return { outcome: "incident", state: "settling" };
		}
		if (intent.overage > 0) {
			// The charge runs OUTSIDE any journal transaction (writeTx takes a synchronous
			// body); its derived id makes a replay after a crash a verified no-op.
			await within("chargeDebt", this.ms, () =>
				this.ledger.chargeDebt({
					budgetId: row.budgetId,
					holdKey,
					role: "overage",
					amount: intent.overage,
				}),
			);
			await this.journal.writeTx(() =>
				this.journal.applyDebt(
					row.budgetId,
					transferIdFor(holdKey, "overage").toString(),
					intent.overage,
				),
			);
		}
		await this.journal.writeTx(() =>
			this.journal.cas(holdKey, "settling", "settled", { terminalKind: "settled" }),
		);
		return { outcome: "settled", resumed };
	}

	/**
	 * Release a hold (a non-2xx response, or an ambiguous placement the journal committed as
	 * `voiding`): claim `open → voiding`, void, then finalize by what the ledger answered.
	 */
	async release(holdKey: string): Promise<ReleaseOutcome> {
		const won = await this.journal.writeTx(() => this.journal.cas(holdKey, "open", "voiding"));
		if (!won) {
			const state = this.journal.get(holdKey)?.state ?? "missing";
			if (state !== "voiding") return { outcome: "not_open", state };
			// A release that never completed, or an ambiguous placement: resume it.
		}
		const voided = await within("release", this.ms, () => this.ledger.release({ holdKey }));
		if (voided === "posted") return { outcome: "incident", state: "voiding" };
		// A retired void id the read-back cannot yet confirm: stays `voiding`, released again.
		if (voided === "unknown") return { outcome: "in_flight" };
		if (voided === "not_found") {
			// Never placed — or an abandoned placement not landed YET. The journal finalizes
			// `voided_not_found` only past ttlAt + its placement grace (the horizon rule).
			try {
				await this.journal.writeTx(() =>
					this.journal.cas(holdKey, "voiding", "voided", { terminalKind: "voided_not_found" }),
				);
			} catch (err) {
				if (err instanceof PlacementHorizonError) return { outcome: "in_flight" };
				throw err;
			}
			return { outcome: "voided" };
		}
		// Voided now or before, or expired by the ledger: nothing was charged either way.
		await this.journal.writeTx(() =>
			this.journal.cas(holdKey, "voiding", "voided", {
				terminalKind: voided === "expired" ? "voided_expired" : "voided",
			}),
		);
		return { outcome: "voided" };
	}
}
