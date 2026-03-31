// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * trust() — Two-Phase Lifecycle Wrapper
 *
 * The convergence point of the usertrust SDK. Wires together:
 *   - LLM client detection (duck typing)
 *   - TigerBeetle ledger (PENDING → POST/VOID)
 *   - SHA-256 hash-chained audit trail
 *   - Policy gate (12-operator rule engine)
 *   - PII detection
 *   - Circuit breaker (per-provider)
 *   - Pattern memory (prompt hashing)
 *   - Proxy mode (remote governance)
 *
 * Failure modes (Spec Section 15):
 *   15.1 — LLM succeeds, POST fails → settled: false, settlement_ambiguous audit
 *   15.2 — LLM fails (retryable) → void pending hold, propagate error
 *   15.3 — Audit write fails after POST → auditDegraded flag, still return response
 *   15.4 — TigerBeetle unreachable → LedgerUnavailableError, do NOT forward
 *
 * Usage:
 * ```ts
 * const client = await trust(new Anthropic(), { dryRun: true, budget: 50_000 });
 * const { response, receipt } = await client.messages.create({ ... });
 * await client.destroy();
 * ```
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AuditWriter, createAuditWriter } from "./audit/chain.js";
import { writeReceipt } from "./audit/rotation.js";
import { detectClientKind } from "./detect.js";
import { TrustTBClient, XFER_SPEND } from "./ledger/client.js";
import { estimateCost, estimateInputTokens } from "./ledger/pricing.js";
import { recordPattern } from "./memory/patterns.js";
import { DEFAULT_RULES } from "./policy/default-rules.js";
import { type GateRule, evaluatePolicy, loadPolicies } from "./policy/gate.js";
import { detectInjection } from "./policy/injection.js";
import { detectPII, redactPII } from "./policy/pii.js";
import { type ProxyConnection, connectProxy } from "./proxy.js";
import { CircuitBreakerRegistry } from "./resilience/circuit.js";
import { DEFAULT_BUDGET, VAULT_DIR } from "./shared/constants.js";

/** Base URL for receipt verification links (used in proxy mode). */
const VERIFY_URL_BASE = "https://verify.usertrust.dev";
import { LedgerUnavailableError, PolicyDeniedError } from "./shared/errors.js";
import { trustId } from "./shared/ids.js";
import { TrustConfigSchema } from "./shared/types.js";
import type {
	ActionDescriptor,
	GovernedActionResult,
	LLMClientKind,
	TrustConfig,
	TrustReceipt,
	TrustedResponse,
} from "./shared/types.js";
import { type StreamCompletion, createGovernedStream } from "./streaming.js";

// ── Public types ──

export interface TrustOpts {
	/** Path to usertrust.config.json. Defaults to `.usertrust/usertrust.config.json`. */
	configPath?: string;
	/** Remote proxy URL. When set, receipts include a verify URL. */
	proxy?: string;
	/** API key for the proxy. */
	key?: string;
	/** Token budget override. */
	budget?: number;
	/** Tier override. */
	tier?: string;
	/**
	 * Dry-run mode — skips TigerBeetle, audit-chain-only.
	 * Also enabled by USERTRUST_DRY_RUN=true env var.
	 */
	dryRun?: boolean;
	/** Vault directory override (default: cwd). */
	vaultBase?: string;
	/**
	 * Inject a mock/test engine. When set, used instead of TigerBeetle.
	 * Primarily for testing failure modes.
	 * @internal
	 */
	_engine?: TrustEngine | null;
	/**
	 * Inject a mock/test audit writer. When set, used instead of real audit.
	 * @internal
	 */
	_audit?: AuditWriter;
}

/** Minimal engine interface for two-phase spend lifecycle. */
export interface TrustEngine {
	spendPending(params: {
		transferId: string;
		amount: number;
	}): Promise<{ transferId: string }>;
	postPendingSpend(transferId: string): Promise<void>;
	voidPendingSpend(transferId: string): Promise<void>;
	/** AUD-461: Void all remaining pending transfers on destroy. */
	voidAllPending?(): Promise<void>;
	destroy?(): void;
}

/** The trusted client: original client shape + governance methods. */
export type TrustedClient<T> = T & {
	destroy(): Promise<void>;
	governAction<R>(
		action: ActionDescriptor,
		execute: () => Promise<R>,
	): Promise<GovernedActionResult<R>>;
};

// ── AUD-453: Async mutex for budget atomicity ──
// Prevents concurrent interceptCall invocations from racing through
// the budget-check + PENDING hold sequence.

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

// ── AUD-457: Budget persistence helpers ──

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
		// Ensure vault dir exists
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		// Atomic write: write tmp then rename
		await writeFile(tmpPath, JSON.stringify(data), "utf-8");
		await rename(tmpPath, ledgerPath);
	} catch {
		// Best-effort — do not fail the LLM call over ledger persistence
	}
}

// ── trust() ──

export async function trust<T>(client: T, opts?: TrustOpts): Promise<TrustedClient<T>> {
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

	// AUD-470: Only accept injected _engine/_audit in test environments.
	// In production, silently ignore them to prevent governance bypass.
	const isTestEnv = process.env.USERTRUST_TEST === "1" || process.env.NODE_ENV === "test";

	// 2. Initialise subsystems
	const vaultPath = vaultBase;
	const audit: AuditWriter = (isTestEnv ? opts?._audit : undefined) ?? createAuditWriter(vaultPath);

	const policiesPath = join(vaultPath, VAULT_DIR, config.policies);
	const loadedRules = existsSync(policiesPath) ? loadPolicies(policiesPath) : [];
	const policyRules: GateRule[] = loadedRules.length > 0 ? loadedRules : DEFAULT_RULES;

	const breaker = new CircuitBreakerRegistry({
		failureThreshold: config.circuitBreaker.failureThreshold,
		resetTimeoutMs: config.circuitBreaker.resetTimeout,
	});

	// 3. Proxy connection (if proxy mode)
	let proxyConn: ProxyConnection | null = null;
	if (opts?.proxy) {
		proxyConn = connectProxy(opts.proxy, opts.key);
	}

	// 4. Engine (injected for tests, real TB client in production, null in dry-run/proxy)
	// AUD-470: _engine injection only accepted in test environments
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

	// 5. Detect client kind
	const kind: LLMClientKind = detectClientKind(client);

	// 6. Track state
	let destroyed = false;
	let budgetSpent = await loadSpendLedger(vaultBase); // AUD-457: restore from disk
	const budgetMutex = new AsyncMutex(); // AUD-453: serialise budget-check + hold
	let inFlightCount = 0; // AUD-462: track in-flight calls for graceful destroy
	let inFlightStreamCount = 0; // AUD-462: track in-flight streams (consumed after interceptCall returns)
	let inFlightHoldTotal = 0; // Track estimated cost of in-flight pending holds

	// 7. Two-phase intercept
	async function interceptCall(
		originalFn: (...args: unknown[]) => unknown,
		thisArg: unknown,
		args: unknown[],
	): Promise<TrustedResponse<unknown>> {
		if (destroyed) {
			throw new Error("TrustedClient has been destroyed");
		}

		// AUD-462: Track in-flight calls so destroy() can wait for them
		inFlightCount++;

		try {
			const params = (args[0] ?? {}) as Record<string, unknown>;
			const model = (params.model as string) ?? "unknown";
			const messages = (params.messages as unknown[]) ?? [];

			// Per-call audit degradation flag (not sticky across calls)
			let callAuditDegraded = false;

			// a. Circuit breaker check
			const cb = breaker.get(kind);
			cb.allowRequest();

			// b. Estimate cost (before policy, so cost fields are available in context)
			const transferId = trustId("tx");
			const estimatedInputTokens = estimateInputTokens(messages);
			const maxOutputTokens = (params.max_tokens as number) ?? 4096;
			const estimatedCost = estimateCost(model, estimatedInputTokens, maxOutputTokens, customRates);

			// AUD-453: Acquire mutex to serialise budget-check + PENDING hold.
			// This prevents concurrent calls from both passing the budget check
			// and overshooting the budget.
			const releaseBudgetLock = await budgetMutex.acquire();

			// AUD-460: Track the proxy's transferId separately for settle/void
			let proxyTransferId: string | undefined;

			try {
				// c. Policy gate
				const policyResult = evaluatePolicy(policyRules, {
					model,
					tier: config.tier,
					estimated_cost: estimatedCost,
					budget_remaining: config.budget - budgetSpent - inFlightHoldTotal,
					...params,
				});
				if (policyResult.decision === "deny") {
					const reason =
						policyResult.reasons.length > 0 ? policyResult.reasons.join("; ") : "Policy denied";
					throw new PolicyDeniedError(reason);
				}

				// d. PII check
				if (config.pii !== "off") {
					const piiResult = detectPII(messages);
					if (piiResult.found && config.pii === "block") {
						throw new PolicyDeniedError(`PII detected: ${piiResult.types.join(", ")}`);
					}
					// "warn" and "redact" modes: continue (redact is not implemented at SDK level)
				}

				// d2. Injection detection
				if (config.injection !== "off") {
					const injectionResult = detectInjection(messages);
					if (injectionResult.detected) {
						if (config.injection === "block") {
							throw new PolicyDeniedError(
								`Prompt injection detected: ${injectionResult.patterns.join(", ")}`,
							);
						}
						// warn: log to audit trail (non-fatal)
						await audit
							.appendEvent({
								kind: "injection_detected",
								actor: "local",
								data: {
									patterns: injectionResult.patterns,
									score: injectionResult.score,
									model,
								},
							})
							.catch(() => {});
					}
				}

				// e. Failure mode 15.4: TigerBeetle / engine unreachable — PENDING hold
				if (proxyConn != null && !isDryRun) {
					try {
						// AUD-460: Capture the proxy's returned transferId
						const proxyResult = await proxyConn.spend({
							model,
							estimatedCost,
							actor: "local",
						});
						proxyTransferId = proxyResult.transferId;
					} catch (holdErr) {
						throw new LedgerUnavailableError(
							holdErr instanceof Error ? holdErr.message : String(holdErr),
						);
					}
				} else if (engine != null && !isDryRun) {
					try {
						await engine.spendPending({
							transferId,
							amount: estimatedCost,
						});
					} catch (holdErr) {
						// Ledger unreachable — do NOT forward to provider
						throw new LedgerUnavailableError(
							holdErr instanceof Error ? holdErr.message : String(holdErr),
						);
					}
				}

				// Track in-flight hold cost for accurate budget calculations
				inFlightHoldTotal += estimatedCost;
			} finally {
				// AUD-453: Release lock after budget check + hold are complete
				releaseBudgetLock();
			}

			// e. Forward to original SDK
			let settled = true;
			try {
				const response = await (originalFn as (...a: unknown[]) => unknown).apply(thisArg, args);

				// e2. Streaming detection: if response is an async iterable, wrap with
				// token accumulation. Settlement and audit happen when the stream ends.
				if (
					response != null &&
					typeof response === "object" &&
					Symbol.asyncIterator in (response as Record<symbol, unknown>)
				) {
					const stream = response as AsyncIterable<unknown>;
					const governedStream = createGovernedStream(
						stream,
						kind,
						async (completion: StreamCompletion) => {
							// Determine cost: use provider usage if reported, else fall back to estimate
							let streamCost: number;
							let usageSource: "provider" | "estimated";
							if (completion.usageReported) {
								streamCost = estimateCost(
									model,
									completion.usage.inputTokens,
									completion.usage.outputTokens,
									customRates,
								);
								usageSource = "provider";
							} else {
								streamCost = estimatedCost;
								usageSource = "estimated";
							}

							// Release in-flight hold and commit budget under mutex
							{
								const releaseLock = await budgetMutex.acquire();
								inFlightHoldTotal -= estimatedCost;
								budgetSpent += streamCost;
								releaseLock();
							}
							// AUD-457: Persist cumulative spend to disk
							await persistSpendLedger(vaultBase, budgetSpent);
							cb.recordSuccess();

							if (proxyConn != null && !isDryRun) {
								try {
									// AUD-460: Use the proxy's transferId for settlement
									await proxyConn.settle(proxyTransferId ?? transferId, streamCost);
								} catch (postErr) {
									settled = false;
									await audit
										.appendEvent({
											kind: "settlement_ambiguous",
											actor: "local",
											data: {
												model,
												cost: streamCost,
												transferId,
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
									await engine.postPendingSpend(transferId);
								} catch (postErr) {
									settled = false;
									await audit
										.appendEvent({
											kind: "settlement_ambiguous",
											actor: "local",
											data: {
												model,
												cost: streamCost,
												transferId,
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

							const syntheticHash = createHash("sha256").update(transferId).digest("hex");
							let auditHash = syntheticHash;
							try {
								const auditEventData: Record<string, unknown> = {
									model,
									cost: streamCost,
									settled,
									transferId,
									usageSource,
									chunksDelivered: completion.chunksDelivered,
								};
								if (config.pii === "warn" || config.pii === "redact") {
									const piiResult = redactPII(messages);
									if (piiResult.detection.found) {
										auditEventData.piiDetected = piiResult.detection.types;
										auditEventData.piiPaths = piiResult.detection.paths;
									}
								}
								const auditEvent = await audit.appendEvent({
									kind: "llm_call",
									actor: "local",
									data: auditEventData,
								});
								auditHash = auditEvent.hash;
							} catch {
								callAuditDegraded = true;
							}

							const streamReceipt: TrustReceipt = {
								transferId,
								cost: streamCost,
								budgetRemaining: config.budget - budgetSpent - inFlightHoldTotal,
								auditHash: callAuditDegraded ? "AUDIT_DEGRADED" : auditHash,
								chainPath: join(VAULT_DIR, "audit"),
								receiptUrl: opts?.proxy != null ? `${VERIFY_URL_BASE}/${transferId}` : null,
								settled,
								model,
								provider: kind,
								timestamp: new Date().toISOString(),
								usageSource,
								chunksDelivered: completion.chunksDelivered,
								...(callAuditDegraded ? { auditDegraded: true as const } : {}),
								// AUD-456: Flag proxy stub receipts
								...(proxyConn != null ? { proxyStub: true as const } : {}),
							};
							inFlightStreamCount--;
							return streamReceipt;
						},
						async (error: unknown, partial: StreamCompletion) => {
							// Release in-flight hold under mutex
							{
								const releaseLock = await budgetMutex.acquire();
								inFlightHoldTotal -= estimatedCost;
								releaseLock();
							}

							cb.recordFailure();

							// Best-effort audit of partial delivery
							audit
								.appendEvent({
									kind: "stream_partial_delivery",
									actor: "local",
									data: {
										transferId,
										model,
										chunksDelivered: partial.chunksDelivered,
										partialInputTokens: partial.usage.inputTokens,
										partialOutputTokens: partial.usage.outputTokens,
										usageReported: partial.usageReported,
										error: (() => {
											const raw = error instanceof Error ? error.message : String(error);
											return config.pii === "warn" || config.pii === "redact"
												? (redactPII(raw).data as string).slice(0, 200)
												: raw.slice(0, 200);
										})(),
									},
								})
								.catch(() => {});

							if (proxyConn != null && !isDryRun) {
								// AUD-460: Use the proxy's transferId for void
								proxyConn.void(proxyTransferId ?? transferId).catch(() => {});
							} else if (engine != null && !isDryRun) {
								engine.voidPendingSpend(transferId).catch(() => {});
							}

							inFlightStreamCount--;
						},
					);

					// AUD-454: For streaming responses, settlement has NOT happened yet.
					// Set settled: false — the real settlement status will be on
					// governedStream.receipt after the stream is fully consumed.
					const streamEstimateHash = createHash("sha256").update(transferId).digest("hex");
					const estimatedReceipt: TrustReceipt = {
						transferId,
						cost: estimatedCost,
						budgetRemaining: config.budget - budgetSpent - inFlightHoldTotal,
						auditHash: callAuditDegraded ? "AUDIT_DEGRADED" : streamEstimateHash,
						chainPath: join(VAULT_DIR, "audit"),
						receiptUrl: opts?.proxy != null ? `${VERIFY_URL_BASE}/${transferId}` : null,
						settled: false, // AUD-454: not settled yet — stream hasn't been consumed
						model,
						provider: kind,
						timestamp: new Date().toISOString(),
						...(callAuditDegraded ? { auditDegraded: true as const } : {}),
						// AUD-456: Flag proxy stub receipts
						...(proxyConn != null ? { proxyStub: true as const } : {}),
					};

					inFlightStreamCount++;
					return { response: governedStream, receipt: estimatedReceipt };
				}

				// f. Compute actual cost from response usage
				let actualCost = estimatedCost;
				if (response != null && typeof response === "object" && "usage" in response) {
					const usage = (response as Record<string, unknown>).usage as Record<
						string,
						unknown
					> | null;
					if (usage != null) {
						const inputTokens =
							(usage.input_tokens as number | undefined) ??
							(usage.prompt_tokens as number | undefined) ??
							estimatedInputTokens;
						const outputTokens =
							(usage.output_tokens as number | undefined) ??
							(usage.completion_tokens as number | undefined) ??
							0;
						actualCost = estimateCost(model, inputTokens, outputTokens, customRates);
					}
				}

				// Release in-flight hold and commit budget under mutex
				{
					const releaseLock = await budgetMutex.acquire();
					inFlightHoldTotal -= estimatedCost;
					budgetSpent += actualCost;
					releaseLock();
				}
				// AUD-457: Persist cumulative spend to disk
				await persistSpendLedger(vaultBase, budgetSpent);

				// g. Circuit breaker: record success
				cb.recordSuccess();

				// g2. Failure mode 15.1: POST fails after LLM success
				if (engine != null && !isDryRun) {
					try {
						await engine.postPendingSpend(transferId);
					} catch (postErr) {
						// POST failed — LLM call succeeded but settlement is ambiguous
						settled = false;
						await audit
							.appendEvent({
								kind: "settlement_ambiguous",
								actor: "local",
								data: {
									model,
									cost: actualCost,
									transferId,
									error: postErr instanceof Error ? postErr.message : String(postErr),
								},
							})
							.catch(() => {
								// Audit also degraded — nothing more we can do
								callAuditDegraded = true;
							});
					}
				}

				// g3. Proxy settlement
				if (proxyConn != null && !isDryRun) {
					try {
						// AUD-460: Use the proxy's transferId for settlement
						await proxyConn.settle(proxyTransferId ?? transferId, actualCost);
					} catch (postErr) {
						settled = false;
						await audit
							.appendEvent({
								kind: "settlement_ambiguous",
								actor: "local",
								data: {
									model,
									cost: actualCost,
									transferId,
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

				// h. Audit event — failure mode 15.3: audit write failure
				const syntheticHash = createHash("sha256").update(transferId).digest("hex");
				let auditHash = syntheticHash;
				try {
					const auditData: Record<string, unknown> = {
						model,
						cost: actualCost,
						settled,
						transferId,
					};
					if (config.pii === "warn" || config.pii === "redact") {
						const piiResult = redactPII(messages);
						if (piiResult.detection.found) {
							auditData.piiDetected = piiResult.detection.types;
							auditData.piiPaths = piiResult.detection.paths;
						}
					}
					const auditEvent = await audit.appendEvent({
						kind: "llm_call",
						actor: "local",
						data: auditData,
					});
					auditHash = auditEvent.hash;
				} catch {
					// Failure mode 15.3: Audit degraded — do not fail the response
					callAuditDegraded = true;
					process.stderr.write(
						`[usertrust] audit degraded: failed to write llm_call event for ${transferId}\n`,
					);
				}

				// i. Daily-rotated audit receipt (non-blocking)
				if (config.audit.rotation !== "none") {
					writeReceipt(
						vaultPath,
						{
							kind: "llm_call",
							subsystem: "trust",
							actor: "local",
							data: { model, cost: actualCost, settled, transferId },
						},
						config.audit.indexLimit,
					);
				}

				// i2. Pattern memory
				if (config.patterns.enabled) {
					const promptHash = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
					await recordPattern({
						promptHash,
						model,
						cost: actualCost,
						success: true,
					}).catch(() => {});
				}

				const budgetRemaining = config.budget - budgetSpent - inFlightHoldTotal;

				const receipt: TrustReceipt = {
					transferId,
					cost: actualCost,
					budgetRemaining,
					auditHash: callAuditDegraded ? "AUDIT_DEGRADED" : auditHash,
					chainPath: join(VAULT_DIR, "audit"),
					receiptUrl: opts?.proxy != null ? `${VERIFY_URL_BASE}/${transferId}` : null,
					settled,
					model,
					provider: kind,
					timestamp: new Date().toISOString(),
					...(callAuditDegraded ? { auditDegraded: true as const } : {}),
					// AUD-456: Flag proxy stub receipts
					...(proxyConn != null ? { proxyStub: true as const } : {}),
				};

				return { response, receipt };
			} catch (err) {
				// Release in-flight hold under mutex (non-streaming failure)
				{
					const releaseLock = await budgetMutex.acquire();
					inFlightHoldTotal -= estimatedCost;
					releaseLock();
				}

				// j. Circuit breaker: record failure
				cb.recordFailure();

				// j2. Failure mode 15.2: LLM fails — VOID the pending hold
				if (engine != null && !isDryRun) {
					try {
						await engine.voidPendingSpend(transferId);
					} catch {
						// Best-effort void — log and continue
					}
				}

				// j3. Proxy void
				if (proxyConn != null && !isDryRun) {
					try {
						// AUD-460: Use the proxy's transferId for void
						await proxyConn.void(proxyTransferId ?? transferId);
					} catch {
						// Best-effort void
					}
				}

				// k. Audit the failure
				await audit
					.appendEvent({
						kind: "llm_call_failed",
						actor: "local",
						data: {
							model,
							error:
								config.pii === "warn" || config.pii === "redact"
									? (redactPII(String(err)).data as string).slice(0, 200)
									: String(err),
							transferId,
						},
					})
					.catch(() => {
						callAuditDegraded = true;
					});

				// l. Pattern memory: record failure
				if (config.patterns.enabled) {
					const promptHash = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
					await recordPattern({
						promptHash,
						model,
						cost: 0,
						success: false,
					}).catch(() => {});
				}

				throw err;
			}
		} finally {
			// AUD-462: Decrement in-flight count so destroy() knows when it's safe
			inFlightCount--;
		}
	}

	// 7b. Action governance — simplified pipeline for non-LLM actions
	async function governActionImpl<R>(
		action: ActionDescriptor,
		execute: () => Promise<R>,
	): Promise<GovernedActionResult<R>> {
		if (destroyed) {
			throw new Error("TrustedClient has been destroyed");
		}

		// AUD-466: Validate cost to prevent budget inflation via negative values
		if (!Number.isFinite(action.cost) || action.cost < 0) {
			throw new Error(
				`action.cost must be a non-negative finite number, got ${String(action.cost)}`,
			);
		}

		inFlightCount++;
		let callAuditDegraded = false;

		try {
			const actor = action.actor ?? "local";
			const transferId = trustId("tx");

			// a. Circuit breaker check (keyed by action kind)
			const cb = breaker.get(action.kind as unknown as LLMClientKind);
			cb.allowRequest();

			// b. Acquire mutex for budget atomicity
			const releaseBudgetLock = await budgetMutex.acquire();
			let proxyTransferId: string | undefined;

			try {
				// c. Policy gate — action fields available in context
				// AUD-467: Caller params spread FIRST so governance fields cannot be shadowed
				const policyResult = evaluatePolicy(policyRules, {
					...(action.params ?? {}),
					action_kind: action.kind,
					action_name: action.name,
					estimated_cost: action.cost,
					budget_remaining: config.budget - budgetSpent - inFlightHoldTotal,
					tier: config.tier,
				});
				if (policyResult.decision === "deny") {
					const reason =
						policyResult.reasons.length > 0 ? policyResult.reasons.join("; ") : "Policy denied";
					throw new PolicyDeniedError(reason);
				}

				// d. PII check on action params
				if (config.pii !== "off" && action.params != null) {
					const piiResult = detectPII(action.params);
					if (piiResult.found && config.pii === "block") {
						throw new PolicyDeniedError(
							`PII detected in action params: ${piiResult.types.join(", ")}`,
						);
					}
				}

				// d2. Injection detection on action params
				if (config.injection !== "off" && action.params != null) {
					const injectionResult = detectInjection(action.params);
					if (injectionResult.detected) {
						if (config.injection === "block") {
							throw new PolicyDeniedError(
								`Injection detected in action params: ${injectionResult.patterns.join(", ")}`,
							);
						}
						// warn: log to audit trail (non-fatal)
						await audit
							.appendEvent({
								kind: "injection_detected",
								actor: action.actor ?? "local",
								data: {
									patterns: injectionResult.patterns,
									score: injectionResult.score,
									actionName: action.name,
									actionKind: action.kind,
								},
							})
							.catch(() => {});
					}
				}

				// e. PENDING hold
				if (proxyConn != null && !isDryRun) {
					try {
						const proxyResult = await proxyConn.spend({
							model: action.name,
							estimatedCost: action.cost,
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
						await engine.spendPending({
							transferId,
							amount: action.cost,
						});
					} catch (holdErr) {
						throw new LedgerUnavailableError(
							holdErr instanceof Error ? holdErr.message : String(holdErr),
						);
					}
				}

				inFlightHoldTotal += action.cost;
			} finally {
				releaseBudgetLock();
			}

			// f. Execute the action
			// Guard against double-decrement of inFlightHoldTotal (AUD-465)
			let holdReleased = false;
			async function releaseHoldAndCommit(cost?: number): Promise<void> {
				if (!holdReleased) {
					holdReleased = true;
					const releaseLock = await budgetMutex.acquire();
					inFlightHoldTotal -= action.cost;
					if (cost !== undefined) {
						budgetSpent += cost;
					}
					releaseLock();
				}
			}

			try {
				const result = await execute();

				// Release in-flight hold and commit budget under mutex
				await releaseHoldAndCommit(action.cost);
				await persistSpendLedger(vaultBase, budgetSpent);

				// g. Circuit breaker: record success
				cb.recordSuccess();

				// h. POST settlement
				let settled = true;
				if (engine != null && !isDryRun) {
					try {
						await engine.postPendingSpend(transferId);
					} catch (postErr) {
						settled = false;
						await audit
							.appendEvent({
								kind: "settlement_ambiguous",
								actor,
								data: {
									actionKind: action.kind,
									actionName: action.name,
									cost: action.cost,
									transferId,
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

				if (proxyConn != null && !isDryRun) {
					try {
						await proxyConn.settle(proxyTransferId ?? transferId, action.cost);
					} catch (postErr) {
						settled = false;
						await audit
							.appendEvent({
								kind: "settlement_ambiguous",
								actor,
								data: {
									actionKind: action.kind,
									actionName: action.name,
									cost: action.cost,
									transferId,
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

				// i. Prepare params for audit — redact PII if configured
				let auditParams: Record<string, unknown> | undefined;
				if (action.params != null) {
					if (config.pii === "warn" || config.pii === "redact") {
						const redacted = redactPII(action.params);
						auditParams = redacted.data as Record<string, unknown>;
					} else {
						auditParams = action.params;
					}
				}

				// i2. Audit event
				const syntheticHash = createHash("sha256").update(transferId).digest("hex");
				let auditHash = syntheticHash;
				try {
					const auditEvent = await audit.appendEvent({
						kind: action.kind,
						actor,
						data: {
							actionName: action.name,
							cost: action.cost,
							settled,
							transferId,
							...(auditParams != null ? { params: auditParams } : {}),
						},
					});
					auditHash = auditEvent.hash;
				} catch {
					// Failure mode 15.3: Audit degraded — do not fail the response
					callAuditDegraded = true;
					process.stderr.write(
						`[usertrust] audit degraded: failed to write ${action.kind} event for ${transferId}\n`,
					);
				}

				// j. Daily-rotated receipt
				if (config.audit.rotation !== "none") {
					writeReceipt(
						vaultPath,
						{
							kind: action.kind,
							subsystem: "trust",
							actor,
							data: {
								actionName: action.name,
								cost: action.cost,
								settled,
								transferId,
								...(auditParams != null ? { params: auditParams } : {}),
							},
						},
						config.audit.indexLimit,
					);
				}

				const budgetRemaining = config.budget - budgetSpent - inFlightHoldTotal;

				const receipt: TrustReceipt = {
					transferId,
					cost: action.cost,
					budgetRemaining,
					auditHash: callAuditDegraded ? "AUDIT_DEGRADED" : auditHash,
					chainPath: join(VAULT_DIR, "audit"),
					receiptUrl: opts?.proxy != null ? `${VERIFY_URL_BASE}/${transferId}` : null,
					settled,
					model: action.name,
					provider: action.kind,
					timestamp: new Date().toISOString(),
					actionKind: action.kind,
					...(callAuditDegraded ? { auditDegraded: true as const } : {}),
					...(proxyConn != null ? { proxyStub: true as const } : {}),
				};

				return { result, receipt };
			} catch (err) {
				// Release in-flight hold (AUD-465: guard prevents double-decrement)
				await releaseHoldAndCommit();

				// Circuit breaker: record failure
				cb.recordFailure();

				// VOID the pending hold
				if (engine != null && !isDryRun) {
					try {
						await engine.voidPendingSpend(transferId);
					} catch {
						// Best-effort void
					}
				}

				if (proxyConn != null && !isDryRun) {
					try {
						await proxyConn.void(proxyTransferId ?? transferId);
					} catch {
						// Best-effort void
					}
				}

				// Audit the failure
				await audit
					.appendEvent({
						kind: `${action.kind}_failed`,
						actor,
						data: {
							actionName: action.name,
							error: (() => {
								const raw = err instanceof Error ? err.message : String(err);
								return config.pii === "warn" || config.pii === "redact"
									? (redactPII(raw).data as string).slice(0, 200)
									: raw.slice(0, 200);
							})(),
							transferId,
						},
					})
					.catch(() => {
						callAuditDegraded = true;
					});

				throw err;
			}
		} finally {
			inFlightCount--;
		}
	}

	// 8. Safety net: clean up on process exit if destroy() was never called
	let beforeExitHandler: (() => void) | null = null;

	// 9. Build Proxy based on client kind
	function createClientProxy(): TrustedClient<T> {
		const destroyFn = async (): Promise<void> => {
			if (destroyed) return;
			destroyed = true;

			// AUD-462: Wait up to 5 seconds for in-flight calls to complete.
			// After the deadline, proceed with teardown anyway.
			const deadline = Date.now() + 5_000;
			while ((inFlightCount > 0 || inFlightStreamCount > 0) && Date.now() < deadline) {
				await new Promise<void>((r) => setTimeout(r, 50));
			}

			// Remove beforeExit safety net
			if (beforeExitHandler != null) {
				process.removeListener("beforeExit", beforeExitHandler);
				beforeExitHandler = null;
			}

			// AUD-461: Void any remaining pending transfers (best-effort).
			// TigerBeetle auto-voids pending transfers after 300s, but
			// explicit voiding releases holds immediately.
			if (engine != null && typeof engine.voidAllPending === "function") {
				await engine.voidAllPending();
			}

			// Flush audit writes
			await audit.flush();

			// Release audit lock
			audit.release();

			// Destroy engine if connected
			if (engine != null && typeof engine.destroy === "function") {
				engine.destroy();
			}

			// Destroy proxy connection if active
			if (proxyConn != null) {
				proxyConn.destroy();
			}
		};

		if (kind === "anthropic") {
			return buildAnthropicProxy(client, interceptCall, destroyFn, governActionImpl);
		}
		if (kind === "openai") {
			return buildOpenAIProxy(client, interceptCall, destroyFn, governActionImpl);
		}
		// google
		return buildGoogleProxy(client, interceptCall, destroyFn, governActionImpl);
	}

	const governedClient = createClientProxy();

	beforeExitHandler = (): void => {
		if (!destroyed) {
			governedClient.destroy().catch(() => {});
		}
	};
	process.on("beforeExit", beforeExitHandler);

	return governedClient;
}

// ── TigerBeetle engine factory ──

/**
 * Create a TrustEngine backed by a real TigerBeetle client.
 * Uses a simplified two-phase interface: pending transfers are created
 * directly against the TB client using escrow-style debit/credit accounts.
 */
async function createTBEngine(config: TrustConfig): Promise<TrustEngine> {
	const tbAddresses = config.tigerbeetle.addresses;
	const tbClusterId = BigInt(config.tigerbeetle.clusterId);

	const tbClient = new TrustTBClient({
		addresses: tbAddresses,
		clusterId: tbClusterId,
	});

	// Initialize treasury and escrow accounts
	await tbClient.createTreasury();
	await tbClient.ensureEscrowAccount("trust:escrow");

	// Pending transfer ID mapping (trustId string -> TB bigint)
	const pendingMap = new Map<string, bigint>();

	return {
		async spendPending(params: {
			transferId: string;
			amount: number;
		}): Promise<{ transferId: string }> {
			const treasury = tbClient.getTreasuryId();
			// Use a deterministic escrow account for SDK-local holds
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

		// AUD-461: Void all remaining pending transfers on destroy.
		// Best-effort — TigerBeetle auto-voids after 300s regardless.
		async voidAllPending(): Promise<void> {
			const entries = [...pendingMap.entries()];
			for (const [trustIdKey, tbTransferId] of entries) {
				try {
					await tbClient.voidTransfer(tbTransferId);
				} catch {
					// Best-effort — ignore individual void failures
				}
				pendingMap.delete(trustIdKey);
			}
		},

		destroy(): void {
			tbClient.destroy();
		},
	};
}

// ── Proxy builders ──
// Each builder intercepts only the `create` / `generateContent` call and
// preserves all other properties of the original client untouched.

type InterceptFn = (
	originalFn: (...args: unknown[]) => unknown,
	thisArg: unknown,
	args: unknown[],
) => Promise<TrustedResponse<unknown>>;

type GovernActionFn = <R>(
	action: ActionDescriptor,
	execute: () => Promise<R>,
) => Promise<GovernedActionResult<R>>;

function buildAnthropicProxy<T>(
	client: T,
	intercept: InterceptFn,
	destroy: () => Promise<void>,
	governAction: GovernActionFn,
): TrustedClient<T> {
	const original = client as Record<string, unknown>;
	const messages = original.messages as Record<string, unknown>;
	const originalCreate = messages.create as (...args: unknown[]) => unknown;

	// Proxy on the messages object: intercept `create`
	const messagesProxy = new Proxy(messages, {
		get(target, prop, receiver) {
			if (prop === "create") {
				return (...args: unknown[]) => intercept(originalCreate, target, args);
			}
			return Reflect.get(target, prop, receiver);
		},
	});

	// Proxy on the client: intercept `messages` to return our proxy, add `destroy`
	const clientProxy = new Proxy(original, {
		get(target, prop, receiver) {
			if (prop === "messages") return messagesProxy;
			if (prop === "destroy") return destroy;
			if (prop === "governAction") return governAction;
			return Reflect.get(target, prop, receiver);
		},
	});

	return clientProxy as TrustedClient<T>;
}

function buildOpenAIProxy<T>(
	client: T,
	intercept: InterceptFn,
	destroy: () => Promise<void>,
	governAction: GovernActionFn,
): TrustedClient<T> {
	const original = client as Record<string, unknown>;
	const chat = original.chat as Record<string, unknown>;
	const completions = chat.completions as Record<string, unknown>;
	const originalCreate = completions.create as (...args: unknown[]) => unknown;

	const completionsProxy = new Proxy(completions, {
		get(target, prop, receiver) {
			if (prop === "create") {
				return (...args: unknown[]) => intercept(originalCreate, target, args);
			}
			return Reflect.get(target, prop, receiver);
		},
	});

	const chatProxy = new Proxy(chat, {
		get(target, prop, receiver) {
			if (prop === "completions") return completionsProxy;
			return Reflect.get(target, prop, receiver);
		},
	});

	const clientProxy = new Proxy(original, {
		get(target, prop, receiver) {
			if (prop === "chat") return chatProxy;
			if (prop === "destroy") return destroy;
			if (prop === "governAction") return governAction;
			return Reflect.get(target, prop, receiver);
		},
	});

	return clientProxy as TrustedClient<T>;
}

function buildGoogleProxy<T>(
	client: T,
	intercept: InterceptFn,
	destroy: () => Promise<void>,
	governAction: GovernActionFn,
): TrustedClient<T> {
	const original = client as Record<string, unknown>;
	const models = original.models as Record<string, unknown>;
	const originalGenerate = models.generateContent as (...args: unknown[]) => unknown;

	const modelsProxy = new Proxy(models, {
		get(target, prop, receiver) {
			if (prop === "generateContent") {
				return (...args: unknown[]) => intercept(originalGenerate, target, args);
			}
			return Reflect.get(target, prop, receiver);
		},
	});

	const clientProxy = new Proxy(original, {
		get(target, prop, receiver) {
			if (prop === "models") return modelsProxy;
			if (prop === "destroy") return destroy;
			if (prop === "governAction") return governAction;
			return Reflect.get(target, prop, receiver);
		},
	});

	return clientProxy as TrustedClient<T>;
}
