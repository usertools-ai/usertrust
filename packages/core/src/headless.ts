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
import { open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CreateTransferStatus } from "tigerbeetle-node";
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
	estimateCost,
	estimateInputTokens,
	holdCacheWriteRate,
	holdInputRate,
	PRICING_TABLE_VERSION,
	resolveAppliedRates,
	resolveRates,
	warnCacheRateMigration,
	warnUnknownModel,
} from "./ledger/pricing.js";
import { publishableUsageFields, sanitizeUsage } from "./ledger/usage.js";
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
import { DEFAULT_BUDGET, LEDGER_HOLD_TIMEOUT_MS, VAULT_DIR } from "./shared/constants.js";
import {
	InsufficientBalanceError,
	LedgerUnavailableError,
	PendingEntryNotFoundError,
	PolicyDeniedError,
	SpendLedgerUnreadableError,
} from "./shared/errors.js";
import { trustId } from "./shared/ids.js";
import {
	capturePrincipal,
	type Principal,
	type PrincipalLedgerTags,
	principalLedgerTags,
} from "./shared/principal.js";
import type { EndpointInfo, TrustConfig, TrustReceipt } from "./shared/types.js";
import { TrustConfigSchema } from "./shared/types.js";

// ── Public types ──

// Re-exported so an integration typing a `budgetContext()` call has both shapes at
// the SAME entry point as the `Governor` it calls — `usertrust/headless` is a
// package entry point in its own right, and a plugin should not have to reach into
// the root export for the argument type of a method it can already see here.
export type { EnvelopeDescriptor, EnvelopeStatus } from "./budget/context.js";
// Same reason for the principal: an integration that passes `principal` to
// `authorize()` gets its type, its field rule and its ledger tags from the entry
// point it already imports — the tags are what a `query_transfers` roll-up filters on.
export type { Principal, PrincipalLedgerTags } from "./shared/principal.js";
export { principalFieldRefusal, principalLedgerTags } from "./shared/principal.js";

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
	 * How long destroy() waits for terminals still working (settles, and aborts and
	 * releases in flight) before it sweeps. Default 5 000 ms. For tests: ignored outside a
	 * test environment.
	 * @internal
	 */
	_destroyDrainMs?: number;
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
	/**
	 * The ledger's pending timeout this call's hold was reserved with, in ms
	 * (`LEDGER_HOLD_TIMEOUT_MS`): TigerBeetle expires the hold on its own that long
	 * after creating it. Absent when no ledger hold was made (dry run). A DURATION,
	 * never a clock reading, so it means the same wherever the handle is logged or
	 * sent. usertrust-server derives each hold's remaining life from it.
	 */
	holdTimeoutMs?: number | undefined;
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
	/** The actor read ONCE at authorize; every terminal record names this, never "local". */
	readonly actor: string;
	/** The frozen principal captured at authorize, or `undefined` when none was given. */
	readonly principal: Principal | undefined;
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
}

/** Parameters for authorizing an LLM call. */
export interface AuthorizeParams {
	/** Model identifier (e.g., "claude-sonnet-4-6"). */
	model: string;
	/** Estimated input token count. If omitted, estimated from messages. */
	estimatedInputTokens?: number | undefined;
	/** Max output tokens for cost estimation. Defaults to 4096. */
	maxOutputTokens?: number | undefined;
	/**
	 * Estimated cache-READ prompt tokens, priced at the model's resolved
	 * `cacheReadPer1k` — the same resolution settle uses (an absent rate falls back
	 * to `inputPer1k`, never to free). With the two cache tiers given,
	 * `estimatedInputTokens` should be the FRESH input only. Omitted → 0, which sizes
	 * the hold exactly as before this field existed. A non-negative integer; anything
	 * else is a `TypeError` before any I/O.
	 */
	estimatedCacheReadTokens?: number | undefined;
	/**
	 * Estimated cache-WRITE (creation) prompt tokens, priced at the model's resolved
	 * `cacheWritePer1k`. Same rules as `estimatedCacheReadTokens`.
	 */
	estimatedCacheWriteTokens?: number | undefined;
	/** Messages array for PII detection and input token estimation. */
	messages?: unknown[] | undefined;
	/** Additional parameters for policy evaluation. */
	params?: Record<string, unknown> | undefined;
	/**
	 * Actor identity, recorded as sent on every audit record this call emits —
	 * denials, `llm_call`, the failure and settlement terminals, and the rotated
	 * receipt. Captured at authorize, so settle/abort never re-read it. Defaults to
	 * "local".
	 */
	actor?: string | undefined;
	/**
	 * Who the work is for — agent `id`/`type`, business `unit`, `role` (see
	 * {@link Principal}). Validated and frozen at authorize, before any I/O: an
	 * invalid field throws a `TypeError`. Recorded on the same audit records as
	 * `actor`, and written as `user_data` tags on the call's ledger transfers
	 * (`principalLedgerTags`). Reporting only: it never selects the account that
	 * pays and never enters the policy gate — that is `withCostCenter`'s job.
	 */
	principal?: Principal | undefined;
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
	/**
	 * The 1-HOUR share of `cacheWriteTokens` (Anthropic's `ephemeral_1h` TTL). A SUBSET
	 * of the write total, never added to it: `cacheWriteTokens` stays the TOTAL written
	 * and this says how much of it was the 1-hour kind, priced at the resolved
	 * `cacheWrite1hPer1k` (the 5-minute remainder at `cacheWritePer1k`). Clamped to the
	 * write total. Sent ALONE (no write total, no other count) it is not usage: the settle
	 * meters at the pre-call estimate like any settle with no counts. Omitted → 0, so an old
	 * client's settle is metered exactly as before.
	 */
	cacheWrite1hTokens?: number | undefined;
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
	 * `withCostCenter` scope active: attribution comes from the handle, never from
	 * the ambient scope at settle time.
	 */
	settle(auth: Authorization, params?: SettleParams): Promise<TrustReceipt>;

	/**
	 * Phase 2b: Abort a failed call.
	 * VOIDs the pending hold, writes failure audit.
	 *
	 * Attribution comes from the handle here too — see settle().
	 *
	 * Answers `{ aborted: true }` only when THIS call ended the hold, and
	 * `{ aborted: false }` when the governor no longer held it (a settle owns it, or it
	 * was already settled, aborted or released) or `destroy()` has taken the remaining
	 * holds (it ends them itself), as `release()` does. A void
	 * the ledger refused still ends the hold here and is named in `voidError`, a fixed
	 * code, never the error's text.
	 */
	abort(auth: Authorization, error?: unknown): Promise<AbortOutcome>;

	/**
	 * Phase 2c: Give back a hold that did not fail: a reservation the caller no longer
	 * needs, or one an integration ends itself (an expired hold, a shutdown). VOIDs the
	 * pending hold and writes a neutral `hold_released` record. It is NOT a
	 * circuit-breaker failure, and not a success either: give-backs can neither open the
	 * breaker nor close one that real failures opened. `abort()` keeps its meaning, a
	 * call that failed.
	 *
	 * Answers `{ released: true }` only when THIS call ended the hold, and
	 * `{ released: false }` when the governor no longer held it (its settle is mid-POST,
	 * or it was already settled, aborted or released) or `destroy()` has taken the
	 * remaining holds (it ends them itself). A void the ledger
	 * refused still ends the hold here (its accounting is released, and the ledger's
	 * pending timeout returns the funds) and is named in `voidError`: a fixed code for
	 * its cause, never the error's text. A hold the ledger had already expired is
	 * released cleanly.
	 *
	 * `reason` is caller text, recorded through {@link sanitizeReleaseReason}.
	 */
	release(auth: Authorization, reason?: string): Promise<ReleaseOutcome>;

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

/** What `Governor.abort()` did: see there. */
export type AbortOutcome =
	| { readonly aborted: true; readonly voidError?: string }
	| { readonly aborted: false };

/** What `Governor.release()` did: see there. */
export type ReleaseOutcome =
	| { readonly released: true; readonly voidError?: string }
	| { readonly released: false };

/** The longest `hold_released` reason the chain records, in characters (code points). */
const RELEASE_REASON_MAX = 200;

/**
 * The reason a `hold_released` record carries. It is caller text (a client's
 * `/v1/release` body, say) and lands on the audit chain, which a verifier later
 * prints at an auditor's terminal. So every control character is stripped (C0, DEL
 * and C1), and only then is it clipped: sanitize first, clip second (AGENTS.md), so a
 * run of controls can neither survive the clip nor eat into the 200 characters a real
 * reason gets. Iterating a string yields code points, so the clip never splits a
 * surrogate pair. Stripped rather than substituted, because this is a stored record,
 * not a terminal render: a `?` would read as part of the reason.
 *
 * Non-string input (an untyped caller) and a reason that strips to nothing both
 * record the default, so the record always says something true.
 *
 * Exported so an integration that echoes the reason elsewhere (usertrust-server's
 * `released` event) sends exactly what the chain recorded, never a second rule.
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

/**
 * The fixed code a release whose engine void failed records and answers, named by
 * its cause: the ledger's own status name for a transfer it refused,
 * `no_pending_entry` when the engine held no record of the hold, and otherwise
 * `ledger_unavailable` (the ledger could not be asked, say). Never the error's text,
 * which can carry a ledger address or a path.
 */
function releaseVoidError(err: unknown): string {
	if (err instanceof PendingEntryNotFoundError) return "no_pending_entry";
	if (err instanceof TBTransferError) {
		const name = CreateTransferStatus[err.code];
		return typeof name === "string" ? name : "ledger_rejected";
	}
	return "ledger_unavailable";
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
			userData?: PrincipalLedgerTags | undefined;
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
					// Named, not the client's default: the ledger expires the hold at this
					// timeout, and a headless handle publishes it (`holdTimeoutMs`).
					timeoutSeconds: LEDGER_HOLD_TIMEOUT_MS / 1000,
					// The principal's roll-up tags ride the hold; post/void inherit them.
					...(params.userData !== undefined
						? {
								userData128: params.userData.userData128,
								userData64: params.userData.userData64,
								userData32: params.userData.userData32,
							}
						: {}),
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
				throw new PendingEntryNotFoundError(transferId);
			}
			try {
				await tbClient.voidTransfer(entry.tbId);
			} catch (err) {
				// The ledger already ended this hold at its pending timeout and returned its
				// funds, which is what the void was for: like `exists`, that outcome stands.
				// Thrown, it left this entry behind, one per expired hold, until destroy().
				const expired =
					err instanceof TBTransferError &&
					err.code === CreateTransferStatus.pending_transfer_expired;
				if (!expired) throw err;
			}
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
/**
 * An optional per-tier token estimate from `AuthorizeParams`: omitted is 0;
 * otherwise a non-negative safe integer, or a `TypeError` naming the field.
 */
function estimateTier(value: unknown, field: string): number {
	if (value === undefined) return 0;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${field} must be a non-negative integer`);
	}
	return value;
}

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
	const destroyDrainMs = (isTestEnv ? opts?._destroyDrainMs : undefined) ?? 5_000;

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
	// Set by destroy() in the same synchronous step that takes every remaining hold, at its
	// deadline. From then on settle(), abort() and release() refuse at entry, before any
	// claim. Not `destroyed`, which is set when destroy() BEGINS: while it drains, a terminal
	// still runs and is waited for (a settle carries a charge for a call that ran).
	let sweeping = false;
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
	// Holds a settle() attempt OWNS: from its synchronous claim until it returns.
	// abort() and release() are silent no-ops for these (no void, no breaker call, no
	// record): everything settle reads after its claim is caller input, and a getter
	// there can call them on the very hold being settled. A settle that throws before
	// its POST leaves this set with its hold still in `unpostedHolds`, voidable again.
	// destroy() waits for this set to drain before voidAllPending(), matching
	// trust()'s 5s in-flight wait — never void a hold a settle is still working on.
	const settling = new Set<string>();
	// Holds an abort() or release() has CLAIMED and not yet recorded: parked on the
	// budget lock or on its ledger void, and in neither map. destroy() waits for these
	// as it does for `settling`, so a parked terminal lands its own void before the sweep.
	// A terminal leaves here in the same synchronous step that calls `appendEvent`, and
	// the writer queues an append when it is CALLED (its mutex's `acquire()` swaps the
	// queue before its first await; chain.test.ts pins this), so that record lands
	// before destroy()'s `flush()` and `release()`. One still here at destroy()'s
	// deadline is taken out and recorded by destroy() itself (the capture is kept for
	// its actor), and that terminal, finding itself gone, writes no second record.
	const inFlight = new Map<string, AuthorizationCapture>();

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
			// Read ONCE, rebuilt and frozen, before any I/O: an invalid principal is a
			// TypeError here, and nothing the caller does to its object afterwards can
			// reach a record or the ledger tags.
			const principal = capturePrincipal(params.principal);
			const principalAudit: { principal?: Principal } =
				principal === undefined ? {} : { principal };
			// Per-tier estimates, read ONCE and validated before any I/O, like the
			// principal: a hold sized from a NaN or a negative count would either reach
			// the ledger as garbage or silently reserve less than the call can cost.
			const estCacheReadTokens = estimateTier(
				params.estimatedCacheReadTokens,
				"estimatedCacheReadTokens",
			);
			const estCacheWriteTokens = estimateTier(
				params.estimatedCacheWriteTokens,
				"estimatedCacheWriteTokens",
			);
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
							...principalAudit,
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
			// The two cache tiers were already read ONCE and validated at the top of
			// authorize (`estCacheReadTokens` / `estCacheWriteTokens`); omitted is 0.
			// D3: size the ESTIMATED-input half of the hold at
			// max(inputPer1k, effective cacheWritePer1k) — see the identical
			// govern.ts hold-sizing comment for the full rationale. Settle-time
			// actual cost is unaffected; this only widens the PENDING reservation.
			// A headless authorize runs BEFORE the call and cannot see the request's cache
			// TTLs, so it reserves the worst case: the input leg at the dearest of input,
			// 5-minute write and 1-hour write, and any stated write estimate at the dearer
			// of the two write rates. (trust() reads the request and reserves the 1-hour
			// rate only when the request declares a 1-hour TTL.) Consequence, declared in
			// the CHANGELOG: holds on headless Anthropic calls run about 60% fatter on the
			// input leg than a 5-minute-only reserve.
			const holdRate = holdInputRate(rateInfo.rates, true, rateInfo.rateSource !== "table");
			// Per-tier hold: each cache tier at ITS OWN rate, resolved from the
			// UN-inflated rates exactly as settle resolves them (`resolveAppliedRates`).
			// Only the FRESH-input estimate keeps the D3 write premium — it is the half
			// of the estimate that cannot know which of its tokens the provider will
			// write to cache. Resolving the cache tiers first matters: a model with no
			// published cache-read rate falls back to `inputPer1k`, and that must be the
			// REAL input rate here, not the inflated hold rate. Tiers omitted → 0, so an
			// old client's hold is exactly what it was.
			const appliedForHold = resolveAppliedRates(rateInfo.rates);
			const estCost = costFromRates(
				{
					...rateInfo.rates,
					cacheReadPer1k: appliedForHold.cacheReadPer1k,
					cacheWritePer1k: holdCacheWriteRate(rateInfo.rates, rateInfo.rateSource !== "table"),
					inputPer1k: holdRate,
				},
				estInputTokens,
				maxOutputTokens,
				estCacheReadTokens,
				estCacheWriteTokens,
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
			const meteredEstimate = costFromRates(
				rateInfo.rates,
				estInputTokens,
				maxOutputTokens,
				estCacheReadTokens,
				estCacheWriteTokens,
			);

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
			// Set once the ledger hold lands: its pending timeout, for the handle.
			let ledgerHoldTimeoutMs: number | undefined;

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
								// Roll-up tags only; an untagged call omits the key, so its hold
								// is created exactly as before.
								...(principal !== undefined ? { userData: principalLedgerTags(principal) } : {}),
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
						ledgerHoldTimeoutMs = LEDGER_HOLD_TIMEOUT_MS;
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
							...principalAudit,
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
				...(ledgerHoldTimeoutMs !== undefined ? { holdTimeoutMs: ledgerHoldTimeoutMs } : {}),
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
			// destroy() may have begun while this call awaited (the budget lock, the policy,
			// the reserve). It claims every hold registered before it, and a hold registered
			// after would outlive the governor: a terminal could end it after the audit
			// writer is released. So it is never registered, and the call fails as one made
			// after destroy() does. Nothing awaits between this check and the registration
			// below.
			//  - Its session accounting is given back, under the budget lock as abort() and
			//    release() give theirs back: a settle destroy() is still draining reads it for
			//    its receipt.
			//  - Its reservation is NOT voided here. This void would be work destroy() does not
			//    wait for, and destroy() may already have closed the ledger client; a void then
			//    rebuilds a client that nothing destroys (#249). The ledger's pending timeout
			//    releases it within 300 s of its reserve (`LEDGER_HOLD_TIMEOUT_MS`), unless the
			//    engine sweep, which voids every reservation that landed before it, did first.
			//  - No record: a granted authorize writes none, and this one never became a hold
			//    the governor owned.
			if (destroyed) {
				if (!envelopeDebited) {
					const releaseLock = await budgetMutex.acquire();
					try {
						inFlightHoldTotal -= estCost;
					} finally {
						releaseLock();
					}
				}
				throw new Error("Governor has been destroyed");
			}
			// The GOVERNOR's record. Keyed by transferId and unreachable from caller
			// code, so `settle()`/`abort()` can never be handed a different cost center
			// than the one the hold was placed against.
			activeAuths.set(
				transferId,
				Object.freeze({
					proxyTransferId,
					actor,
					principal,
					costCenter: captured?.attribution.costCenter,
					envelope: captured,
					sessionAccounted: !envelopeDebited,
					meteredEstimate,
				}),
			);
			return auth;
		},

		async settle(auth: Authorization, params?: SettleParams): Promise<TrustReceipt> {
			// The handle's id, read ONCE and FIRST: a getter on it runs here, before any state
			// changes, and every claim, lookup and record below uses this one value.
			const transferId = auth.transferId;
			// Refused once destroy() has taken the remaining holds (see `sweeping`). NOT while
			// it drains: a settle carries a charge for a call that ran, and destroy() waits for
			// it, so refusing it there would void that call's cost.
			if (sweeping) {
				throw new Error("Governor has been destroyed");
			}
			// Caller input, read ONCE and FIRST: every SettleParams field, into a plain
			// local, before this call claims anything. A getter runs here, before any state
			// changes: one that throws leaves the hold untouched (live, still settleable),
			// and one that ends the hold itself (release, abort) is the first terminal, so
			// the claim below refuses this settle. Nothing below re-reads `params`.
			const input = {
				inputTokens: params?.inputTokens,
				outputTokens: params?.outputTokens,
				cacheReadTokens: params?.cacheReadTokens,
				cacheWriteTokens: params?.cacheWriteTokens,
				cacheWrite1hTokens: params?.cacheWrite1hTokens,
				usageSource: params?.usageSource,
				chunksDelivered: params?.chunksDelivered,
				computeMs: params?.computeMs,
			};
			// One `get` where there used to be `has` + a read off the caller's object:
			// the presence check and the attribution now come from the same internal
			// record, so liveness and provenance cannot disagree. Semantics are
			// unchanged — the first terminal claims the entry, every later one is
			// refused.
			const capture = activeAuths.get(transferId);
			if (capture === undefined) {
				throw new Error(`Authorization ${transferId} is not active (already settled or aborted)`);
			}
			activeAuths.delete(transferId);
			// Claimed. Still PENDING. Pre-POST throw leaves the id here so
			// abort()/destroy() can void a hold that never reached POST. The id
			// leaves this set when POST begins and is never put back after a POST
			// attempt — success or transport-ambiguous.
			unpostedHolds.set(transferId, capture);
			// And OWNED, synchronously, from this claim (AGENTS.md: exactly one ledger
			// mutation per hold, claimed synchronously). Everything below reads caller
			// input, the SettleParams fields and the handle's, and any of it can be a
			// getter that calls release() or abort() on this very hold. Marked
			// `settling`, they stay out until this attempt is over: posted, or failed
			// before its POST, when the `finally` hands the hold back.
			settling.add(transferId);
			try {
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
				// The same discipline for WHO: the actor and principal captured at
				// authorize, never the caller's handle or `SettleParams`. No principal →
				// no key, so an untagged call's records keep their shape.
				const principalAudit: { principal?: Principal } =
					capture.principal === undefined ? {} : { principal: capture.principal };

				// A3: settlement meters with the endpoint scope CAPTURED AT AUTHORIZE —
				// SettleParams carries no endpoint field by design.
				const endpoint = auth.endpoint ?? defaultEndpoint;
				const rateInfo = resolveRates(model, endpoint.class, config);

				// D5 — the caller's object was read ONCE, into `input`, at entry. The
				// presence check below and the counts that get priced and recorded then
				// come from that read, so a caller whose `SettleParams` is a live object (a proxy,
				// a getter over a running accumulator) cannot have "reported?" answered
				// off one value and the money computed off another.
				const reportedCounts = {
					inputTokens: input.inputTokens,
					outputTokens: input.outputTokens,
					cacheReadTokens: input.cacheReadTokens,
					cacheWriteTokens: input.cacheWriteTokens,
					cacheWrite1hTokens: input.cacheWrite1hTokens,
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
					cacheWrite1hTokens: reportedCounts.cacheWrite1hTokens ?? 0,
					source: usageReported ? (input.usageSource ?? "provider") : "estimated",
				});
				// Present IFF provider-sourced (D5) — the single rule, in one place.
				const usageAudit = publishableUsageFields(usageSnapshot, rateInfo.rates);

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
						usageSnapshot.cacheWrite1hTokens ?? 0,
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
				// Leave the pre-POST cleanup set BEFORE the await. A transport-ambiguous
				// POST must not remain abort-voidable, and deleting after `settling`
				// drops would open a window where abort voids a hold mid-commit.
				unpostedHolds.delete(transferId);
				if (proxyConn != null && !isDryRun) {
					try {
						await proxyConn.settle(auth.proxyTransferId ?? transferId, actualCost);
					} catch (postErr) {
						settled = false;
						await audit
							.appendEvent({
								kind: "settlement_ambiguous",
								actor: capture.actor,
								data: {
									model,
									cost: actualCost,
									transferId,
									error:
										postErr instanceof Error
											? postErr.message.slice(0, 200)
											: String(postErr).slice(0, 200),
									...costCenterAudit,
									...principalAudit,
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
						const postResult = await engine.postPendingSpend(transferId, actualCost);
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
						settled = false;
						await audit
							.appendEvent({
								kind: "settlement_ambiguous",
								actor: capture.actor,
								data: {
									model,
									cost: actualCost,
									transferId,
									error:
										postErr instanceof Error
											? postErr.message.slice(0, 200)
											: String(postErr).slice(0, 200),
									...costCenterAudit,
									...principalAudit,
								},
							})
							.catch(() => {
								callAuditDegraded = true;
							});
					}
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
						inFlightHoldTotal -= auth.estimatedCost;
						budgetSpent += actualCost;
					} finally {
						releaseLock();
					}
					// Finding-2 (RECON #4): serialized monotonic persist — never regresses.
					await persistSpend();
				}

				// Audit event
				const syntheticHash = createHash("sha256").update(transferId).digest("hex");
				let auditHash = syntheticHash;
				try {
					const auditEvent = await audit.appendEvent({
						kind: "llm_call",
						actor: capture.actor,
						data: {
							model,
							cost: actualCost,
							settled,
							transferId,
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
							...(input.chunksDelivered != null ? { chunksDelivered: input.chunksDelivered } : {}),
							source: "headless",
							...costCenterAudit,
							...principalAudit,
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
							actor: capture.actor,
							data: {
								model,
								actual: actualCost,
								posted: shortfallRecord.posted,
								shortfall: shortfallRecord.shortfall,
								transferId,
								...costCenterAudit,
								...principalAudit,
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
							actor: capture.actor,
							data: {
								model,
								cost: actualCost,
								settled,
								transferId,
								...costCenterAudit,
								...principalAudit,
							},
						},
						config.audit.indexLimit,
					);
				}

				// Pattern memory
				if (config.patterns.enabled) {
					const promptHash = createHash("sha256").update(transferId).digest("hex");
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
					transferId,
					cost: actualCost,
					budgetRemaining: config.budget - budgetSpent - inFlightHoldTotal,
					auditHash,
					chainPath: join(VAULT_DIR, "audit"),
					receiptUrl: opts?.proxy != null ? `${VERIFY_URL_BASE}/${transferId}` : null,
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
						...(input.computeMs != null && Number.isFinite(input.computeMs) && input.computeMs >= 0
							? { computeMs: input.computeMs }
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
					...(input.chunksDelivered != null ? { chunksDelivered: input.chunksDelivered } : {}),
					...(postedCost !== undefined ? { postedCost } : {}),
					...(settledBudget !== undefined ? { budget: settledBudget } : {}),
					...(callAuditDegraded ? { auditDegraded: true as const } : {}),
					...(proxyConn != null ? { proxyStub: true as const } : {}),
				};

				return receipt;
			} finally {
				settling.delete(transferId);
			}
		},

		async abort(auth: Authorization, error?: unknown): Promise<AbortOutcome> {
			// The handle's id, read ONCE and FIRST (see settle()).
			const transferId = auth.transferId;
			// Refused once destroy() has taken the remaining holds (see `sweeping`): the hold is
			// destroy()'s to end, and it voids and records it. Before any claim: no void, no
			// record. While destroy() drains, an abort runs as before and is waited for.
			if (sweeping) {
				return { aborted: false };
			}
			// Same lookup as settle, and the same reason: liveness and attribution come
			// from one internal record. Still idempotent-silent, unlike settle.
			// A settle owns this hold (from its claim to its end; see `settling`):
			// first terminal is settle. A concurrent abort must not void (TB may be
			// committing) and must not recordFailure / llm_call_failed — that would
			// trip the provider circuit for a call that is settling, not failing.
			if (settling.has(transferId)) {
				return { aborted: false };
			}
			// AUD-001: a settle that threw BEFORE POST has already claimed the
			// auth (deleted from activeAuths) but left the transfer PENDING.
			// Look there first, then in the claimed-but-never-POSTed set. A miss
			// in both is already posted, voided, or a transport-ambiguous POST
			// (counted fail-closed, already wrote settlement_ambiguous + llm_call)
			// — a cleanup abort must not throw, double-void, or look like an LLM
			// failure.
			let capture = activeAuths.get(transferId);
			if (capture !== undefined) {
				activeAuths.delete(transferId);
			} else {
				capture = unpostedHolds.get(transferId);
				if (capture === undefined) {
					return { aborted: false };
				}
				unpostedHolds.delete(transferId);
			}
			// Claimed, and in flight until its record starts: destroy() waits for it (see
			// `inFlight`). No second `settling` check here: nothing above awaits and settle()
			// marks its hold at its own claim, so it could never be true, and a return here
			// would orphan the claimed hold. No return from here on skips the void.
			inFlight.set(transferId, capture);
			try {
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

				// VOID the pending hold. A failed void is named, never thrown: the hold's
				// accounting is released above, and the ledger's timeout returns its funds.
				let voidError: string | undefined;
				if (proxyConn != null && !isDryRun) {
					try {
						await proxyConn.void(auth.proxyTransferId ?? transferId);
					} catch {
						voidError = "proxy_void_failed";
					}
				} else if (engine != null && !isDryRun) {
					try {
						await engine.voidPendingSpend(transferId);
					} catch (err) {
						voidError = releaseVoidError(err);
					}
				}

				const outcome: AbortOutcome =
					voidError === undefined ? { aborted: true } : { aborted: true, voidError };

				// Audit the failure.
				// A1: an attributed hold leaves an attributed record on the VOID terminal
				// too — forensic continuity, so an auditor reconstructing a cost center's
				// history sees the calls that were held against it and released, not only
				// the ones that settled. Read from the capture, like settle: abort commonly
				// runs from a `catch` block outside the `withCostCenter` scope entirely, and
				// the handle it is handed there is caller-owned.
				// Out of `inFlight` in the same step as the append. Already gone means
				// destroy() reached its deadline first and recorded this hold: no second record.
				if (!inFlight.delete(transferId)) return outcome;
				await audit
					.appendEvent({
						kind: "llm_call_failed",
						actor: capture.actor,
						data: {
							model: auth.model,
							transferId,
							error:
								error instanceof Error
									? error.message.slice(0, 200)
									: error != null
										? String(error).slice(0, 200)
										: "aborted",
							source: "headless",
							...(voidError === undefined ? {} : { voidError }),
							...(capture.costCenter === undefined ? {} : { costCenter: capture.costCenter }),
							...(capture.principal === undefined ? {} : { principal: capture.principal }),
						},
					})
					.catch(() => {});
				return outcome;
			} finally {
				inFlight.delete(transferId);
			}
		},

		async release(auth: Authorization, reason?: string): Promise<ReleaseOutcome> {
			// The handle's id, read ONCE and FIRST (see settle()).
			const transferId = auth.transferId;
			// Refused once destroy() has taken the remaining holds, before any claim, as abort() is.
			if (sweeping) {
				return { released: false };
			}
			// abort()'s claim discipline, step for step and for the same reasons: a hold a
			// settle owns (see `settling`) belongs to settle; a hold whose settle failed
			// before its POST is releasable again; a miss in both is already resolved. Only
			// the terminal's MEANING differs, and this one says whether it ended the hold.
			if (settling.has(transferId)) {
				return { released: false };
			}
			let capture = activeAuths.get(transferId);
			if (capture !== undefined) {
				activeAuths.delete(transferId);
			} else {
				capture = unpostedHolds.get(transferId);
				if (capture === undefined) {
					return { released: false };
				}
				unpostedHolds.delete(transferId);
			}
			// Claimed, and in flight until its record starts (see abort()).
			inFlight.set(transferId, capture);
			try {
				// Exactly what abort() gives back, the same way: only the session wallet's own
				// in-flight exposure. An attributed hold never added to it.
				if (capture.sessionAccounted) {
					const releaseLock = await budgetMutex.acquire();
					try {
						inFlightHoldTotal -= auth.estimatedCost;
					} finally {
						releaseLock();
					}
				}

				// No circuit-breaker call, deliberately: a give-back is neither a failure nor a
				// success (see the interface).

				// VOID the pending hold. A hold the ledger already expired is done (the engine
				// says so). Any other refusal is recorded, never thrown: the hold's accounting
				// is released above, and the ledger's pending timeout returns its funds.
				let voidError: string | undefined;
				if (proxyConn != null && !isDryRun) {
					try {
						await proxyConn.void(capture.proxyTransferId ?? transferId);
					} catch {
						// A proxy's failure carries no cause this governor can read, an expiry
						// included. (Proxy mode is removed, AUD-456: `proxyConn` is always null.)
						voidError = "proxy_void_failed";
					}
				} else if (engine != null && !isDryRun) {
					try {
						await engine.voidPendingSpend(transferId);
					} catch (err) {
						voidError = releaseVoidError(err);
					}
				}

				const outcome: ReleaseOutcome =
					voidError === undefined ? { released: true } : { released: true, voidError };

				// A neutral terminal record (#204): what ended the hold and why, attributed
				// from the capture like every other terminal. Out of `inFlight` in the same
				// step as the append (see abort()).
				if (!inFlight.delete(transferId)) return outcome;
				await audit
					.appendEvent({
						kind: "hold_released",
						actor: capture.actor,
						data: {
							model: auth.model,
							transferId,
							reason: sanitizeReleaseReason(reason),
							source: "headless",
							...(voidError === undefined ? {} : { voidError }),
							...(capture.costCenter === undefined ? {} : { costCenter: capture.costCenter }),
							...(capture.principal === undefined ? {} : { principal: capture.principal }),
						},
					})
					.catch(() => {});
				return outcome;
			} finally {
				inFlight.delete(transferId);
			}
		},

		async destroy(): Promise<void> {
			if (destroyed) return;
			destroyed = true;

			// Never void a hold a terminal is still working on: a settle's POST, or an abort
			// or release parked on the budget lock or its own void. ONE deadline for both
			// (trust()'s 5 s bound), never one per set. A terminal that starts while this
			// drains (a settle, an abort, a release) runs as before and is waited for too; they
			// refuse only from the claim below (`sweeping`).
			const deadline = Date.now() + destroyDrainMs;
			while ((settling.size > 0 || inFlight.size > 0) && Date.now() < deadline) {
				await new Promise<void>((r) => setTimeout(r, 50));
			}

			// At the deadline, destroy() takes every hold that is still the governor's, in ONE
			// synchronous step, before its first await: no terminal can claim one of them
			// while destroy() records another, and every terminal called from here on refuses
			// at entry (`sweeping`), before any claim.
			//  - An abort or release still in flight has not recorded its hold, and its own
			//    record would land after the writer closes below. Taken out of `inFlight`, it
			//    writes none (see abort()); its record is destroy()'s.
			//  - Every hold still held: still active, or handed back by a settle that threw
			//    before its POST. A settle still posting is in neither map (it leaves
			//    `unpostedHolds` before its POST, its first await), and neither is a
			//    transport-ambiguous POST, which already has its record (`settlement_ambiguous`).
			const stillInFlight = [...inFlight];
			inFlight.clear();
			sweeping = true;
			const leftovers = [...activeAuths, ...unpostedHolds];
			activeAuths.clear();
			unpostedHolds.clear();

			// A terminal still in flight: its void is its own, or the engine sweep's below
			// (which also reaches this hold: its engine entry goes only when its own void
			// returns), and the ledger takes one of the two: one mutation either way. The record
			// says only what destroy() knows, that the void had not completed. It names no
			// `voidError`: there was no outcome yet. The terminal still answers its caller from
			// its own void.
			for (const [txId, capture] of stillInFlight) {
				await audit
					.appendEvent({
						kind: "hold_released",
						actor: capture.actor,
						data: {
							transferId: txId,
							reason: "governor destroyed (terminal still in flight: its void had not completed)",
							source: "headless",
							...(capture.costCenter === undefined ? {} : { costCenter: capture.costCenter }),
							...(capture.principal === undefined ? {} : { principal: capture.principal }),
						},
					})
					.catch(() => {});
			}

			// Every hold still held: voided and recorded, so destroy() ends no hold without a
			// record.
			for (const [txId, capture] of leftovers) {
				let voidError: string | undefined;
				if (proxyConn != null && !isDryRun) {
					try {
						await proxyConn.void(capture.proxyTransferId ?? txId);
					} catch {
						voidError = "proxy_void_failed";
					}
				} else if (engine != null && !isDryRun) {
					try {
						await engine.voidPendingSpend(txId);
					} catch (err) {
						voidError = releaseVoidError(err);
					}
				}
				// The capture carries no model (#205), so this record names none.
				await audit
					.appendEvent({
						kind: "hold_released",
						actor: capture.actor,
						data: {
							transferId: txId,
							reason: "governor destroyed",
							source: "headless",
							...(voidError === undefined ? {} : { voidError }),
							...(capture.costCenter === undefined ? {} : { costCenter: capture.costCenter }),
							...(capture.principal === undefined ? {} : { principal: capture.principal }),
						},
					})
					.catch(() => {});
			}

			// AUD-001 / AUD-461: same sweep trust() runs, best-effort, and it writes no
			// record. What it can still find has one already: a settle whose POST threw
			// (`settlement_ambiguous`; a void of a transfer TB did post fails closed in the
			// catch), an abort or release whose own void failed (its record names the
			// `voidError`, though this sweep may yet return the funds), a terminal still in
			// flight above (recorded there), and a settle still posting past the deadline (its
			// own records). Then close the client: a voidAllPending throw must not skip
			// destroy() and hang the process on the open TigerBeetle socket.
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
