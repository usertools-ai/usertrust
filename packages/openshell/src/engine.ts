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
 *   (the overage's DEBT is recorded once with the claim, so the next reservation sees
 *   it at once; a confirmed expiry reverses it with the `expired` transition);
 *   3. charge any overage to the budget's debt account (`overage` id), OUTSIDE any
 *      journal transaction — a crash replays it (same id, verified);
 *   4. `settling → settled`.
 * The receipt event (step 5) and the late-settlement path are the next slice.
 *
 * STRUCTURAL RULE: every ledger account a settlement might touch is ensured BEFORE the hold is
 * placed. A settlement runs after the post, when nothing can be refused any more: an account
 * that cannot be named (`::`) or created (a colliding ordinary wallet) must refuse the
 * reservation, never strand a posted hold in `settling` with its overage uncharged.
 */

import { AuditChainUnverifiableError, type AuditPort, type HoldEventKind } from "./audit.js";
import {
	type AuditReset,
	type EventSlot,
	type HoldJournal,
	type HoldRow,
	type HoldState,
	PlacementHorizonError,
	type Reservation,
} from "./journal.js";
import { debtAccountLabel, type LedgerPort, transferIdFor } from "./ledger.js";

export interface EngineOptions {
	/** The hold's lifetime, in whole seconds: the TigerBeetle pending timeout. */
	holdTtlSeconds: number;
	/**
	 * How far past a hold's `ttlAt` (the LATEST the ledger can release it) the sweeper waits
	 * before expiring an `open` hold. Default 60 s.
	 */
	expiryGraceMs?: number;
	/**
	 * The audit chain (slice 1c-2). With it, every hold records — once each — a `reserved`
	 * event, its terminal event and any late-settlement correction. Without it, nothing is
	 * appended (the engine as 1c-1 left it).
	 */
	audit?: AuditPort;
	/**
	 * How often the sweep re-verifies the WHOLE audit chain up to the journal's checkpoint (ms;
	 * default one hour, and always at the first sweep). A record verifies only the bytes after
	 * the checkpoint, so this bounds how long a rewrite of OLDER bytes goes unseen.
	 */
	auditFullVerifyMs?: number;
	now?: () => number;
}

/** What one {@link HoldEngine.sweep} did. A row whose step threw is reported, never fatal. */
export interface SweepReport {
	/** Holds the sweeper moved `open → expiring → expired`. */
	expired: string[];
	/** Holds the sweeper claimed whose void the ledger answered posted or not found: incidents. */
	incidents: string[];
	/** Holds the sweeper claimed whose void it cannot confirm yet: left `expiring`, in flight. */
	inFlight: string[];
	/** In-flight rows replayed (`settling`, `voiding`, `expiring`), with what each returned. */
	replayed: Array<{ holdId: string; outcome: string }>;
	/** Recorded late settlements the ledger took this sweep. */
	lateCharged: string[];
	/** Rows whose step threw, with the error: the next sweep tries them again. */
	errors: Array<{ holdId: string; error: unknown }>;
	/** Audit events the sweep recorded (each missing one, once). */
	events: Array<{ holdId: string; slot: EventSlot }>;
	/**
	 * The full chain verification this sweep: `ok`; `broken` (a definite finding — or the chain
	 * was already broken: the checkpoint is kept, records refuse, the detector raises it, and only
	 * an operator reset resumes); `error` (not a finding — an I/O error, or the unverified tail:
	 * retried next sweep, nothing changed); `not_due`; or `no_audit`.
	 */
	auditVerify: "ok" | "broken" | "error" | "not_due" | "no_audit";
}

/**
 * The placement did not START within the reservation's one shared placement window (the lock
 * wait and the balance lookup took it): nothing was placed. The journal commits the row
 * `voiding`; it is finalized by the release path.
 */
export class PlacementWindowError extends Error {
	constructor(lateByMs: number) {
		super(`hold engine: the placement window closed ${lateByMs} ms before the hold was placed`);
		this.name = "PlacementWindowError";
	}
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
	 * The hold expired first (the sweeper claimed it, or the ledger confirmed its own timeout
	 * passed): never a post — the full ACTUAL amount was recorded as the hold's late settlement
	 * (its debt counted with it) and charged to the debt account (an actual amount of zero records
	 * and charges nothing). `resumed`: the late settlement was already recorded.
	 */
	| { outcome: "late_settled"; state: "expiring" | "expired"; resumed: boolean }
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

/**
 * A debt charge the ledger refuses for good: both the role's id and its `-retry` id are
 * retired and neither landed. The row carries the incident; an operator must act on it.
 */
export class DebtChargeFailedError extends Error {
	constructor(
		public readonly holdKey: string,
		public readonly role: "overage" | "late",
		public readonly transferIds: readonly [string, string],
	) {
		super(
			`hold engine: the ${role} debt for hold ${holdKey} can never be charged — transfer ids ${transferIds[0]} and ${transferIds[1]} are both retired and neither landed; the row carries a debt_charge_failed incident`,
		);
		this.name = "DebtChargeFailedError";
	}
}

/**
 * A settlement intent that breaks its contract: `post` and `overage` safe non-negative
 * integers, `post` at most the hold, and an overage only with the hold posted in full (an
 * overage means the actual exceeded the hold). Refused at the claim: nothing is posted.
 */
export class InvalidSettlementIntentError extends Error {
	constructor(why: string) {
		super(`hold engine: invalid settlement intent — ${why}`);
		this.name = "InvalidSettlementIntentError";
	}
}

const isUsertokens = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;

/** What is wrong with an intent's NUMBERS alone (no hold needed), or null. */
function numbersProblem(i: unknown): string | null {
	if (typeof i !== "object" || i === null) return `the intent is not an object (${String(i)})`;
	const { post, overage } = i as Record<string, unknown>;
	if (!isUsertokens(post) || !isUsertokens(overage)) {
		return `post and overage must be safe non-negative integers, got ${String(post)} / ${String(overage)}`;
	}
	// The actual cost (post + overage) is charged as one amount: it must be one too.
	if (!Number.isSafeInteger((post as number) + (overage as number))) {
		return `post + overage must be a safe integer, got ${String(post)} + ${String(overage)}`;
	}
	return null;
}

/**
 * THE settlement-intent contract, judged against the hold it settles: safe non-negative
 * integers; `post` at most the hold; an overage only with the hold posted in full (an overage
 * means the actual exceeded the hold). One predicate, applied at the claim (a fresh intent is
 * refused and the row stays open) and at the start of EVERY completion — fresh or resumed — so
 * no stored intent, from any engine version, is posted or charged unless it passes.
 */
function intentProblem(i: unknown, hold: number): string | null {
	const numbers = numbersProblem(i);
	if (numbers !== null) return numbers;
	const { post, overage } = i as SettlementIntent;
	if (post > hold) return `post ${post} exceeds the hold ${hold}`;
	if (overage > 0 && post !== hold) {
		return `an overage of ${overage} with post ${post}: the hold (${hold}) is posted in full first`;
	}
	return null;
}

/** A frozen copy of the two numbers a settlement acts on. */
function snapshotIntent(i: SettlementIntent): Readonly<SettlementIntent> {
	return Object.freeze({ post: i.post, overage: i.overage });
}

/** The chain kind of a hold's event in `slot`, by the row's state. */
function eventKind(slot: EventSlot, row: HoldRow): HoldEventKind {
	if (slot === "reserved") return "openshell.hold.reserved";
	if (slot === "late") return "openshell.hold.late_settlement";
	return row.state === "settled"
		? "openshell.hold.settled"
		: row.state === "voided"
			? "openshell.hold.voided"
			: "openshell.hold.expired_unsettled";
}

/** What a hold's event in `slot` says. */
function eventData(slot: EventSlot, row: HoldRow): Record<string, unknown> & { holdId: string } {
	const base = {
		holdId: row.holdId,
		budgetId: row.budgetId,
		amount: row.amount,
		reservedSeq: row.reservedSeq,
	};
	if (slot === "reserved") return { ...base, ttlAt: row.ttlAt, admitBy: row.admitBy };
	if (slot === "late") return { ...base, lateState: row.lateState, lateAmount: row.lateAmount };
	return { ...base, state: row.state, terminalKind: row.terminalKind };
}

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
		if (
			opts.expiryGraceMs !== undefined &&
			(!Number.isSafeInteger(opts.expiryGraceMs) || opts.expiryGraceMs < 0)
		) {
			throw new TypeError("hold engine: expiryGraceMs must be a non-negative whole number");
		}
		if (
			opts.auditFullVerifyMs !== undefined &&
			(!Number.isSafeInteger(opts.auditFullVerifyMs) || opts.auditFullVerifyMs <= 0)
		) {
			throw new TypeError("hold engine: auditFullVerifyMs must be a positive whole number");
		}
		this.now = opts.now ?? Date.now;
		this.expiryGraceMs = opts.expiryGraceMs ?? 60_000;
		this.fullVerifyMs = opts.auditFullVerifyMs ?? 3_600_000;
	}

	private readonly expiryGraceMs: number;
	private readonly fullVerifyMs: number;
	/** This instance's last successful full verification (ms) — in memory ONLY, by design. */
	private fullVerifiedAt: number | null = null;

	/** The applied-marker id of a hold's late-settlement debt. */
	private lateId(holdKey: string): string {
		return transferIdFor(holdKey, "late").toString();
	}

	/**
	 * A settlement that LOST to an expiry (the row is `expiring` or `expired`). Never a post: the
	 * full actual amount is recorded once as the hold's late settlement, its debt counted in the
	 * same transaction, then charged to the debt account. A duplicate acts on the STORED amount.
	 * The intent passes the same contract as any settlement first.
	 */
	private async settleLate(
		holdKey: string,
		intent: Readonly<SettlementIntent>,
		state: "expiring" | "expired",
	): Promise<SettleOutcome> {
		const row = this.journal.get(holdKey);
		if (row === undefined) return { outcome: "incident", state: "missing" };
		const problem = intentProblem(intent, row.amount);
		if (problem !== null) throw new InvalidSettlementIntentError(problem);
		const actual = intent.post + intent.overage;
		// Recorded FIRST, zero included (a terminal `zero`, no transfer): whichever disposition is
		// recorded first is final, so a later, conflicting settlement can never charge it.
		const recorded = await this.journal.writeTx(() => {
			if (!this.journal.recordLate(holdKey, actual)) return false;
			if (actual > 0) this.journal.applyDebt(row.budgetId, this.lateId(holdKey), actual);
			return true;
		});
		// The ledger charge runs outside any transaction (a no-op unless the row is `recorded` and
		// carries no incident). Its result is NOT assumed: the answer comes next.
		await this.chargeLate(holdKey);
		return this.afterLate(
			holdKey,
			await this.lateAnswer(holdKey, intent, actual, state, !recorded),
		);
	}

	/**
	 * THE answer to a late settlement, from ONE transaction's view of the row, read AFTER the
	 * charge attempt. THE RULE (for every outcome in this engine): an INCIDENT OUTRANKS EVERY
	 * SUCCESS — it is checked first.
	 * - an incident on the row → `incident`, with the late settlement attached in the same
	 *   transaction (`unbilled`: the intent, the actual amount, whether a late amount was
	 *   recorded, and whether the ledger took the charge), for an operator;
	 * - else `charged` or `zero` → `late_settled` (billed, or nothing to bill);
	 * - else (recorded, the charge did not complete) → `in_flight`, for the sweep.
	 */
	private lateAnswer(
		holdKey: string,
		intent: Readonly<SettlementIntent>,
		actual: number,
		state: "expiring" | "expired",
		resumed: boolean,
	): Promise<SettleOutcome> {
		return this.journal.writeTx((): SettleOutcome => {
			const now = this.journal.get(holdKey);
			if (now === undefined) return { outcome: "incident", state: "missing" };
			if (now.incident !== null) {
				const onLedger =
					typeof now.incident === "object" &&
					(now.incident as Record<string, unknown>).late_charged_on_ledger !== undefined;
				this.journal.recordUnbilled(holdKey, {
					kind: "late_settlement",
					intent,
					actual,
					lateRecorded: now.lateState !== "none",
					lateCharged: now.lateState === "charged" || onLedger,
				});
				return { outcome: "incident", state: now.state };
			}
			if (now.lateState === "charged" || now.lateState === "zero") {
				return { outcome: "late_settled", state, resumed };
			}
			return { outcome: "in_flight" };
		});
	}

	/**
	 * Record one of a hold's audit events ONCE (the journal's critical section): the chain is
	 * scanned for it — a VERIFYING chain only — and it is appended only if absent. No audit
	 * port: nothing to record.
	 */
	private async recordEvent(
		holdKey: string,
		slot: EventSlot,
	): Promise<"recorded" | "already" | "not_eligible" | "no_audit"> {
		const audit = this.opts.audit;
		if (audit === undefined) return "no_audit";
		return this.journal.recordEventOnce(holdKey, slot, (row, from) =>
			audit.record(
				eventKind(slot, row),
				slot === "reserved" ? 0 : (row.reservedSeq ?? 0),
				eventData(slot, row),
				from,
			),
		);
	}

	/**
	 * A terminal or late-settlement event right after its transition — BEST-EFFORT here, because
	 * the hold's outcome has already happened: a failure is left for the sweep, which records
	 * every missing event, and the detector raises one that stays missing past its deadline.
	 */
	private async recordEventSoon(holdKey: string, slot: EventSlot): Promise<void> {
		try {
			await this.recordEvent(holdKey, slot);
		} catch {
			// recovered by the sweep; detected by HoldDetector if it stays missing
		}
	}

	/** A late answer, with its correction event recorded once the late settlement is final. */
	private async afterLate(holdKey: string, out: SettleOutcome): Promise<SettleOutcome> {
		if (out.outcome === "late_settled") await this.recordEventSoon(holdKey, "late");
		return out;
	}

	/**
	 * A terminal transition decided by ONE transaction's view of the final row, the incident
	 * FIRST: `moved` when the row moved `from → to`; `incident` when the row carries one (the
	 * journal's CAS never moves an incident row); otherwise the state another writer left it in.
	 */
	private finalTransition(
		holdKey: string,
		from: HoldState,
		to: HoldState,
		set: { terminalKind: string },
	): Promise<"moved" | "incident" | HoldState | "missing"> {
		return this.journal.writeTx(() => {
			const row = this.journal.get(holdKey);
			if (row === undefined) return "missing";
			if (row.incident !== null) return "incident";
			return this.journal.cas(holdKey, from, to, set) ? "moved" : row.state;
		});
	}

	/**
	 * Charge a RECORDED late settlement to the debt account (`late`, or `late-retry` if that id
	 * was retired), then mark it charged. Acts only on the stored amount; nothing recorded, or
	 * already charged, is a no-op. Both ids retired and nothing landed: a terminal incident.
	 */
	private async chargeLate(holdKey: string): Promise<void> {
		const row = this.journal.get(holdKey);
		// Only a `recorded` late settlement is charged: `none`, `charged` and the terminal `zero`
		// have nothing to send.
		if (row === undefined || row.lateState !== "recorded" || row.lateAmount === null) return;
		if (row.incident !== null) return;
		const amount = row.lateAmount;
		const charged = await within("chargeDebt", this.ms, () =>
			this.ledger.chargeDebt({ budgetId: row.budgetId, holdKey, role: "late", amount }),
		);
		if (charged !== "done") {
			const incident = { kind: "debt_charge_failed", ...charged, amount };
			await this.journal.writeTx(() => this.journal.recordIncident(holdKey, incident));
			throw new DebtChargeFailedError(holdKey, charged.role, charged.transferIds);
		}
		// The ledger TOOK the charge. Marked `charged` — unless the row became an incident
		// meanwhile (markLateCharged never moves an incident row): then the fact is written onto
		// the incident, never lost.
		await this.journal.writeTx(() => {
			if (!this.journal.markLateCharged(holdKey)) {
				if (this.journal.get(holdKey)?.incident !== null) {
					this.journal.recordLedgerChargedOnIncident(holdKey, amount);
				}
			}
		});
	}

	/** The applied-marker id of a hold's overage debt: the ledger transfer it records. */
	private overageId(holdKey: string): string {
		return transferIdFor(holdKey, "overage").toString();
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
		// Snapshotted BEFORE any await: a caller that mutates `p` while the ensure or the
		// journal is pending must not ensure one budget and place another (#174 r3).
		const { holdKey, budgetId, amount } = p;
		// The structural rule: every account a settlement might touch, before any placement.
		debtAccountLabel(budgetId); // a name the ledger cannot give a debt account: throws
		await within("ensureDebtAccount", this.ms, () => this.ledger.ensureDebtAccount(budgetId));
		// ONE shared placement deadline, from ONE clock read: the placement must START by
		// placeBy (the lock wait and the balance lookup included), and it then commits within
		// one more deadline. The ledger's timeout starts at that commit, so the hold can be
		// released by the ledger no EARLIER than admitBy (admission is judged against it) and
		// no LATER than ttlAt (the sweeper's deadline and the placement horizon's base).
		const start = this.now();
		const lifetime = this.opts.holdTtlSeconds * 1000;
		const placeBy = start + this.ms;
		const r = await this.journal.reserve({
			holdId: holdKey,
			budgetId,
			amount,
			admitBy: start + lifetime,
			ttlAt: placeBy + this.ms + lifetime,
			availableCredit: (holdId) => this.ledger.available(budgetId, holdId),
			placeHold: () => {
				const late = this.now() - placeBy;
				if (late > 0) throw new PlacementWindowError(late);
				return this.ledger.placeHold({
					budgetId,
					holdKey,
					amount,
					timeoutSeconds: this.opts.holdTtlSeconds,
				});
			},
		});
		if (!r.admitted) return { admitted: false, reason: r.reason };
		// The `reserved` event is the durable admission registry: an admission completes only once
		// it is recorded, and an authorized call is never absent from the chain.
		try {
			await this.recordEvent(holdKey, "reserved");
		} catch (err) {
			// Release ONLY an admission nobody completed: once any caller (a same-key retry) has
			// recorded the event, the hold is that caller's admitted hold and this claim loses.
			await this.releaseUnrecorded(holdKey).catch(() => undefined);
			throw err;
		}
		// The admission is decided AGAIN, from a read taken after the await (#191 r1): the row
		// must still be `open`, with no incident, before `admitBy`, and — with an audit port —
		// carry its recorded `reserved` event. Anything else is not an admission.
		const row = this.journal.get(holdKey);
		const recorded = this.opts.audit === undefined || row?.reservedSeq != null;
		if (row?.state === "open" && row.incident === null && recorded) {
			if (this.now() < row.admitBy) return { admitted: true, existing: r.existing };
			// Past admitBy: no caller can be admitted on this hold any more — release it.
			await this.release(holdKey).catch(() => undefined);
			return { admitted: false, reason: "hold_expired" };
		}
		return { admitted: false, reason: row?.state === "open" ? "hold_expired" : "not_open" };
	}

	/**
	 * The OPERATOR RESET — the only way out of `broken` (see {@link AuditState}). The chain is
	 * re-verified from genesis to its end (refused if it does not verify: repair it first, e.g.
	 * `usertrust audit quarantine-tail`); a chained `openshell.audit.reset` event records the
	 * checkpoint the chain no longer agreed with AND the head now verified; then, in one journal
	 * transaction, every hold event of the chain is absorbed, the checkpoint set past the reset
	 * event, the finding cleared, and the reset journaled.
	 */
	async resetAuditChain(by: { operator: string; reason: string }): Promise<AuditReset> {
		const audit = this.opts.audit;
		if (audit === undefined) throw new Error("hold engine: no audit port to reset");
		const st = this.journal.auditState();
		if (st.state !== "broken") {
			throw new Error(`hold engine: the audit chain is ${st.state}, not broken — nothing to reset`);
		}
		const full = await audit.verifyFull(null);
		const rec = await audit.record(
			"openshell.audit.reset",
			full.checkpoint.sequence,
			{
				holdId: "(audit chain)",
				operator: by.operator,
				reason: by.reason,
				previous: st.checkpoint,
				finding: st.reason,
				verifiedHead: { sequence: full.checkpoint.sequence, hash: full.checkpoint.hash },
			},
			full.checkpoint,
		);
		const reset: AuditReset = {
			at: this.now(),
			operator: by.operator,
			reason: by.reason,
			previous: st.checkpoint,
			verifiedHead: full.checkpoint,
			resetEvent: rec.event,
		};
		await this.journal.writeTx(() =>
			this.journal.applyAuditReset(reset, [...full.tail, ...rec.tail], rec.checkpoint),
		);
		this.fullVerifiedAt = this.now();
		return reset;
	}

	/**
	 * Release a hold whose admission never completed (its `reserved` event unrecorded): claimed
	 * by {@link HoldJournal.claimUnrecordedRelease}, then voided like any release. A hold another
	 * caller has since admitted is left alone.
	 */
	private async releaseUnrecorded(holdKey: string): Promise<void> {
		const won = await this.journal.writeTx(() => this.journal.claimUnrecordedRelease(holdKey));
		if (won) await this.release(holdKey);
	}

	/** Settle a hold to the given intent; the loser of the claim acts BY STATE. */
	async settle(holdKey: string, given: SettlementIntent): Promise<SettleOutcome> {
		// Snapshotted BEFORE any await (#174 r3): the claim writes it after the lock wait, and the
		// debt recorded and the overage charged must be the same number.
		const intent = snapshotIntent(given);
		const numbers = numbersProblem(intent);
		if (numbers !== null) throw new InvalidSettlementIntentError(numbers);
		// The claim and the overage's DEBT commit together: from the moment the overage is
		// known, the next reservation sees it — never after the ledger charge (#174 r1: a
		// reservation in that gap read the old debt and admitted past the budget).
		const claim = await this.journal.writeTx(() => {
			// Judged against the hold INSIDE the claim transaction, before the row can move: a
			// throw rolls it back, so a broken intent is never claimed, stored or posted.
			const open = this.journal.get(holdKey);
			if (open?.state === "open") {
				const problem = intentProblem(intent, open.amount);
				if (problem !== null) throw new InvalidSettlementIntentError(problem);
			}
			if (this.journal.cas(holdKey, "open", "settling", { intent })) {
				const row = this.journal.get(holdKey);
				if (row !== undefined && intent.overage > 0) {
					this.journal.applyDebt(row.budgetId, this.overageId(holdKey), intent.overage);
				}
				return { won: true } as const;
			}
			const row = this.journal.get(holdKey);
			return {
				won: false,
				state: row?.state ?? "missing",
				intent: row?.intent ?? null,
			} as const;
		});
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
				return this.settleLate(holdKey, intent, claim.state);
			default:
				// open (cannot lose a claim from open), voiding, voided, or missing.
				return { outcome: "incident", state: claim.state };
		}
	}

	/** Steps 2–4, from a claimed `settling` row. */
	private async completeSettlement(
		holdKey: string,
		stored: SettlementIntent,
		resumed: boolean,
	): Promise<SettleOutcome> {
		const row = this.journal.get(holdKey);
		if (row === undefined) return { outcome: "incident", state: "missing" };
		if (row.state === "settled") return { outcome: "duplicate" };
		// A recorded incident cannot be completed by settling again: no ledger call.
		if (row.incident !== null) return { outcome: "incident", state: row.state };
		// THE choke point: every completion — a fresh claim or a resume of a stored intent (one
		// written by ANY engine version, e.g. a row carried over by the v0 migration) — passes the
		// same contract before anything is posted or charged. A stored intent that fails it is a
		// terminal incident, recorded once; no ledger call is made, and recorded debt is left as is.
		const problem = intentProblem(stored, row.amount);
		if (problem !== null) {
			await this.journal.writeTx(() =>
				this.journal.recordIncident(holdKey, {
					kind: "invalid_stored_intent",
					problem,
					intent: stored,
				}),
			);
			return { outcome: "incident", state: row.state };
		}
		const intent = snapshotIntent(stored); // nothing outside this call can change it now
		const posted = await within("post", this.ms, () =>
			this.ledger.post({ holdKey, amount: intent.post }),
		);
		if (posted === "expired") {
			// A CONFIRMED expiry from the ledger: the hold's one terminal is `expired`, and
			// the actual usage goes through the late-settlement path. The overage debt recorded
			// with the claim was never charged: it is reversed in the same transaction (once).
			// In the SAME transaction as `expired`: the overage debt recorded with the claim is
			// reversed (it will never be charged as overage), and the full ACTUAL amount is recorded
			// as the late settlement with its debt — durable before any ledger call, so a crash
			// after this is completed by the sweeper's replay, never lost.
			const actual = intent.post + intent.overage;
			await this.journal.writeTx(() => {
				const moved = this.journal.cas(holdKey, "settling", "expired", {
					terminalKind: "hold_expired_unsettled",
				});
				if (!moved) return;
				if (intent.overage > 0) {
					this.journal.applyDebt(
						row.budgetId,
						`${this.overageId(holdKey)}:reversed`,
						-intent.overage,
					);
				}
				// Any actual amount is recorded, zero included (a terminal `zero`): the first
				// recorded disposition wins, so no later settlement can charge this hold.
				if (this.journal.recordLate(holdKey, actual) && actual > 0) {
					this.journal.applyDebt(row.budgetId, this.lateId(holdKey), actual);
				}
			});
			await this.chargeLate(holdKey);
			await this.recordEventSoon(holdKey, "terminal");
			return this.afterLate(
				holdKey,
				await this.lateAnswer(holdKey, intent, actual, "expired", resumed),
			);
		}
		if (posted === "unknown") return { outcome: "in_flight" };
		if (posted === "voided" || posted === "not_found") {
			return { outcome: "incident", state: "settling" };
		}
		if (intent.overage > 0) {
			// The debt is already recorded (with the claim). The ledger charge runs OUTSIDE any
			// journal transaction; its derived id makes a replay after a crash a verified no-op.
			const charged = await within("chargeDebt", this.ms, () =>
				this.ledger.chargeDebt({
					budgetId: row.budgetId,
					holdKey,
					role: "overage",
					amount: intent.overage,
				}),
			);
			// Both ids retired and nothing charged: TERMINAL. The row is marked (so replay and the
			// sweeper stop treating it as in flight), then the failure is raised, loud. Its debt is
			// already recorded, so admission stays bounded — but the ledger never carries it.
			if (charged !== "done") {
				const incident = { kind: "debt_charge_failed", ...charged, amount: intent.overage };
				await this.journal.writeTx(() => this.journal.recordIncident(holdKey, incident));
				throw new DebtChargeFailedError(holdKey, charged.role, charged.transferIds);
			}
		}
		const fin = await this.finalTransition(holdKey, "settling", "settled", {
			terminalKind: "settled",
		});
		if (fin === "moved" || fin === "settled") {
			await this.recordEventSoon(holdKey, "terminal");
			return { outcome: "settled", resumed: fin !== "moved" || resumed };
		}
		if (fin === "missing") return { outcome: "incident", state: "missing" };
		return { outcome: "incident", state: fin === "incident" ? "settling" : fin };
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
			let fin: "moved" | "incident" | HoldState | "missing";
			try {
				fin = await this.finalTransition(holdKey, "voiding", "voided", {
					terminalKind: "voided_not_found",
				});
			} catch (err) {
				if (err instanceof PlacementHorizonError) return { outcome: "in_flight" };
				throw err;
			}
			if (fin === "moved" || fin === "voided") {
				await this.recordEventSoon(holdKey, "terminal");
				return { outcome: "voided" };
			}
			return { outcome: "incident", state: "voiding" };
		}
		// Voided now or before, or expired by the ledger: nothing was charged either way.
		const fin = await this.finalTransition(holdKey, "voiding", "voided", {
			terminalKind: voided === "expired" ? "voided_expired" : "voided",
		});
		if (fin === "moved" || fin === "voided") {
			await this.recordEventSoon(holdKey, "terminal");
			return { outcome: "voided" };
		}
		return { outcome: "incident", state: "voiding" };
	}

	/**
	 * One sweep: the work the plan gives the sweeper, run on a timer and once at start (which
	 * covers a crash). Each step acts BY STATE on rows read from the journal — no in-memory map:
	 *   1. the heartbeat (the independent detector reads it);
	 *   2. every `open` hold past `ttlAt + grace` (the ledger has released it by then) is claimed
	 *      `open → expiring` and finished (below);
	 *   3. every in-flight row (`settling`, `voiding`, `expiring`; rows carrying an INCIDENT are
	 *      never in flight, so never resumed) is replayed — a `settling` row from its stored
	 *      intent, through the same contract choke point as any settlement;
	 *   4. every recorded, uncharged late settlement is charged.
	 * A step that throws for one row is reported in {@link SweepReport.errors} and the sweep goes
	 * on: one bad row never stops the others.
	 */
	async sweep(): Promise<SweepReport> {
		const now = this.now();
		const report: SweepReport = {
			expired: [],
			incidents: [],
			inFlight: [],
			replayed: [],
			lateCharged: [],
			errors: [],
			events: [],
			auditVerify: this.opts.audit === undefined ? "no_audit" : "not_due",
		};
		await this.journal.writeTx(() => this.journal.recordHeartbeat(now));
		// Each OBLIGATION of a row is attempted at most once per sweep: a row the expiry step
		// claimed (and failed to finish) is not replayed again in the same sweep — the next sweep
		// tries it. Advancing a row's state and charging its late settlement are separate
		// obligations, each attempted once.
		const touched = new Set<string>();
		const attempt = async (
			obligation: "advance" | "late" | `event-${EventSlot}`,
			holdId: string,
			step: () => Promise<void>,
		) => {
			const key = `${obligation}:${holdId}`;
			if (touched.has(key)) return;
			touched.add(key);
			try {
				await step();
			} catch (error) {
				report.errors.push({ holdId, error });
			}
		};
		for (const row of this.journal.openPast(now - this.expiryGraceMs)) {
			await attempt("advance", row.holdId, async () => {
				const won = await this.journal.writeTx(() =>
					this.journal.cas(row.holdId, "open", "expiring"),
				);
				if (!won) return; // a settlement or a release claimed it first: theirs
				// Reported by what the ledger answered — never `expired` unless it expired.
				const outcome = await this.finishExpiry(row.holdId);
				if (outcome === "expired") report.expired.push(row.holdId);
				else if (outcome === "incident") report.incidents.push(row.holdId);
				else report.inFlight.push(row.holdId);
			});
		}
		for (const row of this.journal.inFlight()) {
			await attempt("advance", row.holdId, async () => {
				let outcome: string;
				if (row.state === "settling") {
					outcome = (
						await this.completeSettlement(row.holdId, row.intent as SettlementIntent, true)
					).outcome;
				} else if (row.state === "voiding") {
					outcome = (await this.release(row.holdId)).outcome;
				} else {
					outcome = await this.finishExpiry(row.holdId);
				}
				report.replayed.push({ holdId: row.holdId, outcome });
			});
		}
		for (const row of this.journal.lateUncharged()) {
			await attempt("late", row.holdId, async () => {
				await this.chargeLate(row.holdId);
				if (this.journal.get(row.holdId)?.lateState === "charged") {
					report.lateCharged.push(row.holdId);
				}
			});
		}
		// 5. Every MISSING audit event, once each — reserved first, so a terminal event can name
		//    its reserved event's sequence. (Without an audit port there is nothing to record.)
		if (this.opts.audit !== undefined && this.journal.auditState().state !== "broken") {
			const missing: Array<[EventSlot, HoldRow[]]> = [
				["reserved", this.journal.reservedWithoutEvent()],
				["terminal", this.journal.terminalWithoutEvent()],
				["late", this.journal.lateWithoutEvent()],
			];
			for (const [slot, rows] of missing) {
				for (const row of rows) {
					await attempt(`event-${slot}`, row.holdId, async () => {
						if ((await this.recordEvent(row.holdId, slot)) === "recorded") {
							report.events.push({ holdId: row.holdId, slot });
						}
					});
				}
			}
		}
		// 6. The WHOLE chain from genesis, up to the journal's checkpoint: at this ENGINE
		//    INSTANCE's first sweep (in memory, never persisted — a restart always re-verifies, so
		//    bytes rewritten while the process was down are seen), then every `auditFullVerifyMs`.
		//    A definite finding moves the checkpoint to `broken` (kept, never cleared); anything
		//    else is retried next sweep and changes nothing.
		const audit = this.opts.audit;
		if (audit !== undefined) {
			const st = this.journal.auditState();
			if (st.state === "broken") {
				report.auditVerify = "broken";
			} else if (this.fullVerifiedAt === null || now - this.fullVerifiedAt >= this.fullVerifyMs) {
				try {
					await audit.verifyFull(st.state === "valid" ? st.checkpoint : null);
					this.fullVerifiedAt = now;
					report.auditVerify = "ok";
				} catch (error) {
					const definite =
						error instanceof AuditChainUnverifiableError && error.scope === "history";
					if (definite) {
						await this.journal.writeTx(() => this.journal.markAuditBroken(error.message));
					}
					report.auditVerify = definite ? "broken" : "error";
					report.errors.push({ holdId: "(audit chain)", error });
				}
			}
		}
		return report;
	}

	/**
	 * Finish an `expiring` hold by what the ledger answers when its pending transfer is voided:
	 * - voided now or before, or already expired by the ledger → `expired`
	 *   (`hold_expired_unsettled`): nothing was charged;
	 * - POSTED, or NOT FOUND (an `open` row's reserve transfer was confirmed placed, and an
	 *   expired one answers "expired", not "not found") → a terminal incident: the ledger and the
	 *   journal disagree, and an operator must look;
	 * - unconfirmed (a retired void id the read-back cannot settle yet) → left `expiring`, in
	 *   flight for the next sweep.
	 */
	private async finishExpiry(holdKey: string): Promise<"expired" | "incident" | "in_flight"> {
		const voided = await within("release", this.ms, () => this.ledger.release({ holdKey }));
		if (voided === "unknown") return "in_flight";
		if (voided === "posted" || voided === "not_found") {
			await this.journal.writeTx(() =>
				this.journal.recordIncident(holdKey, { kind: "expiry_ledger_disagrees", voided }),
			);
			return "incident";
		}
		const fin = await this.finalTransition(holdKey, "expiring", "expired", {
			terminalKind: "hold_expired_unsettled",
		});
		// Its terminal event: sweep step 5, later in this same sweep (finishExpiry runs only there).
		return fin === "moved" || fin === "expired" ? "expired" : "incident";
	}
}
