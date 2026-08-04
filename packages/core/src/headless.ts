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

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CreateTransferStatus } from "tigerbeetle-node";
import { type AuditWriter, createAuditWriter } from "./audit/chain.js";
import { writeReceipt } from "./audit/rotation.js";
import type { TrustEngine, TrustOpts } from "./govern.js";
import { TBTransferError, TrustTBClient, XFER_SPEND } from "./ledger/client.js";
import {
	costFromRates,
	estimateCost,
	estimateInputTokens,
	resolveRates,
	warnUnknownModel,
} from "./ledger/pricing.js";
import { recordPattern } from "./memory/patterns.js";
import { DEFAULT_RULES, mergePolicies } from "./policy/default-rules.js";
import { evaluatePolicy, type GateRule, loadPolicies } from "./policy/gate.js";
import { detectPII } from "./policy/pii.js";
import type { ProxyConnection } from "./proxy.js";
import { CircuitBreakerRegistry } from "./resilience/circuit.js";
import { DEFAULT_BUDGET, VAULT_DIR } from "./shared/constants.js";
import {
	InsufficientBalanceError,
	LedgerUnavailableError,
	PolicyDeniedError,
} from "./shared/errors.js";
import { trustId } from "./shared/ids.js";
import type { EndpointInfo, TrustConfig, TrustReceipt } from "./shared/types.js";
import { TrustConfigSchema } from "./shared/types.js";

// ── Public types ──

/**
 * Options for createGovernor(): TrustOpts plus a governor-wide default
 * endpoint scope (M2 local-model governance).
 *
 * The envelope identity `parentUserId` is INHERITED from TrustOpts — one field
 * and one validation rule across both governors, so a cost center derives the
 * same account whichever one holds the client.
 */
export interface GovernorOpts extends TrustOpts {
	/**
	 * Governor-wide default endpoint scope for rate resolution. Applies to every
	 * authorize() call that does not carry its own per-call `endpoint` override
	 * (A3). Omitted → cloud scope (`{ class: "cloud", runtime: "unknown" }`),
	 * which preserves pre-M2 metering exactly.
	 *
	 * SECURITY (A10): endpoint scope is a TRUSTED-OPERATOR decision — never wire
	 * it to end-user/request input. It sits on the same trust boundary as
	 * budget/customRates: whoever sets it already controls billing entirely.
	 */
	endpoint?: Partial<EndpointInfo> | undefined;
}

/** Handle returned by authorize(), passed to settle() or abort(). */
export interface Authorization {
	transferId: string;
	estimatedCost: number;
	model: string;
	/** The proxy's transferId when in proxy mode. */
	proxyTransferId?: string | undefined;
	/** @internal Timestamp when authorization was created. */
	createdAt: number;
	/**
	 * @internal Endpoint scope captured at authorize (A3). settle()/abort() use
	 * THIS scope — never a later governor-level value. Always the NORMALIZED
	 * full shape (normalizeEndpoint output), unlike the Partial caller inputs.
	 */
	endpoint?: EndpointInfo | undefined;
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
	/**
	 * Per-call endpoint scope override — wins over the governor-wide default
	 * (A3). The effective scope is captured on the Authorization and governs
	 * settle()/abort() and the receipt's endpoint/meter fields.
	 *
	 * SECURITY (A10): trusted-operator input only — never derive from
	 * end-user/request data. Partial: omitted fields normalize (class →
	 * "cloud", runtime → "unknown") — fail-expensive.
	 */
	endpoint?: Partial<EndpointInfo> | undefined;
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
	/**
	 * Wall-clock compute duration in milliseconds (local runtimes report it,
	 * e.g. Ollama eval_duration). Flows to receipt.meter.computeMs. Non-finite
	 * or negative values are dropped (A6: the field is then omitted entirely).
	 */
	computeMs?: number | undefined;
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

// ── M2 endpoint scope helpers ──

/**
 * Normalize a (possibly partial, e.g. untyped-JS-caller) endpoint shape into a
 * full EndpointInfo. Missing class defaults to "cloud" — the fail-EXPENSIVE
 * safe default — and missing runtime to "unknown".
 */
function normalizeEndpoint(endpoint: Partial<EndpointInfo> | undefined): EndpointInfo {
	return {
		class: endpoint?.class ?? "cloud",
		runtime: endpoint?.runtime ?? "unknown",
		...(endpoint?.baseURL !== undefined ? { baseURL: endpoint.baseURL } : {}),
	};
}

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
	// AUD-457 hardening (RECON #4): UNIQUE tmp path per write. A fixed
	// `spend-ledger.json.tmp` lets two concurrent writers clobber each other's
	// staging file, so a half-written record can be renamed into place. A pid +
	// uuid suffix isolates every writer's staging file.
	const tmpPath = join(dir, `spend-ledger.json.${process.pid}.${randomUUID()}.tmp`);
	try {
		// Ensure vault dir exists
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		// MONOTONIC guard (RECON #4): cumulative spend must never regress on disk.
		// A stale/racing writer carrying a lower budgetSpent must not "un-spend"
		// money that another writer (a concurrent settle, another process, or a
		// prior run) already recorded. Skip the write if the persisted value is
		// already >= ours.
		const existing = await loadSpendLedger(vaultBase);
		if (existing > budgetSpent) {
			return;
		}
		const data: SpendLedger = {
			budgetSpent,
			updatedAt: new Date().toISOString(),
		};
		// Atomic write: write UNIQUE tmp then rename over the target.
		await writeFile(tmpPath, JSON.stringify(data), "utf-8");
		await rename(tmpPath, ledgerPath);
	} catch {
		// Best-effort — do not fail the LLM call over ledger persistence. Clean up
		// our unique staging file if the rename never happened.
		await unlink(tmpPath).catch(() => {});
	}
}

// ── TigerBeetle engine factory (mirrors govern.ts) ──

/** TigerBeetle codes that mean "this debit would exceed the account's credits". */
function isTBInsufficientBalance(err: unknown): boolean {
	if (!(err instanceof TBTransferError)) return false;
	return (
		err.code === CreateTransferStatus.exceeds_credits ||
		err.code === CreateTransferStatus.overflows_debits ||
		err.code === CreateTransferStatus.overflows_debits_pending
	);
}

/** TigerBeetle's answer when the account being debited does not exist at all. */
function isTBDebitAccountNotFound(err: unknown): boolean {
	if (!(err instanceof TBTransferError)) return false;
	return err.code === CreateTransferStatus.debit_account_not_found;
}

/**
 * Create a balance-enforcing TrustEngine backed by a real TigerBeetle client.
 *
 * P1-LEDGER-ENFORCE (RECON #3): the holding account is created with
 * `debits_must_not_exceed_credits` and FUNDED with `seedBudget` usertokens, so a
 * pending debit (hold) whose cumulative amount would exceed the remaining budget
 * is REJECTED atomically by TigerBeetle. That rejection is surfaced as an
 * {@link InsufficientBalanceError}, which the governor re-throws as a hard budget
 * DENY (never as a ledger outage).
 *
 * NOTE (cross-domain): RECON #3 designates `createLedgerEngine` /
 * `createFundedBudgetWallet` (LEDGER-owned, in `ledger/engine.ts`) as the eventual
 * home for this factory. Those symbols do not yet exist on disk, so this
 * HEADLESS-local factory implements the same funded-enforcing contract using the
 * existing `TrustTBClient` primitives — identical to the GOVERN-local factory in
 * `govern.ts`. When LEDGER ships `createLedgerEngine`, BOTH `trust()` and
 * `createGovernor()` should switch to it in lockstep.
 *
 * LOCKSTEP: this is a duplicate of `govern.ts`'s factory and every change there
 * belongs here verbatim (AGENTS.md, Known drift). `tests/harden/
 * engine-factory-parity.test.ts` compares the two as source text and fails on a
 * one-sided edit. It stays UNEXPORTED — `usertrust/headless` is a package entry
 * point, so exporting it would ship an engine factory to consumers; the seam
 * tests drive `govern.ts`'s copy by name and this one through `createGovernor()`.
 */
async function createTBEngine(config: TrustConfig, seedBudget: number): Promise<TrustEngine> {
	const tbAddresses = config.tigerbeetle.addresses;
	const tbClusterId = BigInt(config.tigerbeetle.clusterId);

	const tbClient = new TrustTBClient({
		addresses: tbAddresses,
		clusterId: tbClusterId,
	});

	// Treasury (unconstrained) funds a per-session enforcing holding wallet.
	await tbClient.createTreasury();
	const treasury = tbClient.getTreasuryId();

	// Enforcing holding wallet (debits_must_not_exceed_credits), funded with the
	// remaining session budget so cumulative pending debits cannot exceed it.
	// A FRESH account id per session prevents double-funding a deterministic
	// account across restarts (which would inflate the TB-enforced budget).
	const holdingId = await tbClient.createFundedBudgetWallet(seedBudget);

	const pendingMap = new Map<string, bigint>();

	return {
		async spendPending(params: {
			transferId: string;
			amount: number;
			debitAccountId?: bigint | undefined;
		}): Promise<{ transferId: string }> {
			// An ATTRIBUTED hold names its own debit account — the cost-center
			// envelope the governor derived at authorize. Unattributed holds keep
			// debiting the session holding wallet, unchanged.
			const debitAccountId = params.debitAccountId ?? holdingId;
			try {
				const tbTransferId = await tbClient.createPendingTransfer({
					debitAccountId,
					creditAccountId: treasury,
					amount: params.amount,
					code: XFER_SPEND,
				});
				pendingMap.set(params.transferId, tbTransferId);
				return { transferId: params.transferId };
			} catch (err) {
				// Over-budget reservation → TB rejects the pending debit. Surface as a
				// budget error so the governor reports a hard DENY, not an outage.
				if (isTBInsufficientBalance(err)) {
					// An ATTRIBUTED hold is rejected by the ENVELOPE's own
					// `debits_must_not_exceed_credits`, so the envelope is the account that
					// has to be named. Reporting `trust:hold` and the session seed names an
					// account the hold never touched and prints an `available` that is
					// routinely GREATER than `required` — a 999-usertoken estimate against a
					// 10-usertoken envelope under a governor seeded at 100000 reads as an SDK
					// bug rather than an exhausted cost center, and names no envelope for the
					// operator to top up.
					// The balance is re-read AFTER the rejection, so it REPORTS rather than
					// decides: TigerBeetle's atomic rejection remains the whole enforcement
					// and no check-then-act enters the money path (budget/allocation.ts does
					// exactly this on its own rejection path). A failed read reports 0 rather
					// than fabricating headroom, and never changes the classification.
					if (params.debitAccountId !== undefined) {
						let available = 0;
						try {
							available = (await tbClient.lookupBalance(params.debitAccountId)).available;
						} catch {
							// Reporting only — a failed read must not mask the budget DENY.
						}
						throw new InsufficientBalanceError(
							`envelope:${params.debitAccountId}`,
							params.amount,
							available,
						);
					}
					// UNATTRIBUTED holds keep today's answer exactly, down to adding no
					// ledger round trip: the seed is a number this factory already holds.
					throw new InsufficientBalanceError("trust:hold", params.amount, seedBudget);
				}
				// A never-allocated envelope has no account at all, and TB answers
				// `debit_account_not_found`. For an ENVELOPE that is a budget answer,
				// not an outage: no account and a zero balance are the same state
				// (budget/allocation.ts reads a missing cost-center account as zero,
				// because never-allocated and fully-reclaimed are indistinguishable).
				// Classifying it as a ledger outage would tell the caller the ledger
				// is down when the truth is "this envelope has no funds" — and would
				// let a retry loop hammer a spend that can never succeed.
				// The envelope is named by its derived account id: the label
				// `parent::costCenter` lives in the governor, never here.
				// UNATTRIBUTED holds keep today's classification exactly. The session
				// wallet is one THIS factory created moments ago, so its absence
				// really is an outage.
				if (params.debitAccountId !== undefined && isTBDebitAccountNotFound(err)) {
					throw new InsufficientBalanceError(`envelope:${params.debitAccountId}`, params.amount, 0);
				}
				throw err;
			}
		},

		async postPendingSpend(transferId: string, actualAmount?: number): Promise<void> {
			const tbId = pendingMap.get(transferId);
			if (tbId === undefined) {
				throw new Error(`No pending transfer found for ${transferId}`);
			}
			// Post the ACTUAL consumed amount (≤ the reserved estimate); omitting it
			// posts the full pending amount.
			await tbClient.postTransfer(tbId, actualAmount);
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
export async function createGovernor(opts?: GovernorOpts): Promise<Governor> {
	// 1. Load config
	const vaultBase = opts?.vaultBase ?? process.cwd();
	const configPath = opts?.configPath ?? join(vaultBase, VAULT_DIR, "usertrust.config.json");

	let config: TrustConfig;
	if (existsSync(configPath)) {
		const raw: unknown = JSON.parse(await readFile(configPath, "utf-8"));
		config = TrustConfigSchema.parse({
			...(raw as Record<string, unknown>),
			...(opts?.budget !== undefined ? { budget: opts.budget } : {}),
			...(opts?.parentUserId !== undefined ? { parentUserId: opts.parentUserId } : {}),
		});
	} else {
		config = TrustConfigSchema.parse({
			budget: opts?.budget ?? DEFAULT_BUDGET,
			...(opts?.parentUserId !== undefined ? { parentUserId: opts.parentUserId } : {}),
		});
	}

	const customRates = config.pricing === "custom" ? config.customRates : undefined;
	// M2: governor-wide default endpoint scope; per-call AuthorizeParams.endpoint
	// overrides it (A3). Defaults to cloud — pre-M2 metering exactly.
	const defaultEndpoint = normalizeEndpoint(opts?.endpoint);
	const isDryRun = opts?.dryRun ?? process.env.USERTRUST_DRY_RUN === "true";
	const isTestEnv = process.env.USERTRUST_TEST === "1" || process.env.NODE_ENV === "test";

	// 2. Initialize subsystems
	const vaultPath = vaultBase;
	const audit: AuditWriter = (isTestEnv ? opts?._audit : undefined) ?? createAuditWriter(vaultPath);

	const policiesPath = join(vaultPath, VAULT_DIR, config.policies);
	const loadedRules = existsSync(policiesPath) ? loadPolicies(policiesPath) : [];
	// P1-CUSTOM-POLICY-REPLACES (RECON #2): platform DEFAULT_RULES are ALWAYS
	// enforced (parity with trust()). mergePolicies is a safe concat — a custom
	// policy file can only ADD deny/warn rules, never remove the
	// budget/overshoot/exhausted guarantees. Before this, headless dropped the
	// defaults entirely when no policies file existed, so authorize() granted
	// unbounded spend with no budget gate at all.
	const policyRules: GateRule[] = mergePolicies(DEFAULT_RULES, loadedRules);

	const breaker = new CircuitBreakerRegistry({
		failureThreshold: config.circuitBreaker.failureThreshold,
		resetTimeoutMs: config.circuitBreaker.resetTimeout,
	});

	// 3. AUD-456: Proxy mode removed — throw early with clear error
	if (opts?.proxy) {
		throw new Error(
			"usertrust: proxy mode is not yet implemented (AUD-456). " +
				"Use dryRun mode for testing, or connect a real TigerBeetle instance for production.",
		);
	}
	// AUD-456: proxyConn is always null now — proxy mode throws above.
	// Cast keeps dead code paths type-safe for future re-enablement.
	const proxyConn = null as ProxyConnection | null;

	// AUD-457: restore cumulative spend from disk BEFORE building the engine so the
	// enforcing holding account can be seeded with the REMAINING budget.
	let budgetSpent = await loadSpendLedger(vaultBase);

	// 4. Engine
	let engine: TrustEngine | null;
	if (isTestEnv && opts?._engine !== undefined) {
		engine = opts._engine;
	} else if (!isDryRun && proxyConn == null) {
		try {
			// P1-LEDGER-ENFORCE (RECON #3): seed the enforcing holding account with the
			// remaining budget so TigerBeetle atomically REJECTS an over-budget hold.
			engine = await createTBEngine(config, Math.max(0, config.budget - budgetSpent));
		} catch (err) {
			throw new LedgerUnavailableError(err instanceof Error ? err.message : String(err));
		}
	} else {
		engine = null;
	}

	// 5. State
	let destroyed = false;
	const budgetMutex = new AsyncMutex();
	let inFlightHoldTotal = 0;
	const activeAuths = new Map<string, Authorization>();

	// Finding-2 (RECON #4): serialized, monotonic spend-ledger persistence.
	// budgetSpent only ever increases (settle adds actualCost >= 0; authorize and
	// abort never mutate it). Persisting OUTSIDE the budget mutex means two
	// concurrent settles can race the read-check-write inside persistSpendLedger:
	// a settle carrying a LOWER cumulative can rename its file AFTER a settle
	// carrying a HIGHER one, regressing the on-disk total and silently
	// under-counting spend on restart (→ overspend). Serializing persistence on a
	// dedicated mutex and refusing to write a value that does not exceed the last
	// value we persisted closes that same-instance race atomically. The disk-read
	// guard + unique tmp inside persistSpendLedger remain as the cross-instance /
	// prior-run defence.
	const persistMutex = new AsyncMutex();
	let lastPersistedSpent = budgetSpent;
	async function persistSpend(): Promise<void> {
		const release = await persistMutex.acquire();
		try {
			// Read the LIVE cumulative under the persist mutex — never a stale
			// snapshot captured at an earlier call site.
			const current = budgetSpent;
			if (current <= lastPersistedSpent) return;
			lastPersistedSpent = current;
			await persistSpendLedger(vaultBase, current);
		} finally {
			release();
		}
	}

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

			// M2: effective endpoint scope — per-call override wins over the
			// governor-wide default (A3). Captured on the Authorization below so
			// settle() meters with the AUTHORIZE-time scope.
			const endpoint =
				params.endpoint !== undefined ? normalizeEndpoint(params.endpoint) : defaultEndpoint;

			// Scope-aware rate resolution. resolveRates never throws;
			// unknownModelPolicy is enforced HERE, at authorize time. `unknown` is
			// only ever true for cloud scope — local misses resolve to
			// "local-default" by definition (A5), so local calls never deny/warn.
			const rateInfo = resolveRates(model, endpoint.class, config);
			if (rateInfo.unknown) {
				if (config.unknownModelPolicy === "deny") {
					throw new PolicyDeniedError(`unknown_model: ${model} not in pricing table`);
				}
				if (config.unknownModelPolicy === "warn") {
					// Shared once-per-process helper — identical wording to trust() (F5).
					warnUnknownModel(model);
				}
			}

			// Estimate cost
			const transferId = trustId("tx");
			const estInputTokens = params.estimatedInputTokens ?? estimateInputTokens(messages);
			const maxOutputTokens = params.maxOutputTokens ?? 4096;
			const estCost = costFromRates(rateInfo.rates, estInputTokens, maxOutputTokens);

			// Acquire mutex for budget atomicity (AUD-453)
			const releaseBudgetLock = await budgetMutex.acquire();
			let proxyTransferId: string | undefined;

			try {
				// Policy gate — caller params spread FIRST so trusted governance
				// fields (tier/estimated_cost/budget_remaining/budget_remaining_after)
				// CANNOT be shadowed by attacker-controlled params.
				// P1-BUDGET-PREFLIGHT (RECON #1): budget_remaining_after is the derived
				// field the block-budget-overshoot default rule compares against zero to
				// deny a single overshooting call PRE-spend. As a HARD rule it fails
				// CLOSED if omitted, so it MUST be supplied on every evaluation.
				const policyResult = evaluatePolicy(policyRules, {
					...(params.params ?? {}),
					model,
					tier: config.tier,
					estimated_cost: estCost,
					budget_remaining: config.budget - budgetSpent - inFlightHoldTotal,
					budget_remaining_after: config.budget - budgetSpent - inFlightHoldTotal - estCost,
					// P1-BUDGET-TIER-SHADOW: the budget tier fields are trusted-host input.
					// The governor knows no cost-center allocation, so the honest value is
					// ABSENT — and asserting it here is what stops `params.params` from
					// supplying its own `budgetFractionRemaining` and satisfying a tier
					// that guards frontier spend. An `exists`-guarded rule then simply
					// does not match; it never matches an attacker's number.
					budgetFractionRemaining: undefined,
					budgetRunwayHours: undefined,
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
						// P1-LEDGER-ENFORCE: an over-budget reservation is rejected
						// atomically by the ledger. Surface it as a hard budget DENY —
						// NOT as "ledger unavailable" (which would misreport a budget cap
						// as an outage).
						if (holdErr instanceof InsufficientBalanceError) {
							throw holdErr;
						}
						// Genuine ledger outage — do NOT forward to provider.
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
				endpoint,
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

			// A3: settlement meters with the endpoint scope CAPTURED AT AUTHORIZE —
			// SettleParams carries no endpoint field by design.
			const endpoint = auth.endpoint ?? defaultEndpoint;
			const rateInfo = resolveRates(model, endpoint.class, config);

			// Determine actual cost
			let actualCost: number;
			let usageSource: "provider" | "estimated";
			if (params?.inputTokens != null || params?.outputTokens != null) {
				actualCost = costFromRates(
					rateInfo.rates,
					params.inputTokens ?? 0,
					params.outputTokens ?? 0,
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
			// Finding-2 (RECON #4): serialized monotonic persist — never regresses.
			await persistSpend();

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
					// Post the ACTUAL consumed cost (RECON #3) — which may be less than
					// the reserved estimate.
					await engine.postPendingSpend(auth.transferId, actualCost);
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
				// M2: endpoint classification + metering provenance (A6: computeMs is
				// OMITTED, never undefined, when absent/invalid).
				endpoint: { class: endpoint.class, runtime: endpoint.runtime },
				meter: {
					costBasis: rateInfo.costBasis,
					rateSource: rateInfo.rateSource,
					...(params?.computeMs != null &&
					Number.isFinite(params.computeMs) &&
					params.computeMs >= 0
						? { computeMs: params.computeMs }
						: {}),
				},
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
