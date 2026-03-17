/**
 * TigerBeetle client wrapper for the @usertools/govern SDK.
 * Extracted from usertools platform — provides account/transfer CRUD
 * with reconnect logic and deterministic account IDs.
 */

import { createHash } from "node:crypto";
import type { Account, Transfer } from "tigerbeetle-node";
import {
	AccountFlags,
	CreateAccountError,
	CreateTransferError,
	TransferFlags,
	amount_max,
	createClient,
} from "tigerbeetle-node";
import { tbId } from "../shared/ids.js";

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

export interface GovernTBClientOptions {
	addresses: string[];
	clusterId?: bigint;
	/** Optional callback invoked on connection issues (replaces sendAlert) */
	onAlert?: (message: string, meta: Record<string, unknown>) => void;
}

export class GovernTBClient {
	private client: ReturnType<typeof createClient>;
	private accountMap = new Map<string, bigint>();
	private treasuryId: bigint | undefined;
	private initialized = false;
	private readonly startedAt = Date.now();
	private readonly initGraceMs = 60_000;
	private opts: Required<Pick<GovernTBClientOptions, "addresses" | "clusterId">>;
	private onAlert?: (message: string, meta: Record<string, unknown>) => void;
	private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
	private reconnectPromise: Promise<void> | null = null;

	constructor(opts: GovernTBClientOptions) {
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
						console.warn(`[govern] ${msg}`, meta);
					}
				}),
			);
		}, 30_000);
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
						console.warn(`[govern] ${msg}`);
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

	async createUserWallet(userId: string): Promise<bigint> {
		const existing = this.accountMap.get(userId);
		if (existing) return existing;

		const accountId = GovernTBClient.deriveAccountId(userId);
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

		const errors = await this.withReconnect(() => this.client.createAccounts([account]));
		if (errors.length > 0) {
			const err = errors[0];
			if (!err) throw new Error("Unknown account/transfer error");
			if (err.result === CreateAccountError.exists) {
				this.accountMap.set(userId, accountId);
				return accountId;
			}
			throw new Error(`Failed to create account: ${CreateAccountError[err.result] ?? err.result}`);
		}

		this.accountMap.set(userId, accountId);
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

		const errors = await this.withReconnect(() => this.client.createAccounts([account]));
		if (errors.length > 0) {
			const err = errors[0];
			if (!err) throw new Error("Unknown account/transfer error");
			throw new Error(`Failed to create treasury: ${CreateAccountError[err.result] ?? err.result}`);
		}

		this.treasuryId = accountId;
		this.initialized = true;
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

		const errors = await this.withReconnect(() => this.client.createTransfers([transfer]));
		if (errors.length > 0) {
			const err = errors[0];
			if (!err) throw new Error("Unknown account/transfer error");
			throw new TBTransferError(
				err.result,
				`Pending transfer failed: ${CreateTransferError[err.result] ?? err.result}`,
			);
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

		const errors = await this.withReconnect(() => this.client.createTransfers([transfer]));
		if (errors.length > 0) {
			const err = errors[0];
			if (!err) throw new Error("Unknown account/transfer error");
			throw new Error(`Post transfer failed: ${CreateTransferError[err.result] ?? err.result}`);
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

		const errors = await this.withReconnect(() => this.client.createTransfers([transfer]));
		if (errors.length > 0) {
			const err = errors[0];
			if (!err) throw new Error("Unknown account/transfer error");
			throw new Error(`Void transfer failed: ${CreateTransferError[err.result] ?? err.result}`);
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

		const errors = await this.withReconnect(() => this.client.createTransfers([transfer]));
		if (errors.length > 0) {
			const err = errors[0];
			if (!err) throw new Error("Unknown account/transfer error");
			throw new TBTransferError(
				err.result,
				`Transfer failed: ${CreateTransferError[err.result] ?? err.result}`,
			);
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
