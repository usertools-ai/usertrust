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
 * const { response, governance } = await client.messages.create({ ... });
 * await client.destroy();
 * ```
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AuditWriter, createAuditWriter } from "./audit/chain.js";
import { writeReceipt } from "./audit/rotation.js";
import { detectClientKind } from "./detect.js";
import { TrustTBClient, XFER_SPEND } from "./ledger/client.js";
import { estimateCost, estimateInputTokens } from "./ledger/pricing.js";
import { recordPattern } from "./memory/patterns.js";
import { DecayRateCalculator } from "./policy/decay.js";
import { type GateRule, evaluatePolicy, loadPolicies } from "./policy/gate.js";
import { detectPII } from "./policy/pii.js";
import { type ProxyConnection, connectProxy } from "./proxy.js";
import { CircuitBreakerRegistry } from "./resilience/circuit.js";
import { DEFAULT_BUDGET, VAULT_DIR } from "./shared/constants.js";
import { LedgerUnavailableError, PolicyDeniedError } from "./shared/errors.js";
import { trustId } from "./shared/ids.js";
import { TrustConfigSchema } from "./shared/types.js";
import type {
	GovernanceReceipt,
	GovernedResponse,
	LLMClientKind,
	TrustConfig,
} from "./shared/types.js";
import { type StreamUsage, createGovernedStream } from "./streaming.js";

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
	destroy?(): void;
}

/** The governed client: original client shape + `destroy()`. */
export type GovernedClient<T> = T & { destroy(): Promise<void> };

// ── trust() ──

export async function trust<T>(client: T, opts?: TrustOpts): Promise<GovernedClient<T>> {
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

	const isDryRun = opts?.dryRun ?? process.env.USERTRUST_DRY_RUN === "true";

	// 2. Initialise subsystems
	const vaultPath = vaultBase;
	const audit: AuditWriter = opts?._audit ?? createAuditWriter(vaultPath);

	const policiesPath = join(vaultPath, VAULT_DIR, config.policies);
	const policyRules: GateRule[] = existsSync(policiesPath) ? loadPolicies(policiesPath) : [];

	const breaker = new CircuitBreakerRegistry({
		failureThreshold: config.circuitBreaker.failureThreshold,
		resetTimeoutMs: config.circuitBreaker.resetTimeout,
	});

	// Decay-weighted budget calculator (1-hour half-life)
	const decayCalc = new DecayRateCalculator({ halfLifeMs: 3_600_000 });
	const spendHistory: Array<{ ts: number; value: number }> = [];

	// 3. Proxy connection (if proxy mode)
	let proxyConn: ProxyConnection | null = null;
	if (opts?.proxy) {
		proxyConn = connectProxy(opts.proxy, opts.key);
	}

	// 4. Engine (injected for tests, real TB client in production, null in dry-run/proxy)
	let engine: TrustEngine | null;
	if (opts?._engine !== undefined) {
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
	let budgetSpent = 0;

	// 7. Two-phase intercept
	async function interceptCall(
		originalFn: (...args: unknown[]) => unknown,
		thisArg: unknown,
		args: unknown[],
	): Promise<GovernedResponse<unknown>> {
		if (destroyed) {
			throw new Error("GovernedClient has been destroyed");
		}

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
		const estimatedCost = estimateCost(model, estimatedInputTokens, maxOutputTokens);

		// c. Policy gate
		const policyResult = evaluatePolicy(policyRules, {
			model,
			tier: config.tier,
			estimated_cost: estimatedCost,
			budget_remaining: config.budget - budgetSpent,
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

		// d2. Failure mode 15.4: TigerBeetle / engine unreachable — PENDING hold
		if (proxyConn != null && !isDryRun) {
			try {
				await proxyConn.spend({
					model,
					estimatedCost,
					actor: "local",
				});
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
					async (usage: StreamUsage) => {
						const streamCost = estimateCost(model, usage.inputTokens, usage.outputTokens);
						budgetSpent += streamCost;
						cb.recordSuccess();

						if (proxyConn != null && !isDryRun) {
							try {
								await proxyConn.settle(transferId, streamCost);
							} catch {
								settled = false;
							}
						} else if (engine != null && !isDryRun) {
							try {
								await engine.postPendingSpend(transferId);
							} catch {
								settled = false;
							}
						}

						const syntheticHash = createHash("sha256").update(transferId).digest("hex");
						let auditHash = syntheticHash;
						try {
							const auditEvent = await audit.appendEvent({
								kind: "llm_call",
								actor: "local",
								data: { model, cost: streamCost, settled, transferId },
							});
							auditHash = auditEvent.hash;
						} catch {
							callAuditDegraded = true;
						}

						return {
							transferId,
							cost: streamCost,
							budgetRemaining: config.budget - budgetSpent,
							auditHash,
							chainPath: join(VAULT_DIR, "audit"),
							receiptUrl: opts?.proxy != null ? `https://verify.usertools.dev/${transferId}` : null,
							settled,
							model,
							provider: kind,
							timestamp: new Date().toISOString(),
							...(callAuditDegraded ? { auditDegraded: true as const } : {}),
						};
					},
					(error: unknown) => {
						cb.recordFailure();
						if (proxyConn != null && !isDryRun) {
							proxyConn.void(transferId).catch(() => {});
						} else if (engine != null && !isDryRun) {
							engine.voidPendingSpend(transferId).catch(() => {});
						}
					},
				);

				// For streaming responses, return the wrapped stream with an
				// estimated governance receipt. The actual receipt (with real
				// token counts) is available via governedStream.governance
				// after the stream is fully consumed.
				const auditHash = createHash("sha256").update(transferId).digest("hex");
				const estimatedGovernance: GovernanceReceipt = {
					transferId,
					cost: estimatedCost,
					budgetRemaining: config.budget - budgetSpent,
					auditHash,
					chainPath: join(VAULT_DIR, "audit"),
					receiptUrl: opts?.proxy != null ? `https://verify.usertools.dev/${transferId}` : null,
					settled,
					model,
					provider: kind,
					timestamp: new Date().toISOString(),
					...(callAuditDegraded ? { auditDegraded: true as const } : {}),
				};

				return { response: governedStream, governance: estimatedGovernance };
			}

			// f. Compute actual cost from response usage
			let actualCost = estimatedCost;
			if (response != null && typeof response === "object" && "usage" in response) {
				const usage = (response as Record<string, unknown>).usage as Record<string, unknown> | null;
				if (usage != null) {
					const inputTokens =
						(usage.input_tokens as number | undefined) ??
						(usage.prompt_tokens as number | undefined) ??
						estimatedInputTokens;
					const outputTokens =
						(usage.output_tokens as number | undefined) ??
						(usage.completion_tokens as number | undefined) ??
						0;
					actualCost = estimateCost(model, inputTokens, outputTokens);
				}
			}

			// Track budget (cumulative and decay-weighted)
			budgetSpent += actualCost;
			spendHistory.push({ ts: Date.now(), value: actualCost });

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
					await proxyConn.settle(transferId, actualCost);
				} catch {
					settled = false;
				}
			}

			// h. Audit event — failure mode 15.3: audit write failure
			const syntheticHash = createHash("sha256").update(transferId).digest("hex");
			let auditHash = syntheticHash;
			try {
				const auditEvent = await audit.appendEvent({
					kind: "llm_call",
					actor: "local",
					data: {
						model,
						cost: actualCost,
						settled,
						transferId,
					},
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

			const budgetRemaining = config.budget - budgetSpent;

			const governance: GovernanceReceipt = {
				transferId,
				cost: actualCost,
				budgetRemaining,
				auditHash,
				chainPath: join(VAULT_DIR, "audit"),
				receiptUrl: opts?.proxy != null ? `https://verify.usertools.dev/${transferId}` : null,
				settled,
				model,
				provider: kind,
				timestamp: new Date().toISOString(),
				...(callAuditDegraded ? { auditDegraded: true as const } : {}),
			};

			return { response, governance };
		} catch (err) {
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
					await proxyConn.void(transferId);
				} catch {
					// Best-effort void
				}
			}

			// k. Audit the failure
			await audit
				.appendEvent({
					kind: "llm_call_failed",
					actor: "local",
					data: { model, error: String(err), transferId },
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
	}

	// 8. Safety net: clean up on process exit if destroy() was never called
	let beforeExitHandler: (() => void) | null = null;

	// 9. Build Proxy based on client kind
	function createClientProxy(): GovernedClient<T> {
		const destroyFn = async (): Promise<void> => {
			if (destroyed) return;
			destroyed = true;

			// Remove beforeExit safety net
			if (beforeExitHandler != null) {
				process.removeListener("beforeExit", beforeExitHandler);
				beforeExitHandler = null;
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
			return buildAnthropicProxy(client, interceptCall, destroyFn);
		}
		if (kind === "openai") {
			return buildOpenAIProxy(client, interceptCall, destroyFn);
		}
		// google
		return buildGoogleProxy(client, interceptCall, destroyFn);
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
) => Promise<GovernedResponse<unknown>>;

function buildAnthropicProxy<T>(
	client: T,
	intercept: InterceptFn,
	destroy: () => Promise<void>,
): GovernedClient<T> {
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
			return Reflect.get(target, prop, receiver);
		},
	});

	return clientProxy as GovernedClient<T>;
}

function buildOpenAIProxy<T>(
	client: T,
	intercept: InterceptFn,
	destroy: () => Promise<void>,
): GovernedClient<T> {
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
			return Reflect.get(target, prop, receiver);
		},
	});

	return clientProxy as GovernedClient<T>;
}

function buildGoogleProxy<T>(
	client: T,
	intercept: InterceptFn,
	destroy: () => Promise<void>,
): GovernedClient<T> {
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
			return Reflect.get(target, prop, receiver);
		},
	});

	return clientProxy as GovernedClient<T>;
}
