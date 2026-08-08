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

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CreateTransferStatus } from "tigerbeetle-node";
import { type AuditWriter, createAuditWriter } from "./audit/chain.js";
import { writeReceipt } from "./audit/rotation.js";
import { costCenterUserId } from "./budget/allocation.js";
import { type CostCenterAttribution, getCurrentCostCenter } from "./budget/attribution.js";
import { computeRunway, runwayHours } from "./budget/runway.js";
import { classifyEndpoint, detectClientKind } from "./detect.js";
import { TBTransferError, TrustTBClient, XFER_SPEND } from "./ledger/client.js";
import {
	costFromRates,
	estimateInputTokens,
	type RateResolution,
	resolveRates,
	warnUnknownModel,
} from "./ledger/pricing.js";
import { recordPattern } from "./memory/patterns.js";
import { DEFAULT_RULES, mergePolicies } from "./policy/default-rules.js";
import { derivePolicyHint, evaluatePolicy, type GateRule, loadPolicies } from "./policy/gate.js";
import { detectInjection } from "./policy/injection.js";
import { detectPII, redactPII } from "./policy/pii.js";
import type { ProxyConnection } from "./proxy.js";
import { CircuitBreakerRegistry } from "./resilience/circuit.js";
import { DEFAULT_BUDGET, VAULT_DIR } from "./shared/constants.js";

/** Base URL for receipt verification links (used in proxy mode). */
const VERIFY_URL_BASE = "https://verify.usertrust.dev";

import { createAnomalyDetector } from "./anomaly/detector.js";
import {
	AnomalyError,
	AuditDegradedError,
	InsufficientBalanceError,
	LedgerUnavailableError,
	PolicyDeniedError,
} from "./shared/errors.js";
import { trustId } from "./shared/ids.js";
import type {
	ActionDescriptor,
	EndpointInfo,
	GovernedActionResult,
	LLMClientKind,
	TrustConfig,
	TrustedResponse,
	TrustReceipt,
} from "./shared/types.js";
import { TrustConfigSchema } from "./shared/types.js";
import {
	type ChunkObservation,
	createGovernedStream,
	type GovernedStream,
	type StreamCompletion,
} from "./streaming.js";

// ── Public types ──

export interface TrustOpts {
	/** Path to usertrust.config.json. Defaults to `.usertrust/usertrust.config.json`. */
	configPath?: string;
	/**
	 * Remote proxy URL.
	 * @deprecated AUD-456: Proxy mode is not yet implemented. Passing this option
	 * will throw an error. Use dryRun mode for testing.
	 */
	proxy?: string;
	/**
	 * API key for the proxy.
	 * @deprecated AUD-456: Proxy mode is not yet implemented.
	 */
	key?: string;
	/** Token budget override. */
	budget?: number;
	/** Tier override. */
	tier?: string;
	/**
	 * This governor's ledger identity — the parent half of the
	 * `(parentUserId, costCenter)` tuple every cost-center envelope account is
	 * derived from. Overrides `parentUserId` in the config file, and is validated
	 * by the same rule at construction (see `TrustConfigSchema.parentUserId`).
	 *
	 * SECURITY: TRUSTED-OPERATOR input, same boundary as budget/customRates —
	 * never derive it from end-user or request data.
	 */
	parentUserId?: string | undefined;
	/**
	 * Dry-run mode — skips TigerBeetle, audit-chain-only.
	 * Also enabled by USERTRUST_DRY_RUN=true env var.
	 */
	dryRun?: boolean;
	/** Vault directory override (default: cwd). */
	vaultBase?: string;
	/**
	 * Explicit endpoint classification override (M2) — wins over config.endpoints
	 * matchers and loopback autodetect. TRUSTED-OPERATOR input, same trust
	 * boundary as budget/customRates: never derive it from end-user or request
	 * data (A10).
	 */
	endpoint?: Partial<EndpointInfo> | undefined;
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
	/**
	 * Reserve `amount` as a PENDING debit.
	 *
	 * `debitAccountId` is an ALREADY-DERIVED cost-center envelope account: the
	 * derivation stays in the governor, beside the other authorize-time captures,
	 * so `TrustTBClient.deriveCostCenterAccountId` keeps the small, audited
	 * call-site count the "one static" invariant depends on. Omitted → the
	 * session holding wallet, i.e. exactly the pre-envelope behaviour.
	 */
	spendPending(params: {
		transferId: string;
		amount: number;
		debitAccountId?: bigint | undefined;
	}): Promise<{ transferId: string }>;
	/**
	 * Settle a PENDING hold. `actualAmount` is CAPPED at the reserved amount —
	 * TigerBeetle rejects (never caps) a post above the pending transfer — and the
	 * truncation is reported back as `shortfall` for the governor to audit as
	 * `settlement_shortfall`. Omitting `actualAmount` posts the full pending
	 * amount. An engine that returns `void` (injected test engines) is treated as
	 * posted-in-full with zero shortfall.
	 */
	postPendingSpend(
		transferId: string,
		actualAmount?: number,
		// biome-ignore lint/suspicious/noConfusingVoidType: load-bearing — an injected engine declaring `Promise<void>` must stay assignable, and `void` is the only member type that accepts it; `undefined` would reject every one.
	): Promise<{ posted: number; shortfall: number } | void>;
	voidPendingSpend(transferId: string): Promise<void>;
	/** AUD-461: Void all remaining pending transfers on destroy. */
	voidAllPending?(): Promise<void>;
	/**
	 * Read `available` for each account, missing accounts ABSENT from the map — the
	 * batch semantics of `TrustTBClient.lookupBalances`, which this delegates to
	 * verbatim in both factories. It is the governor's ONLY window onto a
	 * cost-center envelope's balance: the TigerBeetle client lives inside the engine
	 * closure, so without this seam the policy gate could not see the envelope it is
	 * about to authorize a spend from, and a settled receipt could not report it.
	 *
	 * REPORTING ONLY — never enforcement. Nothing decides whether money may move
	 * from what this returns; TigerBeetle's atomic rejection of the hold is the
	 * whole enforcement, so a stale read can only under-deny and no check-then-act
	 * enters the money path.
	 *
	 * OPTIONAL only because the interface predates it and an injected test engine
	 * may omit it. BOTH `createTBEngine` factories implement it — an engine that
	 * places an attributed hold and cannot report the envelope it debited is
	 * refused at authorize with `LedgerUnavailableError`, exactly like a read that
	 * threw (A2). Falling back to session-scoped numbers is NOT an option: the
	 * overshoot rule would then clear the call against the holding wallet while the
	 * hold debits the envelope, and the policy record would name a wallet the money
	 * never came from.
	 */
	lookupBalances?(accountIds: bigint[]): Promise<Map<bigint, number>>;
	destroy?(): void;
}

// ── F5: governed-surface type rewrites ────────────────────────────────────────
// The runtime proxy makes Anthropic `messages.create` / `beta.messages.create`
// resolve to the `{ response, receipt }` envelope, makes `messages.stream` /
// `beta.messages.stream` ASYNC (they authorize before forwarding) with a
// `.receipt` promise hung off the returned MessageStream, and makes
// `messages.parse` / `beta.messages.parse` return the parsed message with a
// settled `.receipt`. These mapped types make the EXPORTED TrustedClient type
// match that runtime contract, so a consumer using the old bare-`Message` or
// sync `const s = client.messages.stream(...)` patterns gets a compile error.
// Clients without a top-level `messages` (OpenAI/Google) pass through unchanged.

/** `stream` becomes `(...args) => Promise<MessageStream & { receipt: Promise<TrustReceipt> }>`. */
type GovernedStreamMethod<F> = F extends (...args: infer A) => infer R
	? (...args: A) => Promise<Awaited<R> & { receipt: Promise<TrustReceipt> }>
	: F;

/** `parse` becomes `(...args) => Promise<ParsedMessage & { receipt: TrustReceipt }>`. */
type GovernedParseMethod<F> = F extends (...args: infer A) => infer R
	? (...args: A) => Promise<Awaited<R> & { receipt: TrustReceipt }>
	: F;

/**
 * The `response` inside a governed `create` envelope. The runtime discriminates
 * on `Symbol.asyncIterator in response` (interceptCall): an iterable provider
 * response is wrapped by `createGovernedStream(...)` and the WRAPPER goes into
 * the envelope — an `AsyncIterable` with a `.receipt` promise, NOT the SDK's
 * raw `Stream` (no `tee()`/`controller`/`toReadableStream()`). On that path the
 * envelope's own `receipt` is the ESTIMATED receipt; the settled one arrives on
 * `response.receipt` — which `GovernedStream` already expresses. Non-iterable
 * responses pass through unchanged. Distributes over the base overload's union,
 * so `Stream<RawMessageStreamEvent> | Message` becomes
 * `GovernedStream<RawMessageStreamEvent> | Message`.
 */
type GovernedResponseOf<T> = T extends AsyncIterable<infer E> ? GovernedStream<E> : T;

/**
 * `create` becomes `(...args) => Promise<{ response, receipt }>`, per overload.
 * The Anthropic SDK declares three `create` overloads (non-streaming, streaming,
 * base); a bare `F extends (...args) => R` conditional infers only the LAST one,
 * which would collapse `create({ stream: true })`'s response to the base union.
 * The cascade matches the overload list positionally (3, then 2, then 1) and
 * rewrites each signature, preserving its response type inside the envelope —
 * matching the runtime, where interceptCall resolves BOTH paths with
 * `{ response, receipt }` (see the `create` trap in buildAnthropicMessagesProxy;
 * on the streaming path `response` is createGovernedStream's wrapper, mapped by
 * GovernedResponseOf above).
 * A single-signature `create` unifies into the 3-pattern as three identical
 * signatures, which resolves identically at every call site. Scoped to the SDK's
 * current 3-overload shape; the real-SDK block in
 * tests/govern/trusted-client-types.test-d.ts is the drift alarm if upstream
 * adds a fourth.
 */
type GovernedCreateMethod<F> = F extends {
	(...args: infer A1): infer R1;
	(...args: infer A2): infer R2;
	(...args: infer A3): infer R3;
}
	? {
			(...args: A1): Promise<{ response: GovernedResponseOf<Awaited<R1>>; receipt: TrustReceipt }>;
			(...args: A2): Promise<{ response: GovernedResponseOf<Awaited<R2>>; receipt: TrustReceipt }>;
			(...args: A3): Promise<{ response: GovernedResponseOf<Awaited<R3>>; receipt: TrustReceipt }>;
		}
	: F extends {
				(...args: infer A1): infer R1;
				(...args: infer A2): infer R2;
			}
		? {
				(
					...args: A1
				): Promise<{ response: GovernedResponseOf<Awaited<R1>>; receipt: TrustReceipt }>;
				(
					...args: A2
				): Promise<{ response: GovernedResponseOf<Awaited<R2>>; receipt: TrustReceipt }>;
			}
		: F extends (...args: infer A) => infer R
			? (...args: A) => Promise<{ response: GovernedResponseOf<Awaited<R>>; receipt: TrustReceipt }>
			: F;

/** Rewrite `create`/`stream`/`parse` on a `messages` resource; leave everything else. */
type GovernedMessages<M> = M extends object
	? Omit<M, "create" | "stream" | "parse"> &
			("create" extends keyof M ? { create: GovernedCreateMethod<M["create"]> } : unknown) &
			("stream" extends keyof M ? { stream: GovernedStreamMethod<M["stream"]> } : unknown) &
			("parse" extends keyof M ? { parse: GovernedParseMethod<M["parse"]> } : unknown)
	: M;

/** Rewrite `beta.messages` when present; otherwise leave `beta` untouched. */
type GovernedBeta<B> = B extends { messages: infer BM }
	? Omit<B, "messages"> & { messages: GovernedMessages<BM> }
	: B;

/**
 * Rewrite only the Anthropic `messages` / `beta.messages` surfaces. A client
 * without a `messages` resource (OpenAI, Google) is returned unchanged — its
 * governed `create`/`responses` shapes are unaffected by this rewrite.
 */
type GovernedShape<T> = T extends { messages: infer M }
	? Omit<T, "messages" | "beta"> & { messages: GovernedMessages<M> } & (T extends { beta: infer B }
				? { beta: GovernedBeta<B> }
				: unknown)
	: T;

/** The trusted client: governed client shape (F5) + governance methods. */
export type TrustedClient<T> = GovernedShape<T> & {
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

// ── M2 unknown-model policy (A5) ──

/** USD value of one usertoken: 1 usertoken = $0.0001 (one basis point of a cent). */
const USERTOKENS_PER_DOLLAR = 10_000;

/**
 * Enforce config.unknownModelPolicy at AUTHORIZE time (A5). Only cloud-scope
 * resolutions can be unknown — local scope always resolves to local rates.
 * "deny" throws before any PENDING hold; "warn" logs once per model string per
 * process via the shared warnUnknownModel helper (receipts carry
 * meter.rateSource "fallback" regardless of warn dedup); "fallback" is silent.
 */
function enforceUnknownModelPolicy(
	model: string,
	resolution: RateResolution,
	config: TrustConfig,
): void {
	if (!resolution.unknown) return;
	if (config.unknownModelPolicy === "deny") {
		throw new PolicyDeniedError(
			`unknown_model: ${model} not in pricing table`,
			'Set pricing: "custom" with a customRates entry for this model in usertrust.config.json, or use a model from the built-in pricing table.',
		);
	}
	if (config.unknownModelPolicy === "warn") {
		warnUnknownModel(model);
	}
}

/**
 * A4: build forward-args for a local openai stream call with
 * stream_options.include_usage merged in. The caller's other stream_options
 * fields survive; an explicit include_usage (true OR false) is respected —
 * only a missing/null value injects. Returns null when no injection applies.
 */
function withInjectedUsageOptions(args: unknown[]): unknown[] | null {
	const params = (args[0] ?? {}) as Record<string, unknown>;
	if (params.stream !== true) return null;
	const rawOptions = params.stream_options;
	const streamOptions =
		rawOptions != null && typeof rawOptions === "object"
			? (rawOptions as Record<string, unknown>)
			: undefined;
	if (streamOptions?.include_usage != null) return null;
	return [
		{ ...params, stream_options: { ...streamOptions, include_usage: true } },
		...args.slice(1),
	];
}

/** Message shapes an OpenAI-compat server emits when it rejects an unknown field. */
const STREAM_OPTIONS_REJECTION_RE =
	/stream_options|include_usage|unrecognized|unknown.{0,20}(field|argument|parameter|option)/i;

/**
 * A4 retry heuristic: does `err` plausibly indicate that the server rejected the
 * injected `stream_options.include_usage`? We only retry-without-injection for
 * these — a blanket retry on ANY error would double the provider call on
 * transient failures (ECONNRESET, timeouts, 5xx) and mask the real root cause,
 * so everything else rethrows the ORIGINAL error immediately. Matches the
 * rejection message on the error, its nested `error.message`, or a cheaply
 * reachable `response` body; or an HTTP-shaped 400/422 status on the error
 * object. Tradeoff: a server that rejects the field with an opaque 500 and no
 * telltale text is NOT retried — acceptable, since include_usage is widely
 * supported and the caller still receives the original error.
 */
function looksLikeStreamOptionsRejection(err: unknown): boolean {
	if (err == null || typeof err !== "object") {
		return err instanceof Error && STREAM_OPTIONS_REJECTION_RE.test(err.message);
	}
	const e = err as Record<string, unknown>;
	const status = e.status ?? e.statusCode;
	if (status === 400 || status === 422) return true;
	const candidates: unknown[] = [e.message, e.body];
	if (err instanceof Error) candidates.push(err.message);
	const nested = e.error;
	if (nested != null && typeof nested === "object") {
		candidates.push((nested as Record<string, unknown>).message);
	}
	const response = e.response;
	if (typeof response === "string") {
		candidates.push(response);
	} else if (response != null && typeof response === "object") {
		const r = response as Record<string, unknown>;
		candidates.push(r.data, r.body);
	}
	return candidates.some((c) => typeof c === "string" && STREAM_OPTIONS_REJECTION_RE.test(c));
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
		// money that another writer already recorded. Skip the write if the
		// persisted value is already >= ours.
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

// ── Cost-center envelope plumbing ─────────────────────────────────────────────
//
// SHARED WITH `headless.ts`, ON PURPOSE. The helpers below are `export`ed for one
// consumer — `createGovernor()` — and for one reason: both governors must resolve,
// gate on, refuse and report the SAME envelope by the SAME arithmetic. A third
// copy alongside the two `createTBEngine` copies is exactly the drift AGENTS.md
// records as a hazard, and here it would be a MONEY drift: D1's throw, A2's
// pre-gate refusal, A7's unfloored `budget_remaining_after` and D5's label re-wrap
// each decide whether a spend happens and which wallet it names. One copy, one
// answer. Nothing here reaches the package's public API — `index.ts` re-exports by
// name and `dist/govern.js` is not an exported subpath — so this widens the module
// surface, not the product's.

/**
 * What an active `withCostCenter` scope resolves to for THIS governor: the
 * envelope account money moves from, and the label everything human-readable
 * quotes. Derived once per call, at the governor's entry point, and then carried
 * by closure (`trust()`) or on the `Authorization` handle (`createGovernor()`) —
 * see {@link resolveEnvelope}.
 */
export interface ResolvedEnvelope {
	attribution: CostCenterAttribution;
	/** The (parent, costCenter) tuple hash. The only thing money is keyed on. */
	accountId: bigint;
	/** `parent::costCenter` — display and audit only, never an account id. */
	label: string;
}

/**
 * The remedy an exhausted ENVELOPE actually needs.
 *
 * `InsufficientBalanceError`'s default hint ("Increase the budget in trust()
 * options…") is not merely unhelpful here, it is wrong: `trust({ budget })` funds
 * the per-session holding wallet, and an attributed call never debits that wallet.
 * An operator who follows the default advice raises a number that cannot affect the
 * rejection and watches the identical call fail again.
 */
const ENVELOPE_FUNDING_HINT =
	"Fund this cost center with allocateBudget(parent, costCenter, amount) — or reclaim from " +
	"another envelope. Raising the trust()/createGovernor() budget funds the session wallet, " +
	"which an attributed call never debits.";

/**
 * Resolve the active scope into the envelope this call will debit, or `undefined`
 * when no scope is active.
 *
 * D1 — an active scope with no governor identity THROWS, at the top of the
 * governor's entry point, before any I/O: no hold, no audit record, no provider
 * call. The alternative — quietly falling back to the session holding wallet — is
 * the failure this whole feature exists to prevent: the caller asked for the spend
 * to come out of a specific envelope, the envelope is never touched, its
 * `getBudgetStatus` keeps reporting a full balance, and every tier keyed on it
 * fails open. Nothing in the system would report that; only the loud throw does.
 */
export function resolveEnvelope(
	attribution: CostCenterAttribution | undefined,
	parentUserId: string | undefined,
): ResolvedEnvelope | undefined {
	if (attribution === undefined) return undefined;
	if (parentUserId === undefined) {
		throw new Error(
			`usertrust: withCostCenter("${attribution.costCenter}") is active but this governor has ` +
				"no parentUserId. A cost-center envelope account is derived from the " +
				"(parentUserId, costCenter) tuple, so an attributed call cannot be routed without " +
				"it — and spending it from the session wallet instead would silently un-enforce the " +
				"envelope. Pass parentUserId to trust()/createGovernor(), or set it in " +
				"usertrust.config.json.",
		);
	}
	return {
		attribution,
		// DERIVE, NEVER LOOK UP (AGENTS.md, Money): the one static, the same one
		// allocation, reclaim, status and budgetContext go through. Never
		// `getAccountId`, never a cache, never a hand-rolled join.
		accountId: TrustTBClient.deriveCostCenterAccountId(parentUserId, attribution.costCenter),
		// Built by the one builder, which also re-validates both halves — cheap,
		// pure, and it keeps the label's injectivity argument in a single place.
		label: costCenterUserId(parentUserId, attribution.costCenter),
	};
}

/**
 * Re-present a ledger rejection of an ATTRIBUTED hold in the caller's own terms.
 *
 * The engine names the envelope by its derived account id, because the
 * `parent::costCenter` label is the governor's and the engine has no parent. An
 * operator reading a 39-digit account id learns nothing actionable, so the governor
 * — which does hold both halves — swaps in the label and the envelope remedy on the
 * way out. The ledger's own `required`/`available` numbers are carried through
 * unchanged: they are the only figures TigerBeetle actually decided on.
 */
export function asEnvelopeBalanceError(
	err: InsufficientBalanceError,
	label: string,
): InsufficientBalanceError {
	return new InsufficientBalanceError(label, err.required, err.available, ENVELOPE_FUNDING_HINT);
}

/**
 * 0..1 share of an envelope still available. Mirrors `budget/context.ts`'s clamp
 * semantics (A5) exactly — `allocated <= 0` is "no headroom" (`0`), never a
 * division by zero, and an over-funded envelope clamps at 1 rather than reporting
 * more than a full budget.
 */
function envelopeFraction(remaining: number, allocated: number): number {
	if (!(allocated > 0)) return 0;
	return Math.min(1, Math.max(0, remaining / allocated));
}

/**
 * The two envelope-scoped POLICY tier fields, from the scope's D4 allocation
 * metadata plus the live balance. Both are explicitly `undefined` when the scope
 * carried no metadata: there is no cost-center registry, so the governor genuinely
 * does not know the envelope's size, and a fabricated number is worse than an
 * absent one (a hard tier then fails closed and fires; a soft tier stays lenient —
 * the documented indeterminate split, unchanged).
 *
 * `spent` is derived from the LIVE balance rather than tracked in process, because
 * the envelope is shared across processes: `allocated − remaining` is what the
 * envelope has actually paid out, the same clamp `getBudgetStatus` and
 * `budgetContext` apply.
 */
export function envelopeTierFields(
	attribution: CostCenterAttribution,
	remaining: number,
	nowMs: number,
): { budgetFractionRemaining: number | undefined; budgetRunwayHours: number | undefined } {
	const { allocated, periodStartMs } = attribution;
	if (allocated === undefined || periodStartMs === undefined) {
		return { budgetFractionRemaining: undefined, budgetRunwayHours: undefined };
	}
	const runway = computeRunway({
		allocated,
		spent: Math.max(0, allocated - remaining),
		periodStartMs,
		periodEndMs: attribution.periodEndMs,
		nowMs,
	});
	const hours = runwayHours(runway, nowMs);
	return {
		budgetFractionRemaining: envelopeFraction(remaining, allocated),
		// `runwayHours` answers `null` for "not projectable"; the POLICY convention
		// for unknown is explicit `undefined` (A6). Two surfaces, two pre-existing
		// conventions — `budget/context.ts` keeps the `null` one. Do not unify them.
		budgetRunwayHours: hours ?? undefined,
	};
}

/**
 * The envelope's live `available` — one batched read, missing account read as `0`
 * (never-allocated and fully-reclaimed are the same observable state, the
 * implicit-zero equivalence `budget/allocation.ts` documents).
 *
 * REPORTS, never decides: TigerBeetle's atomic rejection of the hold is the whole
 * enforcement, so a stale answer can only under-deny and no check-then-act enters
 * the money path. Rejects when the engine cannot answer — the two callers below
 * differ precisely in what they do with that rejection.
 */
async function readEnvelopeBalance(
	engine: TrustEngine,
	envelope: ResolvedEnvelope,
): Promise<number> {
	const read = engine.lookupBalances;
	if (read == null) {
		throw new Error(
			"this TrustEngine cannot read balances (no lookupBalances) — an attributed hold " +
				"would debit an envelope nothing can report on",
		);
	}
	const balances = await read.call(engine, [envelope.accountId]);
	return balances.get(envelope.accountId) ?? 0;
}

/**
 * The authorize-time preflight: the envelope number the policy gate is about to
 * be gated on, or `undefined` when this call places no envelope hold at all —
 * unattributed, dry-run, or a governor with no engine. Those three place no hold
 * anywhere, so there is no envelope truth to be had and nothing for the session
 * numbers to contradict; the gate keeps describing exactly what it did before
 * envelopes existed.
 *
 * A2 (corrected) — an ATTRIBUTED call whose envelope cannot be read is REFUSED
 * here, before the policy gate, with the existing ledger-unavailable
 * classification. It is the one place in this file where a failed *report* stops a
 * call, and the reasoning is specific:
 *
 *  - Falling back to the SESSION numbers is what the first draft did, and it is
 *    unsound: `block-budget-overshoot` would then evaluate the holding wallet
 *    while the hold debits the envelope, and the policy record would say a call
 *    was cleared against a wallet it never touched. Mixed semantics in the one
 *    record an auditor reads.
 *  - Continuing with the fields ABSENT is not "continuing" at all — the hard
 *    `block-budget-overshoot` rule treats an indeterminate `budget_remaining_after`
 *    as fail-closed and denies, so the caller gets a policy denial that names the
 *    wrong cause.
 *  - Refusing costs almost no availability: the preflight and the hold share one
 *    TigerBeetle transport (and the client's own reconnect machinery has already
 *    run underneath), so a read that genuinely failed means the hold was doomed
 *    anyway. What it buys is an honest classification — the ledger is unreachable,
 *    and that is what the caller is told.
 *
 * @throws LedgerUnavailableError when an attributed call's envelope balance cannot
 * be read. No hold is placed and the policy gate is never reached.
 */
export async function preflightEnvelopeRemaining(
	engine: TrustEngine | null,
	isDryRun: boolean,
	envelope: ResolvedEnvelope | undefined,
): Promise<number | undefined> {
	if (envelope === undefined || isDryRun || engine == null) return undefined;
	try {
		return await readEnvelopeBalance(engine, envelope);
	} catch (err) {
		throw new LedgerUnavailableError(
			`cannot read cost-center envelope ${envelope.label} to authorize an attributed call: ` +
				(err instanceof Error ? err.message : String(err)),
		);
	}
}

/**
 * The post-settle snapshot read (D7). Same read, opposite failure policy: it NEVER
 * throws, because it runs after the money committed and a receipt is a report —
 * degrading a report must not unwind or re-decide a settlement. A failure omits
 * the block.
 */
export async function snapshotEnvelopeRemaining(
	engine: TrustEngine | null,
	isDryRun: boolean,
	envelope: ResolvedEnvelope | undefined,
): Promise<number | undefined> {
	if (envelope === undefined || isDryRun || engine == null) return undefined;
	try {
		return await readEnvelopeBalance(engine, envelope);
	} catch {
		return undefined;
	}
}

/**
 * D7 — the post-settle envelope snapshot a settled receipt carries, or `undefined`
 * when the call was unattributed or the read did not answer. Never throws: a
 * receipt is a report, and degrading a report must not unwind money that already
 * committed.
 */
export function envelopeReceiptBudget(
	envelope: ResolvedEnvelope | undefined,
	remaining: number | undefined,
): TrustReceipt["budget"] | undefined {
	if (envelope === undefined || remaining === undefined) return undefined;
	const { costCenter, allocated } = envelope.attribution;
	return {
		costCenter,
		remaining,
		// Omitted rather than guessed when the scope stated no allocation (D4).
		...(allocated === undefined ? {} : { fraction: envelopeFraction(remaining, allocated) }),
	};
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
			...(opts?.parentUserId !== undefined ? { parentUserId: opts.parentUserId } : {}),
		});
	} else {
		config = TrustConfigSchema.parse({
			budget: opts?.budget ?? DEFAULT_BUDGET,
			...(opts?.parentUserId !== undefined ? { parentUserId: opts.parentUserId } : {}),
		});
	}

	const isDryRun = opts?.dryRun ?? process.env.USERTRUST_DRY_RUN === "true";

	// AUD-470: Only accept injected _engine/_audit in test environments.
	// In production, silently ignore them to prevent governance bypass.
	const isTestEnv = process.env.USERTRUST_TEST === "1" || process.env.NODE_ENV === "test";

	// 2. Initialise subsystems
	const vaultPath = vaultBase;
	const audit: AuditWriter = (isTestEnv ? opts?._audit : undefined) ?? createAuditWriter(vaultPath);

	const policiesPath = join(vaultPath, VAULT_DIR, config.policies);
	const loadedRules = existsSync(policiesPath) ? loadPolicies(policiesPath) : [];
	// P1-CUSTOM-POLICY-REPLACES (RECON #2): platform DEFAULT_RULES are ALWAYS
	// enforced. mergePolicies is a safe concat — a custom policy file can only ADD
	// deny/warn rules, never remove the budget/overshoot/exhausted guarantees. The
	// gate is deny-wins with no "allow" effect, so appended user rules cannot weaken
	// a default deny.
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

	// 4. Engine (injected for tests, real TB client in production, null in dry-run/proxy)
	// AUD-470: _engine injection only accepted in test environments
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

	// 5. Detect client kind (transport) + classify the endpoint (settlement
	// regime, M2). classifyEndpoint runs BESIDE detectClientKind — the endpoint
	// class, not the model string, picks local vs cloud metering (A3: this scope
	// is captured once here and used verbatim at every authorize/settle below).
	const kind: LLMClientKind = detectClientKind(client);
	const endpoint: EndpointInfo = classifyEndpoint(client, config, opts?.endpoint);

	// 6. Track state
	let destroyed = false;
	const budgetMutex = new AsyncMutex(); // AUD-453: serialise budget-check + hold
	let inFlightCount = 0; // AUD-462: track in-flight calls for graceful destroy
	let inFlightStreamCount = 0; // AUD-462: track in-flight streams (consumed after interceptCall returns)
	let inFlightHoldTotal = 0; // Track estimated cost of in-flight pending holds

	// Streaming anomaly detector — shared across calls so injection-cascade
	// can track signals across the conversation. Disabled when config.anomaly.enabled=false.
	// M2 seam fix: the injected costCalculator prices spend-velocity with the
	// SAME scoped rates as settlement, using the observed event's
	// model/endpointClass (the detector is shared while the model varies per
	// call). Denominations differ by design: cloud events → DOLLARS against
	// thresholdDollarsPerMin; local events → nominal usertokens against
	// localThresholdUsertokensPerMin, WITHOUT the per-call >=1 settlement floor.
	// Settlement floors per call; the anomaly signal measures flow — so a
	// default {0,0}-rate local stream contributes 0 and can never false-trip
	// spend_velocity (rejected-merge design note, pinned by Task 3 tests).
	const anomalyDetector = createAnomalyDetector(config.anomaly, {
		provider: kind,
		costCalculator: (calcModel, inputTokens, outputTokens, event) => {
			const scope = event?.endpointClass ?? "cloud";
			const resolution = resolveRates(event?.model ?? calcModel, scope, config);
			if (scope === "local") {
				const inTok = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
				const outTok = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
				return (
					(inTok / 1000) * resolution.rates.inputPer1k +
					(outTok / 1000) * resolution.rates.outputPer1k
				);
			}
			return costFromRates(resolution.rates, inputTokens, outputTokens) / USERTOKENS_PER_DOLLAR;
		},
	});

	// 7. Two-phase intercept
	async function interceptCall(
		originalFn: (...args: unknown[]) => unknown,
		thisArg: unknown,
		args: unknown[],
		// A1: which provider surface this call arrived through. "create" is the
		// default request/response (and create-stream) path. "stream-helper" is the
		// Anthropic messages.stream / beta.messages.stream convenience helper, whose
		// forwarded call returns a self-driving MessageStream we settle via
		// NON-CONSUMING emitter events instead of routing through
		// createGovernedStream (A1) — consuming its single-owner async iterator would
		// steal it from the caller. "openai-responses" (Task 3, A6) is the OpenAI
		// Responses API (create, stream and non-stream): it shares the create request/
		// response lifecycle and the generic createGovernedStream streaming path (A7),
		// but MUST NOT receive the chat.completions-only stream_options.include_usage
		// injection (A6) — the surface flag suppresses it below.
		surfaceKind: "create" | "stream-helper" | "openai-responses" = "create",
	): Promise<TrustedResponse<unknown>> {
		if (destroyed) {
			throw new Error("TrustedClient has been destroyed");
		}

		// AUD-462: Track in-flight calls so destroy() can wait for them
		inFlightCount++;

		try {
			// ── The ONE AsyncLocalStorage read for this call (ALS discipline) ──
			// Read HERE, at the top of the governor's synchronous entry point, while
			// the CALLER's async context is still the current one, and carried by
			// closure from here on. Every terminal below — the five MessageStream
			// emitter listeners, createGovernedStream's onComplete/onError, the
			// non-stream settle, the outer-catch void — runs LATER, on the SDK's SSE
			// pump tick or the consumer's `for await` tick, in a context this call
			// never owned. `getCurrentCostCenter()` there would silently answer with a
			// later call's scope, or with nothing, and would never fail loudly. Same
			// propagation shape as `rateResolution` ("price once", A3), for the same
			// reason. `budget/attribution.ts` documents the mechanics and its suite
			// pins the emitter-tick hazard as a negative case.
			const attribution = getCurrentCostCenter();
			const envelope = resolveEnvelope(attribution, config.parentUserId);
			// Spread into every audit record this call emits (A1: an attributed hold
			// must leave an attributed forensic trail on the settle AND the void
			// terminals). Empty when unattributed, so those records stay byte-identical
			// to what they were before envelopes — and one object decides for all of
			// them rather than a dozen conditionals drifting apart.
			const costCenterAudit: { costCenter?: string } =
				envelope === undefined ? {} : { costCenter: envelope.attribution.costCenter };

			// ── SESSION accounting tracks SESSION-WALLET money only ──
			// `budgetSpent` and `inFlightHoldTotal` describe the per-session HOLDING
			// wallet: they gate every unattributed call, they are what
			// `receipt.budgetRemaining` reports, and `persistSpendLedger` carries
			// `budgetSpent` across restarts as the `max(0, budget - budgetSpent)` seed of
			// that wallet. An ATTRIBUTED hold debits the `(parent, costCenter)` envelope
			// and never touches the holding wallet, so counting it here charges the
			// session for money it did not pay: unattributed calls are eventually
			// hard-denied against a wallet TigerBeetle would still have held against, and
			// the shortfall survives the restart. Fail-closed — over-deny, never loss —
			// but silent, which is why it is a bug and not a conservative default.
			// Set at the point the hold actually lands on the envelope, NOT from the
			// scope: a dry-run or engine-less attributed call places no envelope hold at
			// all, so the session numbers stay its only — and honest — accounting,
			// exactly as they are the only numbers its policy gate saw.
			let envelopeDebited = false;
			/** This call's SESSION-wallet share of an amount: all of it, or none. */
			const sessionShare = (amount: number): number => (envelopeDebited ? 0 : amount);
			/** AUD-457 persistence, skipped when the session total did not move. */
			const persistSessionSpend = async (): Promise<void> => {
				if (envelopeDebited) return;
				await persistSpendLedger(vaultBase, budgetSpent);
			};

			const params = (args[0] ?? {}) as Record<string, unknown>;
			const model = (params.model as string) ?? "unknown";
			// P3-PROVIDER-BLINDSPOT: normalize the prompt-bearing payload across
			// providers (Anthropic/OpenAI `messages` + `system`, Google `contents`) so
			// PII/injection scanning, token estimation, redaction, and pattern hashing
			// all see the actual prompt — not an empty `messages` array on Google calls.
			const promptParts = extractPromptParts(params, kind);

			// Per-call audit degradation flag (not sticky across calls)
			let callAuditDegraded = false;

			// P3-PII-REDACT-EGRESS: `forwardArgs` is what we actually send to the
			// provider. In redact mode it becomes a redacted deep clone so PII never
			// egresses; block mode throws before any egress. Default: forward verbatim.
			let forwardArgs = args;

			// a. Circuit breaker check
			const cb = breaker.get(kind);
			cb.allowRequest();

			// b. Estimate cost (before policy, so cost fields are available in context).
			// M2: rates resolve within the endpoint scope CAPTURED AT AUTHORIZE (A3) —
			// this one resolution prices the hold, both settlement paths, and the
			// receipt's meter provenance. unknownModelPolicy is enforced here, at
			// authorize time, before any PENDING hold (A5).
			const transferId = trustId("tx");
			const estimatedInputTokens = estimateInputTokens(promptParts);
			// F1: size the output estimate to the caller's ACTUAL cap. Responses callers
			// set `max_output_tokens`; chat.completions set `max_tokens`. Read the
			// Responses field first, then chat, then the 4096 default — each only when it
			// is a finite positive number (a 0/negative/NaN cap never shrinks the hold).
			const finitePositiveCap = (value: unknown): number | undefined =>
				typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
			const maxOutputTokens =
				finitePositiveCap(params.max_output_tokens) ?? finitePositiveCap(params.max_tokens) ?? 4096;
			const rateResolution = resolveRates(model, endpoint.class, config);
			enforceUnknownModelPolicy(model, rateResolution, config);
			const estimatedCost = costFromRates(
				rateResolution.rates,
				estimatedInputTokens,
				maxOutputTokens,
			);

			// AUD-453: Acquire mutex to serialise budget-check + PENDING hold.
			// This prevents concurrent calls from both passing the budget check and
			// overshooting the budget. The attributed-envelope preflight read is taken
			// INSIDE this lock (top of the try below), so a concurrent hold to the same
			// envelope cannot land between the read and the gate — see the note there.
			const releaseBudgetLock = await budgetMutex.acquire();

			// AUD-460: Track the proxy's transferId separately for settle/void
			let proxyTransferId: string | undefined;

			// AUD-468: Track whether the in-flight hold has been released, so
			// the catch handlers below can't double-decrement inFlightHoldTotal
			// (mirrors the AUD-465 guard used in governActionImpl).
			let holdActive = false;
			async function releaseInFlightHold(): Promise<void> {
				if (!holdActive) return;
				holdActive = false;
				const releaseLock = await budgetMutex.acquire();
				// `sessionShare` on BOTH sides: an attributed hold that skipped the
				// increment must skip the matching decrement, or `inFlightHoldTotal`
				// drifts negative and hands the session more headroom than its budget.
				inFlightHoldTotal -= sessionShare(estimatedCost);
				releaseLock();
			}

			try {
				// Attributed calls only: ONE batched read of the envelope's live
				// `available`, for the policy numbers below. Taken INSIDE the budget mutex
				// — the same lock that serialises the hold — and BEFORE the gate, so this
				// call's own hold lands only after the read and a CONCURRENT attributed
				// call to the SAME envelope cannot slip its hold between this read and the
				// gate. When the read was OUTSIDE the lock, two such calls both read the
				// pre-hold balance and the second bypassed a hard scarcity tier
				// (`budgetFractionRemaining` / `budgetRunwayHours`) the ledger cannot
				// enforce — TigerBeetle's atomic `debits_must_not_exceed_credits` rejects an
				// OVERSHOOT but never a fractional/runway tier. Serialising the read under
				// the hold's lock makes the gate describe the wallet the hold will debit,
				// exactly as the SESSION path already does (its check reads in-process
				// counters mutated under this same mutex). Cross-process (multi-governor)
				// concurrency still relies on TB atomicity — overshoot only — the same
				// limitation the session path has.
				// A2: a read that FAILS refuses the call outright — the finally below
				// releases the mutex and the ledger-unavailable error propagates before the
				// gate is evaluated or any hold is attempted.
				const envelopeRemaining = await preflightEnvelopeRemaining(engine, isDryRun, envelope);

				// c. Policy gate
				// P1-PARAM-SHADOW: caller `params` are spread FIRST so trusted
				// governance fields (tier/estimated_cost/budget_remaining/
				// budget_remaining_after) CANNOT be shadowed by request-supplied keys.
				// P1-BUDGET-PREFLIGHT: budget_remaining_after is the derived field the
				// single-field gate compares against zero to deny a single overshooting
				// call (the `block-budget-overshoot` default rule).
				//
				// ENVELOPE SCOPING: an ATTRIBUTED call is gated on THE ENVELOPE ITS HOLD
				// WILL DEBIT — `budget_remaining` is that envelope's live ledger
				// `available`, so `block-budget-exhausted` and `block-budget-overshoot`
				// become pre-spend guards on the cost center, ahead of the ledger's own
				// atomic rejection. The gate and the hold therefore always describe the
				// SAME wallet; the case where they could disagree (an unreadable
				// envelope) refused the call above rather than reaching here (A2).
				// `budget_remaining_after` is deliberately UNFLOORED on both paths: it
				// must be allowed to go NEGATIVE, because `block-budget-overshoot` is a
				// non-disableable hard `lt 0` deny and flooring it at zero would
				// structurally disarm that rule on every attributed call.
				// The session numbers still stand for a call that places no hold at all
				// (unattributed, dry-run, no engine) — unchanged, and honest, because
				// nothing debits an envelope on those paths either.
				const sessionRemaining = config.budget - budgetSpent - inFlightHoldTotal;
				const gateRemaining = envelopeRemaining ?? sessionRemaining;
				// P1-BUDGET-TIER-SHADOW: the budget tier fields are trusted-host input,
				// and asserting them here is what stops a request body from supplying its
				// own `budgetFractionRemaining` and satisfying a tier that guards frontier
				// spend. They are now REAL for an attributed call whose scope stated its
				// allocation (D4) — the case this path could not describe before — and
				// stay explicitly `undefined` for every other call, where the honest value
				// is ABSENT: an `exists`-guarded rule then simply does not match, and a
				// hard rule without that guard fires. Never an attacker's number.
				const tierFields =
					envelope !== undefined && envelopeRemaining !== undefined
						? envelopeTierFields(envelope.attribution, envelopeRemaining, Date.now())
						: { budgetFractionRemaining: undefined, budgetRunwayHours: undefined };
				const policyResult = evaluatePolicy(policyRules, {
					...params,
					model,
					tier: config.tier,
					estimated_cost: estimatedCost,
					budget_remaining: gateRemaining,
					budget_remaining_after: gateRemaining - estimatedCost,
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
					throw new PolicyDeniedError(
						reason,
						derivePolicyHint(policyResult, envelope !== undefined),
					);
				}

				// d. PII check + redact-egress
				if (config.pii !== "off") {
					const piiResult = detectPII(promptParts);
					if (piiResult.found && config.pii === "block") {
						// block mode: throw BEFORE any egress.
						throw new PolicyDeniedError(
							`PII detected: ${piiResult.types.join(", ")}`,
							'PII enforcement blocked this call. Use { pii: "warn" } to log instead, or { pii: "redact" } to strip PII before egress.',
						);
					}
					if (config.pii === "redact" && piiResult.found) {
						// redact mode: forward a redacted DEEP CLONE so PII never egresses.
						// redactPII is pure — the caller's original object is never mutated.
						const redactedBody = redactPII(params).data as Record<string, unknown>;
						forwardArgs = [redactedBody, ...args.slice(1)];
					}
					// "warn" mode: continue, no transform (audit copy is redacted later).
				}

				// d2. Injection detection
				if (config.injection !== "off") {
					const injectionResult = detectInjection(promptParts);
					if (injectionResult.detected) {
						if (config.injection === "block") {
							throw new PolicyDeniedError(
								`Prompt injection detected: ${injectionResult.patterns.join(", ")}`,
								'Injection enforcement blocked this call. Use { injection: "warn" } to log instead of block.',
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
									...costCenterAudit,
								},
							})
							.catch(() => {});
						// Feed the anomaly detector so cascading injections trip the breaker.
						anomalyDetector.observe({
							kind: "injection",
							patterns: injectionResult.patterns,
						});
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
							// Attributed → the envelope pays. Unattributed → the key is
							// OMITTED, not passed as undefined, so the engine's default
							// (the session holding wallet) is reached by exactly the path
							// it was before envelopes existed.
							...(envelope !== undefined ? { debitAccountId: envelope.accountId } : {}),
						});
					} catch (holdErr) {
						// P1-LEDGER-ENFORCE: an over-budget reservation is rejected
						// atomically by the ledger. Surface it as a hard budget DENY —
						// NOT as "ledger unavailable" (which would misreport a budget cap
						// as an outage). This throws out of the budget-section try, runs
						// its finally (releases the budget lock), and propagates without
						// a hold to void — exactly mirroring the policy-deny control flow.
						if (holdErr instanceof InsufficientBalanceError) {
							// An attributed rejection is re-presented in the caller's terms:
							// the `parent::costCenter` label instead of a derived account id,
							// and the remedy that actually funds an envelope.
							throw envelope === undefined
								? holdErr
								: asEnvelopeBalanceError(holdErr, envelope.label);
						}
						// Genuine ledger outage — do NOT forward to provider.
						throw new LedgerUnavailableError(
							holdErr instanceof Error ? holdErr.message : String(holdErr),
						);
					}
					// The hold landed. Record WHICH wallet it debited — every session
					// counter below is conditioned on this one answer.
					envelopeDebited = envelope !== undefined;
				}

				// Track in-flight hold cost for accurate budget calculations — the
				// SESSION wallet's share of it, which is nothing once the envelope paid.
				inFlightHoldTotal += sessionShare(estimatedCost);
				holdActive = true; // AUD-468: arm the guard
			} finally {
				// AUD-453: Release lock after budget check + hold are complete
				releaseBudgetLock();
			}

			// e0. M2 usage injection (A4): for local openai streams, opt in to the
			// server's final usage chunk (Ollama emits /v1 streaming usage ONLY when
			// stream_options.include_usage is set). The merge preserves the caller's
			// other stream_options fields and respects an explicit include_usage.
			// The resulting usage chunk is FORWARDED to the consumer unmodified
			// (transparent middleware). Task 3/A6: the OpenAI Responses API is EXCLUDED
			// — stream_options.include_usage is chat.completions-only; Responses carries
			// usage automatically on the terminal `response.completed` event, and
			// injecting the param would be an unknown field on the Responses request.
			let preInjectionArgs: unknown[] | null = null;
			if (
				kind === "openai" &&
				surfaceKind !== "openai-responses" &&
				endpoint.class === "local" &&
				config.local.injectUsageOptions
			) {
				const injected = withInjectedUsageOptions(forwardArgs);
				if (injected != null) {
					preInjectionArgs = forwardArgs;
					forwardArgs = injected;
				}
			}

			// e. Forward to original SDK. P3-PII-REDACT-EGRESS: forwardArgs is the
			// redacted clone in redact mode, or the original args otherwise.
			let settled = true;
			// D4: set only when the engine capped the post at the reserved hold. The
			// stream and non-stream terminals are mutually exclusive for one hold, so
			// they share this the same way they share `settled`.
			let postedCost: number | undefined;
			// D4 event-order buffer for the STREAM terminal: the truncation is learned at
			// POST time but the `settlement_shortfall` event may only be appended AFTER
			// this call's `llm_call`, so it is parked here and drained below.
			let streamShortfall: { posted: number; shortfall: number } | undefined;

			// A2: one idempotent finalize gate per hold. The FIRST terminal signal for
			// this authorization wins and claims the single ledger outcome (settle XOR
			// void); every later signal returns false and MUST NOT mutate the ledger.
			// Every terminal path routes through it: the non-stream settle + its
			// outer-catch void, the stream onComplete/onError closures below, and
			// (Tasks 2/3) any new surface's emitter/iterator/error/abort listeners. A
			// duplicate terminal signal can neither double-settle nor double-void.
			let finalizeState: "pending" | "settled" | "voided" = "pending";
			function finalizeOnce(outcome: "settle" | "void"): boolean {
				if (finalizeState !== "pending") return false;
				finalizeState = outcome === "settle" ? "settled" : "voided";
				return true;
			}

			// Estimate-priced stream receipt (settled:false). Serves as the initial
			// handle returned to the caller AND the idempotent fallback a duplicate
			// stream terminal returns after the hold was already resolved.
			const buildEstimatedStreamReceipt = (): TrustReceipt => {
				const streamEstimateHash = createHash("sha256").update(transferId).digest("hex");
				return {
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
					// M2: authorize-time scope, already fixed for the eventual settle (A3).
					endpoint: { class: endpoint.class, runtime: endpoint.runtime },
					meter: {
						costBasis: rateResolution.costBasis,
						rateSource: rateResolution.rateSource,
					},
					...(callAuditDegraded ? { auditDegraded: true as const } : {}),
					// AUD-456: Flag proxy stub receipts
					...(proxyConn != null ? { proxyStub: true as const } : {}),
				};
			};

			// Terminal stream settlement (A2 settle branch). Idempotent via
			// finalizeOnce: budget commit + ledger POST + llm_call audit happen AT MOST
			// ONCE per hold. Tasks 2/3 reuse this verbatim — the
			// Anthropic MessageStream 'finalMessage' listener and any new stream surface
			// call it with a StreamCompletion built from final usage. Does NOT touch
			// inFlightStreamCount — the caller (createGovernedStream wiring, or a new
			// surface's listener) owns that counter.
			let streamSettledReceipt: TrustReceipt | undefined;
			const finalizeStreamSettle = async (completion: StreamCompletion): Promise<TrustReceipt> => {
				if (!finalizeOnce("settle")) {
					// A duplicate terminal (e.g. 'finalMessage' after 'end', or a settle
					// racing an abort-void): never mutate the ledger again.
					return streamSettledReceipt ?? buildEstimatedStreamReceipt();
				}

				// Determine cost: use provider usage if reported, else fall back to
				// estimate. A3: priced with the rate resolution captured at authorize;
				// A11: costFromRates floors at 1 even for 0/0 usage.
				let streamCost: number;
				let usageSource: "provider" | "estimated";
				if (completion.usageReported) {
					streamCost = costFromRates(
						rateResolution.rates,
						completion.usage.inputTokens,
						completion.usage.outputTokens,
					);
					usageSource = "provider";
				} else {
					streamCost = estimatedCost;
					usageSource = "estimated";
				}

				// Release in-flight hold and commit budget under mutex.
				// AUD-468: holdActive guard prevents double-release.
				if (holdActive) {
					holdActive = false;
					const releaseLock = await budgetMutex.acquire();
					inFlightHoldTotal -= sessionShare(estimatedCost);
					budgetSpent += sessionShare(streamCost);
					releaseLock();
				} else {
					// Hold already released — still need to record the spend.
					const releaseLock = await budgetMutex.acquire();
					budgetSpent += sessionShare(streamCost);
					releaseLock();
				}
				// AUD-457: Persist cumulative spend to disk (session spend only — an
				// envelope's burn is the ledger's to report, and writing it here would
				// shrink the next run's holding-wallet seed by money it never paid).
				await persistSessionSpend();
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
									...costCenterAudit,
								},
							})
							.catch(() => {
								callAuditDegraded = true;
							});
					}
				} else if (engine != null && !isDryRun) {
					try {
						// Post the ACTUAL consumed cost (RECON #3), capped by the engine
						// at the reserved hold; a truncation comes back as `shortfall`.
						const postResult = await engine.postPendingSpend(transferId, streamCost);
						if (postResult != null && postResult.shortfall > 0) {
							postedCost = postResult.posted;
							// EVENT ORDER: captured here, APPENDED after `llm_call` below.
							// `verifyTransaction` resolves a transfer by the FIRST chain event
							// whose `data.transferId` matches, so a shortfall written ahead of
							// its `llm_call` would render this settled call as PENDING with no
							// cost. The correction must annotate the settlement, never precede it.
							streamShortfall = { posted: postResult.posted, shortfall: postResult.shortfall };
						}
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
									...costCenterAudit,
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
						// M2: metering provenance mirrors the receipt (A3 authorize-time scope).
						endpointClass: endpoint.class,
						costBasis: rateResolution.costBasis,
						rateSource: rateResolution.rateSource,
						...costCenterAudit,
					};
					if (config.pii === "warn" || config.pii === "redact") {
						const piiResult = redactPII(promptParts);
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

				// D4: the truncation correction, appended AFTER the `llm_call` it
				// annotates (see the capture at the POST above). Still advisory — a chain
				// that cannot take it degrades the receipt and NEVER unwinds a settlement
				// that already committed.
				if (streamShortfall !== undefined) {
					await audit
						.appendEvent({
							kind: "settlement_shortfall",
							actor: "local",
							data: {
								model,
								actual: streamCost,
								posted: streamShortfall.posted,
								shortfall: streamShortfall.shortfall,
								transferId,
								...costCenterAudit,
							},
						})
						.catch(() => {
							callAuditDegraded = true;
						});
				}

				// P3-AUDIT-FAILCLOSED (streaming): chunks were already delivered, so the
				// strongest post-delivery signal is to REJECT `.receipt`. The caller's
				// finally decrements inFlightStreamCount so destroy() never blocks.
				if (config.audit.failClosed && (callAuditDegraded || audit.isDegraded())) {
					throw new AuditDegradedError(
						`audit unavailable (writeFailures=${audit.getWriteFailures()}) for ${transferId}`,
					);
				}

				// D7: the envelope snapshot is read AFTER the POST, so it reports what
				// the cost center actually holds now rather than in-memory arithmetic
				// that drifts the moment another process spends from the same envelope.
				// It observes; it never decides. A read that fails omits the block —
				// this runs after the money committed, and a report must never unwind
				// or re-decide a settlement. It is a POST-SETTLEMENT observation, so it
				// is attached ONLY when `settled` — an ambiguous settlement (POST
				// rejected) may still be pending and be posted or voided later, making
				// the balance transient; we do not even read the ledger for it then.
				const streamBudget = settled
					? envelopeReceiptBudget(
							envelope,
							await snapshotEnvelopeRemaining(engine, isDryRun, envelope),
						)
					: undefined;

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
					// M2 provenance (A6: computeMs omitted — no compute-time source here).
					endpoint: { class: endpoint.class, runtime: endpoint.runtime },
					meter: {
						costBasis: rateResolution.costBasis,
						rateSource: rateResolution.rateSource,
					},
					...(postedCost !== undefined ? { postedCost } : {}),
					...(streamBudget !== undefined ? { budget: streamBudget } : {}),
					...(callAuditDegraded ? { auditDegraded: true as const } : {}),
					// AUD-456: Flag proxy stub receipts
					...(proxyConn != null ? { proxyStub: true as const } : {}),
				};
				streamSettledReceipt = streamReceipt;
				return streamReceipt;
			};

			// Terminal stream void (A2 void branch). Idempotent via finalizeOnce:
			// releases the hold and voids the ledger AT MOST ONCE. Tasks 2/3 reuse this
			// for the Anthropic MessageStream 'error'/'abort' listeners and any new
			// stream surface's error path. Does NOT touch inFlightStreamCount.
			const finalizeStreamVoid = async (
				error: unknown,
				partial: StreamCompletion,
			): Promise<void> => {
				if (!finalizeOnce("void")) return;

				// Release in-flight hold under mutex (AUD-468: guarded).
				await releaseInFlightHold();

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
							...costCenterAudit,
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
			};

			// A1: settle an Anthropic MessageStream (messages.stream /
			// beta.messages.stream) via its MULTICAST event emitter, never by consuming
			// its single-owner async iterator (that belongs to the caller). The stream
			// self-drives, so finalMessage/error/abort fire even if the caller never
			// consumes (A4); the TigerBeetle PENDING 300s timeout (see destroy() and
			// createPendingTransfer) is the last-resort backstop for a hold whose
			// terminal event never arrives. finalizeOnce makes the six-mode consumption
			// matrix safe: settle XOR void, exactly one ledger mutation.
			const settleViaMessageStream = (streamObj: unknown): TrustedResponse<unknown> => {
				// The initial handle: estimate-priced, settled:false — identical to the
				// generic stream path. The caller reads the real receipt off `.receipt`.
				const estimatedReceipt = buildEstimatedStreamReceipt();

				const emitter =
					streamObj != null && typeof streamObj === "object"
						? (streamObj as {
								on?: (event: string, listener: (...a: unknown[]) => void) => unknown;
								abort?: () => void;
							})
						: null;

				// This closure OWNS inFlightStreamCount for the stream's lifetime; the
				// finalize* gates never touch it. Release it EXACTLY ONCE no matter how
				// many terminal events fire (finalMessage-then-abort race, error-after-
				// end, …) so destroy() never blocks and the counter never drifts.
				inFlightStreamCount++;
				let streamCountReleased = false;
				const releaseStreamCount = (): void => {
					if (streamCountReleased) return;
					streamCountReleased = true;
					inFlightStreamCount--;
				};

				// `.receipt`: resolves with the settled receipt, rejects on a genuine
				// stream error / failClosed. Built BEFORE the feature-detect branch so BOTH
				// the emitter path and the non-emitter fallback expose a live `.receipt` the
				// caller can await for the settled outcome. F8: governance never SILENTLY
				// swallows a stream failure — a consumer who awaits `.receipt` always sees
				// the error (the pre-attached catch below is a SEPARATE branch: promises are
				// multicast, so it silences the unhandled-rejection ONLY for a fire-and-forget
				// consumer that never awaits `.receipt`, never registers an error handler, and
				// never calls done()/finalMessage() — that narrow gap is documented).
				let receiptResolve!: (r: TrustReceipt) => void;
				let receiptReject!: (e: unknown) => void;
				const receiptPromise = new Promise<TrustReceipt>((res, rej) => {
					receiptResolve = res;
					receiptReject = rej;
				});
				receiptPromise.catch(() => {});

				// Expose `.receipt` on the returned stream object (best-effort — a frozen or
				// non-object stream simply omits it; the terminal events still settle
				// governance).
				const attachReceipt = (): void => {
					if (streamObj == null || typeof streamObj !== "object") return;
					try {
						Object.assign(streamObj as object, { receipt: receiptPromise });
					} catch {
						// non-extensible target — skip
					}
				};

				// A3: a helper that connected is a billable SUCCESS. If the forwarded
				// object is not an event-emitter MessageStream (feature-detect miss / an
				// SDK too old to return one), we cannot tap emitter events — settle at
				// ESTIMATE now so the hold never dangles, resolve `.receipt` from that
				// background settle (mirroring the finalMessage path), and hand the object
				// back raw.
				if (emitter == null || typeof emitter.on !== "function") {
					finalizeStreamSettle({
						usage: { inputTokens: 0, outputTokens: 0 },
						chunksDelivered: 0,
						usageReported: false,
					})
						.then(receiptResolve, receiptReject)
						.finally(releaseStreamCount);
					attachReceipt();
					return { response: streamObj, receipt: estimatedReceipt };
				}

				// Non-consuming chunk accounting: streamEvent is multicast, so tapping it
				// does not steal the caller's iterator. Mirrors the wrapStream tap so
				// partial-void audits and a usage-less finalMessage both carry real
				// numbers, and (best-effort, A1) trips the shared anomaly detector.
				let chunksDelivered = 0;
				let accInput = 0;
				let accOutput = 0;
				let accUsageReported = false;
				// R1: set TRUE before governance calls emitter.abort() on an anomaly trip,
				// so the 'abort' handler can distinguish a governance cutoff (void + breaker
				// failure) from a genuine consumer abort (F9 settle-partial).
				let anomalyAbort = false;
				const partial = (): StreamCompletion => ({
					usage: { inputTokens: accInput, outputTokens: accOutput },
					chunksDelivered,
					usageReported: accUsageReported,
				});

				emitter.on("streamEvent", (event: unknown) => {
					chunksDelivered++;
					const tokens = extractAnthropicStreamUsage(event);
					let deltaTokens = 0;
					if (tokens.inputTokens > accInput) {
						deltaTokens += tokens.inputTokens - accInput;
						accInput = tokens.inputTokens;
						accUsageReported = true;
					}
					if (tokens.outputTokens > accOutput) {
						deltaTokens += tokens.outputTokens - accOutput;
						accOutput = tokens.outputTokens;
						accUsageReported = true;
					}
					if (!config.anomaly.enabled) return;
					anomalyDetector.observe({
						kind: "chunk",
						deltaTokens,
						cumulativeInputTokens: accInput,
						cumulativeOutputTokens: accOutput,
						// M2: stamp the per-call scope so the SHARED detector prices this
						// event with the same scoped rates as settlement.
						model,
						endpointClass: endpoint.class,
					});
					const verdict = anomalyDetector.check();
					if (verdict.tripped) {
						audit
							.appendEvent({
								kind: "anomaly_detected",
								actor: "local",
								data: {
									anomalyKind: verdict.kind,
									message: verdict.message,
									metric: verdict.metric,
									threshold: verdict.threshold,
									model,
									transferId,
									provider: kind,
									...costCenterAudit,
								},
							})
							.catch(() => {});
						// A1 best-effort mid-stream cutoff (full parity deferred). R1: flag
						// this as a GOVERNANCE abort BEFORE aborting so the 'abort' handler
						// VOIDs + records a breaker failure — same ledger + breaker outcome as
						// the generic createGovernedStream anomaly path (which throws
						// AnomalyError → finalizeStreamVoid). finalizeOnce keeps it safe if a
						// finalMessage is already in flight.
						anomalyAbort = true;
						if (typeof emitter.abort === "function") emitter.abort();
					}
				});

				emitter.on("finalMessage", (msg: unknown) => {
					// A3: usage-extraction failure after a successful stream settles at
					// ESTIMATE, never voids. F3: MERGE per-field — a finalMessage that
					// carries only one field (or null for the other) keeps the counter
					// accumulated from streamEvent for the MISSING field, rather than
					// zeroing it. Reported when EITHER source carried a real number;
					// otherwise settle on the estimate.
					const finalUsage = readFinalMessageUsage(msg);
					const usageReported = finalUsage.reported || accUsageReported;
					const completion: StreamCompletion = usageReported
						? {
								usage: {
									inputTokens: finalUsage.inputTokens ?? accInput,
									outputTokens: finalUsage.outputTokens ?? accOutput,
								},
								chunksDelivered,
								usageReported: true,
							}
						: {
								usage: { inputTokens: 0, outputTokens: 0 },
								chunksDelivered,
								usageReported: false,
							};
					finalizeStreamSettle(completion)
						.then(receiptResolve, receiptReject)
						.finally(releaseStreamCount);
				});

				const voidVia = (error: unknown): void => {
					// finalizeStreamVoid claims finalizeOnce("void") SYNCHRONOUSLY at its
					// top, so finalizeState reflects the outcome the moment it returns.
					finalizeStreamVoid(error, partial()).finally(releaseStreamCount);
					// Only surface the void on `.receipt` when THIS terminal actually won
					// the gate. A late abort after a settle is a ledger no-op (finalizeOnce
					// already granted "settle") — it must not reject a receipt the settle
					// path will resolve, even though that settle's async is still in flight.
					if (finalizeState === "voided") receiptReject(error);
				};

				// F9: a consumer-initiated abort surfaces as the SDK's 'abort' event
				// (APIUserAbortError), distinct from the provider-failure 'error' event. It
				// is an early EXIT, not a failure: settle at the PARTIAL accumulated usage
				// (mirroring the generic governed-stream break-out-of-for-await path) instead
				// of voiding, and never record a circuit-breaker failure — a caller who
				// aborts N streams must not trip the breaker. finalizeStreamSettle records
				// success. The `pending` guard makes a LATE abort after a real terminal a
				// clean no-op: without it the no-op settle would resolve `.receipt` with a
				// stale estimate, racing (and beating) the winning terminal's async settle.
				const settlePartialVia = (): void => {
					if (finalizeState !== "pending") return;
					finalizeStreamSettle(partial())
						.then(receiptResolve, receiptReject)
						.finally(releaseStreamCount);
				};

				emitter.on("error", (err: unknown) => voidVia(err ?? new Error("stream error")));
				// R1: a GOVERNANCE anomaly cutoff (anomalyAbort) is a provider-side FAILURE —
				// void the hold + record a breaker failure, matching the generic path. A
				// genuine consumer abort is an early exit — settle the partial usage (F9).
				emitter.on("abort", (err: unknown) => {
					if (anomalyAbort) {
						voidVia(err ?? new Error("anomaly cutoff"));
					} else {
						settlePartialVia();
					}
				});

				// F6: the real MessageStream emits NO 'finalMessage' on a clean SSE close
				// that lacks a message_stop (receivedMessages stays empty → _emitFinal emits
				// nothing) — only 'end' fires. Without an 'end' catch-all the PENDING hold
				// would dangle until the TigerBeetle 300s timeout. When 'end' is the SOLE
				// terminal (gate still pending) settle at ESTIMATE so the hold releases; on
				// every other terminal ('end' always fires last, after the winning settle/
				// void) the guard makes this a no-op that must NOT touch `.receipt`.
				emitter.on("end", () => {
					if (finalizeState !== "pending") return;
					finalizeStreamSettle({
						usage: { inputTokens: 0, outputTokens: 0 },
						chunksDelivered,
						usageReported: false,
					})
						.then(receiptResolve, receiptReject)
						.finally(releaseStreamCount);
				});

				attachReceipt();

				return { response: streamObj, receipt: estimatedReceipt };
			};

			try {
				let response: unknown;
				try {
					response = await (originalFn as (...a: unknown[]) => unknown).apply(thisArg, forwardArgs);
				} catch (callErr) {
					// A4: some OpenAI-compat servers reject unknown stream_options. When
					// WE injected them AND the error plausibly says so (message/HTTP-status
					// heuristic), retry ONCE without the injection; the retried stream
					// simply settles on the estimate if no usage tail arrives (A7). Any
					// other error — transient network failures, unrelated 5xx — rethrows
					// the ORIGINAL immediately rather than duplicating compute and masking
					// the root cause.
					if (preInjectionArgs == null || !looksLikeStreamOptionsRejection(callErr)) {
						throw callErr;
					}
					response = await (originalFn as (...a: unknown[]) => unknown).apply(
						thisArg,
						preInjectionArgs,
					);
				}

				// A1: Anthropic messages.stream / beta.messages.stream helper. The
				// forwarded call returned a MessageStream (event-emitter + AsyncIterable)
				// owned by the CALLER. Settle via its multicast emitter — this branch
				// runs BEFORE the generic Symbol.asyncIterator path because a
				// MessageStream matches that check too but must NEVER be routed through
				// createGovernedStream (that would steal the caller's single async
				// iterator, A1). A synchronous throw from stream() (bad params, connect
				// failure before the object is returned) never reaches here — it lands in
				// the outer catch, which voids the still-PENDING hold once.
				if (surfaceKind === "stream-helper") {
					return settleViaMessageStream(response);
				}

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
						async (completion: StreamCompletion): Promise<TrustReceipt> => {
							// A2: route the createGovernedStream terminal through the shared
							// idempotent settle gate. The finally decrements the stream counter on
							// BOTH the receipt return and the failClosed throw.
							try {
								return await finalizeStreamSettle(completion);
							} finally {
								inFlightStreamCount--;
							}
						},
						async (error: unknown, partial: StreamCompletion) => {
							// A2: route the createGovernedStream error terminal through the shared
							// idempotent void gate. The finally decrements the stream counter exactly
							// as the success path does.
							try {
								await finalizeStreamVoid(error, partial);
							} finally {
								inFlightStreamCount--;
							}
						},
						// onChunk: streaming anomaly detector hook. Observe each chunk;
						// if a signal trips, throw AnomalyError to abort the stream.
						// The thrown error propagates through wrapStream's onError above
						// → existing VOID flow runs → upstream caller sees AnomalyError.
						(obs: ChunkObservation) => {
							if (!config.anomaly.enabled) return;
							anomalyDetector.observe({
								kind: "chunk",
								deltaTokens: obs.deltaTokens,
								cumulativeInputTokens: obs.cumulativeInputTokens,
								cumulativeOutputTokens: obs.cumulativeOutputTokens,
								// M2: stamp the per-call scope so the SHARED detector prices
								// this event with the same scoped rates as settlement.
								model,
								endpointClass: endpoint.class,
							});
							const verdict = anomalyDetector.check();
							if (verdict.tripped) {
								// Append hash-chained anomaly_detected audit event.
								// Best-effort: do not block the abort if audit fails.
								audit
									.appendEvent({
										kind: "anomaly_detected",
										actor: "local",
										data: {
											anomalyKind: verdict.kind,
											message: verdict.message,
											metric: verdict.metric,
											threshold: verdict.threshold,
											model,
											transferId,
											provider: kind,
											...costCenterAudit,
										},
									})
									.catch(() => {});
								throw new AnomalyError(
									verdict.kind,
									verdict.message,
									verdict.metric,
									verdict.threshold,
								);
							}
						},
					);

					// AUD-454: For streaming responses, settlement has NOT happened yet.
					// The initial handle carries settled:false at the estimate — the real
					// settlement status lands on governedStream.receipt after consumption.
					const estimatedReceipt = buildEstimatedStreamReceipt();

					inFlightStreamCount++;
					return { response: governedStream, receipt: estimatedReceipt };
				}

				// f. Compute actual cost from response usage. A3: priced with the rate
				// resolution captured at authorize. costFromRates clamps NaN/negative
				// counts (A7) and floors at 1 even for 0/0 provider usage (A11).
				let actualCost = estimatedCost;
				let usageSource: "provider" | "estimated" = "estimated";
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
						actualCost = costFromRates(rateResolution.rates, inputTokens, outputTokens);
						usageSource = "provider";
					}
				}

				// h. Audit the llm_call FIRST (P3-AUDIT-FAILCLOSED). The settlement-
				// defining event is written BEFORE the irreversible budget commit and
				// POST, so a fail-closed deployment never settles an unaudited spend.
				// The event carries settled:true optimistically; a later POST failure
				// appends the settlement_ambiguous correction and flips receipt.settled.
				const syntheticHash = createHash("sha256").update(transferId).digest("hex");
				let auditHash = syntheticHash;
				let llmAuditFailed = false;
				try {
					const auditData: Record<string, unknown> = {
						model,
						cost: actualCost,
						settled: true,
						transferId,
						usageSource,
						// M2: metering provenance mirrors the receipt (A3 authorize-time scope).
						endpointClass: endpoint.class,
						costBasis: rateResolution.costBasis,
						rateSource: rateResolution.rateSource,
						...costCenterAudit,
					};
					if (config.pii === "warn" || config.pii === "redact") {
						const piiResult = redactPII(promptParts);
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
					// Failure mode 15.3: Audit degraded — mark + warn.
					llmAuditFailed = true;
					callAuditDegraded = true;
					process.stderr.write(
						`[usertrust] audit degraded: failed to write llm_call event for ${transferId}\n`,
					);
				}

				// P3-AUDIT-FAILCLOSED: under failClosed a failed llm_call audit ABORTS the
				// call before any money moves. Throwing here routes to the outer catch,
				// which VOIDs the hold (once) and never POSTs — the internal ledger holds
				// no unaudited spend, and the caller is told the call failed.
				if (config.audit.failClosed && llmAuditFailed) {
					throw new AuditDegradedError(
						`audit unavailable (writeFailures=${audit.getWriteFailures()}) for ${transferId}`,
					);
				}

				// A2: claim the single settle outcome for this hold BEFORE money moves.
				// Always granted here (no other terminal path runs for a non-stream call);
				// the claim exists so a post-commit throw routes to the outer catch WITHOUT
				// double-voiding an already-settled hold.
				finalizeOnce("settle");

				// Release in-flight hold and commit budget under mutex — money moves only
				// AFTER the spend is audited. AUD-468: mark hold released before the commit
				// so a later throw cannot double-decrement inFlightHoldTotal via the catch.
				if (holdActive) {
					holdActive = false;
					const releaseLock = await budgetMutex.acquire();
					inFlightHoldTotal -= sessionShare(estimatedCost);
					budgetSpent += sessionShare(actualCost);
					releaseLock();
				}
				// AUD-457: Persist cumulative spend to disk (session spend only).
				await persistSessionSpend();

				// g. Circuit breaker: record success
				cb.recordSuccess();

				// g2. Failure mode 15.1: POST fails after LLM success
				if (engine != null && !isDryRun) {
					try {
						// Post the ACTUAL consumed cost (RECON #3), capped by the engine
						// at the reserved hold; a truncation comes back as `shortfall`.
						const postResult = await engine.postPendingSpend(transferId, actualCost);
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
										transferId,
										...costCenterAudit,
									},
								})
								.catch(() => {
									callAuditDegraded = true;
								});
						}
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
									...costCenterAudit,
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
									...costCenterAudit,
								},
							})
							.catch(() => {
								callAuditDegraded = true;
							});
					}
				}

				// P3-AUDIT-FAILCLOSED belt-and-suspenders: if ANY audit write during this
				// call degraded the writer (including best-effort advisory writes), refuse
				// to report success under failClosed so the caller cannot silently proceed.
				if (config.audit.failClosed && (callAuditDegraded || audit.isDegraded())) {
					throw new AuditDegradedError(
						`audit unavailable (writeFailures=${audit.getWriteFailures()}) for ${transferId}`,
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
							data: { model, cost: actualCost, settled, transferId, ...costCenterAudit },
						},
						config.audit.indexLimit,
					);
				}

				// i2. Pattern memory
				if (config.patterns.enabled) {
					const promptHash = createHash("sha256").update(JSON.stringify(promptParts)).digest("hex");
					await recordPattern({
						promptHash,
						model,
						cost: actualCost,
						success: true,
					}).catch(() => {});
				}

				const budgetRemaining = config.budget - budgetSpent - inFlightHoldTotal;
				// D7 (see the streaming settle above for the full rationale): a
				// post-settle observation of the envelope, omitted when it cannot be read
				// AND when the settlement is ambiguous — a settled:false receipt must not
				// carry a snapshot the contract defines as post-settlement.
				const settledBudget = settled
					? envelopeReceiptBudget(
							envelope,
							await snapshotEnvelopeRemaining(engine, isDryRun, envelope),
						)
					: undefined;

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
					usageSource,
					// M2 provenance (A6: computeMs omitted — no compute-time source here).
					endpoint: { class: endpoint.class, runtime: endpoint.runtime },
					meter: {
						costBasis: rateResolution.costBasis,
						rateSource: rateResolution.rateSource,
					},
					...(postedCost !== undefined ? { postedCost } : {}),
					...(settledBudget !== undefined ? { budget: settledBudget } : {}),
					...(callAuditDegraded ? { auditDegraded: true as const } : {}),
					// AUD-456: Flag proxy stub receipts
					...(proxyConn != null ? { proxyStub: true as const } : {}),
				};

				return { response, receipt };
			} catch (err) {
				// Release in-flight hold under mutex (non-streaming failure)
				// AUD-468: Use the guarded release — this is a no-op if the
				// success path already released the hold, preventing
				// inFlightHoldTotal from drifting negative on post-commit throws.
				await releaseInFlightHold();

				// j. Circuit breaker: record failure
				cb.recordFailure();

				// j2/j3. VOID the pending hold — but ONLY if this hold has not already
				// claimed a settle outcome (A2). A pre-commit throw (provider/transport
				// error, PII/policy deny, failClosed-before-commit) reaches here with the
				// hold still PENDING → finalizeOnce("void") is granted and the ledger is
				// voided. A post-commit throw (failClosed belt-and-suspenders) already
				// settled the spend → the claim is refused and no spurious void is issued
				// against an already-posted transfer.
				if (finalizeOnce("void")) {
					// Failure mode 15.2: LLM fails — VOID the pending hold
					if (engine != null && !isDryRun) {
						try {
							await engine.voidPendingSpend(transferId);
						} catch {
							// Best-effort void — log and continue
						}
					}

					// Proxy void
					if (proxyConn != null && !isDryRun) {
						try {
							// AUD-460: Use the proxy's transferId for void
							await proxyConn.void(proxyTransferId ?? transferId);
						} catch {
							// Best-effort void
						}
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
							...costCenterAudit,
						},
					})
					.catch(() => {
						callAuditDegraded = true;
					});

				// l. Pattern memory: record failure
				if (config.patterns.enabled) {
					const promptHash = createHash("sha256").update(JSON.stringify(promptParts)).digest("hex");
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
			// governAction is its OWN governor entry point — a caller invokes it
			// directly, synchronously, from inside its own `withCostCenter` scope — so
			// it takes its own single ALS read here and carries the capture through
			// its terminals, exactly as `interceptCall` does. See the ALS-discipline
			// note there for why a later read would be wrong.
			const attribution = getCurrentCostCenter();
			const envelope = resolveEnvelope(attribution, config.parentUserId);
			const costCenterAudit: { costCenter?: string } =
				envelope === undefined ? {} : { costCenter: envelope.attribution.costCenter };

			// Session accounting is SESSION-WALLET-only here for exactly the reasons the
			// LLM path documents at length — an attributed action's hold debits the
			// envelope, so charging the session for it over-denies later unattributed
			// traffic and persists that shortfall across restarts.
			let envelopeDebited = false;
			const sessionShare = (amount: number): number => (envelopeDebited ? 0 : amount);
			const persistSessionSpend = async (): Promise<void> => {
				if (envelopeDebited) return;
				await persistSpendLedger(vaultBase, budgetSpent);
			};

			const actor = action.actor ?? "local";
			const transferId = trustId("tx");

			// a. Circuit breaker check (keyed by action kind)
			const cb = breaker.get(action.kind as unknown as LLMClientKind);
			cb.allowRequest();

			// b. Acquire mutex for budget atomicity. The attributed-envelope preflight
			// read is taken INSIDE this lock (top of the try below) so a concurrent hold
			// to the same envelope cannot land between the read and the gate — see there.
			const releaseBudgetLock = await budgetMutex.acquire();
			let proxyTransferId: string | undefined;

			try {
				// Attributed only: ONE batched read of the envelope's live `available`,
				// taken INSIDE the budget mutex and BEFORE the gate, so this action's own
				// hold lands only after the read and a CONCURRENT attributed action on the
				// SAME envelope cannot slip its hold between the read and the gate. Outside
				// the lock, both would read the pre-hold balance and the second would bypass
				// a hard scarcity tier (`budgetFractionRemaining` / `budgetRunwayHours`) the
				// ledger cannot enforce — TB rejects an OVERSHOOT, never a fractional/runway
				// tier. Same in-mutex serialisation the SESSION path already has;
				// cross-process concurrency still relies on TB atomicity (overshoot only).
				// A2: a read that FAILS refuses the action — the finally below releases the
				// mutex and the error propagates before the gate or any hold.
				const envelopeRemaining = await preflightEnvelopeRemaining(engine, isDryRun, envelope);

				// c. Policy gate — action fields available in context
				// AUD-467: Caller params spread FIRST so governance fields cannot be shadowed.
				// P1-BUDGET-PREFLIGHT: budget_remaining_after is the derived field the
				// block-budget-overshoot default rule compares against zero (a HARD rule
				// that fails CLOSED if the governor omits it — so it MUST be supplied),
				// and it is UNFLOORED here for the same reason as on the LLM path: it has
				// to be able to go negative or that rule can never fire.
				// ENVELOPE SCOPING: identical to the LLM path — an attributed action is
				// gated on the envelope its hold will debit, never on the session wallet.
				const sessionRemaining = config.budget - budgetSpent - inFlightHoldTotal;
				const gateRemaining = envelopeRemaining ?? sessionRemaining;
				const tierFields =
					envelope !== undefined && envelopeRemaining !== undefined
						? envelopeTierFields(envelope.attribution, envelopeRemaining, Date.now())
						: { budgetFractionRemaining: undefined, budgetRunwayHours: undefined };
				const policyResult = evaluatePolicy(policyRules, {
					...(action.params ?? {}),
					action_kind: action.kind,
					action_name: action.name,
					estimated_cost: action.cost,
					budget_remaining: gateRemaining,
					budget_remaining_after: gateRemaining - action.cost,
					tier: config.tier,
					// P1-BUDGET-TIER-SHADOW: trusted-host input, asserted after the spread
					// so `action.params` cannot inject a budget tier's own inputs. REAL for
					// an attributed action whose scope stated its allocation (D4), and
					// explicitly `undefined` otherwise — never a caller's number. See the
					// same assertion on the LLM path above.
					budgetFractionRemaining: tierFields.budgetFractionRemaining,
					budgetRunwayHours: tierFields.budgetRunwayHours,
					// Structurally un-forgeable: it comes from this call's own async
					// execution context, which `action.params` cannot reach.
					cost_center: envelope?.attribution.costCenter,
				});
				if (policyResult.decision === "deny") {
					const reason =
						policyResult.reasons.length > 0 ? policyResult.reasons.join("; ") : "Policy denied";
					throw new PolicyDeniedError(
						reason,
						derivePolicyHint(policyResult, envelope !== undefined),
					);
				}

				// d. PII check on action params
				if (config.pii !== "off" && action.params != null) {
					const piiResult = detectPII(action.params);
					if (piiResult.found && config.pii === "block") {
						throw new PolicyDeniedError(
							`PII detected in action params: ${piiResult.types.join(", ")}`,
							'PII enforcement blocked this action. Use { pii: "warn" } to log instead of block; on governed actions { pii: "redact" } redacts only the audit copy — the action itself runs on the original input.',
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
								'Injection enforcement blocked this call. Use { injection: "warn" } to log instead of block.',
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
									...costCenterAudit,
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
							// Attributed → the envelope pays. Unattributed → the key is
							// OMITTED, not passed as undefined, so the engine's default (the
							// session holding wallet) is reached by exactly the path it was
							// before envelopes existed.
							...(envelope !== undefined ? { debitAccountId: envelope.accountId } : {}),
						});
					} catch (holdErr) {
						// P1-LEDGER-ENFORCE: over-budget reservation → hard budget DENY,
						// not a ledger-outage misreport.
						if (holdErr instanceof InsufficientBalanceError) {
							// An attributed rejection is re-presented in the caller's terms:
							// the `parent::costCenter` label instead of a derived account id,
							// and the remedy that actually funds an envelope.
							throw envelope === undefined
								? holdErr
								: asEnvelopeBalanceError(holdErr, envelope.label);
						}
						throw new LedgerUnavailableError(
							holdErr instanceof Error ? holdErr.message : String(holdErr),
						);
					}
					// The hold landed — record which wallet it debited.
					envelopeDebited = envelope !== undefined;
				}

				inFlightHoldTotal += sessionShare(action.cost);
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
					// `sessionShare` on both sides: skipping the increment obliges us to
					// skip the decrement, or the counter drifts negative.
					inFlightHoldTotal -= sessionShare(action.cost);
					if (cost !== undefined) {
						budgetSpent += sessionShare(cost);
					}
					releaseLock();
				}
			}

			try {
				const result = await execute();

				// i. Prepare params for audit — redact PII if configured.
				let auditParams: Record<string, unknown> | undefined;
				if (action.params != null) {
					if (config.pii === "warn" || config.pii === "redact") {
						const redacted = redactPII(action.params);
						auditParams = redacted.data as Record<string, unknown>;
					} else {
						auditParams = action.params;
					}
				}

				// i2. Audit the action FIRST (P3-AUDIT-FAILCLOSED). The settlement-
				// defining event precedes the budget commit + POST, so a fail-closed
				// deployment never settles an unaudited action. settled:true is
				// optimistic; a later POST failure appends settlement_ambiguous.
				const syntheticHash = createHash("sha256").update(transferId).digest("hex");
				let auditHash = syntheticHash;
				let actionAuditFailed = false;
				try {
					const auditEvent = await audit.appendEvent({
						kind: action.kind,
						actor,
						data: {
							actionName: action.name,
							cost: action.cost,
							settled: true,
							transferId,
							...costCenterAudit,
							...(auditParams != null ? { params: auditParams } : {}),
						},
					});
					auditHash = auditEvent.hash;
				} catch {
					// Failure mode 15.3: Audit degraded — mark + warn.
					actionAuditFailed = true;
					callAuditDegraded = true;
					process.stderr.write(
						`[usertrust] audit degraded: failed to write ${action.kind} event for ${transferId}\n`,
					);
				}

				// P3-AUDIT-FAILCLOSED: under failClosed a failed action audit ABORTS the
				// call before any money moves — the outer catch VOIDs the hold (once) and
				// never POSTs.
				if (config.audit.failClosed && actionAuditFailed) {
					throw new AuditDegradedError(
						`audit unavailable (writeFailures=${audit.getWriteFailures()}) for ${transferId}`,
					);
				}

				// Release in-flight hold and commit budget under mutex — money moves only
				// AFTER the action is audited.
				await releaseHoldAndCommit(action.cost);
				await persistSessionSpend();

				// g. Circuit breaker: record success
				cb.recordSuccess();

				// h. POST settlement
				let settled = true;
				if (engine != null && !isDryRun) {
					try {
						// Post the ACTUAL cost (RECON #3).
						await engine.postPendingSpend(transferId, action.cost);
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
									...costCenterAudit,
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
									...costCenterAudit,
								},
							})
							.catch(() => {
								callAuditDegraded = true;
							});
					}
				}

				// P3-AUDIT-FAILCLOSED belt-and-suspenders: refuse to report success if any
				// audit write during this call degraded the writer under failClosed.
				if (config.audit.failClosed && (callAuditDegraded || audit.isDegraded())) {
					throw new AuditDegradedError(
						`audit unavailable (writeFailures=${audit.getWriteFailures()}) for ${transferId}`,
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
								...costCenterAudit,
								...(auditParams != null ? { params: auditParams } : {}),
							},
						},
						config.audit.indexLimit,
					);
				}

				const budgetRemaining = config.budget - budgetSpent - inFlightHoldTotal;
				// D7 (see the LLM path for the full rationale): a post-settle observation
				// of the envelope, omitted when it cannot be read AND when the settlement
				// is ambiguous. It reports; it never re-decides a settlement that already
				// committed, and it is never attached to a settled:false receipt.
				const actionBudget = settled
					? envelopeReceiptBudget(
							envelope,
							await snapshotEnvelopeRemaining(engine, isDryRun, envelope),
						)
					: undefined;

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
					...(actionBudget !== undefined ? { budget: actionBudget } : {}),
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
							...costCenterAudit,
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

// ── Provider-aware prompt extraction (P3-PROVIDER-BLINDSPOT) ──

/**
 * Normalize the prompt-bearing payload across providers so PII/injection scanning
 * and token estimation cover ALL shapes, not just Anthropic/OpenAI `messages`:
 *   - Anthropic/OpenAI: `params.messages` (+ Anthropic top-level `system` string)
 *   - Google:           `params.contents` (the prompt lives here, not `messages`)
 *
 * Without this, a Google `generateContent({ model, contents })` call has an empty
 * `messages` array, so every PII/injection scan sees nothing and PII egresses.
 */
/**
 * Normalize the prompt-bearing payload across providers into a flat parts array
 * that PII/injection scanning, token estimation, redaction, and pattern hashing
 * all consume. Exported for the A8 byte-exact regression test (kept internal to
 * the package — not re-exported from index.ts).
 *
 * Branch order is load-bearing (A8): the OpenAI Responses branch is shape-
 * discriminated (`kind === "openai"` AND no `messages` key) and placed so it can
 * NEVER preempt the chat.completions / Anthropic `messages` branch — every
 * chat.completions or Anthropic call carries `messages` and skips it, so existing
 * extraction stays byte-unchanged.
 */
export function extractPromptParts(
	params: Record<string, unknown>,
	kind: LLMClientKind,
): unknown[] {
	if (kind === "google") {
		const contents = params.contents;
		if (Array.isArray(contents)) return contents;
		return contents != null ? [contents] : [];
	}

	// A8: OpenAI Responses API uses `input`/`instructions`, not `messages`. Wrap the
	// input so BOTH the token estimator (which walks a message's `content`) and the
	// recursive PII/injection scanners (which deep-walk every string) cover it,
	// whether `input` is a plain string, a message array, or a content-part array.
	if (kind === "openai" && params.messages === undefined) {
		const parts: unknown[] = [];
		const input = params.input;
		if (typeof input === "string") {
			parts.push({ role: "user", content: input });
		} else if (Array.isArray(input)) {
			parts.push({ role: "user", content: input });
		} else if (input != null && typeof input === "object") {
			parts.push({ role: "user", content: [input] });
		}
		if (typeof params.instructions === "string") {
			parts.push({ role: "system", content: params.instructions });
		}
		return parts;
	}

	const messages = params.messages;
	const parts: unknown[] = Array.isArray(messages) ? [...messages] : [];
	if (typeof params.system === "string") {
		parts.push({ role: "system", content: params.system });
	}
	return parts;
}

// ── Anthropic MessageStream helpers (Task 2, A1/A3) ──

/**
 * A1/A3: read provider usage off an Anthropic final Message (the `finalMessage`
 * event payload). Each field is returned PER-FIELD: a finite, non-negative count
 * when present, else `undefined` (so the caller can fall back to the counter it
 * accumulated from streamEvent for THAT field, rather than zeroing it — F3).
 * `reported` is true when at least one field carried a real number; when false the
 * caller settles at ESTIMATE rather than voiding a billable success (A3).
 */
function readFinalMessageUsage(msg: unknown): {
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	reported: boolean;
} {
	if (msg != null && typeof msg === "object") {
		const usage = (msg as Record<string, unknown>).usage;
		if (usage != null && typeof usage === "object") {
			const u = usage as Record<string, unknown>;
			const inTok =
				typeof u.input_tokens === "number" && Number.isFinite(u.input_tokens) && u.input_tokens >= 0
					? u.input_tokens
					: undefined;
			const outTok =
				typeof u.output_tokens === "number" &&
				Number.isFinite(u.output_tokens) &&
				u.output_tokens >= 0
					? u.output_tokens
					: undefined;
			if (inTok !== undefined || outTok !== undefined) {
				return { inputTokens: inTok, outputTokens: outTok, reported: true };
			}
		}
	}
	return { inputTokens: undefined, outputTokens: undefined, reported: false };
}

/**
 * A1: incremental token extraction from a raw Anthropic stream event, for the
 * non-consuming messages.stream tap. Kept local to govern.ts (Task 2 does not
 * touch streaming.ts); mirrors streaming.ts extractAnthropicTokens — message_start
 * carries input_tokens, message_delta carries cumulative output_tokens.
 */
function extractAnthropicStreamUsage(event: unknown): {
	inputTokens: number;
	outputTokens: number;
} {
	if (event == null || typeof event !== "object") return { inputTokens: 0, outputTokens: 0 };
	const c = event as Record<string, unknown>;
	if (c.type === "message_start" && c.message != null && typeof c.message === "object") {
		const msg = c.message as Record<string, unknown>;
		if (msg.usage != null && typeof msg.usage === "object") {
			const usage = msg.usage as Record<string, unknown>;
			const inTok = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
			return { inputTokens: inTok > 0 ? inTok : 0, outputTokens: 0 };
		}
	}
	if (c.type === "message_delta" && c.usage != null && typeof c.usage === "object") {
		const usage = c.usage as Record<string, unknown>;
		const outTok = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
		return { inputTokens: 0, outputTokens: outTok > 0 ? outTok : 0 };
	}
	return { inputTokens: 0, outputTokens: 0 };
}

// ── TigerBeetle engine factory ──

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
 * P1-LEDGER-ENFORCE: the holding account is created with
 * `debits_must_not_exceed_credits` and FUNDED with `seedBudget` usertokens, so a
 * pending debit (hold) whose cumulative amount would exceed the remaining budget
 * is REJECTED atomically by TigerBeetle. That rejection is surfaced as an
 * {@link InsufficientBalanceError}, which the governor re-throws as a hard budget
 * DENY (never as a ledger outage). The prior escrow account had no enforcing flag
 * and no funding, so `spendPending` could never reject an over-budget hold.
 *
 * NOTE (cross-domain): RECON #3 designates `createLedgerEngine` /
 * `createFundedBudgetWallet` (LEDGER-owned, in `ledger/engine.ts`) as the eventual
 * home for this factory. Those symbols do not yet exist on disk, so this
 * GOVERN-local factory implements the same funded-enforcing contract using the
 * existing `TrustTBClient` primitives. When LEDGER ships `createLedgerEngine`,
 * this factory is a drop-in replacement (identical `TrustEngine` shape).
 *
 * LOCKSTEP: `headless.ts` carries a duplicate of this factory and every change
 * here belongs there verbatim (AGENTS.md, Known drift). `tests/harden/
 * engine-factory-parity.test.ts` compares the two as source text and fails on a
 * one-sided edit.
 *
 * @internal Exported (below, on its own line) for that seam's tests only —
 * `index.ts` does not re-export it, so it is not part of the published API. The
 * headless copy is deliberately NOT exported: `usertrust/headless` IS a package
 * entry point, and a test-only export there would ship an engine factory to
 * consumers.
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

		// AUD-461: Void all remaining pending transfers on destroy.
		// Best-effort — TigerBeetle auto-voids after 300s regardless.
		async voidAllPending(): Promise<void> {
			const entries = [...pendingMap.entries()];
			for (const [trustIdKey, entry] of entries) {
				try {
					await tbClient.voidTransfer(entry.tbId);
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

// The export sits on its own line on purpose: `export async function …` runs the
// declaration to 101 columns, Biome wraps it, and the wrapped signature no longer
// matches headless.ts's copy — which the parity suite compares as source text.
export { createTBEngine };

// ── Proxy builders ──
// Each builder intercepts only the `create` / `generateContent` call and
// preserves all other properties of the original client untouched.

type InterceptFn = (
	originalFn: (...args: unknown[]) => unknown,
	thisArg: unknown,
	args: unknown[],
	surfaceKind?: "create" | "stream-helper" | "openai-responses",
) => Promise<TrustedResponse<unknown>>;

type GovernActionFn = <R>(
	action: ActionDescriptor,
	execute: () => Promise<R>,
) => Promise<GovernedActionResult<R>>;

/**
 * F4: mirror the Anthropic SDK's `parseMessage` / `parseBetaMessage` transform for a
 * governed `messages.parse()` / `beta.messages.parse()`. The SDK's `parse()` is
 * `this.create(params).then((m) => parseMessage(m, params))` — routed through our
 * proxy, `this.create` is the GOVERNED create, which returns a `{ response, receipt }`
 * wrapper the SDK parser crashes on (`wrapper.content` is undefined) AFTER the spend
 * has already settled. So the proxy runs the governed create itself and applies the
 * transform to the raw Message here.
 *
 * Faithful to the SDK for the modern `parsed_output` API: each `text` block gains a
 * NON-ENUMERABLE `parsed_output` (parsed via the caller-provided
 * `output_config.format.parse` when structured outputs are requested, else `JSON.parse`,
 * else null), and the message carries the first text block's `parsed_output` at the top
 * level. Reads the deprecated beta `output_format` too, so ONE transform covers the
 * stable and beta surfaces (stable params simply lack `output_format`). A structured
 * parse failure throws, matching the SDK. The deprecated per-block `parsed` getter is
 * intentionally not reproduced (superseded by `parsed_output`).
 */
function applyAnthropicParseTransform(message: unknown, params: unknown): unknown {
	if (message == null || typeof message !== "object") return message;
	const p = (params ?? {}) as Record<string, unknown>;
	const outputConfig = p.output_config as { format?: unknown } | null | undefined;
	const format = (p.output_format ?? outputConfig?.format) as
		| { type?: unknown; parse?: unknown }
		| null
		| undefined;
	const hasSchema = format != null && typeof format === "object" && format.type === "json_schema";
	const parseText = (text: string): unknown => {
		if (!hasSchema) return null;
		try {
			return typeof format?.parse === "function"
				? (format.parse as (c: string) => unknown)(text)
				: JSON.parse(text);
		} catch (err) {
			throw new Error(`Failed to parse structured output: ${err}`);
		}
	};

	const msg = message as Record<string, unknown>;
	let firstParsed: unknown = null;
	const content = Array.isArray(msg.content)
		? msg.content.map((block) => {
				if (
					block != null &&
					typeof block === "object" &&
					(block as { type?: unknown }).type === "text"
				) {
					const parsed = parseText(String((block as { text?: unknown }).text ?? ""));
					if (firstParsed === null) firstParsed = parsed;
					const parsedBlock = { ...(block as Record<string, unknown>) };
					Object.defineProperty(parsedBlock, "parsed_output", {
						value: parsed,
						enumerable: false,
					});
					return parsedBlock;
				}
				return block;
			})
		: msg.content;

	return { ...msg, content, parsed_output: firstParsed };
}

/**
 * A1/A5: build a governed proxy over an Anthropic `messages` resource (stable or
 * beta — both share the create/stream shape). `create` routes through
 * interceptCall (surface "create"). `stream`, when present as a function (A5
 * feature-detect), routes through interceptCall (surface "stream-helper") bound to
 * the RAW `messages` target (A5) so the helper's internal
 * `messages.create({stream:true}).withResponse()` runs against the un-proxied
 * create and never re-enters the governed create trap. The governed `stream` is
 * async (it authorizes before forwarding), so callers `await` the handle, then use
 * `.on()` / `.finalMessage()` / `.abort()` / `.receipt`. `parse`, when present (A5
 * feature-detect), routes its create through governance and applies the SDK parse
 * transform (F4). Everything else (countTokens, batches, …) falls through to
 * Reflect.get untouched.
 */
function buildAnthropicMessagesProxy(
	messages: Record<string, unknown>,
	intercept: InterceptFn,
): Record<string, unknown> {
	const originalCreate = messages.create as (...args: unknown[]) => unknown;
	// A5: feature-detect `stream` as a FUNCTION before wrapping it — an older SDK
	// without the helper leaves it absent and it stays a raw pass-through.
	const originalStream =
		typeof messages.stream === "function"
			? (messages.stream as (...args: unknown[]) => unknown)
			: undefined;
	// A5/F4: feature-detect `parse` the same way — absent on older SDKs.
	const hasParse = typeof messages.parse === "function";

	return new Proxy(messages, {
		get(target, prop, receiver) {
			if (prop === "create") {
				return (...args: unknown[]) => intercept(originalCreate, target, args);
			}
			if (prop === "stream" && originalStream !== undefined) {
				return async (...args: unknown[]) => {
					const { response } = await intercept(originalStream, target, args, "stream-helper");
					return response;
				};
			}
			if (prop === "parse" && hasParse) {
				// F4: run the governed create ONCE, then apply the SDK parse transform to
				// the settled Message and hand back the parsed Message (SDK-shaped) with
				// the settlement receipt attached.
				return async (...args: unknown[]) => {
					const { response, receipt } = await intercept(originalCreate, target, args);
					const parsed = applyAnthropicParseTransform(response, args[0]);
					if (parsed != null && typeof parsed === "object") {
						try {
							Object.defineProperty(parsed, "receipt", {
								value: receipt,
								enumerable: true,
								configurable: true,
							});
						} catch {
							// non-extensible parsed object — skip
						}
					}
					return parsed;
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}

/**
 * A5: build a governed proxy over `client.beta` when it exposes a create-shaped
 * `beta.messages`. Returns undefined on any miss (no beta, non-object beta, a beta
 * getter that throws, or a beta.messages without a create function) so the caller
 * falls back to raw Reflect.get and NOTHING throws at wrap time (peerDep-range
 * compatibility). beta.models / beta.files / beta.messages.batches stay documented
 * pass-throughs — create, stream, and parse on beta.messages are governed.
 */
function buildAnthropicBetaProxy(
	original: Record<string, unknown>,
	intercept: InterceptFn,
): Record<string, unknown> | undefined {
	let beta: unknown;
	try {
		beta = original.beta;
	} catch {
		return undefined;
	}
	if (beta == null || typeof beta !== "object") return undefined;
	const betaObj = beta as Record<string, unknown>;
	const betaMessages = betaObj.messages;
	if (
		betaMessages == null ||
		typeof betaMessages !== "object" ||
		typeof (betaMessages as Record<string, unknown>).create !== "function"
	) {
		return undefined;
	}
	const betaMessagesProxy = buildAnthropicMessagesProxy(
		betaMessages as Record<string, unknown>,
		intercept,
	);
	return new Proxy(betaObj, {
		get(target, prop, receiver) {
			if (prop === "messages") return betaMessagesProxy;
			return Reflect.get(target, prop, receiver);
		},
	});
}

function buildAnthropicProxy<T>(
	client: T,
	intercept: InterceptFn,
	destroy: () => Promise<void>,
	governAction: GovernActionFn,
): TrustedClient<T> {
	const original = client as Record<string, unknown>;
	const messages = original.messages as Record<string, unknown>;

	// Stable messages: governed `create` + (feature-detected) `stream`.
	const messagesProxy = buildAnthropicMessagesProxy(messages, intercept);

	// beta.messages.create/stream/parse — governed identically when present (A5); a
	// client without `beta` yields undefined and `beta` stays a raw pass-through.
	const betaProxy = buildAnthropicBetaProxy(original, intercept);

	const clientProxy = new Proxy(original, {
		get(target, prop, receiver) {
			if (prop === "messages") return messagesProxy;
			if (prop === "beta" && betaProxy !== undefined) return betaProxy;
			if (prop === "destroy") return destroy;
			if (prop === "governAction") return governAction;
			return Reflect.get(target, prop, receiver);
		},
	});

	return clientProxy as TrustedClient<T>;
}

/**
 * Task 3 (A5): build a governed proxy over `client.responses` when the OpenAI SDK
 * exposes a create-shaped Responses API. Returns undefined on any miss (no
 * `responses`, non-object `responses`, a getter that throws, or a `responses`
 * without a `create` function) so the caller falls back to raw Reflect.get and
 * NOTHING throws at wrap time — the peer range (`openai >=4.70.0`) predates the
 * Responses API (~4.87), so older clients must keep working untouched.
 *
 * `responses.create` routes through interceptCall on the SEPARATE "openai-responses"
 * surface (A6: no stream_options.include_usage injection; A7: streaming still flows
 * through the generic createGovernedStream path). `this` binds to the RAW `responses`
 * object. Everything else (retrieve / cancel / delete / …) stays a pass-through.
 */
function buildOpenAIResponsesProxy(
	original: Record<string, unknown>,
	intercept: InterceptFn,
): Record<string, unknown> | undefined {
	let responses: unknown;
	try {
		responses = original.responses;
	} catch {
		return undefined;
	}
	if (responses == null || typeof responses !== "object") return undefined;
	const responsesObj = responses as Record<string, unknown>;
	if (typeof responsesObj.create !== "function") return undefined;
	const originalCreate = responsesObj.create as (...args: unknown[]) => unknown;

	return new Proxy(responsesObj, {
		get(target, prop, receiver) {
			if (prop === "create") {
				return (...args: unknown[]) => intercept(originalCreate, target, args, "openai-responses");
			}
			return Reflect.get(target, prop, receiver);
		},
	});
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

	// responses.create — governed when present (A5); an older client without the
	// Responses API yields undefined and `responses` stays a raw pass-through.
	const responsesProxy = buildOpenAIResponsesProxy(original, intercept);

	const clientProxy = new Proxy(original, {
		get(target, prop, receiver) {
			if (prop === "chat") return chatProxy;
			if (prop === "responses" && responsesProxy !== undefined) return responsesProxy;
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
