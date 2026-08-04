// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * allocation.ts — cost-center allocation and reclaim over the TigerBeetle ledger
 *
 * THE METERING CONSUMER EXISTS — but only for ATTRIBUTED traffic. A governed call
 * made inside a `withCostCenter(cc, fn)` scope (see `budget/attribution.ts`) places
 * its PENDING hold against the wallet {@link allocateBudget} funds, so
 * {@link getBudgetStatus} reports that cost center's real `spent` and a policy tier
 * on `budgetFractionRemaining` (see `policy/gate.ts`) trips on real burn.
 *
 * Calls made OUTSIDE every scope still spend from the per-session funded holding
 * account (`createFundedBudgetWallet` in `govern.ts`, mirrored in `headless.ts`) —
 * that path is unchanged and deliberately so. The consequence to keep in mind:
 * these figures measure attributed spend, so an agent that never opens a scope
 * still reports `spent: 0` here while burning the session budget. That is a gap in
 * INSTRUMENTATION, not in enforcement — the session wallet's own
 * `debits_must_not_exceed_credits` bounds it either way.
 *
 * A cost center is a sub-wallet of its parent, nothing more. Its TigerBeetle
 * account is `TrustTBClient.deriveCostCenterAccountId(parent, costCenter)` — a
 * domain-separated, length-prefixed hash of the TUPLE, in a namespace disjoint
 * from the `wallet:` preimages that ordinary wallet ids and escrow labels share.
 * The `parent::costCenter` string ({@link costCenterUserId}) is the display and
 * audit label ONLY; no account is derived from it, so no wallet an integrator can
 * name reaches a cost center's money. Allocation and reclaim are plain immediate
 * transfers between the two accounts. There is no cost-center registry and no new
 * ledger schema.
 *
 * LEDGER INVARIANT (what makes `spent` meaningful): a cost-center wallet receives
 * funds ONLY via {@link allocateBudget} from its parent, and spends only outward.
 * Under that invariant `spent = allocated - balance` is exact. Fund a cost center
 * by any other route and every derived figure — spent, burn rate, runway — is
 * wrong, silently. {@link getBudgetStatus} clamps `spent` at 0 so an over-funded
 * child cannot invert the burn rate, but the clamp hides the breach rather than
 * repairing it.
 *
 * NO PRE-CHECK ON THE ALLOCATION PATH (AUD-455): allocation never reads the
 * parent balance before transferring. A `lookupBalance` + transfer sequence is a
 * check-then-act race — the balance can change between the two. TigerBeetle
 * enforces `debits_must_not_exceed_credits` atomically at commit, so the
 * rejection is the check. Reclaim is deliberately different: it must know how
 * much to move, so it reads first and treats a stale read as a benign race (see
 * {@link reclaimBudget}).
 *
 * RETRIES ARE NOT SAFE. Neither {@link allocateBudget} nor {@link reclaimBudget}
 * is idempotent under an ambiguous transport failure: a retry after an
 * unacknowledged commit double-allocates or double-reclaims. The ledger balance
 * is the source of truth — read it before retrying. A caller-supplied idempotency
 * key is the correct fix and is deferred to a follow-up.
 *
 * EMPTY WALLETS ARE EXPECTED. An allocation that creates the wallet and then
 * fails to transfer leaves a zero-balance account behind. That is harmless — a
 * TigerBeetle account holding nothing costs nothing and the next allocation
 * reuses it. There is no cleanup path and none is needed.
 *
 * AUDIT EVENTS carry `{ costCenter, amount, costCenterUserId }` and nothing else.
 * Caller input is never spread into the payload: a budget grant is a delegation
 * worth proving, but the proof must not become a channel for credentials or
 * prompt text.
 */

import { CreateTransferStatus } from "tigerbeetle-node";
import type { AppendEventInput } from "../audit/chain.js";
import type { TBTransferError } from "../ledger/client.js";
import { TrustTBClient, XFER_BUDGET_GRANT, XFER_BUDGET_RECLAIM } from "../ledger/client.js";
import { InsufficientBalanceError } from "../shared/errors.js";
import { COST_CENTER_PATTERN, parentUserIdRefusal } from "../shared/ids.js";
import { computeRunway, type Runway } from "./runway.js";

// ── Identity ──

/**
 * Display-label separator only — the account id does not depend on this string.
 * Cost-center accounts come from the tuple hash, so changing this would rename the
 * audit label (breaking vault continuity) without moving a single usertoken.
 */
const SEPARATOR = "::";
const MAX_DERIVED_ID_LENGTH = 200;

/**
 * The DISPLAY and AUDIT label for a cost center: `parent::costCenter`.
 *
 * NOT an account id, and not a preimage of one — the money lives at
 * `TrustTBClient.deriveCostCenterAccountId(parentUserId, costCenter)`, whose
 * domain-separated preimage no wallet id or escrow label can reach. What this label
 * must still be is INJECTIVE over legal pairs: it is the identity an operator reads
 * and the one `data.costCenterUserId` carries into the audit chain, so two distinct
 * cost centers sharing a label would make the chain ambiguous even though their
 * balances never mix. It is injective because `COST_CENTER_PATTERN` is colon-free
 * and non-empty: the cost center is exactly the label's maximal colon-free suffix,
 * which reads the tuple back uniquely. That is the whole reason the parent may now
 * carry a single `:` (issue #64) and the cost center may not. Both patterns also
 * exclude whitespace, control characters, and ANSI escapes, which keeps the label
 * safe to embed in an audit event and in terminal output.
 *
 * The parent may NOT carry `::`, and that is a separate rule from the charset —
 * `parentUserIdRefusal` in `shared/ids.ts` is the authoritative source for both, and
 * returns a distinct reason for each so this door can say which one fired. A `::`
 * parent would make the tuple's own `deriveAccountId(parentUserId)` land on an
 * unreclaimed pre-v3 cost-center account, so allocation would debit stranded legacy
 * money as though it were the parent's.
 *
 * @throws Error when either part is missing, over-long, outside its charset, or (for
 * the parent) inside the quarantined `::` namespace.
 */
export function costCenterUserId(parentUserId: string, costCenter: string): string {
	// The messages quote the patterns rather than restating them: a hand-copied
	// charset is one edit away from describing a rule the code no longer enforces.
	const parentRefusal = parentUserIdRefusal(parentUserId);
	if (parentRefusal !== null) {
		throw new Error(`budget: parentUserId ${parentRefusal}`);
	}
	if (typeof costCenter !== "string" || !COST_CENTER_PATTERN.test(costCenter)) {
		throw new Error(`budget: costCenter must match ${COST_CENTER_PATTERN.source}`);
	}
	const derived = `${parentUserId}${SEPARATOR}${costCenter}`;
	// Unreachable through the patterns above (128 + 2 + 64 = 194). Kept so that
	// loosening either bound cannot silently start producing oversized ids.
	if (derived.length > MAX_DERIVED_ID_LENGTH) {
		throw new Error(`budget: derived cost-center id exceeds ${MAX_DERIVED_ID_LENGTH} characters`);
	}
	return derived;
}

// ── Types ──

/** Minimal audit surface — accepts the SDK's AuditWriter without depending on it. */
export interface BudgetAuditWriter {
	appendEvent(input: AppendEventInput): Promise<unknown>;
}

/**
 * Whether this operation landed in the audit chain.
 *
 * `audited` is true only when an `auditWriter` was supplied AND its append
 * succeeded. It exists because omitting the writer would otherwise be invisible:
 * an unaudited allocation and a successfully audited one would be byte-identical
 * results, while the Global Constraint on this work is that a delegation MUST be
 * provable. `auditFailed` narrows an `audited: false` to the case where a writer
 * was supplied and threw — the money still moved, and the caller must surface it.
 */
interface AuditOutcome {
	/** True only when a writer was supplied and the append succeeded. */
	audited: boolean;
	/** True when the transfer committed but its audit event could not be written. */
	auditFailed?: boolean;
	/**
	 * The writer's failure message. Present only alongside `auditFailed`, and
	 * carried so a caller can log WHY the delegation went unproven — a bare flag
	 * leaves an operator with a committed transfer and nothing to diagnose.
	 */
	auditFailureReason?: string;
}

export interface AllocateResult extends AuditOutcome {
	costCenterUserId: string;
	transferId: string;
	allocated: number;
}

export interface ReclaimResult extends AuditOutcome {
	reclaimed: number;
	/** Null when nothing moved — an empty cost center or a lost race. */
	transferId: string | null;
}

export interface BudgetStatus {
	costCenterUserId: string;
	balance: number;
	runway: Runway;
}

// ── Helpers ──

/**
 * Check whether a caught error is a TigerBeetle insufficient-balance rejection.
 *
 * Mirrors the predicate in `ledger/engine.ts`, which is module-private there.
 * Both must stay in step: they are the only places the SDK decides that a
 * rejection means "not enough money" rather than "the ledger is broken".
 */
function isInsufficientBalanceError(err: unknown): err is TBTransferError {
	if (err == null || typeof err !== "object") return false;
	if (!("code" in err) || !("name" in err)) return false;
	const e = err as { code: number; name: string };
	return (
		e.name === "TBTransferError" &&
		(e.code === CreateTransferStatus.exceeds_credits ||
			e.code === CreateTransferStatus.overflows_debits ||
			e.code === CreateTransferStatus.overflows_debits_pending)
	);
}

/**
 * Resolve the parent and cost-center accounts, refusing a self-transfer.
 *
 * BOTH ids are derived, never looked up. `getAccountId` reads an in-process map
 * that is populated only by a `createUserWallet` call in this same process, so a
 * lookup rejects before any ledger I/O on a freshly constructed client — even
 * when the wallet exists in TigerBeetle. Each id here is the same pure hash its
 * creation door derives from — `deriveAccountId` (SHA-256 of `wallet:${userId}`)
 * for the parent, `deriveCostCenterAccountId` (the tuple) for the child — so a
 * derived id IS the account the wallet was created as, in any process. A parent
 * wallet that genuinely does not exist then fails at commit inside TigerBeetle:
 * loudly, at the ledger, rather than before reaching it.
 *
 * The two hashes live in disjoint domains, so a child colliding with its own
 * parent now takes a 128-bit truncated-hash collision rather than a punctuation
 * trick. The guard stays anyway: it costs one comparison, and what it refuses is a
 * transfer that debits and credits one account — a no-op reported as a funded
 * allocation.
 */
function resolveAccounts(
	parentUserId: string,
	costCenter: string,
): { parentAccount: bigint; childAccount: bigint } {
	const parentAccount = TrustTBClient.deriveAccountId(parentUserId);
	const childAccount = TrustTBClient.deriveCostCenterAccountId(parentUserId, costCenter);
	if (childAccount === parentAccount) {
		throw new Error("budget: cost center resolves to the parent account");
	}
	return { parentAccount, childAccount };
}

/**
 * Available balance of a cost-center wallet, or 0 when the wallet does not exist.
 *
 * A cost center that was never allocated has no TigerBeetle account at all. That
 * is an implicit zero rather than an error: with no cost-center registry, "never
 * allocated" and "allocated then fully reclaimed" are the same observable state,
 * and a typo'd cost-center name is indistinguishable from an empty one.
 *
 * Existence is probed with `lookupAccounts` rather than by matching the message
 * `lookupBalance` throws, and the balance itself still comes from `lookupBalance`
 * so its overflow checks are never duplicated or bypassed.
 */
async function costCenterBalance(tb: TrustTBClient, accountId: bigint): Promise<number> {
	const accounts = await tb.lookupAccounts([accountId]);
	if (accounts.length === 0) return 0;
	const { available } = await tb.lookupBalance(accountId);
	return available;
}

/**
 * Append an audit event, reporting failure rather than raising it.
 *
 * Called only after a transfer has committed. The transfer is authoritative: a
 * failed append must not unwind it, must not retry it, and must not surface as a
 * rejection that a caller could mistake for "the money did not move". The
 * {@link AuditOutcome} on the result is the channel instead — and it
 * distinguishes "no writer was supplied" from "the append succeeded", which a
 * lone `auditFailed` flag could not.
 *
 * `BudgetAuditWriter` is a public interface, so the thrown value comes from
 * consumer code and is never discarded: it is warned to the console AND carried
 * on the outcome. Silence here would leave a committed transfer with no record
 * of which allocation lost its event, and no reason for the loss.
 */
async function appendBudgetEvent(
	auditWriter: BudgetAuditWriter | undefined,
	kind: "budget_allocated" | "budget_reclaimed",
	parentUserId: string,
	costCenter: string,
	amount: number,
	childUserId: string,
): Promise<AuditOutcome> {
	if (!auditWriter) return { audited: false };
	try {
		await auditWriter.appendEvent({
			kind,
			actor: parentUserId,
			data: { costCenter, amount, costCenterUserId: childUserId },
		});
		return { audited: true };
	} catch (err) {
		const auditFailureReason = err instanceof Error ? err.message : String(err);
		console.warn("[BUDGET] Transfer committed but its audit event was not written", {
			kind,
			costCenterUserId: childUserId,
			amount,
			error: auditFailureReason,
		});
		return { audited: false, auditFailed: true, auditFailureReason };
	}
}

// ── Allocation ──

/**
 * Move `amount` UT from a parent wallet into one of its cost centers.
 *
 * The cost-center wallet is created on demand. `createCostCenterWallet` already
 * treats TigerBeetle's `exists` status as success and resolves with the existing
 * account id, so an already-created wallet needs no handling here — and every
 * rejection it does raise (`exists_with_different_flags` above all, which means
 * the account is missing its balance enforcement) is a real failure that must
 * propagate rather than be swallowed.
 *
 * NOT SAFE TO BLIND-RETRY: a retry after an unacknowledged commit double-allocates.
 * The ledger balance is the source of truth — read it before retrying.
 *
 * @throws {InsufficientBalanceError} when the parent cannot cover the amount.
 * @throws Error on an invalid amount or cost-center name, before any ledger I/O.
 */
export async function allocateBudget(
	tb: TrustTBClient,
	p: {
		parentUserId: string;
		costCenter: string;
		/** UT, positive safe integer. */
		amount: number;
		auditWriter?: BudgetAuditWriter;
	},
): Promise<AllocateResult> {
	const childUserId = costCenterUserId(p.parentUserId, p.costCenter);
	const amount = p.amount;
	if (!Number.isSafeInteger(amount) || amount <= 0) {
		throw new Error("budget: amount must be a positive integer");
	}

	const { parentAccount, childAccount } = resolveAccounts(p.parentUserId, p.costCenter);

	// The pair reaches the ledger door AS A PAIR — nothing joins it into an id. That
	// is what keeps creation and resolveAccounts on the one static, which is what the
	// cross-check below depends on.
	const createdAccount = await tb.createCostCenterWallet(p.parentUserId, p.costCenter);
	// A creation path answering with anything but the derived id — poisoned, or
	// hashing a different preimage than resolveAccounts does — would make allocation
	// fund an account that reclaim and status, which always derive, never read.
	if (createdAccount !== childAccount) {
		throw new Error("budget: cost center account id does not match its derived id");
	}

	// AUD-455: No pre-check — TB enforces debits_must_not_exceed_credits atomically.
	// A lookupBalance + immediateTransfer sequence has a TOCTOU race.
	let transferId: bigint;
	try {
		transferId = await tb.immediateTransfer({
			debitAccountId: parentAccount,
			creditAccountId: childAccount,
			amount,
			// NOT XFER_SPEND (which plan delta D9 called for): the metering path uses
			// that code for real consumption, so reconciliation summing XFER_SPEND
			// debits would count a delegation twice — once moving into the cost
			// center, and again when the cost center spends it.
			code: XFER_BUDGET_GRANT,
		});
	} catch (err) {
		if (isInsufficientBalanceError(err)) {
			// Fresh lookup for accurate error reporting — after the rejection, so it
			// reports rather than decides.
			let available = 0;
			try {
				const bal = await tb.lookupBalance(parentAccount);
				available = bal.available;
			} catch {
				// Balance lookup failed — report 0 as fallback
			}
			throw new InsufficientBalanceError(p.parentUserId, amount, available);
		}
		throw err;
	}

	const audit = await appendBudgetEvent(
		p.auditWriter,
		"budget_allocated",
		p.parentUserId,
		p.costCenter,
		amount,
		childUserId,
	);

	return {
		costCenterUserId: childUserId,
		transferId: transferId.toString(),
		allocated: amount,
		...audit,
	};
}

/**
 * Return a cost center's unspent balance to its parent.
 *
 * Optimistic read-then-transfer by design: the amount to move is not known until
 * it is read. If a concurrent spend or a second reclaim lands between the read
 * and the transfer, TigerBeetle rejects for insufficient balance — that is the
 * race resolving correctly, not a failure, and it reports as a zero reclaim.
 * Every other rejection propagates.
 *
 * Only *available* funds move; anything held by a pending transfer stays until
 * that hold settles or expires. Calling this twice is safe — the second call
 * finds nothing and moves nothing.
 *
 * NOT SAFE TO BLIND-RETRY: a retry after an unacknowledged commit double-reclaims.
 * The ledger balance is the source of truth — read it before retrying.
 */
export async function reclaimBudget(
	tb: TrustTBClient,
	p: {
		parentUserId: string;
		costCenter: string;
		auditWriter?: BudgetAuditWriter;
	},
): Promise<ReclaimResult> {
	const childUserId = costCenterUserId(p.parentUserId, p.costCenter);
	const { parentAccount, childAccount } = resolveAccounts(p.parentUserId, p.costCenter);

	const available = await costCenterBalance(tb, childAccount);
	// Nothing moved, so there is nothing to audit — `audited: false` is the honest
	// report, not a failure.
	if (available <= 0) return { reclaimed: 0, transferId: null, audited: false };

	let transferId: bigint;
	try {
		transferId = await tb.immediateTransfer({
			debitAccountId: childAccount,
			creditAccountId: parentAccount,
			amount: available,
			code: XFER_BUDGET_RECLAIM,
		});
	} catch (err) {
		// The balance went stale between the read and the transfer. Benign.
		if (isInsufficientBalanceError(err)) return { reclaimed: 0, transferId: null, audited: false };
		throw err;
	}

	const audit = await appendBudgetEvent(
		p.auditWriter,
		"budget_reclaimed",
		p.parentUserId,
		p.costCenter,
		available,
		childUserId,
	);

	return {
		reclaimed: available,
		transferId: transferId.toString(),
		...audit,
	};
}

/**
 * Read a cost center's balance and its runway against a caller-supplied allocation.
 *
 * `allocated` and the period bounds are caller state — there is no registry to
 * read them from — so this is a projection over what the caller believes it
 * granted, checked against what the ledger actually holds. A cost center that was
 * never allocated reads as a zero balance rather than an error.
 *
 * The wall clock is read here, at the call site, and injected into
 * {@link computeRunway}, which stays pure.
 */
export async function getBudgetStatus(
	tb: TrustTBClient,
	p: {
		parentUserId: string;
		costCenter: string;
		allocated: number;
		periodStartMs: number;
		periodEndMs?: number;
		nowMs?: number;
	},
): Promise<BudgetStatus> {
	// Read-only: with no transfer there is no parent account to resolve and no
	// self-transfer to refuse, so this deliberately bypasses `resolveAccounts` — at
	// the price of being the second place the child id is derived. It must stay on
	// the SAME static, or status reads an account allocation never funded and every
	// cost center reports a zero balance: a governance read that fails open.
	const childUserId = costCenterUserId(p.parentUserId, p.costCenter);
	const childAccount = TrustTBClient.deriveCostCenterAccountId(p.parentUserId, p.costCenter);
	const balance = await costCenterBalance(tb, childAccount);

	return {
		costCenterUserId: childUserId,
		balance,
		runway: computeRunway({
			allocated: p.allocated,
			// An over-funded child (see the LEDGER INVARIANT note) would otherwise
			// yield negative spend. computeRunway normalizes that to 0 as well, so
			// this clamp is this module's own guarantee rather than the only guard —
			// spend leaving here is non-negative regardless of what runway does with it.
			spent: Math.max(0, p.allocated - balance),
			periodStartMs: p.periodStartMs,
			periodEndMs: p.periodEndMs,
			nowMs: p.nowMs ?? Date.now(),
		}),
	};
}
