/**
 * Two-phase spend engine for the @usertools/govern SDK.
 * Implements PENDING -> POST/VOID lifecycle for all governed operations.
 *
 * Extracted from usertools platform TokenEngineImpl.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CreateTransferError } from "tigerbeetle-node";
import { DEFAULT_HOLD_TTL_MS } from "../shared/constants.js";
import { InsufficientBalanceError } from "../shared/errors.js";
import { fnv1a32 } from "../shared/ids.js";
import type { GovernTBClient, TBTransferError } from "./client.js";
import { XFER_SPEND } from "./client.js";
import { type ModelRates, PRICING_TABLE, estimateCost } from "./pricing.js";

// ── Types ──

export interface SpendAction {
	type: "ai_compute";
	model: string;
	inputTokens: number;
	outputTokens: number;
}

export interface TransferResult {
	transferId: string;
	debitAccountId: string;
	creditAccountId: string;
	amount: number;
	timestamp: string;
	pending: boolean;
}

export interface PricingTable {
	[model: string]: ModelRates;
}

export interface GovernEngineOptions {
	tbClient: GovernTBClient;
	pricing?: PricingTable;
	/** Hold timeout in milliseconds (default: 5 minutes) */
	holdTtlMs?: number;
	/** DLQ directory path (default: .usertools/dlq/) */
	dlqPath?: string;
}

// ── DLQ ──

interface DLQEntry {
	timestamp: string;
	source: string;
	transferId: string;
	payload: Record<string, unknown>;
	error: string;
}

function writeDeadLetter(entry: DLQEntry, dlqPath: string): void {
	try {
		if (!existsSync(dlqPath)) {
			mkdirSync(dlqPath, { recursive: true });
		}
		const line = `${JSON.stringify(entry)}\n`;
		const filePath = join(dlqPath, "dead-letter.jsonl");
		writeFileSync(filePath, line, { flag: "a" });
	} catch (err) {
		console.error("[govern] Failed to write dead letter:", err);
	}
}

// ── Helpers ──

/** Derive a 64-bit user fingerprint for user_data_64 on transfers. */
function deriveUserId64(userId: string): bigint {
	const hash = createHash("sha256").update(userId).digest("hex");
	return BigInt(`0x${hash.slice(0, 16)}`);
}

/** Check whether a caught error is a TigerBeetle insufficient-balance rejection. */
function isInsufficientBalanceError(err: unknown): err is TBTransferError {
	if (err == null || typeof err !== "object") return false;
	if (!("code" in err) || !("name" in err)) return false;
	const e = err as { code: number; name: string };
	return (
		e.name === "TBTransferError" &&
		(e.code === CreateTransferError.exceeds_credits ||
			e.code === CreateTransferError.overflows_debits ||
			e.code === CreateTransferError.overflows_debits_pending)
	);
}

// ── Engine ──

export class GovernEngine {
	private tb: GovernTBClient;
	private holdTtlMs: number;
	private dlqPath: string;

	constructor(opts: GovernEngineOptions) {
		this.tb = opts.tbClient;
		this.holdTtlMs = opts.holdTtlMs ?? DEFAULT_HOLD_TTL_MS;
		this.dlqPath = opts.dlqPath ?? join(".usertools", "dlq");
	}

	/**
	 * Create a PENDING hold for an AI compute action.
	 * The hold reserves tokens until settled (POST) or released (VOID).
	 */
	async spendPending(p: {
		userId: string;
		action: SpendAction;
		metadata?: { agentRef?: string };
	}): Promise<TransferResult> {
		const cost = estimateCost(p.action.model, p.action.inputTokens, p.action.outputTokens);
		const userAccount = this.tb.getAccountId(p.userId);
		const treasury = this.tb.getTreasuryId();

		const bal = await this.tb.lookupBalance(userAccount);
		if (bal.available < cost) {
			throw new InsufficientBalanceError(p.userId, cost, bal.available);
		}

		const holdTimeoutSeconds = Math.ceil(this.holdTtlMs / 1000);

		let pendingId: bigint;
		try {
			pendingId = await this.tb.createPendingTransfer({
				debitAccountId: userAccount,
				creditAccountId: treasury,
				amount: cost,
				code: XFER_SPEND,
				timeoutSeconds: holdTimeoutSeconds,
				userData64: deriveUserId64(p.userId),
				...(p.metadata?.agentRef ? { userData32: fnv1a32(p.metadata.agentRef) } : {}),
			});
		} catch (err) {
			if (isInsufficientBalanceError(err)) {
				throw new InsufficientBalanceError(p.userId, cost, 0);
			}
			throw err;
		}

		return {
			transferId: pendingId.toString(),
			debitAccountId: userAccount.toString(),
			creditAccountId: treasury.toString(),
			amount: cost,
			timestamp: new Date().toISOString(),
			pending: true,
		};
	}

	/**
	 * Settle a PENDING hold — debit is finalized.
	 * Optionally pass actual amount if less than the hold.
	 */
	async postPendingSpend(transferId: string, actualAmount?: number): Promise<void> {
		try {
			await this.tb.postTransfer(BigInt(transferId), actualAmount);
		} catch (err) {
			// Post may have succeeded on TB but timed out — try to void
			let voidSucceeded = false;
			try {
				await this.tb.voidTransfer(BigInt(transferId));
				voidSucceeded = true;
			} catch {
				// Both post and void failed — transfer state is ambiguous
				writeDeadLetter(
					{
						timestamp: new Date().toISOString(),
						source: "engine.postPendingSpend.ambiguous",
						transferId,
						payload: { actualAmount },
						error: "Both post and void failed — transfer state ambiguous",
					},
					this.dlqPath,
				);
				throw new Error(`Spend settlement ambiguous for transfer ${transferId}`);
			}
			if (voidSucceeded) {
				throw new Error("Spend failed: pending transfer voided after post failure");
			}
		}
	}

	/**
	 * Release a PENDING hold — tokens returned to the user's available balance.
	 */
	async voidPendingSpend(transferId: string): Promise<void> {
		await this.tb.voidTransfer(BigInt(transferId));
	}

	/**
	 * Query balance for a user.
	 */
	async balance(userId: string): Promise<{
		available: number;
		pending: number;
		total: number;
	}> {
		const accountId = this.tb.getAccountId(userId);
		return await this.tb.lookupBalance(accountId);
	}
}
