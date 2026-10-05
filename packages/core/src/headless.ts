// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * headless.ts — Headless Governance API
 *
 * A two-phase lifecycle API (authorize → settle | abort | release) for
 * governing LLM calls WITHOUT requiring a provider SDK client instance.
 * `abort` is for a call that FAILED; `release` gives back a hold that is not a
 * failure (a TTL sweep, a shutdown, a call not made).
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
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CreateTransferStatus, type Transfer } from "tigerbeetle-node";
import { type AuditWriter, createAuditWriter } from "./audit/chain.js";
import {
	appendDenialEvent,
	classifyPolicyDenial,
	type DenialRecord,
	isGovernanceDenial,
	toDenialRuleRefs,
} from "./audit/denial-events.js";
import { writeReceipt } from "./audit/rotation.js";
import { getCurrentCostCenter } from "./budget/attribution.js";
// The money math and the validation doors are IMPORTED from `budget/context.ts`,
// never re-implemented: `budgetContext()` below is a second reader of the same
// ledger balances, and a private clamp/runway copy here would let the pull-side
// report and the standalone `budgetContext` disagree about the same envelope.
import {
	assertDistinctValidCostCenters,
	assertEnvelopeCap,
	type EnvelopeDescriptor,
	type EnvelopeStatus,
	envelopeStatusFrom,
} from "./budget/context.js";
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
	copyAppliedRates,
	costFromRates,
	effectiveCacheWriteRate,
	estimateCost,
	estimateInputTokens,
	PRICING_TABLE_VERSION,
	resolveAppliedRates,
	resolveRates,
	warnCacheRateMigration,
	warnUnknownModel,
} from "./ledger/pricing.js";
import { publishableUsage, sanitizeUsage } from "./ledger/usage.js";
import { recordPattern } from "./memory/patterns.js";
import { DEFAULT_RULES, mergePolicies } from "./policy/default-rules.js";
import {
	derivePolicyHint,
	evaluatePolicy,
	type GateRule,
	loadPolicies,
	sanitizePolicyContext,
} from "./policy/gate.js";
import { detectPII } from "./policy/pii.js";
import type { ProxyConnection } from "./proxy.js";
import { CircuitBreakerRegistry } from "./resilience/circuit.js";
import { DEFAULT_BUDGET, VAULT_DIR } from "./shared/constants.js";
import {
	AlreadySettledError,
	InsufficientBalanceError,
	LedgerUnavailableError,
	PolicyDeniedError,
	SpendLedgerUnreadableError,
} from "./shared/errors.js";
import { idempotencyKeyRefusal, principalFieldRefusal, trustId } from "./shared/ids.js";
import type { EndpointInfo, Principal, TrustConfig, TrustReceipt } from "./shared/types.js";
import { TrustConfigSchema } from "./shared/types.js";

// ── Public types ──

// Re-exported so an integration typing a `budgetContext()` call has both shapes at
// the SAME entry point as the `Governor` it calls — `usertrust/headless` is a
// package entry point in its own right, and a plugin should not have to reach into
// the root export for the argument type of a method it can already see here.
export type { EnvelopeDescriptor, EnvelopeStatus } from "./budget/context.js";
// The same reason: a headless integration names the principal it passes to
// `authorize()` from the entry point it already imports.
export type { Principal } from "./shared/types.js";

/**
 * Options for createGovernor(): TrustOpts plus a governor-wide default
 * endpoint scope (M2 local-model governance).
 *
 * The envelope identity `parentUserId` is INHERITED from TrustOpts — one field
 * and one validation rule across both governors, so a cost center derives the
 * same account whichever one holds the client. Host-owned policy `scope` is
 * inherited the same way — `scopePatterns` match that value, never request
 * content.
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
	/**
	 * The derivation domain for caller idempotency keys: a key becomes
	 * `idempotencyScope ‖ 0x00 ‖ idempotencyKey` before any transfer id is derived
	 * from it, so two governors sharing one TigerBeetle cluster can never collide
	 * on a key unless they share a scope — and sharing a scope is exactly how two
	 * processes agree that a key means one charge.
	 *
	 * Omitted → a random id the VAULT persists (`.usertrust/idempotency-scope`),
	 * created on the first keyed call. Unique per vault and stable across restarts,
	 * which neither a path nor a tenant name is: two containers mounting different
	 * vaults at one path would otherwise share every key on a shared cluster.
	 * `usertrust-server` relies on this per-tenant vault.
	 *
	 * SECURITY: TRUSTED-OPERATOR input, same boundary as `parentUserId` — never
	 * derive it from end-user or request data, or one tenant can claim another's
	 * keys.
	 */
	idempotencyScope?: string | undefined;
}

/** Handle returned by authorize(), passed to settle(), abort() or release(). */
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
	/**
	 * The UN-INFLATED metering estimate (plain `inputPer1k`, unmodified rates),
	 * captured at authorize time — never the write-premium-fattened hold
	 * (`Authorization.estimatedCost`). `settle()`'s "no usage reported"
	 * fallback reads THIS, so a call that never reports cache-write tokens is
	 * never charged, audited, or receipted at the cache-write rate. Internal
	 * only, deliberately off the public `Authorization` handle — see the
	 * `meteredEstimate` comment at the authorize-time computation.
	 */
	readonly meteredEstimate: number;
	/**
	 * The model, endpoint scope and hold amount, as authorize saw them. Every
	 * terminal reads these HERE, never off the caller's handle: the handle is the
	 * caller's own mutable object for the whole authorize→settle window, and a
	 * settle priced from `auth.model` or `auth.endpoint` lets a caller re-rate its
	 * own spend after the hold was placed — one assignment to a cheaper model, or to
	 * `class: "local"`, and the call settles at that model's rates. The same holds
	 * for the session accounting: what authorize added to `inFlightHoldTotal` is
	 * `holdAmount`, so that is what every terminal subtracts, and a caller editing
	 * `estimatedCost` cannot move the session's in-flight total.
	 */
	readonly model: string;
	readonly endpoint: EndpointInfo;
	readonly holdAmount: number;
	/** The principal REBUILT and frozen at authorize, or `undefined` when none was given. */
	readonly principal: Readonly<Principal> | undefined;
	/** A keyed call's derived identity, or `undefined` for an unkeyed call. */
	readonly idempotency: KeyedCall | undefined;
}

/**
 * @internal A caller idempotency key, after derivation. The raw key lives on only
 * inside `derivedKey` (the in-process replay map's key) and is never written to
 * any record: the chain sees `keyHash` alone.
 */
interface KeyedCall {
	/** `scope ‖ 0x00 ‖ key` — what every transfer id for this key is derived from. */
	readonly derivedKey: string;
	/** The post ANCHOR: `deriveTransferId(derivedKey, "post")`, restart-stable. */
	readonly postId: bigint;
	/** SHA-256 hex of `derivedKey` — the only form of the key a record may carry. */
	readonly keyHash: string;
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
	/**
	 * A caller idempotency key: 1–256 characters of printable ASCII
	 * (`[\x21-\x7e]`), refused with a `TypeError` before any I/O otherwise.
	 *
	 * TigerBeetle is the record of "already charged": the key's POST id is derived
	 * from the key alone, so at most one charge per key ever commits — across
	 * processes and restarts. Within one process, a replay while the first hold is
	 * still active returns that SAME handle and creates no second hold. A key whose
	 * charge already posted is refused with `AlreadySettledError`, at authorize or,
	 * for a concurrent duplicate, at settle (whose own hold is then released).
	 *
	 * The replay returns the FIRST call's handle and re-reads nothing from the
	 * replay's own parameters: the key is the intent. A process-local check that
	 * the parameters match would make the same replay succeed or fail depending on
	 * whether the process had restarted, because the ledger records no parameters.
	 *
	 * Deliberate narrowing: a hold that never settled before its process restarted
	 * is left to TigerBeetle's own pending timeout, and a replay after the restart
	 * authorizes afresh — {@link Governor.recordUnheldSettlement} is how a settle
	 * that arrives for such a hold is recorded rather than lost. In `dryRun` there
	 * is no ledger, so only the in-process replay holds. The raw key is never
	 * recorded — only its SHA-256.
	 */
	idempotencyKey?: string | undefined;
	/**
	 * Who spent — see {@link Principal}. Each field must be 1–128 characters of
	 * `[A-Za-z0-9._:-]`, refused with a `TypeError` before any I/O otherwise. Each
	 * field is read ONCE, and the record carries an object rebuilt from those
	 * reads, so a getter, a later mutation or an extra key never reaches a record.
	 * Never affects the wallet or the policy gate.
	 */
	principal?: Principal | undefined;
}

/** What {@link Governor.recordUnheldSettlement} found. */
export type UnheldSettlementOutcome =
	| {
			/** The key has a hold here that can still be settled: settle THAT one. */
			readonly outcome: "held";
			readonly transferId: string;
	  }
	| {
			/** No live hold and no charge: the reported usage is recorded as unrecoverable. */
			readonly outcome: "unrecoverable";
			/** False for an exact retry this governor had already recorded — no second record. */
			readonly recorded: boolean;
	  };

/**
 * A settle for a hold this governor does not hold — see
 * {@link Governor.recordUnheldSettlement}. Only the usage counts are read; a
 * settle's other fields describe a hold, and there is none.
 */
export interface UnheldSettlementParams {
	/** The key the hold was authorized under. The same rule as `AuthorizeParams.idempotencyKey`. */
	idempotencyKey: string;
	/** The usage the late settle reported. */
	usage?:
		| Pick<
				SettleParams,
				"inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "usageSource"
		  >
		| undefined;
	/** Who spent. The same rule as `AuthorizeParams.principal`. */
	principal?: Principal | undefined;
}

/**
 * Parameters for settling an authorized call.
 *
 * The four token fields are the DISJOINT tiers of spec D2: `inputTokens` is
 * FRESH input only, with cached reads and cache writes reported separately.
 * Callers that normalize their own provider usage (openclaw does) must not
 * leave cache tokens inside `inputTokens` — they would then price at
 * `inputPer1k` instead of the cache rates, which overstates reads by ~10x.
 *
 * Supplying ANY of the four counts makes the settle "reported": the cost is
 * metered from what was supplied and the omitted counts are 0. Supplying NONE
 * falls back to the pre-call metering estimate.
 */
export interface SettleParams {
	/** Actual FRESH input tokens consumed (cache tiers excluded). */
	inputTokens?: number | undefined;
	/** Actual output tokens consumed, including provider-billed thinking tokens. */
	outputTokens?: number | undefined;
	/**
	 * Cache-hit prompt tokens (D5). Priced at the model's resolved
	 * `cacheReadPer1k`; when the model publishes none, at `inputPer1k` (D1 —
	 * absence is never free).
	 */
	cacheReadTokens?: number | undefined;
	/** Cache-creation prompt tokens (D5). Priced at the resolved `cacheWritePer1k`. */
	cacheWriteTokens?: number | undefined;
	/** Number of streaming chunks delivered (for streaming calls). */
	chunksDelivered?: number | undefined;
	/**
	 * Whether usage came from the provider or the caller's estimate.
	 *
	 * Headless trusts this label — it is an operator boundary, and the caller is
	 * the only party that knows where its counts came from (D5). What is NOT
	 * trusted is a count: a `"provider"` label over an unusable `inputTokens` or
	 * `outputTokens` still yields `usageSource: "estimated"` and NO `usage`
	 * record, because a published four-tier record containing a fabricated zero
	 * is the one thing D5 forbids outright.
	 */
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
	 * `withCostCenter` scope active: attribution, model, endpoint scope and hold
	 * amount all come from the governor's own capture, keyed by
	 * `auth.transferId` — never from the ambient scope at settle time, and never
	 * read back off the handle.
	 *
	 * A keyed call whose key the ledger already charged under ANOTHER hold (a
	 * concurrent duplicate) is never posted: this hold is released and the settle
	 * throws `AlreadySettledError`.
	 */
	settle(auth: Authorization, params?: SettleParams): Promise<TrustReceipt>;

	/**
	 * Phase 2b: Abort a failed call.
	 * VOIDs the pending hold, writes failure audit.
	 *
	 * Reads the governor's capture, never the handle — see settle().
	 */
	abort(auth: Authorization, error?: unknown): Promise<void>;

	/**
	 * Phase 2c: Release a hold that is neither a success nor a failure — a TTL
	 * sweep, a shutdown, a call the caller decided not to make.
	 *
	 * VOIDs the pending hold exactly as abort() does, but it is NOT a failure: it
	 * records no circuit-breaker failure and writes the neutral `hold_released`,
	 * never `llm_call_failed`. abort() still means "the call failed".
	 *
	 * Same claim discipline as abort(): a silent no-op while the hold's POST is in
	 * flight, and a silent no-op for a hold already settled, aborted or released.
	 * `reason` is caller text, so it is recorded only after control characters are
	 * stripped, clipped to 200 characters; it defaults to `"released"`.
	 */
	release(auth: Authorization, reason?: string): Promise<void>;

	/**
	 * Record a settle that arrived for a hold this governor does NOT hold — it
	 * expired, a TTL sweep released it, or the process that placed it has since
	 * restarted. Real provider spend that no settle can charge must never go
	 * unrecorded; this is where it is recorded. No ledger effect in any branch.
	 *
	 * Keyed only, because the key's post anchor is what tells "never charged" from
	 * "a retry of a settle that already charged":
	 *  - the key has a hold in THIS governor that can still be settled →
	 *    `{ outcome: "held", transferId }`, and nothing is recorded: settle that hold;
	 *  - an authorize for the key is in flight, or a settle of it is mid-POST → that
	 *    is waited out, and the key asked again;
	 *  - the ledger holds a post under the key → `AlreadySettledError`, because the
	 *    charge stands;
	 *  - otherwise → appends `settlement_unrecoverable` (the key's SHA-256, the
	 *    principal, the reported usage) and answers `{ outcome: "unrecoverable" }`.
	 *    An exact in-process retry (same key, same usage) is answered with
	 *    `recorded: false` and no second record.
	 *
	 * The charge itself is still recoverable by the caller: a fresh `authorize()`
	 * under the same key, then `settle()`, posts under the key's anchor. This records
	 * that THIS settle could not.
	 *
	 * @throws TypeError for a missing or invalid key, or an invalid principal — before
	 * any I/O. Usage is read like settle()'s: unusable counts are sanitized, not refused.
	 * @throws LedgerUnavailableError when the post anchor cannot be read, or the
	 * engine cannot read transfers at all. Nothing is recorded, because "no charge
	 * exists" is not known.
	 * @throws whatever the audit append throws: an unrecoverable settlement whose
	 * record did not land must not be reported as recorded.
	 */
	recordUnheldSettlement(params: UnheldSettlementParams): Promise<UnheldSettlementOutcome>;

	/** Graceful shutdown — voids all pending holds, flushes audit. */
	destroy(): Promise<void>;

	/**
	 * The pull-side scarcity read across this governor's own envelopes — what an
	 * integration puts in front of the model so it can spend like it knows what
	 * things cost. Batched: exactly ONE ledger round trip for the whole array,
	 * answered in descriptor order.
	 *
	 * REPORTING ONLY (A8). Nothing here gates, delays, or decides a spend, and
	 * the numbers are snapshots that can race a concurrent settlement — the same
	 * observational contract `budget/context.ts` documents at length.
	 *
	 * TWO LAYERS, deliberately not the same layer:
	 *  - Pre-I/O validation THROWS — the `MAX_ENVELOPES` cap, the
	 *    per-descriptor cost-center door and duplicate rejection are caller/config
	 *    bugs, and answering `[]` would hide a misconfiguration forever.
	 *  - Every READ failure is quiet: dryRun, no engine, an engine without
	 *    `lookupBalances`, a rejected lookup, or a governor with no
	 *    `parentUserId` all answer `[]`.
	 *
	 * `envelopes` is CALLER TRUTH for reporting only. There is no cost-center
	 * registry, so `allocated` and the period bounds come from the caller's own
	 * bookkeeping — a descriptor neither creates nor funds an envelope
	 * (`allocateBudget` does).
	 *
	 * @throws Error when `envelopes.length` exceeds the cap, a `costCenter` fails
	 * validation, or two descriptors name the same one — all before any ledger I/O.
	 */
	budgetContext(envelopes: EnvelopeDescriptor[]): Promise<EnvelopeStatus[]>;

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

// ── release() reason ──

/** The longest `hold_released` reason the chain records, in characters (code points). */
const RELEASE_REASON_MAX = 200;

/**
 * `release()`'s reason is CALLER text — over HTTP it is a remote tenant's — bound
 * for the hash chain, where an auditor's tooling later prints it. So control
 * characters are STRIPPED (C0, DEL and C1: the 8-bit CSI/OSC introducers live in
 * C1), and only then is it clipped: sanitize first, clip second (AGENTS.md), so a
 * run of controls can neither survive the clip nor eat into the 200 characters a
 * real reason gets. Iterating a string yields code points, so the clip never
 * splits a surrogate pair. Stripped rather than substituted because this is a
 * stored record, not a terminal render: a `?` would read as part of the reason.
 *
 * Non-string input (an untyped caller) and a reason that strips to nothing both
 * record the default, so the record always says something true.
 *
 * Exported so an integration that echoes the reason elsewhere (usertrust-server's
 * `released` SSE event) sends exactly what the chain recorded, never a second rule.
 */
export function sanitizeReleaseReason(reason: unknown): string {
	if (typeof reason !== "string") return "released";
	let out = "";
	let kept = 0;
	for (const ch of reason) {
		const code = ch.codePointAt(0) as number;
		const safe = code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? "" : ch;
		if (safe === "") continue;
		out += safe;
		kept += 1;
		if (kept === RELEASE_REASON_MAX) break;
	}
	return out === "" ? "released" : out;
}

// ── Caller idempotency keys and principals ──

/**
 * An operator's explicit `idempotencyScope`, validated before any I/O so a
 * misconfigured governor throws before a TigerBeetle client exists to leak.
 * `undefined` when none was given: the vault's persisted scope is then used.
 */
function explicitScopeOf(scope: unknown): string | undefined {
	if (scope === undefined) return undefined;
	if (typeof scope !== "string" || scope === "") {
		throw new TypeError("idempotencyScope must be a non-empty string");
	}
	return scope;
}

/** Where a vault keeps its default idempotency scope — see {@link persistedScope}. */
const SCOPE_FILE = "idempotency-scope";
const PERSISTED_SCOPE_PATTERN =
	/^vault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The DEFAULT idempotency scope: a random id created ONCE per vault and kept in it.
 *
 * A path would be neither unique nor stable. Containers that mount different vaults
 * at the same path would share every key on a shared ledger cluster — one's
 * legitimate key refused, or its settle released as a duplicate, as though another
 * had charged it — and the same vault reached by a different path after a config
 * change would derive new keys, so a replay of a key it had already charged would
 * charge again. One id per vault is unique wherever the vaults differ and stable
 * wherever the vault persists.
 *
 * Created without ever overwriting: the id is written to a temp file, then
 * HARD-LINKED into place, which fails with EEXIST instead of replacing a scope
 * another process created first — so two processes opening one fresh vault agree
 * on one scope. A file that exists but holds no scope is an error, never replaced:
 * a new scope would let every key this vault already charged charge again.
 */
async function persistedScope(vaultBase: string): Promise<string> {
	const dir = join(vaultBase, VAULT_DIR);
	const file = join(dir, SCOPE_FILE);
	const existing = await readPersistedScope(file);
	if (existing !== undefined) return existing;
	await mkdir(dir, { recursive: true });
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const handle = await open(tmp, "wx");
		try {
			await handle.writeFile(`vault:${randomUUID()}\n`, "utf-8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await link(tmp, file).catch((err: unknown) => {
			if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
		});
		// The link must survive a power loss too, or a restart mints a second scope.
		// Best effort where a directory cannot be fsynced at all, as for the spend
		// ledger — but never silently on a real failure.
		const dirHandle = await open(dir, "r");
		try {
			await dirHandle.sync();
		} catch (dirErr) {
			const code = (dirErr as NodeJS.ErrnoException)?.code;
			if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM" && code !== "EBADF") {
				throw dirErr;
			}
		} finally {
			await dirHandle.close();
		}
	} finally {
		await unlink(tmp).catch(() => {});
	}
	const created = await readPersistedScope(file);
	if (created === undefined) {
		throw new Error(`the idempotency scope ${file} vanished while it was being created`);
	}
	return created;
}

async function readPersistedScope(file: string): Promise<string | undefined> {
	let raw: string;
	try {
		raw = await readFile(file, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw err;
	}
	const scope = raw.trim();
	if (!PERSISTED_SCOPE_PATTERN.test(scope)) {
		throw new Error(
			`${file} does not hold an idempotency scope. It is not replaced: a new scope would let every key this vault already charged charge again. Restore it, or pass idempotencyScope explicitly.`,
		);
	}
	return scope;
}

/**
 * Read a caller's `idempotencyKey` ONCE and refuse anything but a legal key with a
 * `TypeError`, before any I/O. `undefined` for an unkeyed call.
 */
function validKey(raw: unknown): string | undefined {
	if (raw === undefined) return undefined;
	const refusal = idempotencyKeyRefusal(raw);
	if (refusal !== null) throw new TypeError(`idempotencyKey ${refusal}`);
	return raw as string;
}

/**
 * Everything the governor derives from a valid key. `scope ‖ 0x00 ‖ key` is
 * injective without escaping: a key is printable ASCII and can never contain 0x00,
 * so the LAST 0x00 in a derived key always splits it back into its scope and key,
 * whatever the scope contains.
 */
function keyedCall(key: string, scope: string): KeyedCall {
	const derivedKey = `${scope}\u0000${key}`;
	return Object.freeze({
		derivedKey,
		postId: TrustTBClient.deriveTransferId(derivedKey, "post"),
		keyHash: createHash("sha256").update(derivedKey, "utf8").digest("hex"),
	});
}

/**
 * Read a caller's `principal` — each field EXACTLY once, so a getter cannot pass
 * validation with one value and be recorded with another — and rebuild it from the
 * validated scalars, frozen. Extra keys never survive. `undefined` for none; a
 * `TypeError` for anything else.
 */
function capturePrincipal(raw: unknown): Readonly<Principal> | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new TypeError("principal must be an object { id, type, origin? }");
	}
	const source = raw as Record<string, unknown>;
	const id = source.id;
	const type = source.type;
	const origin = source.origin;
	const fields: Array<[string, unknown]> = [
		["id", id],
		["type", type],
	];
	if (origin !== undefined) fields.push(["origin", origin]);
	for (const [name, value] of fields) {
		const refusal = principalFieldRefusal(value);
		if (refusal !== null) throw new TypeError(`principal.${name} ${refusal}`);
	}
	return Object.freeze(
		origin === undefined
			? { id: id as string, type: type as string }
			: { id: id as string, type: type as string, origin: origin as string },
	);
}

/**
 * The `principal` member of a record: the KEY absent when there is none, so an
 * unlabelled record keeps exactly its pre-principal shape (exactOptionalPropertyTypes:
 * `principal: undefined` is a different shape from no key), and otherwise the
 * record's OWN copy, rebuilt from the capture — never a reference two records share.
 */
function principalRecord(principal: Readonly<Principal> | undefined): {
	principal?: Principal;
} {
	if (principal === undefined) return {};
	return {
		principal:
			principal.origin === undefined
				? { id: principal.id, type: principal.type }
				: { id: principal.id, type: principal.type, origin: principal.origin },
	};
}

/**
 * The `idempotencyKeyHash` member of a keyed call's records — the KEY absent for an
 * unkeyed call. Every record a keyed hold leaves carries it, so a key can be followed
 * across the chain (a recovery after a `settlement_unrecoverable` included) without
 * the raw key ever being written.
 */
function keyRecord(keyed: KeyedCall | undefined): { idempotencyKeyHash?: string } {
	return keyed === undefined ? {} : { idempotencyKeyHash: keyed.keyHash };
}

/**
 * @internal One idempotency key's state inside one governor: the authorize still
 * in flight for it, or the live hold that authorize placed. A key with no entry has
 * no live hold here, and its next authorize asks the ledger.
 */
type KeyedSlot =
	| { readonly state: "authorizing"; readonly pending: Promise<Authorization> }
	| { readonly state: "held"; readonly auth: Authorization };

/** @internal A key's slot as it reads NOW — see `liveKey` in `createGovernor()`. */
type LiveKey = KeyedSlot | { readonly state: "posting"; readonly done: Promise<void> };

/** How many recorded late-settle fingerprints a governor remembers (see `recordUnheldSettlement`). */
const RECORDED_UNHELD_MAX = 10_000;

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
	let raw: string;
	try {
		raw = await readFile(ledgerPath, "utf-8");
	} catch (err) {
		// ENOENT is the ONE honest zero: no ledger means nothing has been spent,
		// which is exactly true on a first run. Every OTHER read failure (EACCES,
		// EIO, EISDIR) means a ledger that exists and could not be read, and
		// answering that with zero is not a conservative default — it re-grants the
		// whole budget in-process AND re-seeds the TigerBeetle enforcing wallet with
		// it, because the seed is `max(0, budget - budgetSpent)`. Absent and
		// unreadable are different facts and must not share an answer.
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
		throw new SpendLedgerUnreadableError(
			`${ledgerPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new SpendLedgerUnreadableError(`${ledgerPath}: not valid JSON`);
	}

	if (
		parsed == null ||
		typeof parsed !== "object" ||
		!("budgetSpent" in parsed) ||
		typeof (parsed as SpendLedger).budgetSpent !== "number"
	) {
		throw new SpendLedgerUnreadableError(`${ledgerPath}: no numeric "budgetSpent" field`);
	}

	const value = (parsed as SpendLedger).budgetSpent;
	// A negative or non-finite cumulative spend is not a smaller number than we
	// expected — it is a file we cannot reason about, and rounding it to zero is
	// the same re-grant as an unreadable one.
	if (!Number.isFinite(value) || value < 0) {
		throw new SpendLedgerUnreadableError(`${ledgerPath}: budgetSpent is ${value}`);
	}
	return value;
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
		// Atomic write: write UNIQUE tmp, FSYNC it, then rename over the target.
		// The rename was already atomic, so no ordinary crash or restart could tear
		// the target — but without the fsync, a power loss can make the rename
		// durable while the bytes it points at are not, leaving a zero-length or
		// partially-zeroed ledger. That file then reads as unreadable rather than
		// as a smaller number, which loadSpendLedger now refuses rather than
		// silently treating as zero spend. Durability here is what keeps that
		// refusal rare instead of routine.
		const handle = await open(tmpPath, "w");
		try {
			await handle.writeFile(JSON.stringify(data), "utf-8");
			// FSYNC FAILURE IS NOT WRITE FAILURE. `sync()` is unsupported on some
			// filesystems (EINVAL/ENOTSUP) and can fail transiently on others, and
			// letting it escape sent the whole write into the outer catch — which
			// unlinks the staging file and returns as if the spend had persisted.
			// On a platform without fsync that silently discarded EVERY ledger
			// write, and a first write discarded that way leaves NO ledger at all,
			// which the loader correctly reads as zero and re-grants the whole
			// budget. A durable-but-unsynced ledger is strictly better than none:
			// degrade, record it, and still rename.
			try {
				await handle.sync();
			} catch (syncErr) {
				process.stderr.write(
					`[usertrust] spend ledger not fsynced (${syncErr instanceof Error ? syncErr.message : String(syncErr)}) — the record is written but a power loss may lose it\n`,
				);
			}
		} finally {
			await handle.close();
		}
		await rename(tmpPath, ledgerPath);
		// Fsync the DIRECTORY so the rename itself survives a power loss. Best
		// effort: some platforms and filesystems refuse an O_RDONLY directory
		// fsync, and failing the write over that would be worse than the residual
		// risk it protects against.
		try {
			const dirHandle = await open(dir, "r");
			try {
				await dirHandle.sync();
			} finally {
				await dirHandle.close();
			}
		} catch (dirErr) {
			// DISTINGUISH unsupported from failed. A blanket catch here read EIO,
			// ENOSPC and EACCES as "this platform has no directory fsync" and
			// reported success — so a real durability failure left the rename
			// non-durable in silence, and a crash could restore an older ledger, or
			// none at all on a first write, which reseeds a LARGER budget. Same
			// conflation as the read path this branch exists to fix: "cannot" and
			// "did not" are different facts.
			const code = (dirErr as NodeJS.ErrnoException)?.code;
			const unsupported =
				code === "EINVAL" || code === "ENOTSUP" || code === "EPERM" || code === "EBADF";
			if (!unsupported) {
				process.stderr.write(
					`[usertrust] spend ledger directory not fsynced (${dirErr instanceof Error ? dirErr.message : String(dirErr)}) — the rename may not survive a power loss\n`,
				);
			}
		}
	} catch (err) {
		// Still best-effort — a settled call must not fail over ledger persistence,
		// because the money has already moved. But SILENT is the part that was
		// wrong: cleaning up and returning made a lost cumulative-spend write
		// indistinguishable from a successful one, and the loss is invisible until
		// the next startup seeds a budget that is too large. The operator gets a
		// line on stderr, matching how audit degradation is already surfaced.
		process.stderr.write(
			`[usertrust] spend ledger write FAILED (${err instanceof Error ? err.message : String(err)}) — cumulative spend ${budgetSpent} was not persisted; the next start may under-count prior spend\n`,
		);
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
 * Any of TigerBeetle's `exists_with_different_*` answers (mirrors govern.ts; the
 * parity suite holds the two copies identical). On a keyed post this is the cue to
 * look the id up — never the decision.
 */
function isTBExistsWithDifferent(err: unknown): boolean {
	if (!(err instanceof TBTransferError)) return false;
	return CreateTransferStatus[err.code]?.startsWith("exists_with_different_") === true;
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

		// Delegated verbatim, like lookupBalances: the governor's only way to ask
		// whether a keyed call's post anchor already exists, and so it is exercised
		// through THIS factory by the idempotency suite rather than only on mocks.
		async lookupTransfer(transferId: bigint): Promise<Transfer | null> {
			return await tbClient.lookupTransfer(transferId);
		},

		async postPendingSpend(
			transferId: string,
			actualAmount?: number,
			postTransferId?: bigint,
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
			const postOpts = postTransferId !== undefined ? { transferId: postTransferId } : undefined;
			try {
				await tbClient.postTransfer(
					entry.tbId,
					actualAmount != null ? posted : undefined,
					postOpts,
				);
			} catch (err) {
				// A keyed post's id is the key's at-most-once ANCHOR. `exists` already
				// returned above as success (a replay of THIS post). Any
				// `exists_with_different_*` is decided by what is STORED under the id,
				// never by which field the server happened to compare first: a post
				// against a DIFFERENT pending transfer means another hold already charged
				// this key. This hold is still pending and still in pendingMap, so the
				// governor can release it. Every other answer stays a hard failure.
				if (postTransferId !== undefined && isTBExistsWithDifferent(err)) {
					const stored = await tbClient.lookupTransfer(postTransferId);
					if (stored !== null && stored.pending_id !== entry.tbId) {
						throw new AlreadySettledError();
					}
				}
				throw err;
			}
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
	const explicitScope = explicitScopeOf(opts?.idempotencyScope);
	const configPath = opts?.configPath ?? join(vaultBase, VAULT_DIR, "usertrust.config.json");

	let config: TrustConfig;
	if (existsSync(configPath)) {
		const raw: unknown = JSON.parse(await readFile(configPath, "utf-8"));
		config = TrustConfigSchema.parse({
			...(raw as Record<string, unknown>),
			...(opts?.budget !== undefined ? { budget: opts.budget } : {}),
			...(opts?.parentUserId !== undefined ? { parentUserId: opts.parentUserId } : {}),
			...(opts?.scope !== undefined ? { scope: opts.scope } : {}),
		});
	} else {
		config = TrustConfigSchema.parse({
			budget: opts?.budget ?? DEFAULT_BUDGET,
			...(opts?.parentUserId !== undefined ? { parentUserId: opts.parentUserId } : {}),
			...(opts?.scope !== undefined ? { scope: opts.scope } : {}),
		});
	}

	const customRates = config.pricing === "custom" ? config.customRates : undefined;
	// D8: one-time migration warning, evaluated at the config-load path.
	warnCacheRateMigration(customRates);
	// M2: governor-wide default endpoint scope; per-call AuthorizeParams.endpoint
	// overrides it (A3). Defaults to cloud — pre-M2 metering exactly.
	const defaultEndpoint = normalizeEndpoint(opts?.endpoint);
	const isDryRun = opts?.dryRun ?? process.env.USERTRUST_DRY_RUN === "true";
	const isTestEnv = process.env.USERTRUST_TEST === "1" || process.env.NODE_ENV === "test";

	// 2. Initialize subsystems
	const vaultPath = vaultBase;
	const audit: AuditWriter = (isTestEnv ? opts?._audit : undefined) ?? createAuditWriter(vaultPath);

	const policiesPath = join(vaultPath, VAULT_DIR, config.policies);
	// No `existsSync` preflight: it answers false for a file inside a directory
	// it cannot traverse, which would report an unreadable policy as an absent
	// one — silently replacing custom rules with the built-in defaults.
	// `loadPolicies` distinguishes ENOENT (legitimately absent) from every other
	// read failure (refused), so it must be called unconditionally.
	const loadedRules = loadPolicies(policiesPath);
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
	// AUD-001: claimed-but-never-POSTed. settle() deletes from activeAuths FIRST
	// so a concurrent settle cannot double-POST. Pre-POST work (metering) is still
	// sync today, but if it throws the hold is PENDING — this set is that cleanup
	// path. Populated at claim; cleared the moment settle finishes the POST
	// section (success, throw, or dry-run skip). A transport-ambiguous POST is
	// NOT left here: TB may have committed, so abort must not void and session
	// spend is counted fail-closed (next run seeds `max(0, budget − budgetSpent)`).
	const unpostedHolds = new Map<string, AuthorizationCapture>();
	// Holds whose POST is in flight. abort() is a silent no-op for these
	// (does not void, does not recordFailure, does not write llm_call_failed).
	// destroy() waits for this set to drain before voidAllPending(), matching
	// trust()'s 5s in-flight wait — never void a hold whose POST is in flight.
	const settling = new Set<string>();
	// A settle's POST attempt in flight, by transferId, resolving when it has finished
	// — whatever the outcome. `settling` answers "is it posting?"; this lets a keyed
	// replay WAIT the POST out instead of guessing what it did.
	const postsInFlight = new Map<string, Promise<void>>();
	function beginPost(transferId: string): () => void {
		let finished: () => void = () => {};
		postsInFlight.set(
			transferId,
			new Promise<void>((resolve) => {
				finished = resolve;
			}),
		);
		settling.add(transferId);
		return () => {
			settling.delete(transferId);
			postsInFlight.delete(transferId);
			finished();
		};
	}

	// Caller idempotency keys with an authorize in flight or a hold placed, in THIS
	// governor — keyed by the derived key. In memory only, on purpose: what must
	// survive a restart is "already charged", and the ledger's post anchor is that
	// record.
	const keyedAuths = new Map<string, KeyedSlot>();
	// Fingerprints of the late settles `recordUnheldSettlement` has recorded, so an
	// exact retry is not recorded twice. In-process, and bounded.
	const recordedUnheld = new Set<string>();

	// The vault's persisted scope, read (or created) on the FIRST keyed call only —
	// a governor that never sees a key never writes the file. A failed read is not
	// cached: the next keyed call tries again.
	let persistedScopeRead: Promise<string> | undefined;
	function idempotencyScope(): Promise<string> {
		if (explicitScope !== undefined) return Promise.resolve(explicitScope);
		persistedScopeRead ??= persistedScope(vaultBase).catch((err: unknown) => {
			persistedScopeRead = undefined;
			throw err;
		});
		return persistedScopeRead;
	}

	/**
	 * What one key's slot means NOW — derived from its hold's own state, never kept in
	 * step by the terminals: `held` while the hold can still be settled, `posting`
	 * while a settle's POST for it is in flight (its outcome is not known yet, so a
	 * replay must wait rather than guess), and nothing once a terminal has resolved or
	 * claimed it. A stale slot is dropped here, so a later hold under the same key can
	 * never be forgotten by an earlier hold's terminal.
	 */
	function liveKey(derivedKey: string): LiveKey | undefined {
		const slot = keyedAuths.get(derivedKey);
		if (slot === undefined || slot.state === "authorizing") return slot;
		const transferId = slot.auth.transferId;
		if (activeAuths.has(transferId)) return slot;
		const done = postsInFlight.get(transferId);
		if (done !== undefined) return { state: "posting", done };
		keyedAuths.delete(derivedKey);
		return undefined;
	}

	/**
	 * Refuse a key the ledger has already charged: `AlreadySettledError` when a post
	 * is stored under its anchor. Fails CLOSED — an engine that cannot read
	 * transfers, or a read that fails, is `LedgerUnavailableError`, never "not
	 * charged".
	 */
	async function assertKeyUncharged(keyed: KeyedCall): Promise<void> {
		if (engine == null || engine.lookupTransfer === undefined) {
			throw new LedgerUnavailableError(
				"this ledger cannot read transfers, so it cannot answer whether an idempotency key was already charged",
			);
		}
		let stored: Transfer | null;
		try {
			stored = await engine.lookupTransfer(keyed.postId);
		} catch (err) {
			throw new LedgerUnavailableError(err instanceof Error ? err.message : String(err));
		}
		if (stored !== null) throw new AlreadySettledError();
	}

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

	/**
	 * The body of the RELEASE terminal, shared by `release()` and settle's duplicate
	 * path (a keyed post the ledger already took under another hold). The caller has
	 * ALREADY claimed the hold — out of `activeAuths` / `unpostedHolds`, or by being
	 * the settle that owns it — so nothing here re-decides liveness, and nothing here
	 * can run twice for one hold.
	 *
	 * Neutral by construction: no `breaker.recordFailure()` and no `llm_call_failed`.
	 * A hold that outlived its usefulness is not evidence the provider is failing, and
	 * booking it as one let five TTL sweeps open the breaker on a healthy provider
	 * (#204). Everything it records comes from the governor's capture.
	 */
	async function releaseClaimedHold(
		transferId: string,
		capture: AuthorizationCapture,
		reason: string,
	): Promise<void> {
		// Exactly what authorize added, and only when authorize added it — an
		// attributed hold never touched the session's in-flight total.
		if (capture.sessionAccounted) {
			const releaseLock = await budgetMutex.acquire();
			try {
				inFlightHoldTotal -= capture.holdAmount;
			} finally {
				releaseLock();
			}
		}

		// VOID the pending hold, best-effort exactly as abort() does: TigerBeetle
		// returns the funds itself at the pending timeout if this does not land.
		if (proxyConn != null && !isDryRun) {
			try {
				await proxyConn.void(capture.proxyTransferId ?? transferId);
			} catch {
				// Best-effort void
			}
		} else if (engine != null && !isDryRun) {
			try {
				await engine.voidPendingSpend(transferId);
			} catch {
				// Best-effort void
			}
		}

		await audit
			.appendEvent({
				kind: "hold_released",
				actor: "local",
				data: {
					model: capture.model,
					transferId,
					reason,
					source: "headless",
					...(capture.costCenter === undefined ? {} : { costCenter: capture.costCenter }),
					...principalRecord(capture.principal),
					...keyRecord(capture.idempotency),
				},
			})
			.catch(() => {});
	}

	/**
	 * The body of `authorize()` once its caller input is validated and its envelope
	 * resolved: gate the call and place its PENDING hold. `authorize()` keeps the
	 * validation, the ONE AsyncLocalStorage read and the keyed replay, so they all
	 * still run synchronously at the entry point, in the caller's own context.
	 */
	async function placeHold(
		params: AuthorizeParams,
		envelope: ResolvedEnvelope | undefined,
		principal: Readonly<Principal> | undefined,
		keyed: KeyedCall | undefined,
	): Promise<Authorization> {
		// A key the ledger has ALREADY charged is refused before anything else
		// happens — the breaker, the gate, the hold. An early answer only: the post
		// anchor's own uniqueness at settle is the guarantee, which is why this read
		// sits outside the money lock. dryRun has no ledger, and so no anchor.
		if (keyed !== undefined && !isDryRun) {
			await assertKeyUncharged(keyed);
		}

		const model = params.model;
		const actor = params.actor ?? "local";
		const messages = params.messages ?? [];

		// Per-invocation denial evidence, filled by the throw sites and read by
		// the boundaries below. A closure local, never an error property — see
		// `govern.ts` for the full rationale.
		const denial: DenialRecord = { denialClass: "policy" };
		const costCenterAudit: { costCenter?: string } =
			envelope === undefined ? {} : { costCenter: envelope.attribution.costCenter };

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
				// ── Denial boundary 1 of 2: the PRE-MUTEX unknown-model refusal ──
				// No transfer id yet — it is minted below — so the event carries
				// only what genuinely exists. The `promptHash` here is THIS spec's
				// `sha256-json-v1` over the prompt parts; the headless pattern
				// memory's `sha256(transferId)` is a different thing entirely and
				// is never substituted for it.
				denial.denialClass = "unknown_model";
				const unknownModelDenial = new PolicyDeniedError(
					`unknown_model: ${model} not in pricing table`,
					'Set pricing: "custom" with a customRates entry for this model in usertrust.config.json, or use a model from the built-in pricing table.',
				);
				await appendDenialEvent({
					audit,
					actor,
					error: unknownModelDenial,
					record: denial,
					fields: {
						model,
						endpointClass: endpoint.class,
						promptParts: messages,
						...costCenterAudit,
						...principalRecord(principal),
						...keyRecord(keyed),
					},
				});
				throw unknownModelDenial;
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
		// D3: size the ESTIMATED-input half of the hold at
		// max(inputPer1k, effective cacheWritePer1k) — see the identical
		// govern.ts hold-sizing comment for the full rationale. Settle-time
		// actual cost is unaffected; this only widens the PENDING reservation.
		const holdInputRate = Math.max(
			rateInfo.rates.inputPer1k,
			effectiveCacheWriteRate(rateInfo.rates),
		);
		const estCost = costFromRates(
			{ ...rateInfo.rates, inputPer1k: holdInputRate },
			estInputTokens,
			maxOutputTokens,
		);
		// FIX (review finding, D3 scope): `estCost` above is the
		// write-premium-INFLATED HOLD — correct for the PENDING reservation
		// (spendPending/proxy.spend/inFlightHoldTotal) and for the policy gate
		// (`estimated_cost`/`budget_remaining_after`, whose documented
		// over-denial trade in D3 depends on the gate seeing the SAME
		// fattened number the ledger actually reserves) and for the public
		// `Authorization.estimatedCost` field it is reported on. It must NEVER
		// become the settled/audited/receipted cost of a call whose settle()
		// reports no token usage — that would price zero cache-write tokens at
		// the cache-write rate. `meteredEstimate` is the un-inflated metering
		// estimate (plain `inputPer1k`, unmodified rates), carried on the
		// internal capture (never the public handle) and is the ONLY value
		// settle()'s "no usage reported" fallback may use.
		const meteredEstimate = costFromRates(rateInfo.rates, estInputTokens, maxOutputTokens);

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

		// ── Denial boundary 2 of 2: the whole budget-mutex section ──
		// Catch OUTSIDE the lock-releasing finally, so the append never holds
		// the money lock across an fsync. See `govern.ts` for the full
		// rationale; this governor's boundary has no provider call after it,
		// because `authorize()` never contacts one.
		try {
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
					// Stripped before the spread. This site has the widest blast radius:
					// packages/server wraps it, so `params.params` arrives in an HTTP
					// request body from a remote tenant.
					...sanitizePolicyContext(params.params),
					model,
					tier: config.tier,
					estimated_cost: estCost,
					budget_remaining: gateRemaining,
					budget_remaining_after: gateRemaining - estCost,
					budgetFractionRemaining: tierFields.budgetFractionRemaining,
					budgetRunwayHours: tierFields.budgetRunwayHours,
					// P1-CLOCK-SHADOW: the third re-assertion site, same assertion and same
					// reason as govern.ts — `params.params` must not be able to pick the
					// time a `timeWindows` rule is evaluated at. Explicit `undefined` sends
					// the gate back to the real clock, which it reads in LOCAL time by
					// contract.
					timestamp: undefined,
					// Structurally un-forgeable: this comes from the caller's own async
					// execution context, which no request body can reach. Asserted after
					// the spread like every other trusted field, `undefined` included.
					cost_center: envelope?.attribution.costCenter,
					// AUD-002: host-owned. This site has the widest blast radius —
					// packages/server wraps it, so `params.params.scope` arrives in an
					// HTTP body from a remote tenant. Assert the operator's config/opts
					// value, `undefined` included.
					scope: config.scope,
				});
				if (policyResult.decision === "deny") {
					const reason =
						policyResult.reasons.length > 0 ? policyResult.reasons.join("; ") : "Policy denied";
					denial.denialClass = classifyPolicyDenial(policyResult.hardViolations);
					denial.policyRules = toDenialRuleRefs(policyResult.hardViolations);
					if (denial.denialClass === "budget_gate") {
						denial.budget = { estimatedCost: estCost, budgetRemaining: gateRemaining };
					}
					throw new PolicyDeniedError(
						reason,
						derivePolicyHint(policyResult, envelope !== undefined),
					);
				}

				// PII check
				if (config.pii !== "off" && messages.length > 0) {
					const piiResult = detectPII(messages);
					if (piiResult.found && config.pii === "block") {
						denial.denialClass = "pii";
						denial.piiTypes = piiResult.types;
						throw new PolicyDeniedError(
							`PII detected: ${piiResult.types.join(", ")}`,
							'PII enforcement blocked this call. Use { pii: "warn" } to log instead of block; the headless governor does not redact egress — redaction is the integrating host\'s responsibility.',
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
		} catch (denialErr) {
			if (isGovernanceDenial(denialErr)) {
				await appendDenialEvent({
					audit,
					actor,
					error: denialErr,
					record: denial,
					fields: {
						model,
						endpointClass: endpoint.class,
						transferId,
						estimatedCost: estCost,
						promptParts: messages,
						...costCenterAudit,
						...principalRecord(principal),
						...keyRecord(keyed),
					},
				});
			}
			throw denialErr;
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
		// than the one the hold was placed against — nor a different model, endpoint
		// scope or hold amount. The endpoint is this record's OWN frozen copy: the
		// handle carries the original object, and an in-place edit of `auth.endpoint`
		// must not reach the record through a shared reference.
		activeAuths.set(
			transferId,
			Object.freeze({
				proxyTransferId,
				costCenter: captured?.attribution.costCenter,
				envelope: captured,
				sessionAccounted: !envelopeDebited,
				meteredEstimate,
				model,
				endpoint: Object.freeze({ ...endpoint }),
				holdAmount: estCost,
				principal,
				idempotency: keyed,
			}),
		);
		return auth;
	}

	// 6. Governor implementation
	const governor: Governor = {
		config,

		async authorize(params: AuthorizeParams): Promise<Authorization> {
			if (destroyed) {
				throw new Error("Governor has been destroyed");
			}

			// Caller input that must be legal before ANYTHING happens. Each field is read
			// exactly once, here, and a refusal is a TypeError before any I/O: no ledger
			// read, no policy evaluation, no record.
			const key = validKey(params.idempotencyKey);
			const principal = capturePrincipal(params.principal);

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

			if (key === undefined) {
				return await placeHold(params, envelope, principal, undefined);
			}
			const keyed = keyedCall(key, await idempotencyScope());
			// In-process replay. A key whose hold can still be settled, or whose
			// authorize is in flight, answers with THAT handle and never a second hold;
			// concurrent callers join the one authorize and share its outcome, a refusal
			// included. A key whose settle is POSTING is waited out and asked again: by
			// then the ledger can say whether it charged.
			for (;;) {
				const live = liveKey(keyed.derivedKey);
				if (live === undefined) break;
				if (live.state === "held") return live.auth;
				if (live.state === "authorizing") return await live.pending;
				await live.done;
				if (destroyed) throw new Error("Governor has been destroyed");
			}
			const pending = placeHold(params, envelope, principal, keyed);
			const slot: KeyedSlot = { state: "authorizing", pending };
			keyedAuths.set(keyed.derivedKey, slot);
			let auth: Authorization;
			try {
				auth = await pending;
			} catch (err) {
				// A refused authorize leaves no slot behind: the key's next authorize is a
				// fresh one, exactly as if this one had never been made.
				if (keyedAuths.get(keyed.derivedKey) === slot) keyedAuths.delete(keyed.derivedKey);
				throw err;
			}
			// This continuation was registered on `pending` before any joiner's, so it
			// runs first: the slot reads "held" before ANY caller has the handle.
			if (keyedAuths.get(keyed.derivedKey) === slot) {
				keyedAuths.set(keyed.derivedKey, { state: "held", auth });
			}
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
			// Claimed. Still PENDING. Pre-POST throw leaves the id here so
			// abort()/destroy() can void a hold that never reached POST. The id
			// moves off this path when POST begins (`settling`) and is never put
			// back after a POST attempt — success or transport-ambiguous.
			unpostedHolds.set(auth.transferId, capture);

			// From the capture, like everything else that prices or labels this
			// settle (see `AuthorizationCapture.model`).
			const model = capture.model;
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
			// Who spent, on every record this settle writes and on the receipt — from
			// the capture, for the reason `costCenterAudit` is.
			const principalAudit = principalRecord(capture.principal);
			const keyAudit = keyRecord(capture.idempotency);

			// A3: settlement meters with the endpoint scope CAPTURED AT AUTHORIZE —
			// SettleParams carries no endpoint field by design, and the handle's copy
			// is the caller's to edit.
			const endpoint = capture.endpoint;
			const rateInfo = resolveRates(model, endpoint.class, config);

			// D5 — read the caller's object ONCE, into a local. The presence check
			// below and the counts that get priced and recorded then come from the
			// same read, so a caller whose `SettleParams` is a live object (a proxy,
			// a getter over a running accumulator) cannot have "reported?" answered
			// off one value and the money computed off another.
			const reportedCounts = {
				inputTokens: params?.inputTokens,
				outputTokens: params?.outputTokens,
				cacheReadTokens: params?.cacheReadTokens,
				cacheWriteTokens: params?.cacheWriteTokens,
			};
			// D4/D5: the reported-usage condition is WIDENED to the cache tiers. It
			// read only input/output, so a settle carrying nothing but cache counts
			// looked like "nothing reported" and silently fell back to the pre-call
			// estimate — discarding real billable tokens at the one boundary
			// (openclaw, and every non-SDK integration) that has them.
			const usageReported =
				reportedCounts.inputTokens != null ||
				reportedCounts.outputTokens != null ||
				reportedCounts.cacheReadTokens != null ||
				reportedCounts.cacheWriteTokens != null;

			// D5 — THE ONE SNAPSHOT. Both the cost below and the `usage` record on
			// the chain event and the receipt derive from THIS object; nothing
			// downstream re-reads `params`. Omitted counts collapse to 0 at this
			// operator boundary: when a caller reported some of the four, the ones
			// it left out are zero (the same "absent cache fields mean zero" rule
			// D5 states for providers), not an invitation to re-estimate half the
			// call. `sanitizeUsage` then clamps every count to a finite integer >= 0
			// — the reason a NaN from a caller's arithmetic cannot reach audit
			// canonicalization, which throws on non-finite — and downgrades a
			// "provider" label whose input/output is unusable.
			const usageSnapshot = sanitizeUsage({
				inputTokens: reportedCounts.inputTokens ?? 0,
				outputTokens: reportedCounts.outputTokens ?? 0,
				cacheReadTokens: reportedCounts.cacheReadTokens ?? 0,
				cacheWriteTokens: reportedCounts.cacheWriteTokens ?? 0,
				source: usageReported ? (params?.usageSource ?? "provider") : "estimated",
			});
			// Present IFF provider-sourced (D5) — the single rule, in one place.
			const usageRecord = publishableUsage(usageSnapshot);
			const usageAudit = usageRecord === undefined ? {} : { usage: usageRecord };

			// Determine actual cost
			let actualCost: number;
			const usageSource: "provider" | "estimated" = usageSnapshot.source;
			if (usageReported) {
				actualCost = costFromRates(
					rateInfo.rates,
					usageSnapshot.inputTokens,
					usageSnapshot.outputTokens,
					usageSnapshot.cacheReadTokens,
					usageSnapshot.cacheWriteTokens,
				);
			} else {
				// FIX: the un-inflated metering estimate, never the fattened hold
				// carried on `auth.estimatedCost` (see the `meteredEstimate`
				// comment on `AuthorizationCapture`).
				actualCost = capture.meteredEstimate;
			}

			// D5 — the rates the money was computed with, published so the record is
			// self-sufficient: `ceil(sum(counts x appliedRates / 1000))` floored at 1
			// reproduces `cost` exactly. RESOLVED rates, so the D1 cache fallback is
			// visible as the number it actually charges rather than as a hole.
			const appliedRates = resolveAppliedRates(rateInfo.rates);

			// SESSION accounting waits until after the POST attempt below. A
			// pre-POST throw must not increment: the hold is still PENDING and
			// abort/destroy will void it. A transport-ambiguous POST MUST
			// increment (fail-closed): TB may have committed after retries, and
			// treating that as unspent reseeds the next run too large.

			// Circuit breaker: success
			const cb = breaker.get("headless" as never);
			cb.recordSuccess();

			// POST settlement
			let settled = true;
			// D4: set only when the engine capped the post at the reserved hold.
			let postedCost: number | undefined;
			// D4 event-order buffer: the truncation is learned at POST time but the
			// `settlement_shortfall` event may only be appended AFTER this call's
			// `llm_call`, so it is parked here and drained below.
			let shortfallRecord: { posted: number; shortfall: number } | undefined;
			// Set when the ledger refused a keyed post because the key was already
			// charged under another hold — see the catch below.
			let duplicate: AlreadySettledError | undefined;
			// Leave the pre-POST cleanup set BEFORE the await. A transport-ambiguous
			// POST must not remain abort-voidable, and deleting after `settling`
			// drops would open a window where abort voids a hold mid-commit.
			unpostedHolds.delete(auth.transferId);
			if (proxyConn != null && !isDryRun) {
				// First terminal is settle. Park the id so concurrent abort() is a
				// silent no-op and destroy() waits, rather than voiding mid-POST.
				const endPost = beginPost(auth.transferId);
				try {
					await proxyConn.settle(capture.proxyTransferId ?? auth.transferId, actualCost);
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
								...principalAudit,
								...keyAudit,
							},
						})
						.catch(() => {
							callAuditDegraded = true;
						});
				} finally {
					endPost();
				}
			} else if (engine != null && !isDryRun) {
				const endPost = beginPost(auth.transferId);
				try {
					// Post the ACTUAL consumed cost (RECON #3), capped by the engine at
					// the reserved hold; a truncation comes back as `shortfall`. A keyed
					// call posts under its key's anchor, so the LEDGER refuses a second
					// charge for the key — across processes and restarts alike.
					// An unkeyed call's post is the exact call it always was: no third
					// argument at all, so an injected engine sees nothing new.
					const postResult =
						capture.idempotency === undefined
							? await engine.postPendingSpend(auth.transferId, actualCost)
							: await engine.postPendingSpend(
									auth.transferId,
									actualCost,
									capture.idempotency.postId,
								);
					if (postResult != null && postResult.shortfall > 0) {
						postedCost = postResult.posted;
						// EVENT ORDER: captured here, APPENDED after `llm_call` below.
						// `verifyTransaction` resolves a transfer by the FIRST chain event whose
						// `data.transferId` matches, so a shortfall written ahead of its
						// `llm_call` would render this settled call as PENDING with no cost. The
						// correction must annotate the settlement, never precede it.
						shortfallRecord = { posted: postResult.posted, shortfall: postResult.shortfall };
					}
				} catch (postErr) {
					if (postErr instanceof AlreadySettledError && capture.idempotency !== undefined) {
						// NOT ambiguous: the ledger refused this post outright, because
						// another hold already charged the key, and this hold is still
						// pending. Release it — still under `settling`, so no concurrent
						// terminal and no destroy() sweep can touch the hold before the void
						// lands. The release is the hold's terminal (`hold_released` comes
						// first in the chain, so the verifier resolves this transfer
						// RELEASED); the duplicate record below annotates it.
						duplicate = postErr;
						await releaseClaimedHold(
							auth.transferId,
							capture,
							"already settled under this idempotency key",
						);
					} else {
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
									...principalAudit,
									...keyAudit,
								},
							})
							.catch(() => {
								callAuditDegraded = true;
							});
					}
				} finally {
					endPost();
				}
			}

			// A concurrent duplicate ends here: released, recorded, refused. Never a
			// second post, never `llm_call`, and no session charge — the release already
			// returned exactly what authorize reserved, and this hold paid nothing.
			if (duplicate !== undefined && capture.idempotency !== undefined) {
				await audit
					.appendEvent({
						kind: "settlement_duplicate",
						actor: "local",
						data: {
							model,
							transferId: auth.transferId,
							source: "headless",
							...costCenterAudit,
							...principalAudit,
							// The key's SHA-256 — never the key itself (see `KeyedCall`).
							...keyAudit,
						},
					})
					.catch(() => {});
				throw duplicate;
			}

			// SESSION accounting, skipped in full when the ENVELOPE paid: this hold was
			// never counted into `inFlightHoldTotal`, so releasing it here would drive
			// that counter negative, and `budgetSpent` must not absorb envelope money it
			// would then persist into the next run's holding-wallet seed. The flag is the
			// authorize-time record, so the release can never be asymmetric with the
			// increment. Counted after a POST *attempt*, not only a confirmed success:
			// a transport-ambiguous POST is treated as spent (fail-closed) so the next
			// run cannot reseed as if the money never moved.
			if (capture.sessionAccounted) {
				// AUD-453: Acquire mutex for budget atomicity — prevents concurrent
				// settle() calls from corrupting inFlightHoldTotal or budgetSpent.
				const releaseLock = await budgetMutex.acquire();
				try {
					inFlightHoldTotal -= capture.holdAmount;
					budgetSpent += actualCost;
				} finally {
					releaseLock();
				}
				// Finding-2 (RECON #4): serialized monotonic persist — never regresses.
				await persistSpend();
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
						// D5: the durable record. The receipt is a return value the
						// caller may drop on the floor; THIS is what an auditor reads,
						// so the four tiers and the rates that priced them belong here
						// too — a chain event that cannot be repriced is a number to
						// trust, not a reconciliation surface. Mirrors the receipt
						// exactly: same snapshot, same resolution.
						...usageAudit,
						// P1-1: the chain event keeps its FLAT shape — audit-event.v1
						// documents `data` as open and it already flattens the receipt's
						// meter. The receipt-side relocation was forced by receipt.v1's
						// CLOSED `meter` object, which has no counterpart here.
						// P1-2: its own frozen copy.
						appliedRates: copyAppliedRates(appliedRates),
						pricingTableVersion: PRICING_TABLE_VERSION,
						...(params?.chunksDelivered != null ? { chunksDelivered: params.chunksDelivered } : {}),
						source: "headless",
						...costCenterAudit,
						...principalAudit,
						...keyAudit,
					},
				});
				auditHash = auditEvent.hash;
			} catch {
				callAuditDegraded = true;
			}

			// D4: the truncation correction, appended AFTER the `llm_call` it annotates
			// (see the capture at the POST above). Still advisory — a chain that cannot
			// take it degrades the receipt and NEVER unwinds a settlement that already
			// committed.
			if (shortfallRecord !== undefined) {
				await audit
					.appendEvent({
						kind: "settlement_shortfall",
						actor: "local",
						data: {
							model,
							actual: actualCost,
							posted: shortfallRecord.posted,
							shortfall: shortfallRecord.shortfall,
							transferId: auth.transferId,
							...costCenterAudit,
							...principalAudit,
							...keyAudit,
						},
					})
					.catch(() => {
						callAuditDegraded = true;
					});
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
							...principalAudit,
							...keyAudit,
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
				// D5: present IFF provider-sourced — same snapshot the cost came from.
				...usageAudit,
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
				// D5: what the rates WERE, beside where they came from. Only this makes
				// a custom/local-model cost independently recomputable. A SIBLING of
				// `meter`, not a member of it — receipt.v1 closed `meter` to additions
				// (P1-1). P1-2: its own frozen copy.
				pricing: {
					appliedRates: copyAppliedRates(appliedRates),
					tableVersion: PRICING_TABLE_VERSION,
				},
				...(params?.chunksDelivered != null ? { chunksDelivered: params.chunksDelivered } : {}),
				...(postedCost !== undefined ? { postedCost } : {}),
				...(settledBudget !== undefined ? { budget: settledBudget } : {}),
				...(callAuditDegraded ? { auditDegraded: true as const } : {}),
				...(proxyConn != null ? { proxyStub: true as const } : {}),
				// At the ROOT, like `pricing`: receipt.v1 closes `meter` and leaves the root
				// open. Its own copy, so the receipt shares no object with the chain.
				...principalRecord(capture.principal),
			};

			return receipt;
		},

		async abort(auth: Authorization, error?: unknown): Promise<void> {
			// Same lookup as settle, and the same reason: liveness and attribution come
			// from one internal record. Still idempotent-silent, unlike settle.
			// In-flight POST: first terminal is settle. A concurrent abort must
			// not void (TB may be committing) and must not recordFailure /
			// llm_call_failed — that would trip the provider circuit for a call
			// that is settling, not failing.
			if (settling.has(auth.transferId)) {
				return;
			}
			// AUD-001: a settle that threw BEFORE POST has already claimed the
			// auth (deleted from activeAuths) but left the transfer PENDING.
			// Look there first, then in the claimed-but-never-POSTed set. A miss
			// in both is already posted, voided, or a transport-ambiguous POST
			// (counted fail-closed, already wrote settlement_ambiguous + llm_call)
			// — a cleanup abort must not throw, double-void, or look like an LLM
			// failure.
			let capture = activeAuths.get(auth.transferId);
			if (capture !== undefined) {
				activeAuths.delete(auth.transferId);
			} else {
				capture = unpostedHolds.get(auth.transferId);
				if (capture === undefined) {
					return;
				}
				unpostedHolds.delete(auth.transferId);
			}
			// Re-check: settle may have entered POST after we read unpostedHolds.
			if (settling.has(auth.transferId)) {
				return;
			}

			// Only the session wallet's own in-flight exposure is released here; an
			// attributed hold never added to it (see authorize), and the VOID below is
			// what returns the envelope's funds.
			if (capture.sessionAccounted) {
				// AUD-453: Acquire mutex for budget atomicity
				const releaseLock = await budgetMutex.acquire();
				try {
					inFlightHoldTotal -= capture.holdAmount;
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
					await proxyConn.void(capture.proxyTransferId ?? auth.transferId);
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
						model: capture.model,
						transferId: auth.transferId,
						error:
							error instanceof Error
								? error.message.slice(0, 200)
								: error != null
									? String(error).slice(0, 200)
									: "aborted",
						source: "headless",
						...(capture.costCenter === undefined ? {} : { costCenter: capture.costCenter }),
						...principalRecord(capture.principal),
						...keyRecord(capture.idempotency),
					},
				})
				.catch(() => {});
		},

		async release(auth: Authorization, reason?: string): Promise<void> {
			// abort()'s claim discipline, step for step and for the same reasons: a hold
			// whose POST is in flight belongs to settle; a claimed-but-never-POSTed hold
			// is still releasable; a miss in both is already resolved, and a cleanup
			// call must not throw over it. Only the terminal's MEANING differs.
			if (settling.has(auth.transferId)) {
				return;
			}
			let capture = activeAuths.get(auth.transferId);
			if (capture !== undefined) {
				activeAuths.delete(auth.transferId);
			} else {
				capture = unpostedHolds.get(auth.transferId);
				if (capture === undefined) {
					return;
				}
				unpostedHolds.delete(auth.transferId);
			}
			// Re-check: settle may have entered POST after we read unpostedHolds.
			if (settling.has(auth.transferId)) {
				return;
			}
			await releaseClaimedHold(auth.transferId, capture, sanitizeReleaseReason(reason));
		},

		async recordUnheldSettlement(params: UnheldSettlementParams): Promise<UnheldSettlementOutcome> {
			if (destroyed) {
				throw new Error("Governor has been destroyed");
			}
			// Caller input, each field read ONCE and refused before any I/O — the same
			// doors authorize() uses, so a key this method accepts is a key authorize
			// would have accepted.
			const key = validKey(params.idempotencyKey);
			if (key === undefined) {
				throw new TypeError(
					"idempotencyKey is required: without one, a late settle cannot be told from a retry of a settle that already charged",
				);
			}
			const principal = capturePrincipal(params.principal);
			const usage = params.usage;
			const reportedCounts = {
				inputTokens: usage?.inputTokens,
				outputTokens: usage?.outputTokens,
				cacheReadTokens: usage?.cacheReadTokens,
				cacheWriteTokens: usage?.cacheWriteTokens,
			};
			// settle()'s reported-usage rule, so the same counts carry the same label
			// whichever of the two records them.
			const usageReported =
				reportedCounts.inputTokens != null ||
				reportedCounts.outputTokens != null ||
				reportedCounts.cacheReadTokens != null ||
				reportedCounts.cacheWriteTokens != null;
			const snapshot = sanitizeUsage({
				inputTokens: reportedCounts.inputTokens ?? 0,
				outputTokens: reportedCounts.outputTokens ?? 0,
				cacheReadTokens: reportedCounts.cacheReadTokens ?? 0,
				cacheWriteTokens: reportedCounts.cacheWriteTokens ?? 0,
				source: usageReported ? (usage?.usageSource ?? "provider") : "estimated",
			});
			const published = publishableUsage(snapshot);
			const keyed = keyedCall(key, await idempotencyScope());

			// Nothing is unrecoverable while this governor can still charge the key: a
			// hold that can be settled answers "held" (with its transferId, so the
			// caller can settle it); an authorize in flight, or a settle mid-POST, is
			// waited out and the key asked again — its outcome decides. Asked once more
			// after the ledger read, which awaits: an authorize may begin during it.
			for (;;) {
				const live = liveKey(keyed.derivedKey);
				if (live?.state === "held") return { outcome: "held", transferId: live.auth.transferId };
				if (live?.state === "authorizing") {
					const placed = await live.pending.then(
						(auth) => auth,
						() => undefined,
					);
					// The authorize's own continuation runs first and turns its slot into
					// the outcome. Should the slot still read "authorizing", decide from the
					// outcome here instead of awaiting the same settled promise again — a
					// loop that only ever awaits settled promises never yields to a timer.
					if (keyedAuths.get(keyed.derivedKey) === live) {
						if (placed !== undefined) return { outcome: "held", transferId: placed.transferId };
						keyedAuths.delete(keyed.derivedKey);
					}
				} else if (live?.state === "posting") {
					await live.done;
				} else {
					if (!isDryRun) await assertKeyUncharged(keyed);
					if (liveKey(keyed.derivedKey) === undefined) break;
				}
				if (destroyed) throw new Error("Governor has been destroyed");
			}

			// An EXACT retry of a late settle this governor already recorded — same key,
			// same reported usage, e.g. a client resending after a lost response — is
			// answered without a second record, so one loss is never counted twice. A
			// different usage under the same key is a different settle, and is recorded.
			const fingerprint = createHash("sha256")
				.update(
					JSON.stringify([
						keyed.keyHash,
						snapshot.inputTokens,
						snapshot.outputTokens,
						snapshot.cacheReadTokens,
						snapshot.cacheWriteTokens,
						snapshot.source,
					]),
				)
				.digest("hex");
			if (recordedUnheld.has(fingerprint)) return { outcome: "unrecoverable", recorded: false };

			// NOT caught. A settle that cannot charge, whose record did not land
			// either, is exactly the silent loss this method exists to prevent, so the
			// caller hears about a failed append.
			await audit.appendEvent({
				kind: "settlement_unrecoverable",
				actor: "local",
				data: {
					// The key's SHA-256, never the key (see `KeyedCall`). There is no
					// transferId: the hold is gone, and after a restart the caller's id
					// names nothing this chain recorded.
					idempotencyKeyHash: keyed.keyHash,
					reason: "no live hold and no charge exist under this idempotency key",
					usageSource: snapshot.source,
					// D5: the four tiers only when provider-sourced, exactly as on llm_call.
					...(published === undefined ? {} : { usage: published }),
					source: "headless",
					...principalRecord(principal),
				},
			});
			// Bounded, oldest first out: a forgotten fingerprint costs one duplicate
			// record, never a lost one.
			if (recordedUnheld.size >= RECORDED_UNHELD_MAX) {
				const oldest = recordedUnheld.values().next().value;
				if (oldest !== undefined) recordedUnheld.delete(oldest);
			}
			recordedUnheld.add(fingerprint);
			return { outcome: "unrecoverable", recorded: true };
		},

		async destroy(): Promise<void> {
			if (destroyed) return;
			destroyed = true;

			// Never void a hold whose POST is in flight. Wait for settling to
			// drain (same 5s bound as trust()) before sweeping leftovers.
			const deadline = Date.now() + 5_000;
			while (settling.size > 0 && Date.now() < deadline) {
				await new Promise<void>((r) => setTimeout(r, 50));
			}

			// Void leftover authorizations (still-active + claimed-but-never-POSTed).
			// The per-id walk is what the proxy path has; the engine sweep below
			// is what trust() does. Walking claimed holds is what keeps abort's
			// sibling from losing the void path after a pre-POST throw. A
			// transport-ambiguous POST is NOT in unpostedHolds — do not treat
			// it as a hold to void.
			for (const [txId, capture] of [...activeAuths, ...unpostedHolds]) {
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
			unpostedHolds.clear();
			keyedAuths.clear();

			// AUD-001 / AUD-461: same sweep trust() runs. pendingMap leftovers
			// (a pre-POST claim that never made unpostedHolds, or a factory
			// entry whose POST threw after TB committed) are best-effort: void
			// of an already-posted transfer fails closed in the catch. This is
			// NOT "void the hold" for an ambiguous POST — abort already refused
			// that path. Then close the client: a voidAllPending throw must not
			// skip destroy() and hang the process on the open TigerBeetle socket.
			if (engine != null && typeof engine.voidAllPending === "function") {
				try {
					await engine.voidAllPending();
				} catch {
					// Best-effort — TigerBeetle auto-voids pending transfers after 300s.
				}
			}

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

		/**
		 * REPORTING ONLY, and the failure policy is the whole design (A8).
		 *
		 * This is the MIRROR of `snapshotEnvelopeRemaining`: same read, never throws,
		 * because nothing downstream decides anything from it. It is deliberately the
		 * OPPOSITE of `preflightEnvelopeRemaining` (A2), which REFUSES an attributed
		 * authorize when the same read fails — there the number feeds the policy gate,
		 * so degrading it would clear a call against a wallet the money never came
		 * from. Here the number goes into a scarcity hint a model reads; an
		 * unreachable ledger must cost the caller a paragraph of prose, never a
		 * denied or delayed call. DO NOT UNIFY THE TWO.
		 *
		 * Only the awaited `lookupBalances` is inside the catch. The pre-I/O doors
		 * above it are caller bugs and throw, and the `envelopeStatusFrom` mapping
		 * below it stays OUTSIDE — a non-finite `periodStartMs` propagates exactly as
		 * it does from core `budgetContext`, rather than collapsing every envelope's
		 * report into an empty array the caller cannot diagnose.
		 */
		async budgetContext(envelopes: EnvelopeDescriptor[]): Promise<EnvelopeStatus[]> {
			// Cheapest door first, and the only one that needs no ledger identity.
			assertEnvelopeCap(envelopes);

			// No parentUserId ⇒ no envelope account is derivable. Unlike `authorize()`'s
			// D1 throw, nothing is about to spend here, so there is nothing to refuse:
			// a governor with no ledger identity simply has no envelopes to report on.
			// It also has to be settled BEFORE the per-descriptor door, which validates
			// each cost center against a parent.
			const parentUserId = config.parentUserId;
			if (parentUserId === undefined) return [];

			assertDistinctValidCostCenters(parentUserId, envelopes);

			// dryRun has no engine at all; an injected engine may predate `lookupBalances`.
			if (isDryRun || engine == null || engine.lookupBalances === undefined) return [];

			// ONE clock read for the whole batch, so two envelopes in one response never
			// disagree about "now" — the same rule core `budgetContext` follows.
			const clock = Date.now();
			const accountIds = envelopes.map((envelope) =>
				TrustTBClient.deriveCostCenterAccountId(parentUserId, envelope.costCenter),
			);

			let balances: Map<bigint, number>;
			try {
				balances = await engine.lookupBalances(accountIds);
			} catch {
				return [];
			}

			// An id the ledger omitted reads as 0 — never-allocated and fully-reclaimed
			// are the same observable state.
			return envelopes.map((envelope, i) =>
				envelopeStatusFrom(envelope, balances.get(accountIds[i] as bigint) ?? 0, clock),
			);
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
