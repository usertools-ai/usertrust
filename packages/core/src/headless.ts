// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * headless.ts — Headless Governance API
 *
 * A two-phase lifecycle API (authorize → settle/abort) for governing
 * LLM calls WITHOUT requiring a provider SDK client instance.
 *
 * This is the integration surface for non-SDK environments like OpenClaw
 * (which uses pi-ai streaming) or any system that makes raw LLM calls.
 *
 * Usage:
 * ```ts
 * import { createGovernor } from "usertrust/headless";
 *
 * const governor = await createGovernor({ dryRun: true, budget: 100_000 });
 *
 * const auth = await governor.authorize({
 *   model: "claude-sonnet-4-6",
 *   estimatedInputTokens: 500,
 *   maxOutputTokens: 4096,
 * });
 *
 * try {
 *   // ... make the LLM call, accumulate usage ...
 *   const receipt = await governor.settle(auth, {
 *     inputTokens: actualInput,
 *     outputTokens: actualOutput,
 *   });
 * } catch (err) {
 *   await governor.abort(auth, err);
 *   throw err;
 * }
 *
 * await governor.destroy();
 * ```
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AuditWriter, createAuditWriter } from "./audit/chain.js";
import { writeReceipt } from "./audit/rotation.js";
import type { TrustEngine, TrustOpts } from "./govern.js";
import { TrustTBClient, XFER_SPEND } from "./ledger/client.js";
import { estimateCost, estimateInputTokens } from "./ledger/pricing.js";
import { recordPattern } from "./memory/patterns.js";
import { type GateRule, evaluatePolicy, loadPolicies } from "./policy/gate.js";
import { detectPII } from "./policy/pii.js";
import { type ProxyConnection, connectProxy } from "./proxy.js";
import { CircuitBreakerRegistry } from "./resilience/circuit.js";
import { DEFAULT_BUDGET, VAULT_DIR } from "./shared/constants.js";
import { LedgerUnavailableError, PolicyDeniedError } from "./shared/errors.js";
import { trustId } from "./shared/ids.js";
import { TrustConfigSchema } from "./shared/types.js";
import type { TrustConfig, TrustReceipt } from "./shared/types.js";

// ── Public types ──

/** Handle returned by authorize(), passed to settle() or abort(). */
export interface Authorization {
	transferId: string;
	estimatedCost: number;
	model: string;
	/** The proxy's transferId when in proxy mode. */
	proxyTransferId?: string | undefined;
	/** @internal Timestamp when authorization was created. */
	createdAt: number;
}

/** Parameters for authorizing an LLM call. */
export interface AuthorizeParams {
	/** Model identifier (e.g., "claude-sonnet-4-6"). */
	model: string;
	/** Estimated input token count. If omitted, estimated from messages. */
	estimatedInputTokens?: number | undefined;
	/** Max output tokens for cost estimation. Defaults to 4096. */
	maxOutputTokens?: number | undefined;
	/** Messages array for PII detection and input token estimation. */
	messages?: unknown[] | undefined;
	/** Additional parameters for policy evaluation. */
	params?: Record<string, unknown> | undefined;
	/** Actor identity. Defaults to "local". */
	actor?: string | undefined;
}

/** Parameters for settling an authorized call. */
export interface SettleParams {
	/** Actual input tokens consumed. If omitted, uses the pre-call estimate. */
	inputTokens?: number | undefined;
	/** Actual output tokens consumed. */
	outputTokens?: number | undefined;
	/** Number of streaming chunks delivered (for streaming calls). */
	chunksDelivered?: number | undefined;
	/** Whether usage came from the provider or our estimate. */
	usageSource?: "provider" | "estimated" | undefined;
}

/** Headless governance engine for non-SDK integrations. */
export interface Governor {
	/**
	 * Phase 1: Authorize an LLM call.
	 * Checks budget, evaluates policy, creates PENDING hold.
	 * Returns an Authorization handle for settle() or abort().
	 */
	authorize(params: AuthorizeParams): Promise<Authorization>;

	/**
	 * Phase 2a: Settle a successful call.
	 * POSTs the pending hold, writes audit event, returns receipt.
	 */
	settle(auth: Authorization, params?: SettleParams): Promise<TrustReceipt>;

	/**
	 * Phase 2b: Abort a failed call.
	 * VOIDs the pending hold, writes failure audit.
	 */
	abort(auth: Authorization, error?: unknown): Promise<void>;

	/** Graceful shutdown — voids all pending holds, flushes audit. */
	destroy(): Promise<void>;

	/** Estimate cost in usertokens for a model call. */
	estimateCost(model: string, inputTokens: number, outputTokens: number): number;

	/** Estimate input token count from a messages array. */
	estimateInputTokens(messages: unknown[]): number;

	/** Current budget remaining (budget - spent - in-flight holds). */
	budgetRemaining(): number;

	/** The loaded configuration. */
	readonly config: Readonly<TrustConfig>;
}

// ── Verify URL base ──

const VERIFY_URL_BASE = "https://verify.usertrust.dev";

// ── Async mutex (same as govern.ts AUD-453) ──

class AsyncMutex {
	private queue: Promise<void> = Promise.resolve();

	async acquire(): Promise<() => void> {
		let release: (() => void) | undefined;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const prev = this.queue;
		this.queue = next;
		await prev;
		return release as () => void;
	}
}

// ── Budget persistence (same as govern.ts AUD-457) ──

interface SpendLedger {
	budgetSpent: number;
	updatedAt: string;
}

async function loadSpendLedger(vaultBase: string): Promise<number> {
	const ledgerPath = join(vaultBase, VAULT_DIR, "spend-ledger.json");
	try {
		const raw = await readFile(ledgerPath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed != null &&
			typeof parsed === "object" &&
			"budgetSpent" in parsed &&
			typeof (parsed as SpendLedger).budgetSpent === "number"
		) {
			const value = (parsed as SpendLedger).budgetSpent;
			if (Number.isFinite(value) && value >= 0) {
				return value;
			}
		}
	} catch {
		// No ledger file or corrupt — start from zero
	}
	return 0;
}

async function persistSpendLedger(vaultBase: string, budgetSpent: number): Promise<void> {
	const dir = join(vaultBase, VAULT_DIR);
	const ledgerPath = join(dir, "spend-ledger.json");
	const tmpPath = join(dir, "spend-ledger.json.tmp");
	const data: SpendLedger = {
		budgetSpent,
		updatedAt: new Date().toISOString(),
	};
	try {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		await writeFile(tmpPath, JSON.stringify(data), "utf-8");
		await rename(tmpPath, ledgerPath);
	} catch {
		// Best-effort — do not fail the LLM call over ledger persistence
	}
}

// ── TigerBeetle engine factory (same as govern.ts) ──

async function createTBEngine(config: TrustConfig): Promise<TrustEngine> {
	const tbAddresses = config.tigerbeetle.addresses;
	const tbClusterId = BigInt(config.tigerbeetle.clusterId);

	const tbClient = new TrustTBClient({
		addresses: tbAddresses,
		clusterId: tbClusterId,
	});

	await tbClient.createTreasury();
	await tbClient.ensureEscrowAccount("trust:escrow");

	const pendingMap = new Map<string, bigint>();

	return {
		async spendPending(params: {
			transferId: string;
			amount: number;
		}): Promise<{ transferId: string }> {
			const treasury = tbClient.getTreasuryId();
			const escrowId = TrustTBClient.deriveAccountId("trust:escrow");

			const tbTransferId = await tbClient.createPendingTransfer({
				debitAccountId: escrowId,
				creditAccountId: treasury,
				amount: params.amount,
				code: XFER_SPEND,
			});

			pendingMap.set(params.transferId, tbTransferId);
			return { transferId: params.transferId };
		},

		async postPendingSpend(transferId: string): Promise<void> {
			const tbId = pendingMap.get(transferId);
			if (tbId === undefined) {
				throw new Error(`No pending transfer found for ${transferId}`);
			}
			await tbClient.postTransfer(tbId);
			pendingMap.delete(transferId);
		},

		async voidPendingSpend(transferId: string): Promise<void> {
			const tbId = pendingMap.get(transferId);
			if (tbId === undefined) {
				throw new Error(`No pending transfer found for ${transferId}`);
			}
			await tbClient.voidTransfer(tbId);
			pendingMap.delete(transferId);
		},

		async voidAllPending(): Promise<void> {
			const entries = [...pendingMap.entries()];
			for (const [trustIdKey, tbTransferId] of entries) {
				try {
					await tbClient.voidTransfer(tbTransferId);
				} catch {
					// Best-effort
				}
				pendingMap.delete(trustIdKey);
			}
		},

		destroy(): void {
			tbClient.destroy();
		},
	};
}

// ── createGovernor() ──

/**
 * Create a headless governance engine for non-SDK integrations.
 *
 * Unlike `trust()` which wraps a provider SDK client, `createGovernor()`
 * returns a standalone engine with an explicit authorize/settle/abort
 * lifecycle. This is designed for systems like OpenClaw that make raw
 * LLM calls via streaming libraries (pi-ai) rather than SDK clients.
 */
export async function createGovernor(opts?: TrustOpts): Promise<Governor> {
	// 1. Load config
	const vaultBase = opts?.vaultBase ?? process.cwd();
	const configPath = opts?.configPath ?? join(vaultBase, VAULT_DIR, "usertrust.config.json");

	let config: TrustConfig;
	if (existsSync(configPath)) {
		const raw: unknown = JSON.parse(await readFile(configPath, "utf-8"));
		config = TrustConfigSchema.parse({
			...(raw as Record<string, unknown>),
			...(opts?.budget !== undefined ? { budget: opts.budget } : {}),
		});
	} else {
		config = TrustConfigSchema.parse({
			budget: opts?.budget ?? DEFAULT_BUDGET,
		});
	}

	const customRates = config.pricing === "custom" ? config.customRates : undefined;
	const isDryRun = opts?.dryRun ?? process.env.USERTRUST_DRY_RUN === "true";
	const isTestEnv = process.env.USERTRUST_TEST === "1" || process.env.NODE_ENV === "test";

	// 2. Initialize subsystems
	const vaultPath = vaultBase;
	const audit: AuditWriter = (isTestEnv ? opts?._audit : undefined) ?? createAuditWriter(vaultPath);

	const policiesPath = join(vaultPath, VAULT_DIR, config.policies);
	const policyRules: GateRule[] = existsSync(policiesPath) ? loadPolicies(policiesPath) : [];

	const breaker = new CircuitBreakerRegistry({
		failureThreshold: config.circuitBreaker.failureThreshold,
		resetTimeoutMs: config.circuitBreaker.resetTimeout,
	});

	// 3. Proxy connection
	let proxyConn: ProxyConnection | null = null;
	if (opts?.proxy) {
		proxyConn = connectProxy(opts.proxy, opts.key);
	}

	// 4. Engine
	let engine: TrustEngine | null;
	if (isTestEnv && opts?._engine !== undefined) {
		engine = opts._engine;
	} else if (!isDryRun && proxyConn == null) {
		try {
			engine = await createTBEngine(config);
		} catch (err) {
			throw new LedgerUnavailableError(err instanceof Error ? err.message : String(err));
		}
	} else {
		engine = null;
	}

	// 5. State
	let destroyed = false;
	let budgetSpent = await loadSpendLedger(vaultBase);
	const budgetMutex = new AsyncMutex();
	let inFlightHoldTotal = 0;
	const activeAuths = new Map<string, Authorization>();

	// 6. Governor implementation
	const governor: Governor = {
		config,

		async authorize(params: AuthorizeParams): Promise<Authorization> {
			if (destroyed) {
				throw new Error("Governor has been destroyed");
			}

			const model = params.model;
			const actor = params.actor ?? "local";
			const messages = params.messages ?? [];

			// Circuit breaker — key on "headless" since we don't have a client kind
			const cb = breaker.get("headless" as never);
			cb.allowRequest();

			// Estimate cost
			const transferId = trustId("tx");
			const estInputTokens = params.estimatedInputTokens ?? estimateInputTokens(messages);
			const maxOutputTokens = params.maxOutputTokens ?? 4096;
			const estCost = estimateCost(model, estInputTokens, maxOutputTokens, customRates);

			// Acquire mutex for budget atomicity (AUD-453)
			const releaseBudgetLock = await budgetMutex.acquire();
			let proxyTransferId: string | undefined;

			try {
				// Policy gate — caller params spread FIRST so governance
				// fields cannot be shadowed (prevents budget_remaining injection).
				const policyResult = evaluatePolicy(policyRules, {
					...(params.params ?? {}),
					model,
					tier: config.tier,
					estimated_cost: estCost,
					budget_remaining: config.budget - budgetSpent - inFlightHoldTotal,
				});
				if (policyResult.decision === "deny") {
					const reason =
						policyResult.reasons.length > 0 ? policyResult.reasons.join("; ") : "Policy denied";
					throw new PolicyDeniedError(reason);
				}

				// PII check
				if (config.pii !== "off" && messages.length > 0) {
					const piiResult = detectPII(messages);
					if (piiResult.found && config.pii === "block") {
						throw new PolicyDeniedError(`PII detected: ${piiResult.types.join(", ")}`);
					}
				}

				// PENDING hold
				if (proxyConn != null && !isDryRun) {
					try {
						const proxyResult = await proxyConn.spend({
							model,
							estimatedCost: estCost,
							actor,
						});
						proxyTransferId = proxyResult.transferId;
					} catch (holdErr) {
						throw new LedgerUnavailableError(
							holdErr instanceof Error ? holdErr.message : String(holdErr),
						);
					}
				} else if (engine != null && !isDryRun) {
					try {
						await engine.spendPending({ transferId, amount: estCost });
					} catch (holdErr) {
						throw new LedgerUnavailableError(
							holdErr instanceof Error ? holdErr.message : String(holdErr),
						);
					}
				}

				inFlightHoldTotal += estCost;
			} finally {
				releaseBudgetLock();
			}

			const auth: Authorization = {
				transferId,
				estimatedCost: estCost,
				model,
				proxyTransferId,
				createdAt: Date.now(),
			};
			activeAuths.set(transferId, auth);
			return auth;
		},

		async settle(auth: Authorization, params?: SettleParams): Promise<TrustReceipt> {
			if (!activeAuths.has(auth.transferId)) {
				throw new Error(
					`Authorization ${auth.transferId} is not active (already settled or aborted)`,
				);
			}
			activeAuths.delete(auth.transferId);

			const model = auth.model;
			let callAuditDegraded = false;

			// Determine actual cost
			let actualCost: number;
			let usageSource: "provider" | "estimated";
			if (params?.inputTokens != null || params?.outputTokens != null) {
				actualCost = estimateCost(
					model,
					params.inputTokens ?? 0,
					params.outputTokens ?? 0,
					customRates,
				);
				usageSource = params.usageSource ?? "provider";
			} else {
				actualCost = auth.estimatedCost;
				usageSource = "estimated";
			}

			// AUD-453: Acquire mutex for budget atomicity — prevents concurrent
			// settle() calls from corrupting inFlightHoldTotal or budgetSpent.
			const releaseLock = await budgetMutex.acquire();
			try {
				inFlightHoldTotal -= auth.estimatedCost;
				budgetSpent += actualCost;
			} finally {
				releaseLock();
			}
			await persistSpendLedger(vaultBase, budgetSpent);

			// Circuit breaker: success
			const cb = breaker.get("headless" as never);
			cb.recordSuccess();

			// POST settlement
			let settled = true;
			if (proxyConn != null && !isDryRun) {
				try {
					await proxyConn.settle(auth.proxyTransferId ?? auth.transferId, actualCost);
				} catch (postErr) {
					settled = false;
					await audit
						.appendEvent({
							kind: "settlement_ambiguous",
							actor: "local",
							data: {
								model,
								cost: actualCost,
								transferId: auth.transferId,
								error:
									postErr instanceof Error
										? postErr.message.slice(0, 200)
										: String(postErr).slice(0, 200),
							},
						})
						.catch(() => {
							callAuditDegraded = true;
						});
				}
			} else if (engine != null && !isDryRun) {
				try {
					await engine.postPendingSpend(auth.transferId);
				} catch (postErr) {
					settled = false;
					await audit
						.appendEvent({
							kind: "settlement_ambiguous",
							actor: "local",
							data: {
								model,
								cost: actualCost,
								transferId: auth.transferId,
								error:
									postErr instanceof Error
										? postErr.message.slice(0, 200)
										: String(postErr).slice(0, 200),
							},
						})
						.catch(() => {
							callAuditDegraded = true;
						});
				}
			}

			// Audit event
			const syntheticHash = createHash("sha256").update(auth.transferId).digest("hex");
			let auditHash = syntheticHash;
			try {
				const auditEvent = await audit.appendEvent({
					kind: "llm_call",
					actor: "local",
					data: {
						model,
						cost: actualCost,
						settled,
						transferId: auth.transferId,
						usageSource,
						...(params?.chunksDelivered != null ? { chunksDelivered: params.chunksDelivered } : {}),
						source: "headless",
					},
				});
				auditHash = auditEvent.hash;
			} catch {
				callAuditDegraded = true;
			}

			// Daily-rotated receipt
			if (config.audit.rotation !== "none") {
				writeReceipt(
					vaultPath,
					{
						kind: "llm_call",
						subsystem: "headless",
						actor: "local",
						data: {
							model,
							cost: actualCost,
							settled,
							transferId: auth.transferId,
						},
					},
					config.audit.indexLimit,
				);
			}

			// Pattern memory
			if (config.patterns.enabled) {
				const promptHash = createHash("sha256").update(auth.transferId).digest("hex");
				await recordPattern({
					promptHash,
					model,
					cost: actualCost,
					success: true,
				}).catch(() => {});
			}

			const receipt: TrustReceipt = {
				transferId: auth.transferId,
				cost: actualCost,
				budgetRemaining: config.budget - budgetSpent - inFlightHoldTotal,
				auditHash,
				chainPath: join(VAULT_DIR, "audit"),
				receiptUrl: opts?.proxy != null ? `${VERIFY_URL_BASE}/${auth.transferId}` : null,
				settled,
				model,
				provider: "headless",
				timestamp: new Date().toISOString(),
				usageSource,
				...(params?.chunksDelivered != null ? { chunksDelivered: params.chunksDelivered } : {}),
				...(callAuditDegraded ? { auditDegraded: true as const } : {}),
				...(proxyConn != null ? { proxyStub: true as const } : {}),
			};

			return receipt;
		},

		async abort(auth: Authorization, error?: unknown): Promise<void> {
			if (!activeAuths.has(auth.transferId)) {
				// Already settled or aborted — idempotent
				return;
			}
			activeAuths.delete(auth.transferId);

			// AUD-453: Acquire mutex for budget atomicity
			const releaseLock = await budgetMutex.acquire();
			try {
				inFlightHoldTotal -= auth.estimatedCost;
			} finally {
				releaseLock();
			}

			// Circuit breaker: failure
			const cb = breaker.get("headless" as never);
			cb.recordFailure();

			// VOID the pending hold
			if (proxyConn != null && !isDryRun) {
				try {
					await proxyConn.void(auth.proxyTransferId ?? auth.transferId);
				} catch {
					// Best-effort void
				}
			} else if (engine != null && !isDryRun) {
				try {
					await engine.voidPendingSpend(auth.transferId);
				} catch {
					// Best-effort void
				}
			}

			// Audit the failure
			await audit
				.appendEvent({
					kind: "llm_call_failed",
					actor: "local",
					data: {
						model: auth.model,
						transferId: auth.transferId,
						error:
							error instanceof Error
								? error.message.slice(0, 200)
								: error != null
									? String(error).slice(0, 200)
									: "aborted",
						source: "headless",
					},
				})
				.catch(() => {});
		},

		async destroy(): Promise<void> {
			if (destroyed) return;
			destroyed = true;

			// Void all active authorizations (engine + proxy paths)
			for (const [txId, auth] of activeAuths) {
				if (proxyConn != null && !isDryRun) {
					try {
						await proxyConn.void(auth.proxyTransferId ?? txId);
					} catch {
						// Best-effort void
					}
				} else if (engine != null && !isDryRun) {
					try {
						await engine.voidPendingSpend(txId);
					} catch {
						// Best-effort void
					}
				}
			}
			activeAuths.clear();

			// Flush audit
			await audit.flush();
			audit.release();

			// Destroy engine
			if (engine != null && typeof engine.destroy === "function") {
				engine.destroy();
			}

			// Destroy proxy
			if (proxyConn != null) {
				proxyConn.destroy();
			}
		},

		estimateCost(model: string, inputTokens: number, outputTokens: number): number {
			return estimateCost(model, inputTokens, outputTokens, customRates);
		},

		estimateInputTokens(messages: unknown[]): number {
			return estimateInputTokens(messages);
		},

		budgetRemaining(): number {
			return config.budget - budgetSpent - inFlightHoldTotal;
		},
	};

	// Safety net: clean up on process exit (use once to avoid listener accumulation)
	const cleanupHandler = (): void => {
		if (!destroyed) {
			governor.destroy().catch(() => {});
		}
	};
	process.once("beforeExit", cleanupHandler);
	process.once("SIGTERM", cleanupHandler);
	process.once("SIGINT", cleanupHandler);

	return governor;
}
