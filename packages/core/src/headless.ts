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
import { getCurrentCostCenter } from "./budget/attribution.js";
// The cost-center envelope helpers are SHARED with `govern.ts`, not copied from
// it (see the block comment above `ResolvedEnvelope` there). D1's throw, A2's
// pre-gate refusal, A7's unfloored arithmetic and D5's label re-wrap all decide
// whether a spend happens and which wallet it names — a second copy here would be
// a money drift the type checker could never catch. `createTBEngine` below stays
// duplicated because that predates this PR and has its own parity test; nothing
// says the next shared thing has to repeat the mistake.
import {
	asEnvelopeBalanceError,
	envelopeReceiptBudget,
	envelopeTierFields,
	preflightEnvelopeRemaining,
	type ResolvedEnvelope,
	resolveEnvelope,
	snapshotEnvelopeRemaining,
	type TrustEngine,
	type TrustOpts,
} from "./govern.js";
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
import { derivePolicyHint, evaluatePolicy, type GateRule, loadPolicies } from "./policy/gate.js";
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
	/**
	 * The cost-center this call's PENDING hold debits, captured from the
	 * `withCostCenter` scope that was active when `authorize()` was called. Absent
	 * for an unattributed call, which debits the session holding wallet exactly as
	 * it did before envelopes existed.
	 *
	 * REPORTING ONLY, and the governor does not read it back. Writing to it
	 * re-routes nothing and relabels nothing: the hold is already placed by the time
	 * a caller sees this handle, and `settle()`/`abort()` take the attribution from
	 * the governor's own internal capture keyed by `transferId` — see
	 * {@link AuthorizationCapture}, which is where the resolved envelope lives too.
	 *
	 * A plain string on purpose. The resolved envelope's `accountId` is a bigint,
	 * which `JSON.stringify` cannot serialize, so it is kept OFF this public handle
	 * and only on the internal capture — an attributed handle stays JSON-serializable
	 * for an integration that logs or transports it, exactly like an unattributed one.
	 * `settle()`/`abort()` never need the account from here anyway.
	 */
	costCenter?: string | undefined;
}

/**
 * @internal The governor's OWN per-call record, keyed by `transferId` in
 * `activeAuths` — never the caller's `Authorization` object.
 *
 * Everything here is decided at authorize, inside the governor, and is
 * unreachable from caller code afterwards. That is the whole point: an audit
 * record must come from the authorize-time capture, never from caller input
 * (AGENTS.md, Audit), and the caller holds a live reference to the handle for the
 * entire authorize→settle window.
 */
interface AuthorizationCapture {
	readonly proxyTransferId: string | undefined;
	/** The scope's cost center, or `undefined` for an unattributed call. */
	readonly costCenter: string | undefined;
	/**
	 * The frozen envelope the hold debited, or `undefined` when unattributed. Its
	 * `accountId` is a bigint, which is the second reason it lives HERE and never on
	 * the public `Authorization`: keeping it off the handle leaves that handle
	 * JSON-serializable, and the governor never needs the account from
	 * caller-reachable state anyway.
	 *
	 * WHY THE GOVERNOR READS THIS, NEVER THE HANDLE. `trust()` carries attribution by
	 * closure because its terminals are closures; `createGovernor()` has none —
	 * `settle()`/`abort()` are separate calls that routinely run on a different task,
	 * after the `withCostCenter` scope has exited, so there is NO AsyncLocalStorage
	 * context to read at settle time and a `getCurrentCostCenter()` call there would
	 * answer with a later, unrelated call's scope or with nothing at all, silently.
	 * And the handle is the caller's own object: reading an envelope back off it would
	 * let a caller relabel the settle/abort audit record and the receipt's budget
	 * block between the two phases — and, because `snapshotEnvelopeRemaining` reads
	 * whatever account the envelope names, put an arbitrary account's balance on the
	 * receipt. So this immutable capture, keyed by `transferId`, is the single source
	 * of settle-time attribution.
	 */
	readonly envelope: ResolvedEnvelope | undefined;
	/**
	 * Whether this hold moved the SESSION wallet's accounting
	 * (`inFlightHoldTotal`, and `budgetSpent` on settle). False exactly when the
	 * hold debited a cost-center envelope instead. Recorded here rather than
	 * re-derived at settle so the release can never be asymmetric with the
	 * increment — a decrement without its matching increment drives
	 * `inFlightHoldTotal` negative and hands the session more headroom than its
	 * budget.
	 */
	readonly sessionAccounted: boolean;
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
	 *
	 * Call it INSIDE a `withCostCenter(cc, fn)` scope to charge the call to that
	 * cost-center envelope: the hold debits the `(parentUserId, cc)` wallet, the
	 * policy gate is evaluated against THAT envelope's live balance, and the
	 * attribution is captured on the returned handle. Attribution is read here and
	 * only here — see {@link AuthorizationCapture}.
	 */
	authorize(params: AuthorizeParams): Promise<Authorization>;

	/**
	 * Phase 2a: Settle a successful call.
	 * POSTs the pending hold, writes audit event, returns receipt.
	 *
	 * Safe to call from anywhere, including a different task with no
	 * `withCostCenter` scope active: attribution comes from the handle, never from
	 * the ambient scope at settle time.
	 */
	settle(auth: Authorization, params?: SettleParams): Promise<TrustReceipt>;

	/**
	 * Phase 2b: Abort a failed call.
	 * VOIDs the pending hold, writes failure audit.
	 *
	 * Attribution comes from the handle here too — see settle().
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

	// Pending transfer mapping (trustId string -> TB id + the reserved amount).
	// heldAmount is what postPendingSpend caps against: TigerBeetle REJECTS a post
	// above the pending amount (exceeds_pending_transfer_amount) — it never caps —
	// so the truncation must happen here, where the reserve is known (spec D1).
	const pendingMap = new Map<string, { tbId: bigint; heldAmount: number }>();

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
				pendingMap.set(params.transferId, { tbId: tbTransferId, heldAmount: params.amount });
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

		/**
		 * Delegate verbatim to the client's batch read. MF1: this four-line
		 * delegation is the whole reason the governor can see an envelope at all.
		 * Implementing it only on mocks — which the first cut of the threading did —
		 * leaves every unit test green while PRODUCTION ships attributed calls with
		 * no envelope-scoped policy numbers and no receipt snapshot: the same
		 * mock-shadows-production shape AGENTS.md records for the dead budget API.
		 * A test drives the preflight through THIS factory for that reason.
		 */
		async lookupBalances(accountIds: bigint[]): Promise<Map<bigint, number>> {
			return await tbClient.lookupBalances(accountIds);
		},

		async postPendingSpend(
			transferId: string,
			actualAmount?: number,
			// biome-ignore lint/suspicious/noConfusingVoidType: matches the TrustEngine interface, where `void` is load-bearing (see the declaration in govern.ts).
		): Promise<{ posted: number; shortfall: number } | void> {
			const entry = pendingMap.get(transferId);
			if (entry === undefined) {
				throw new Error(`No pending transfer found for ${transferId}`);
			}
			// Post at most the RESERVED amount; the truncation (shortfall) is
			// returned for the governor to audit. Omitting actualAmount still posts
			// the full pending amount (amount_max), unchanged.
			const posted =
				actualAmount != null ? Math.min(actualAmount, entry.heldAmount) : entry.heldAmount;
			await tbClient.postTransfer(entry.tbId, actualAmount != null ? posted : undefined);
			pendingMap.delete(transferId);
			return { posted, shortfall: actualAmount != null ? actualAmount - posted : 0 };
		},

		async voidPendingSpend(transferId: string): Promise<void> {
			const entry = pendingMap.get(transferId);
			if (entry === undefined) {
				throw new Error(`No pending transfer found for ${transferId}`);
			}
			await tbClient.voidTransfer(entry.tbId);
			pendingMap.delete(transferId);
		},

		async voidAllPending(): Promise<void> {
			const entries = [...pendingMap.entries()];
			for (const [trustIdKey, entry] of entries) {
				try {
					await tbClient.voidTransfer(entry.tbId);
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
	// Keyed by transferId, holding the GOVERNOR's capture — not the caller's handle.
	const activeAuths = new Map<string, AuthorizationCapture>();

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

			// ── The ONE AsyncLocalStorage read for this call (ALS discipline) ──
			// Read HERE, at the top of the governor's synchronous entry point, while
			// the CALLER's async context — the one `withCostCenter` opened — is still
			// current, and carried on the Authorization handle from here on. This
			// governor has NO closure spanning authorize→settle, so the handle is what
			// a closure is on the `trust()` path: `settle()` and `abort()` are separate
			// calls that routinely run after the scope has already exited, and a store
			// read there would answer with a later, unrelated call's scope or with
			// nothing — silently, never loudly. `budget/attribution.ts` documents the
			// mechanics and pins that hazard as a negative case.
			// D1 lives inside `resolveEnvelope`: an active scope with no `parentUserId`
			// throws right here — before the circuit breaker, before rate resolution,
			// before the mutex, before any I/O at all.
			const attribution = getCurrentCostCenter();
			const envelope = resolveEnvelope(attribution, config.parentUserId);

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
					throw new PolicyDeniedError(
						`unknown_model: ${model} not in pricing table`,
						"Add the model to customRates in trust() options, or use a model from the built-in pricing table.",
					);
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

			// Acquire mutex for budget atomicity (AUD-453). The attributed-envelope
			// preflight read is taken INSIDE this lock (top of the try below) so a
			// concurrent hold to the same envelope cannot land between the read and the
			// gate — see the note there.
			const releaseBudgetLock = await budgetMutex.acquire();
			let proxyTransferId: string | undefined;
			// Set below, at the point the hold actually lands on the envelope wallet.
			// Deliberately NOT `envelope !== undefined`: a dry-run or engine-less
			// attributed call places no envelope hold at all, so the session numbers
			// remain the only — and the honest — accounting for it, exactly as they are
			// the only numbers its policy gate saw.
			let envelopeDebited = false;

			try {
				// Attributed calls only: ONE batched read of the envelope's live
				// `available`, for the policy numbers below. Taken INSIDE the budget mutex
				// — the same lock that serialises the hold — and BEFORE the gate, so this
				// call's own hold lands only after the read and a CONCURRENT attributed
				// authorize on the SAME envelope cannot slip its hold between this read and
				// the gate. When the read was OUTSIDE the lock, both read the pre-hold
				// balance and the second bypassed a hard scarcity tier
				// (`budgetFractionRemaining` / `budgetRunwayHours`) the ledger cannot
				// enforce — TigerBeetle rejects an OVERSHOOT, never a fractional/runway
				// tier. Serialising the read under the hold's lock makes the gate describe
				// the wallet the hold will debit, exactly as the SESSION path already does.
				// Cross-process (multi-governor) concurrency still relies on TB atomicity —
				// overshoot only — the same limitation the session path has. The full
				// rationale lives with the helper in `govern.ts`.
				// A2: a read that FAILS refuses the call outright — the finally below
				// releases the mutex and the ledger-unavailable error propagates before the
				// gate is evaluated or any hold is attempted; gating on the SESSION wallet
				// while the hold debits the ENVELOPE would clear the call against a wallet
				// the money never came from, in the one record an auditor reads.
				const envelopeRemaining = await preflightEnvelopeRemaining(engine, isDryRun, envelope);

				// Policy gate — caller params spread FIRST so trusted governance
				// fields (tier/estimated_cost/budget_remaining/budget_remaining_after)
				// CANNOT be shadowed by attacker-controlled params.
				// P1-BUDGET-PREFLIGHT (RECON #1): budget_remaining_after is the derived
				// field the block-budget-overshoot default rule compares against zero to
				// deny a single overshooting call PRE-spend. As a HARD rule it fails
				// CLOSED if omitted, so it MUST be supplied on every evaluation.
				//
				// ENVELOPE SCOPING (identical to `trust()`'s two sites — the three-site
				// re-assertion table in AGENTS.md is a set, not three independent
				// choices): an ATTRIBUTED call is gated on THE ENVELOPE ITS HOLD WILL
				// DEBIT. `budget_remaining` is that envelope's live ledger `available`,
				// so `block-budget-exhausted` and `block-budget-overshoot` become
				// pre-spend guards on the cost center, ahead of the ledger's own atomic
				// rejection, and the gate and the hold always describe the SAME wallet —
				// the case where they could disagree (an unreadable envelope) refused the
				// call above rather than reaching here (A2).
				// `budget_remaining_after` is deliberately UNFLOORED on both paths (A7):
				// it must be allowed to go NEGATIVE, because `block-budget-overshoot` is
				// a non-disableable hard `lt 0` deny and flooring it at zero would
				// structurally disarm that rule on every attributed call.
				// The session numbers still stand for a call that places no envelope hold
				// at all — unattributed, dry-run, or no engine — which is honest, because
				// nothing debits an envelope on those paths either.
				const sessionRemaining = config.budget - budgetSpent - inFlightHoldTotal;
				const gateRemaining = envelopeRemaining ?? sessionRemaining;
				// P1-BUDGET-TIER-SHADOW: the budget tier fields are trusted-host input,
				// and asserting them here is what stops `params.params` from supplying
				// its own `budgetFractionRemaining` and satisfying a tier that guards
				// frontier spend. They are now REAL for an attributed call whose scope
				// stated its allocation (D4) — the case this governor could not describe
				// before — and stay explicitly `undefined` for every other call, where
				// the honest value is ABSENT: an `exists`-guarded rule then simply does
				// not match, and a hard rule without that guard fires. Never an
				// attacker's number.
				const tierFields =
					envelope !== undefined && envelopeRemaining !== undefined
						? envelopeTierFields(envelope.attribution, envelopeRemaining, Date.now())
						: { budgetFractionRemaining: undefined, budgetRunwayHours: undefined };
				const policyResult = evaluatePolicy(policyRules, {
					...(params.params ?? {}),
					model,
					tier: config.tier,
					estimated_cost: estCost,
					budget_remaining: gateRemaining,
					budget_remaining_after: gateRemaining - estCost,
					budgetFractionRemaining: tierFields.budgetFractionRemaining,
					budgetRunwayHours: tierFields.budgetRunwayHours,
					// Structurally un-forgeable: this comes from the caller's own async
					// execution context, which no request body can reach. Asserted after
					// the spread like every other trusted field, `undefined` included.
					cost_center: envelope?.attribution.costCenter,
				});
				if (policyResult.decision === "deny") {
					const reason =
						policyResult.reasons.length > 0 ? policyResult.reasons.join("; ") : "Policy denied";
					throw new PolicyDeniedError(reason, derivePolicyHint(policyResult));
				}

				// PII check
				if (config.pii !== "off" && messages.length > 0) {
					const piiResult = detectPII(messages);
					if (piiResult.found && config.pii === "block") {
						throw new PolicyDeniedError(
							`PII detected: ${piiResult.types.join(", ")}`,
							'PII enforcement blocked this call. Use { pii: "warn" } to log instead, or { pii: "redact" } to strip PII before egress.',
						);
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
						await engine.spendPending({
							transferId,
							amount: estCost,
							// Attributed → the envelope pays. Unattributed → the key is
							// OMITTED, not passed as undefined, so the engine's default (the
							// session holding wallet) is reached by exactly the path it was
							// before envelopes existed.
							...(envelope !== undefined ? { debitAccountId: envelope.accountId } : {}),
						});
					} catch (holdErr) {
						// P1-LEDGER-ENFORCE: an over-budget reservation is rejected
						// atomically by the ledger. Surface it as a hard budget DENY —
						// NOT as "ledger unavailable" (which would misreport a budget cap
						// as an outage).
						if (holdErr instanceof InsufficientBalanceError) {
							// An attributed rejection is re-presented in the caller's terms:
							// the `parent::costCenter` label instead of a derived account id,
							// and the remedy that actually funds an envelope. Unattributed
							// rejections rethrow the SAME object — nothing on that path moved.
							throw envelope === undefined
								? holdErr
								: asEnvelopeBalanceError(holdErr, envelope.label);
						}
						// Genuine ledger outage — do NOT forward to provider.
						throw new LedgerUnavailableError(
							holdErr instanceof Error ? holdErr.message : String(holdErr),
						);
					}
					// The hold landed. Record WHICH wallet it debited, for the session
					// accounting below and for the release on settle/abort.
					envelopeDebited = envelope !== undefined;
				}

				// SESSION accounting tracks SESSION-WALLET money only. An attributed hold
				// debits the `(parentUserId, costCenter)` envelope, so counting it here
				// would reserve session headroom against money the session wallet never
				// pays — every later unattributed call gated on a smaller number than the
				// wallet actually holds, and (via `budgetSpent` on settle) that shortfall
				// persisted into the next run's holding-wallet seed. The envelope's own
				// `debits_must_not_exceed_credits` is what bounds an attributed call, and
				// the policy gate above is already scoped to it.
				if (!envelopeDebited) {
					inFlightHoldTotal += estCost;
				}
			} finally {
				releaseBudgetLock();
			}

			// ONE capture, frozen, shared by the handle and the governor's own record.
			// Frozen so an in-place edit of the object the caller can see fails loudly
			// instead of looking like it worked; `attribution` is rebuilt frozen rather
			// than trusted to have arrived that way, so the guarantee is local to this
			// file.
			const captured: ResolvedEnvelope | undefined =
				envelope === undefined
					? undefined
					: Object.freeze({
							attribution: Object.freeze({ ...envelope.attribution }),
							accountId: envelope.accountId,
							label: envelope.label,
						});

			const auth: Authorization = {
				transferId,
				estimatedCost: estCost,
				model,
				proxyTransferId,
				createdAt: Date.now(),
				endpoint,
				// Spread-omitted so an unattributed handle keeps exactly the shape it had
				// before envelopes (exactOptionalPropertyTypes: writing
				// `costCenter: undefined` is a DIFFERENT type from omitting the key).
				// Reporting only — the governor reads the capture below, never this. ONLY
				// the serializable cost-center string rides the handle; the resolved
				// envelope (bigint account id) stays on the internal capture, so an
				// attributed handle is still `JSON.stringify`-able for a caller that logs
				// or transports it.
				...(captured !== undefined ? { costCenter: captured.attribution.costCenter } : {}),
			};
			// The GOVERNOR's record. Keyed by transferId and unreachable from caller
			// code, so `settle()`/`abort()` can never be handed a different cost center
			// than the one the hold was placed against.
			activeAuths.set(
				transferId,
				Object.freeze({
					proxyTransferId,
					costCenter: captured?.attribution.costCenter,
					envelope: captured,
					sessionAccounted: !envelopeDebited,
				}),
			);
			return auth;
		},

		async settle(auth: Authorization, params?: SettleParams): Promise<TrustReceipt> {
			// One `get` where there used to be `has` + a read off the caller's object:
			// the presence check and the attribution now come from the same internal
			// record, so liveness and provenance cannot disagree. Semantics are
			// unchanged — the first terminal claims the entry, every later one is
			// refused.
			const capture = activeAuths.get(auth.transferId);
			if (capture === undefined) {
				throw new Error(
					`Authorization ${auth.transferId} is not active (already settled or aborted)`,
				);
			}
			activeAuths.delete(auth.transferId);

			const model = auth.model;
			let callAuditDegraded = false;

			// A1 — forensic continuity: an attributed hold leaves an attributed record
			// on every terminal, so this spreads onto BOTH `settlement_ambiguous`
			// records, the `llm_call` event and the rotated receipt below. It comes from
			// the GOVERNOR'S CAPTURE — never from a store read, never from `params`, and
			// never from the handle: by the time settle runs there is usually no
			// `withCostCenter` scope at all, and everything the caller can reach
			// (`auth`, `SettleParams`) is caller input that must not be able to relabel a
			// spend after the fact. Unattributed calls spread an empty object, so those
			// payloads stay byte-identical to what they were before envelopes.
			const costCenterAudit: { costCenter?: string } =
				capture.costCenter === undefined ? {} : { costCenter: capture.costCenter };

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

			// SESSION accounting, skipped in full when the ENVELOPE paid: this hold was
			// never counted into `inFlightHoldTotal`, so releasing it here would drive
			// that counter negative, and `budgetSpent` must not absorb envelope money it
			// would then persist into the next run's holding-wallet seed. The flag is the
			// authorize-time record, so the release can never be asymmetric with the
			// increment.
			if (capture.sessionAccounted) {
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
			}

			// Circuit breaker: success
			const cb = breaker.get("headless" as never);
			cb.recordSuccess();

			// POST settlement
			let settled = true;
			// D4: set only when the engine capped the post at the reserved hold.
			let postedCost: number | undefined;
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
								...costCenterAudit,
							},
						})
						.catch(() => {
							callAuditDegraded = true;
						});
				}
			} else if (engine != null && !isDryRun) {
				try {
					// Post the ACTUAL consumed cost (RECON #3), capped by the engine at
					// the reserved hold; a truncation comes back as `shortfall`.
					const postResult = await engine.postPendingSpend(auth.transferId, actualCost);
					if (postResult != null && postResult.shortfall > 0) {
						postedCost = postResult.posted;
						await audit
							.appendEvent({
								kind: "settlement_shortfall",
								actor: "local",
								data: {
									model,
									actual: actualCost,
									posted: postResult.posted,
									shortfall: postResult.shortfall,
									transferId: auth.transferId,
									...costCenterAudit,
								},
							})
							.catch(() => {
								callAuditDegraded = true;
							});
					}
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
								...costCenterAudit,
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
						...costCenterAudit,
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
							...costCenterAudit,
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

			// D7: the envelope snapshot is read AFTER the POST, so it reports what the
			// cost center actually holds now rather than in-memory arithmetic that
			// drifts the moment another process spends from the same envelope. It
			// observes; it never decides. A read that fails OMITS the block — this runs
			// after the money committed, and a report must never unwind or re-decide a
			// settlement. Both arguments come from the governor's capture, which is why
			// a settle running outside every `withCostCenter` scope — the normal case for
			// this governor — still names the right envelope, and why a caller cannot
			// point this read at an account their call never touched. It is a
			// POST-SETTLEMENT observation, so it is attached ONLY when `settled` — an
			// ambiguous settlement (POST rejected) leaves the transfer possibly still
			// pending, so the balance is transient; we do not even read the ledger then.
			const settledBudget = settled
				? envelopeReceiptBudget(
						capture.envelope,
						await snapshotEnvelopeRemaining(engine, isDryRun, capture.envelope),
					)
				: undefined;

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
				...(postedCost !== undefined ? { postedCost } : {}),
				...(settledBudget !== undefined ? { budget: settledBudget } : {}),
				...(callAuditDegraded ? { auditDegraded: true as const } : {}),
				...(proxyConn != null ? { proxyStub: true as const } : {}),
			};

			return receipt;
		},

		async abort(auth: Authorization, error?: unknown): Promise<void> {
			// Same lookup as settle, and the same reason: liveness and attribution come
			// from one internal record. Still idempotent-silent, unlike settle.
			const capture = activeAuths.get(auth.transferId);
			if (capture === undefined) {
				// Already settled or aborted — idempotent
				return;
			}
			activeAuths.delete(auth.transferId);

			// Only the session wallet's own in-flight exposure is released here; an
			// attributed hold never added to it (see authorize), and the VOID below is
			// what returns the envelope's funds.
			if (capture.sessionAccounted) {
				// AUD-453: Acquire mutex for budget atomicity
				const releaseLock = await budgetMutex.acquire();
				try {
					inFlightHoldTotal -= auth.estimatedCost;
				} finally {
					releaseLock();
				}
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

			// Audit the failure.
			// A1: an attributed hold leaves an attributed record on the VOID terminal
			// too — forensic continuity, so an auditor reconstructing a cost center's
			// history sees the calls that were held against it and released, not only
			// the ones that settled. Read from the capture, like settle: abort commonly
			// runs from a `catch` block outside the `withCostCenter` scope entirely, and
			// the handle it is handed there is caller-owned.
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
						...(capture.costCenter === undefined ? {} : { costCenter: capture.costCenter }),
					},
				})
				.catch(() => {});
		},

		async destroy(): Promise<void> {
			if (destroyed) return;
			destroyed = true;

			// Void all active authorizations (engine + proxy paths)
			for (const [txId, capture] of activeAuths) {
				if (proxyConn != null && !isDryRun) {
					try {
						await proxyConn.void(capture.proxyTransferId ?? txId);
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
