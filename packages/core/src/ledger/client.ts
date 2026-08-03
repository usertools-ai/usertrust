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
import { COST_CENTER_PATTERN, PARENT_USER_ID_PATTERN, tbId } from "../shared/ids.js";

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
		if (this.reconnectPromise) return this.reconnectPromise;
		this.reconnectPromise = this._doReconnect().finally(() => {
			this.reconnectPromise = null;
		});
		return this.reconnectPromise;
	}

	private async _doReconnect(): Promise<void> {
		const maxRetries = 5;
		for (let attempt = 0; attempt < maxRetries; attempt++) {
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
		try {
			return await fn();
		} catch (err) {
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
	 * Create (or return) the balance-enforced wallet for a user id.
	 *
	 * `::` is no longer refused here. The real cost-center account space comes
	 * from {@link TrustTBClient.deriveCostCenterAccountId}, which hashes the
	 * `(parent, costCenter)` pair through a domain-separated preimage
	 * (`COST_CENTER_DOMAIN_TAG`, prefix-disjoint from this method's `"wallet:"`
	 * tag) — so no string an ordinary caller can pass, `::`-laden or not, can
	 * ever reach it. That domain separation is what makes the derivation
	 * collision-free now, not a reserved separator.
	 *
	 * Ordinary wallet ids and escrow labels still hash through the SAME
	 * `"wallet:"` namespace as each other — see
	 * {@link TrustTBClient.ensureEscrowAccount} — and collide safely only
	 * because their differing account flags make TigerBeetle answer
	 * `exists_with_different_flags` rather than silently sharing a balance.
	 *
	 * There is no `{ derived: true }` opt-in any more: it retired with its last
	 * caller. A cost-center account is reachable only by handing the PAIR to
	 * {@link TrustTBClient.createCostCenterWallet}, so no single string — however
	 * it is punctuated, and whatever flag accompanies it — is a preimage of one.
	 */
	async createUserWallet(userId: string): Promise<bigint> {
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
	 * derivation.
	 *
	 * Deliberately does NOT write `accountMap`: the id is derived, never looked up, and
	 * a cache would only be a second source of truth that a client in another process
	 * does not share.
	 *
	 * @throws Error when either part is outside its charset, or TigerBeetle refuses.
	 */
	async createCostCenterWallet(parentUserId: string, costCenter: string): Promise<bigint> {
		if (typeof parentUserId !== "string" || !PARENT_USER_ID_PATTERN.test(parentUserId)) {
			throw new Error(`Invalid parentUserId: must match ${PARENT_USER_ID_PATTERN.source}`);
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
	 * `::` is no longer refused here. Escrow labels hash through the same
	 * {@link TrustTBClient.deriveAccountId} `"wallet:"` namespace as ordinary
	 * wallets — see {@link TrustTBClient.createUserWallet} — and collide safely
	 * only because their differing account flags (escrow carries no
	 * `debits_must_not_exceed_credits`) make TigerBeetle answer
	 * `exists_with_different_flags` rather than silently sharing a balance. The
	 * real cost-center account space is unreachable from here regardless: it
	 * comes from {@link TrustTBClient.deriveCostCenterAccountId}, a
	 * domain-separated preimage disjoint from `"wallet:"`, so no escrow label
	 * can ever resolve to a cost center's wallet.
	 */
	async ensureEscrowAccount(label: string): Promise<bigint> {
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

	async createPendingTransfer(p: {
		debitAccountId: bigint;
		creditAccountId: bigint;
		amount: number;
		code: number;
		timeoutSeconds?: number;
		userData128?: bigint;
		userData64?: bigint;
		userData32?: number;
	}): Promise<bigint> {
		const transferId = tbId();
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
			// `exists` IS SUCCESS HERE. transferId is generated above, OUTSIDE the
			// withReconnect closure, so a retry after a connection error resubmits the
			// same unique id; TigerBeetle deduplicates on it and answers `exists` only
			// when every field of the submitted transfer matches the one already
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

	async postTransfer(pendingId: bigint, amount?: number): Promise<bigint> {
		const postId = tbId();
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
			// `exists` IS SUCCESS HERE. postId is generated above, OUTSIDE the
			// withReconnect closure, so a retry after a connection error resubmits the
			// same unique id; TigerBeetle deduplicates on it and answers `exists` only
			// when every field of the submitted transfer matches the one already
			// committed (a mismatch is a distinct exists_with_different_* code that
			// still throws). Receiving it is therefore proof the debit settled.
			// Throwing would report a failed settlement for money that moved — and the
			// governor, seeing failure, would void a pending transfer that is already
			// posted, leaving the ledger holding a debit its accounting does not.
			if (
				res.status !== CreateTransferStatus.created &&
				res.status !== CreateTransferStatus.exists
			) {
				throw new Error(`Post transfer failed: ${CreateTransferStatus[res.status] ?? res.status}`);
			}
		}
		return postId;
	}

	async voidTransfer(pendingId: bigint): Promise<bigint> {
		const voidId = tbId();
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
			// `exists` IS SUCCESS HERE. voidId is generated above, OUTSIDE the
			// withReconnect closure, so a retry after a connection error resubmits the
			// same unique id; TigerBeetle deduplicates on it and answers `exists` only
			// when every field of the submitted transfer matches the one already
			// committed (a mismatch is a distinct exists_with_different_* code that
			// still throws). Receiving it is therefore proof the hold was released.
			// Throwing would fail the caller's cleanup path over a reservation TB has
			// already returned, and a retry could only ever fail again.
			if (
				res.status !== CreateTransferStatus.created &&
				res.status !== CreateTransferStatus.exists
			) {
				throw new Error(`Void transfer failed: ${CreateTransferStatus[res.status] ?? res.status}`);
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
		const transferId = p.transferId ?? tbId();
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
		const acct = accounts[0] as Account;
		const postedBig = acct.credits_posted - acct.debits_posted;
		if (
			postedBig > BigInt(Number.MAX_SAFE_INTEGER) ||
			postedBig < -BigInt(Number.MAX_SAFE_INTEGER)
		) {
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

	async ping(): Promise<boolean> {
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
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}
		this.client.destroy();
	}
}
