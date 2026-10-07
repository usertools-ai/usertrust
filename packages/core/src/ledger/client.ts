// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * TigerBeetle client wrapper for the usertrust SDK.
 * Provides account/transfer CRUD with reconnect logic and
 * deterministic account IDs.
 */

import { createHash } from "node:crypto";
import type { Account, Transfer } from "tigerbeetle-node";
import {
	AccountFlags,
	amount_max,
	CreateAccountStatus,
	CreateTransferStatus,
	createClient,
	TransferFlags,
} from "tigerbeetle-node";
import {
	COST_CENTER_PATTERN,
	LEGACY_COST_CENTER_SEPARATOR,
	parentUserIdRefusal,
	tbId,
} from "../shared/ids.js";

/** Typed error carrying the numeric TB error code for structured matching. */
export class TBTransferError extends Error {
	constructor(
		public readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "TBTransferError";
	}
}

/**
 * A caller-supplied transfer id was answered `exists`, but the STORED transfer is not the
 * one this call describes. `field` names the first difference. Extends TBTransferError so
 * existing catch sites still match; `code` is `exists`.
 *
 * Defence in depth. Measured against a real TigerBeetle 0.17.9
 * (`tests/integration/replay.tb.test.ts`), the server itself refuses every amount-changing
 * post replay with `exists_with_different_amount` — including a larger amount after a full
 * post, and `amount_max` after a partial one. The only amount it answers plain `exists` for
 * is `amount_max` after a FULL post, which is the same intent. The client still verifies
 * every `exists` for a caller-supplied id, so success never rests on that server rule alone.
 */
export class TransferReplayMismatchError extends TBTransferError {
	constructor(
		public readonly transferId: bigint,
		public readonly field: string,
	) {
		super(
			CreateTransferStatus.exists,
			`Transfer ${transferId} exists with a different ${field}: a replay must resubmit the same intent`,
		);
		this.name = "TransferReplayMismatchError";
	}
}

/**
 * A caller-supplied PENDING transfer id was answered `exists` (fields verified): this is a
 * replay, and it must never be read as "reserved". A pending transfer's stored record is
 * immutable — posting, voiding or expiring the hold changes nothing on the row TigerBeetle
 * returns — so the client cannot tell a live hold from one already spent, released or
 * expired. Treating the replay as a live reservation is an overspend path. The caller
 * re-reserves under a NEW id (a new role, e.g. `"reserve#2"`) or denies; if it still holds
 * the old id it may void it, which fails harmlessly when the hold is no longer pending.
 * Extends TBTransferError so existing catch sites still match; `code` is `exists`.
 *
 * Accepted residue (fail closed): if the FIRST attempt's reply was lost after the hold
 * committed, the retry sees `exists` and gets this error although the hold IS live. The
 * caller's re-reserve then holds the amount twice until the first hold leaves — at its
 * timeout, or, with `timeoutSeconds: 0` (no expiry), only when it is voided. A caller that
 * uses `timeoutSeconds: 0` must void the old id itself; nothing else will release it.
 */
export class PendingReplayError extends TBTransferError {
	constructor(public readonly transferId: bigint) {
		super(
			CreateTransferStatus.exists,
			`Pending transfer ${transferId} already exists: a replayed reservation is not a live hold — reserve under a new id`,
		);
		this.name = "PendingReplayError";
	}
}

/**
 * The FIRST attempt under this caller-supplied id failed (e.g. `exceeds_credits`), and
 * TigerBeetle answers `id_already_failed` to every later attempt with the same id: a
 * derived `(key, role)` is permanently retired once it fails. Retrying cannot succeed —
 * the caller must derive a different id. Distinct from a transient failure on purpose.
 */
export class TransferIdRetiredError extends TBTransferError {
	constructor(public readonly transferId: bigint) {
		super(
			CreateTransferStatus.id_already_failed,
			`Transfer id ${transferId} is retired: its first attempt failed, and the same id can never succeed`,
		);
		this.name = "TransferIdRetiredError";
	}
}

/**
 * This ledger client was destroyed. An operation on it fails rather than reconnecting:
 * a reconnect would build a native client that nothing destroys, and an open TigerBeetle
 * client keeps the process alive (#249). An operation that was in flight at `destroy()`
 * fails with its own error; one started after it fails with this.
 */
export class LedgerClientClosedError extends Error {
	constructor() {
		super("TigerBeetle client was destroyed");
		this.name = "LedgerClientClosedError";
	}
}

// Ledger ID: all usertokens live on ledger 1
export const LEDGER_USERTOKENS = 1;

// Account codes
export const CODE_USER_WALLET = 1;
export const CODE_PLATFORM_TREASURY = 2;
export const CODE_ESCROW = 3;

// Transfer codes
export const XFER_PURCHASE = 1;
export const XFER_SPEND = 2;
export const XFER_TRANSFER = 3;
export const XFER_REFUND = 4;
export const XFER_ALLOCATION = 5;
export const XFER_TOOL_CALL = 6;
export const XFER_A2A_DELEGATION = 7;
/** Cost-center budget returned to its parent. Distinct from XFER_REFUND, which
 * reverses a purchase — a reclaim reverses a delegation, not a sale. */
export const XFER_BUDGET_RECLAIM = 8;
/**
 * Budget delegated from a parent wallet into one of its cost centers.
 *
 * Deliberately NOT XFER_SPEND: a grant moves usertokens between two wallets the
 * same owner controls and consumes nothing. Reconciliation that sums XFER_SPEND
 * debits would otherwise count a delegated budget twice — once moving into the
 * cost center, and again when the cost center actually spends it.
 */
export const XFER_BUDGET_GRANT = 9;

// Domain tag for cost-center account derivation. Versioned so a future encoding change can
// coexist; deliberately NOT "wallet:"-prefixed — prefix disjointness from deriveAccountId's
// preimages is the entire separation mechanism (flags cannot distinguish cost-center wallets).
// Any future domain tag must be prefix-free against every existing tag, or two domains could
// share preimages. The KAT suite pins these bytes: changing them breaks every known answer.
const COST_CENTER_DOMAIN_TAG = Buffer.from("usertrust:cost-center:v1", "utf8");

// Domain tag for caller-derived TRANSFER ids (deriveTransferId). Prefix-free against
// "wallet:" and "usertrust:cost-center:v1" under the same policy as above, although transfer
// and account ids already live in separate TigerBeetle namespaces. The KAT suite pins it.
const TRANSFER_ID_DOMAIN_TAG = Buffer.from("usertrust:transfer:v1", "utf8");

// TigerBeetle reserves 0 and 2^128 - 1; a transfer may use neither as its id.
const MAX_TRANSFER_ID = (1n << 128n) - 1n;

/**
 * Validate a caller-supplied transfer id, or mint a fresh one. Callers that need a
 * transfer to be idempotent ACROSS process restarts (a durable replay, not just a
 * reconnect retry) pass an id derived from their own durable key — see
 * {@link TrustTBClient.deriveTransferId}.
 */
function transferIdOrFresh(transferId: bigint | undefined): bigint {
	if (transferId === undefined) return tbId();
	if (transferId <= 0n || transferId >= MAX_TRANSFER_ID) {
		throw new RangeError(`Transfer id must be in (0, 2^128 - 1): ${transferId}`);
	}
	return transferId;
}

/**
 * Per-account available/pending/total balance, shared by {@link TrustTBClient.lookupBalance}
 * and {@link TrustTBClient.lookupBalances} so the overflow guards live in exactly ONE
 * place. Module-private: nothing outside this file computes a balance from raw `Account`
 * fields, which is the documented anti-pattern — the guards below are what stand between a
 * corrupted TB response and a `NaN`/silently-wrapped balance reaching budget arithmetic.
 */
function accountBalance(acct: Account): {
	available: number;
	pending: number;
	total: number;
} {
	const postedBig = acct.credits_posted - acct.debits_posted;
	if (postedBig > BigInt(Number.MAX_SAFE_INTEGER) || postedBig < -BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(
			`[TB] Balance overflow: ${postedBig.toString()} exceeds Number.MAX_SAFE_INTEGER`,
		);
	}
	const pendingBig = acct.debits_pending;
	if (pendingBig > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(
			`[TB] Pending overflow: ${pendingBig.toString()} exceeds Number.MAX_SAFE_INTEGER`,
		);
	}
	const posted = Number(postedBig);
	const pending = Number(acct.debits_pending);
	return {
		available: Math.max(0, posted - pending),
		pending,
		total: Math.max(0, posted),
	};
}

export interface TrustTBClientOptions {
	addresses: string[];
	clusterId?: bigint;
	/** Optional callback invoked on connection issues (replaces sendAlert) */
	onAlert?: (message: string, meta: Record<string, unknown>) => void;
}

export class TrustTBClient {
	private client: ReturnType<typeof createClient>;
	private accountMap = new Map<string, bigint>();
	private treasuryId: bigint | undefined;
	private initialized = false;
	private readonly startedAt = Date.now();
	private readonly initGraceMs = 60_000;
	private opts: Required<Pick<TrustTBClientOptions, "addresses" | "clusterId">>;
	private onAlert?: (message: string, meta: Record<string, unknown>) => void;
	private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
	private reconnectPromise: Promise<void> | null = null;
	// Set first by destroy(); from then on this client never reconnects (#249). The native
	// client cannot say so itself: its ERR_CLIENT_CLOSED does not tell a destroy() from our
	// own reconnect, which closes the old client too, and an operation in flight on THAT one
	// must still retry on the new client. Only this wrapper knows it was destroyed.
	private closed = false;

	constructor(opts: TrustTBClientOptions) {
		this.opts = {
			addresses: opts.addresses,
			clusterId: opts.clusterId ?? 0n,
		};
		if (opts.onAlert) {
			this.onAlert = opts.onAlert;
		}
		this.client = createClient({
			cluster_id: this.opts.clusterId,
			replica_addresses: this.opts.addresses,
		});
		this.healthCheckInterval = setInterval(() => {
			this.ping().catch(() =>
				this.reconnect().catch((err) => {
					console.error("[TB] Health check reconnection failed:", err);
					if (this.healthCheckInterval) {
						clearInterval(this.healthCheckInterval);
						this.healthCheckInterval = null;
					}
					const msg = "TigerBeetle health check failed — interval stopped";
					const meta = { error: err instanceof Error ? err.message : String(err) };
					if (this.onAlert) {
						this.onAlert(msg, meta);
					} else {
						console.warn(`[usertrust] ${msg}`, meta);
					}
				}),
			);
		}, 30_000);
		// Do not let the health-check timer keep the Node event loop alive. Without
		// this, a process that forgets to call destroy() can never exit — and the
		// beforeExit cleanup net (which only fires on an otherwise-empty loop) never
		// runs. The timer still fires while the loop is busy.
		this.healthCheckInterval.unref?.();
	}

	private isConnectionError(err: unknown): boolean {
		if (!(err instanceof Error)) return false;
		const msg = err.message.toLowerCase();
		return (
			msg.includes("connection refused") ||
			msg.includes("econnrefused") ||
			msg.includes("econnreset") ||
			msg.includes("client is closed") ||
			msg.includes("closed") ||
			msg.includes("not connected") ||
			msg.includes("socket") ||
			msg.includes("timeout")
		);
	}

	async reconnect(): Promise<void> {
		// Refused once destroyed, BEFORE the dedup. A reconnect that just finished stays
		// cached until its cleanup runs, and handing it back would answer success for a
		// client destroy() has closed.
		if (this.closed) throw new LedgerClientClosedError();
		if (this.reconnectPromise) return this.reconnectPromise;
		this.reconnectPromise = this._doReconnect().finally(() => {
			this.reconnectPromise = null;
		});
		return this.reconnectPromise;
	}

	private async _doReconnect(): Promise<void> {
		const maxRetries = 5;
		for (let attempt = 0; attempt < maxRetries; attempt++) {
			// destroy() may have landed while this waited out its backoff: build no client.
			// createClient is synchronous below, so one check per attempt covers it.
			if (this.closed) throw new LedgerClientClosedError();
			try {
				console.log(`[TB] Reconnection attempt ${attempt + 1}/${maxRetries}`);
				try {
					this.client.destroy();
				} catch {
					/* ignore destroy errors */
				}
				this.client = createClient({
					cluster_id: this.opts.clusterId,
					replica_addresses: this.opts.addresses,
				});
				return;
			} catch (err) {
				if (attempt === maxRetries - 1) {
					console.error("[TB] CRITICAL: All reconnection attempts failed");
					const msg = "TigerBeetle connection lost — all reconnection attempts failed";
					if (this.onAlert) {
						this.onAlert(msg, {});
					} else {
						console.warn(`[usertrust] ${msg}`);
					}
					throw err;
				}
				const delay = 1000 * 2 ** attempt;
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	private async withReconnect<T>(fn: () => Promise<T>): Promise<T> {
		// Destroyed: fail fast, without touching the closed native client.
		if (this.closed) throw new LedgerClientClosedError();
		try {
			return await fn();
		} catch (err) {
			// Destroyed while this was in flight: its own error stands, and no reconnect.
			// A POST that committed but lost its reply here would, by reconnecting, have been
			// answered `exists` on a fresh client: a success, on a client nothing destroys.
			// It now fails (a settle records `settlement_ambiguous`); its charge stands.
			if (this.closed) throw err;
			if (this.isConnectionError(err)) {
				await this.reconnect();
				return await fn();
			}
			throw err;
		}
	}

	/**
	 * Derive a deterministic TigerBeetle account ID from a userId via SHA-256
	 * truncation. Uses 128 bits (full TB u128 space) to minimize collision risk.
	 */
	static deriveAccountId(userId: string): bigint {
		const hash = createHash("sha256").update(`wallet:${userId}`).digest("hex");
		return BigInt(`0x${hash.slice(0, 32)}`);
	}

	/**
	 * Cost-center account ids hash the (parent, costCenter) TUPLE — domain-separated from the
	 * "wallet:" namespace and length-prefixed with UTF-8 byte lengths — never a joined string.
	 * Pure and total over strings: no validation, no Unicode normalization (both live at the
	 * doors); normalizing here would alias two byte strings to one account. The length prefixes
	 * are what make ("ab","c") ≠ ("a","bc") regardless of charset, which is what lets parent ids
	 * contain ":" (issue #64). Length prefixes count UTF-8 BYTES. Code-unit counts would be
	 * injective too, but a reimplementation reading "length" the other way derives different ids
	 * for every multibyte parent — silent cross-implementation divergence, which the multibyte
	 * KAT in the test suite pins shut.
	 */
	static deriveCostCenterAccountId(parentUserId: string, costCenter: string): bigint {
		const parent = Buffer.from(parentUserId, "utf8");
		const cc = Buffer.from(costCenter, "utf8");
		const lenParent = Buffer.alloc(4);
		lenParent.writeUInt32BE(parent.length);
		const lenCc = Buffer.alloc(4);
		lenCc.writeUInt32BE(cc.length);
		const digest = createHash("sha256")
			.update(Buffer.concat([COST_CENTER_DOMAIN_TAG, lenParent, parent, lenCc, cc]))
			.digest("hex");
		return BigInt(`0x${digest.slice(0, 32)}`);
	}

	/**
	 * A deterministic TRANSFER id for a caller's durable `(key, role)` — e.g. a hold key and
	 * `"reserve" | "post" | "void"` — so a replay after a crash resubmits the SAME id and
	 * TigerBeetle answers `exists` (every field identical) instead of creating a second
	 * transfer. Same encoding discipline as {@link deriveCostCenterAccountId}: domain tag, then
	 * UTF-8 byte-length-prefixed parts, sha256, first 16 BYTES big-endian. Pure and total; it
	 * never validates or normalizes. The 2^-128-scale chance of a reserved value (0 or
	 * 2^128 - 1) is refused at the door ({@link transferIdOrFresh}), not remapped here.
	 *
	 * Three consequences of a derived id, all enforced by the client:
	 * - `exists` is VERIFIED against the stored transfer before it counts as success
	 *   ({@link TransferReplayMismatchError}) — defence in depth: TigerBeetle 0.17.9 already
	 *   refuses an amount-changing replay with `exists_with_different_amount`.
	 * - A replayed PENDING transfer is never "reserved" ({@link PendingReplayError}): its
	 *   stored record cannot say whether the hold is still live. Re-reserve under a new role
	 *   or deny. Post and void replays are unaffected.
	 * - An id whose FIRST attempt failed is retired for good: TigerBeetle answers
	 *   `id_already_failed` to every later attempt, surfaced as {@link TransferIdRetiredError}.
	 *   Retrying after, say, a top-up cannot succeed under the same `(key, role)` — derive a
	 *   new role (e.g. `"post#2"`) for the new attempt.
	 */
	static deriveTransferId(key: string, role: string): bigint {
		const k = Buffer.from(key, "utf8");
		const r = Buffer.from(role, "utf8");
		const lenK = Buffer.alloc(4);
		lenK.writeUInt32BE(k.length);
		const lenR = Buffer.alloc(4);
		lenR.writeUInt32BE(r.length);
		const digest = createHash("sha256")
			.update(Buffer.concat([TRANSFER_ID_DOMAIN_TAG, lenK, k, lenR, r]))
			.digest("hex");
		return BigInt(`0x${digest.slice(0, 32)}`);
	}

	/**
	 * Create (or return) the balance-enforced wallet for a user id.
	 *
	 * `::` IS QUARANTINED — see {@link LEGACY_COST_CENTER_SEPARATOR}. Not as the
	 * retired derivation reservation: the tuple hash killed that, and no string
	 * passed here is a preimage of any account
	 * {@link TrustTBClient.deriveCostCenterAccountId} produces. It is refused
	 * because on a cluster upgraded from v2.x an unreclaimed legacy cost center
	 * still SITS at `deriveAccountId("parent::cc")` with `CODE_USER_WALLET` and
	 * an ordinary wallet's flags. Without this refusal `createUserWallet`
	 * hashes straight onto it, TigerBeetle answers `exists` (not
	 * `exists_with_different_flags` — the flags match exactly), this method
	 * reads that as success, and the caller's brand-new wallet silently adopts a
	 * stranded cost center's balance. A pending hold voided after the upgrade
	 * re-strands funds there even on a cleanly reclaimed cluster, which is why
	 * the migration alone is not enough.
	 *
	 * Single `:` stays legal (issue #64) — `acct:123` is a wallet id like any
	 * other. Only the doubled separator is quarantined, and it was refused here
	 * on every released version before v3, so nothing legal is lost.
	 *
	 * Ordinary wallet ids and escrow labels still hash through the SAME
	 * `"wallet:"` namespace as each other — see
	 * {@link TrustTBClient.ensureEscrowAccount}, which carries the same refusal
	 * for the same reason — and collide safely only because their differing
	 * account flags make TigerBeetle answer `exists_with_different_flags` rather
	 * than silently sharing a balance.
	 *
	 * There is no `{ derived: true }` opt-in any more: it retired with its last
	 * caller. A cost-center account is reachable only by handing the PAIR to
	 * {@link TrustTBClient.createCostCenterWallet}, so no single string — however
	 * it is punctuated, and whatever flag accompanies it — is a preimage of one.
	 */
	async createUserWallet(userId: string): Promise<bigint> {
		if (userId.includes(LEGACY_COST_CENTER_SEPARATOR)) {
			throw new Error(
				`Invalid userId: "${LEGACY_COST_CENTER_SEPARATOR}" is reserved for pre-v3 cost-center accounts and may not name a wallet`,
			);
		}

		// A cached id is still an answer that the wallet exists: refused once destroyed, as
		// every operation that reaches the ledger is (withReconnect()).
		if (this.closed) throw new LedgerClientClosedError();
		const existing = this.accountMap.get(userId);
		if (existing) return existing;

		const accountId = TrustTBClient.deriveAccountId(userId);
		const account: Account = {
			id: accountId,
			debits_pending: 0n,
			debits_posted: 0n,
			credits_pending: 0n,
			credits_posted: 0n,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
			reserved: 0,
			ledger: LEDGER_USERTOKENS,
			code: CODE_USER_WALLET,
			flags: AccountFlags.debits_must_not_exceed_credits | AccountFlags.history,
			timestamp: 0n,
		};

		const results = await this.withReconnect(() => this.client.createAccounts([account]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			// `exists` is treated as success — the wallet is already present.
			if (res.status !== CreateAccountStatus.created && res.status !== CreateAccountStatus.exists) {
				throw new Error(
					`Failed to create account: ${CreateAccountStatus[res.status] ?? res.status}`,
				);
			}
		}

		this.accountMap.set(userId, accountId);
		return accountId;
	}

	/**
	 * Create (or return) the balance-enforced wallet for a cost center.
	 *
	 * The id comes from {@link TrustTBClient.deriveCostCenterAccountId} — the tuple is
	 * never joined into a string, so no `(parent, costCenter)` pair can reach another
	 * pair's account and no ordinary wallet id can reach any of them. That determinism
	 * is exactly what licenses `exists` as success: the account TigerBeetle reports is
	 * the account this call asked for, so a retry after a socket reset is a no-op
	 * rather than a second wallet. Every `exists_with_different_*` stays a hard failure
	 * — `exists_with_different_flags` is an account missing its
	 * `debits_must_not_exceed_credits` enforcement, which a blanket `try/catch` around
	 * this call would silently accept.
	 *
	 * Validation here is a BELT to the budget path's braces: the derivation is total
	 * over strings, so nothing but this door keeps a control character out of a wallet
	 * that the audit trail then quotes. ASCII is door policy, not a property of the
	 * derivation. The parent rule comes from `parentUserIdRefusal` — one authoritative
	 * source shared with `budget/allocation.ts` — so the `::` quarantine that
	 * {@link TrustTBClient.createUserWallet} applies to wallet ids reaches parent ids
	 * here without a second copy of the rule.
	 *
	 * Deliberately does NOT write `accountMap`: the id is derived, never looked up, and
	 * a cache would only be a second source of truth that a client in another process
	 * does not share.
	 *
	 * @throws Error when either part is outside its charset, when the parent is inside
	 * the quarantined `::` namespace, or when TigerBeetle refuses.
	 */
	async createCostCenterWallet(parentUserId: string, costCenter: string): Promise<bigint> {
		const parentRefusal = parentUserIdRefusal(parentUserId);
		if (parentRefusal !== null) {
			throw new Error(`Invalid parentUserId: ${parentRefusal}`);
		}
		if (typeof costCenter !== "string" || !COST_CENTER_PATTERN.test(costCenter)) {
			throw new Error(`Invalid costCenter: must match ${COST_CENTER_PATTERN.source}`);
		}

		const accountId = TrustTBClient.deriveCostCenterAccountId(parentUserId, costCenter);
		const account: Account = {
			id: accountId,
			debits_pending: 0n,
			debits_posted: 0n,
			credits_pending: 0n,
			credits_posted: 0n,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
			reserved: 0,
			ledger: LEDGER_USERTOKENS,
			code: CODE_USER_WALLET,
			flags: AccountFlags.debits_must_not_exceed_credits | AccountFlags.history,
			timestamp: 0n,
		};

		const results = await this.withReconnect(() => this.client.createAccounts([account]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			// `exists` is treated as success — the wallet is already present.
			if (res.status !== CreateAccountStatus.created && res.status !== CreateAccountStatus.exists) {
				throw new Error(
					`Failed to create cost-center wallet: ${CreateAccountStatus[res.status] ?? res.status}`,
				);
			}
		}

		return accountId;
	}

	setTreasuryId(id: bigint): void {
		this.treasuryId = id;
		this.initialized = true;
	}

	async createTreasury(): Promise<bigint> {
		if (this.treasuryId) {
			const tid = this.treasuryId;
			const accounts = await this.withReconnect(() => this.client.lookupAccounts([tid]));
			if (accounts.length > 0) return this.treasuryId;
		}

		const accountId = this.treasuryId ?? tbId();
		const account: Account = {
			id: accountId,
			debits_pending: 0n,
			debits_posted: 0n,
			credits_pending: 0n,
			credits_posted: 0n,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
			reserved: 0,
			ledger: LEDGER_USERTOKENS,
			code: CODE_PLATFORM_TREASURY,
			flags: AccountFlags.history,
			timestamp: 0n,
		};

		const results = await this.withReconnect(() => this.client.createAccounts([account]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			if (res.status !== CreateAccountStatus.created) {
				throw new Error(
					`Failed to create treasury: ${CreateAccountStatus[res.status] ?? res.status}`,
				);
			}
		}

		this.treasuryId = accountId;
		this.initialized = true;
		return accountId;
	}

	/**
	 * Create (or return) the escrow account for a label.
	 *
	 * `::` IS QUARANTINED here too — see {@link LEGACY_COST_CENTER_SEPARATOR}.
	 * Escrow labels hash through the same {@link TrustTBClient.deriveAccountId}
	 * `"wallet:"` namespace as ordinary wallets, so
	 * `ensureEscrowAccount("parent::cc")` lands on exactly the account an
	 * unreclaimed pre-v3 cost center still occupies on an upgraded cluster. The
	 * flags differ there (escrow carries no `debits_must_not_exceed_credits`),
	 * so THIS door would be told `exists_with_different_flags` and throw — but
	 * the quarantine holds at every door into the namespace rather than at the
	 * ones where a flag mismatch happens to save us, because that is a property
	 * of today's account codes and not of the names. A future escrow account
	 * created with wallet flags, or a legacy account created before the escrow
	 * flags settled, turns the flag mismatch back into a bare `exists` — and an
	 * `exists` read as success is a stranded legacy balance adopted as escrow.
	 *
	 * The real cost-center account space is unreachable from here regardless: it
	 * comes from {@link TrustTBClient.deriveCostCenterAccountId}, a
	 * domain-separated preimage disjoint from `"wallet:"`. Single `:` stays
	 * legal — `escrow:session-1` is an ordinary label.
	 */
	async ensureEscrowAccount(label: string): Promise<bigint> {
		if (label.includes(LEGACY_COST_CENTER_SEPARATOR)) {
			throw new Error(
				`Invalid escrow label: "${LEGACY_COST_CENTER_SEPARATOR}" is reserved for pre-v3 cost-center accounts and may not name an escrow account`,
			);
		}

		const accountId = TrustTBClient.deriveAccountId(label);
		const account: Account = {
			id: accountId,
			debits_pending: 0n,
			debits_posted: 0n,
			credits_pending: 0n,
			credits_posted: 0n,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
			reserved: 0,
			ledger: LEDGER_USERTOKENS,
			code: CODE_ESCROW,
			flags: AccountFlags.history,
			timestamp: 0n,
		};

		const results = await this.withReconnect(() => this.client.createAccounts([account]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			// `exists` is treated as success — the escrow account is already present.
			if (res.status !== CreateAccountStatus.created && res.status !== CreateAccountStatus.exists) {
				throw new Error(
					`Failed to create escrow account: ${CreateAccountStatus[res.status] ?? res.status}`,
				);
			}
		}

		return accountId;
	}

	/**
	 * Create a per-session budget wallet that TigerBeetle balance-enforces.
	 *
	 * The account carries `debits_must_not_exceed_credits` and is seeded with
	 * `seedCredits` usertokens via an ALLOCATION transfer from the treasury (the
	 * mint). Any pending debit against this wallet is atomically REJECTED by TB
	 * once cumulative (debits_pending + debits_posted) would exceed the seed —
	 * surfaced by createPendingTransfer as a {@link TBTransferError}.
	 *
	 * Returns a FRESH, non-deterministic account id (tbId()) every call, so
	 * re-initialising across processes never double-funds a shared deterministic
	 * account (which would inflate the enforced budget on every restart).
	 */
	async createFundedBudgetWallet(seedCredits: number): Promise<bigint> {
		const treasury = this.getTreasuryId(); // throws if treasury not initialized
		const accountId = tbId();
		const account: Account = {
			id: accountId,
			debits_pending: 0n,
			debits_posted: 0n,
			credits_pending: 0n,
			credits_posted: 0n,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
			reserved: 0,
			ledger: LEDGER_USERTOKENS,
			code: CODE_USER_WALLET,
			flags: AccountFlags.debits_must_not_exceed_credits | AccountFlags.history,
			timestamp: 0n,
		};
		const results = await this.withReconnect(() => this.client.createAccounts([account]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			if (res.status !== CreateAccountStatus.created) {
				throw new Error(
					`Failed to create budget wallet: ${CreateAccountStatus[res.status] ?? res.status}`,
				);
			}
		}
		// Fund from the treasury mint. The account id is fresh, so this seeding
		// transfer runs exactly once per wallet.
		const seed = Number.isFinite(seedCredits) && seedCredits > 0 ? Math.floor(seedCredits) : 0;
		if (seed > 0) {
			await this.immediateTransfer({
				debitAccountId: treasury,
				creditAccountId: accountId,
				amount: seed,
				code: XFER_ALLOCATION,
			});
		}
		return accountId;
	}

	setAccountMapping(userId: string, accountId: bigint): void {
		this.accountMap.set(userId, accountId);
	}

	getAccountId(userId: string): bigint {
		const id = this.accountMap.get(userId);
		if (!id) throw new Error(`No TigerBeetle account for user: ${userId}`);
		return id;
	}

	getTreasuryId(): bigint {
		if (!this.treasuryId) throw new Error("Treasury not initialized");
		return this.treasuryId;
	}

	/**
	 * A caller-supplied id answered `exists`: confirm the STORED transfer is the one `submitted`
	 * describes before treating it as success (see {@link TransferReplayMismatchError}). A
	 * submitted field TigerBeetle fills in from the pending transfer (0 ids/ledger/code/user
	 * data on a post or void, `amount_max` or 0 for the amount) is skipped; every other field
	 * must match exactly. A minted id needs none of this: its only replay is a reconnect retry
	 * of the identical transfer.
	 */
	private async assertReplayMatches(submitted: Transfer): Promise<void> {
		const stored = await this.lookupTransfer(submitted.id);
		if (!stored) throw new TransferReplayMismatchError(submitted.id, "record (none found)");
		const resolvesPending =
			(submitted.flags &
				(TransferFlags.post_pending_transfer | TransferFlags.void_pending_transfer)) !==
			0;
		const inherited = (v: bigint | number) => resolvesPending && (v === 0n || v === 0);
		const checks: Array<[string, bigint | number, bigint | number]> = [
			["flags", submitted.flags, stored.flags],
			["pending_id", submitted.pending_id, stored.pending_id],
			["debit_account_id", submitted.debit_account_id, stored.debit_account_id],
			["credit_account_id", submitted.credit_account_id, stored.credit_account_id],
			["ledger", submitted.ledger, stored.ledger],
			["code", submitted.code, stored.code],
			["timeout", submitted.timeout, stored.timeout],
			["user_data_128", submitted.user_data_128, stored.user_data_128],
			["user_data_64", submitted.user_data_64, stored.user_data_64],
			["user_data_32", submitted.user_data_32, stored.user_data_32],
		];
		for (const [field, want, got] of checks) {
			if (inherited(want)) continue;
			if (want !== got) throw new TransferReplayMismatchError(submitted.id, field);
		}
		// amount_max (post) and 0 (void) mean "whatever the pending transfer holds".
		const amountInherited =
			resolvesPending && (submitted.amount === amount_max || submitted.amount === 0n);
		if (!amountInherited && submitted.amount !== stored.amount) {
			throw new TransferReplayMismatchError(submitted.id, "amount");
		}
	}

	/**
	 * The shared `exists` / `id_already_failed` handling for a caller-supplied id. Returns
	 * normally when the result is a verified success; throws otherwise. Callers keep their
	 * own message for every other status.
	 */
	private async settleCallerSuppliedStatus(status: number, submitted: Transfer): Promise<void> {
		if (status === CreateTransferStatus.id_already_failed) {
			throw new TransferIdRetiredError(submitted.id);
		}
		if (status === CreateTransferStatus.exists) await this.assertReplayMatches(submitted);
	}

	async createPendingTransfer(p: {
		debitAccountId: bigint;
		creditAccountId: bigint;
		amount: number;
		code: number;
		timeoutSeconds?: number;
		userData128?: bigint;
		userData64?: bigint;
		userData32?: number;
		/** Caller-supplied id for cross-restart idempotency; minted fresh when omitted. */
		transferId?: bigint;
	}): Promise<bigint> {
		// Decided ONCE, synchronously, before any await: re-reading `p.transferId` after the
		// await would let a caller that mutates its options mid-call skip verification.
		const callerSupplied = p.transferId !== undefined;
		const transferId = transferIdOrFresh(p.transferId);
		const transfer: Transfer = {
			id: transferId,
			debit_account_id: p.debitAccountId,
			credit_account_id: p.creditAccountId,
			amount: BigInt(p.amount),
			pending_id: 0n,
			user_data_128: p.userData128 ?? 0n,
			user_data_64: p.userData64 ?? 0n,
			user_data_32: p.userData32 ?? 0,
			timeout: p.timeoutSeconds ?? 300,
			ledger: LEDGER_USERTOKENS,
			code: p.code,
			flags: TransferFlags.pending,
			timestamp: 0n,
		};

		const results = await this.withReconnect(() => this.client.createTransfers([transfer]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			// A caller-supplied id: `exists` must be VERIFIED, and a retired id is its own error.
			if (callerSupplied) {
				await this.settleCallerSuppliedStatus(res.status, transfer);
				// Verified, and still a REPLAY: a pending record cannot say whether the hold is
				// live, spent, released or expired, so it is never reported as reserved.
				if (res.status === CreateTransferStatus.exists) {
					throw new PendingReplayError(transferId);
				}
			}
			// `exists` IS SUCCESS HERE. transferId is fixed above, OUTSIDE the
			// withReconnect closure (minted, or supplied by a caller replaying a durable
			// intent), so a retry or replay resubmits the same id; TigerBeetle
			// deduplicates on it and answers `exists` only when every field of the
			// submitted transfer matches the one already
			// committed (a mismatch is a distinct exists_with_different_* code that
			// still throws). Receiving it is therefore proof the reservation landed.
			// Throwing would report a failed reservation against funds TB is already
			// holding pending — nobody would ever post or void them, and the hold would
			// sit on the wallet until its timeout expires.
			if (
				res.status !== CreateTransferStatus.created &&
				res.status !== CreateTransferStatus.exists
			) {
				throw new TBTransferError(
					res.status,
					`Pending transfer failed: ${CreateTransferStatus[res.status] ?? res.status}`,
				);
			}
		}
		return transferId;
	}

	async postTransfer(
		pendingId: bigint,
		amount?: number,
		opts?: { transferId?: bigint },
	): Promise<bigint> {
		const callerSupplied = opts?.transferId !== undefined; // decided before any await
		const postId = transferIdOrFresh(opts?.transferId);
		const transfer: Transfer = {
			id: postId,
			debit_account_id: 0n,
			credit_account_id: 0n,
			amount: amount != null ? BigInt(amount) : amount_max,
			pending_id: pendingId,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
			timeout: 0,
			ledger: 0,
			code: 0,
			flags: TransferFlags.post_pending_transfer,
			timestamp: 0n,
		};

		const results = await this.withReconnect(() => this.client.createTransfers([transfer]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			// A caller-supplied id: `exists` must be VERIFIED, and a retired id is its own error.
			if (callerSupplied) await this.settleCallerSuppliedStatus(res.status, transfer);
			// `exists` IS SUCCESS HERE. postId is fixed above, OUTSIDE the
			// withReconnect closure (minted, or supplied by a caller replaying a durable
			// intent), so a retry or replay resubmits the same id; TigerBeetle
			// deduplicates on it and answers `exists` only when every field of the
			// submitted transfer matches the one already
			// committed (a mismatch is a distinct exists_with_different_* code that
			// still throws). Receiving it is therefore proof the debit settled.
			// Throwing would report a failed settlement for money that moved — and the
			// governor, seeing failure, would void a pending transfer that is already
			// posted, leaving the ledger holding a debit its accounting does not.
			if (
				res.status !== CreateTransferStatus.created &&
				res.status !== CreateTransferStatus.exists
			) {
				throw new TBTransferError(
					res.status,
					`Post transfer failed: ${CreateTransferStatus[res.status] ?? res.status}`,
				);
			}
		}
		return postId;
	}

	async voidTransfer(pendingId: bigint, opts?: { transferId?: bigint }): Promise<bigint> {
		const callerSupplied = opts?.transferId !== undefined; // decided before any await
		const voidId = transferIdOrFresh(opts?.transferId);
		const transfer: Transfer = {
			id: voidId,
			debit_account_id: 0n,
			credit_account_id: 0n,
			amount: 0n,
			pending_id: pendingId,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
			timeout: 0,
			ledger: 0,
			code: 0,
			flags: TransferFlags.void_pending_transfer,
			timestamp: 0n,
		};

		const results = await this.withReconnect(() => this.client.createTransfers([transfer]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			// A caller-supplied id: `exists` must be VERIFIED, and a retired id is its own error.
			if (callerSupplied) await this.settleCallerSuppliedStatus(res.status, transfer);
			// `exists` IS SUCCESS HERE. voidId is fixed above, OUTSIDE the
			// withReconnect closure (minted, or supplied by a caller replaying a durable
			// intent), so a retry or replay resubmits the same id; TigerBeetle
			// deduplicates on it and answers `exists` only when every field of the
			// submitted transfer matches the one already
			// committed (a mismatch is a distinct exists_with_different_* code that
			// still throws). Receiving it is therefore proof the hold was released.
			// Throwing would fail the caller's cleanup path over a reservation TB has
			// already returned, and a retry could only ever fail again.
			if (
				res.status !== CreateTransferStatus.created &&
				res.status !== CreateTransferStatus.exists
			) {
				// A TBTransferError like every other transfer path, so a caller can tell an
				// already-expired hold (pending_transfer_expired) from a real failure by code.
				throw new TBTransferError(
					res.status,
					`Void transfer failed: ${CreateTransferStatus[res.status] ?? res.status}`,
				);
			}
		}
		return voidId;
	}

	async immediateTransfer(p: {
		debitAccountId: bigint;
		creditAccountId: bigint;
		amount: number;
		code: number;
		transferId?: bigint;
		userData128?: bigint;
		userData64?: bigint;
		userData32?: number;
	}): Promise<bigint> {
		// Decided ONCE, synchronously, before any await (as on the other transfer paths).
		const callerSupplied = p.transferId !== undefined;
		// The same range check as the sibling transfer paths (#183): 0, 2^128 - 1 and anything
		// outside (0, 2^128 - 1) throw RangeError before any client call.
		const transferId = transferIdOrFresh(p.transferId);
		const transfer: Transfer = {
			id: transferId,
			debit_account_id: p.debitAccountId,
			credit_account_id: p.creditAccountId,
			amount: BigInt(p.amount),
			pending_id: 0n,
			user_data_128: p.userData128 ?? 0n,
			user_data_64: p.userData64 ?? 0n,
			user_data_32: p.userData32 ?? 0,
			timeout: 0,
			ledger: LEDGER_USERTOKENS,
			code: p.code,
			flags: 0,
			timestamp: 0n,
		};

		const results = await this.withReconnect(() => this.client.createTransfers([transfer]));
		if (results.length > 0) {
			const res = results[0];
			if (!res) throw new Error("Unknown account/transfer error");
			// A caller-supplied id: `exists` is VERIFIED against the stored transfer, and a
			// retired id (`id_already_failed`) is TransferIdRetiredError — the same contract as
			// createPendingTransfer, postTransfer and voidTransfer (#178).
			if (callerSupplied) await this.settleCallerSuppliedStatus(res.status, transfer);
			// `exists` IS SUCCESS HERE. The transfer id is generated above, OUTSIDE the
			// withReconnect closure, so a retry after a connection error resubmits the
			// same unique id; TigerBeetle deduplicates on it and answers `exists`, which
			// it returns only when every field of the submitted transfer matches the one
			// already committed (a mismatch is a distinct exists_with_different_* code
			// that still throws). Receiving it is therefore proof our transfer landed.
			// Throwing would report failure for money that moved — and a caller retrying
			// that "failure" would double-allocate.
			if (
				res.status !== CreateTransferStatus.created &&
				res.status !== CreateTransferStatus.exists
			) {
				throw new TBTransferError(
					res.status,
					`Transfer failed: ${CreateTransferStatus[res.status] ?? res.status}`,
				);
			}
		}
		return transferId;
	}

	async lookupTransfer(transferId: bigint): Promise<Transfer | null> {
		const transfers = await this.withReconnect(() => this.client.lookupTransfers([transferId]));
		return transfers.length > 0 ? (transfers[0] as Transfer) : null;
	}

	async lookupAccounts(accountIds: bigint[]): Promise<Account[]> {
		return await this.withReconnect(() => this.client.lookupAccounts(accountIds));
	}

	async lookupBalance(accountId: bigint): Promise<{
		available: number;
		pending: number;
		total: number;
	}> {
		const accounts = await this.withReconnect(() => this.client.lookupAccounts([accountId]));
		if (accounts.length === 0) throw new Error(`Account not found: ${accountId}`);
		return accountBalance(accounts[0] as Account);
	}

	/**
	 * Batched {@link TrustTBClient.lookupBalance}: one `lookupAccounts` round trip for
	 * every account in `accountIds`, sharing the exact same per-account computation (and
	 * its overflow guards) via {@link accountBalance} — never a hand-rolled second copy.
	 *
	 * Two deliberate differences from the single-account method, both required by its
	 * callers (budget/context.ts's envelope reads): a missing account is ABSENT from the
	 * returned map rather than throwing — "never allocated" and "fully reclaimed" are the
	 * same observable state with no registry, so the caller's implicit-zero reading is
	 * `balances.get(id) ?? 0`, never a per-account try/catch; and only the `available`
	 * figure is returned, since that is all any caller of the batch path needs.
	 *
	 * Results are matched to requests by `Account.id`, never by array position — TB is not
	 * documented to preserve request order, and index-matching would silently mispair
	 * balances the moment it didn't.
	 *
	 * Duplicate input ids are deduped before the round trip: TigerBeetle is queried once
	 * per unique id, which is also what keeps this to exactly ONE `lookupAccounts` call
	 * regardless of how many times a caller repeats an id. Empty input short-circuits
	 * before any I/O — there is nothing to look up and no reason to open a round trip.
	 */
	async lookupBalances(accountIds: bigint[]): Promise<Map<bigint, number>> {
		// Refused once destroyed, before the empty-input shortcut, like every lookup.
		if (this.closed) throw new LedgerClientClosedError();
		if (accountIds.length === 0) return new Map();
		const uniqueIds = [...new Set(accountIds)];
		const accounts = await this.withReconnect(() => this.client.lookupAccounts(uniqueIds));
		const balances = new Map<bigint, number>();
		for (const acct of accounts as Account[]) {
			balances.set(acct.id, accountBalance(acct).available);
		}
		return balances;
	}

	async ping(): Promise<boolean> {
		// A destroyed client is not healthy, its start-up grace period included.
		if (this.closed) return false;
		try {
			if (!this.initialized || !this.treasuryId) {
				return Date.now() - this.startedAt < this.initGraceMs;
			}
			const tid = this.treasuryId;
			const accounts = await this.withReconnect(() => this.client.lookupAccounts([tid]));
			return accounts.length > 0;
		} catch {
			return false;
		}
	}

	destroy(): void {
		// First, so this client is closed even if the native destroy below throws: it is native
		// and unguarded, and a throw there leaves the native client open. The rejections it
		// causes for requests in flight reach withReconnect() only later, as promise reactions.
		this.closed = true;
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}
		this.client.destroy();
	}
}
