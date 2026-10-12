// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The weekly spend report's MODEL: a pure function from an ordered audit chain to the figures a CFO reads.
 *
 * No filesystem, no clock, no network. Every figure is derived from event rows the model names, so a reader can
 * recompute it, and each rule below states what the figure is NOT, because the report is the one artifact a
 * customer forwards to someone who never saw the chain.
 *
 * What is counted as SPEND, and what is deliberately not. CLASSIFICATION IS BY EVIDENCE, and anything the chain does not
 * prove is UNCONFIRMED, shown as such, never silently dropped and never silently counted:
 *   - CONFIRMED: an `llm_call` (or a governed action) with a finite non-negative `cost`, not `settled: false`, and NO record
 *     for its `transferId` other than itself and the closed set of annotations written after a post landed
 *     (`settlement_shortfall`, `usage_implausible`). Of those, the ones with POSITIVE evidence of a landed post (a headless
 *     record, which is written after the ledger POST, or a `settlement_shortfall`) are counted separately; the rest were
 *     audited before the POST (`trust()` writes `llm_call` first, by design, and writes nothing more on success), so the
 *     chain alone cannot prove the post and the report says so.
 *   - UNCONFIRMED: everything else: `settled: false`; ANY other record for the transfer (`settlement_ambiguous`,
 *     `llm_call_failed`, `<kind>_failed`, a release, a kind this code has never seen), because a failure marker does not
 *     prove a void (a post-commit throw also appends `llm_call_failed` for a call that WAS charged); a row with no
 *     `transferId`; and a standalone `settlement_ambiguous` with no call. The set of kinds that can confirm is closed; a
 *     new kind therefore unconfirms by default instead of leaking into spend.
 *   - Dollars are classified by the recorded DENOMINATION (`costBasis`): `usd-proxy` is dollars (a GPU-amortized local
 *     endpoint is `usd-proxy`), `nominal` is a unit count, shown and excluded from dollar totals. A row with no
 *     `costBasis` (headless rows) is counted as dollars unless it says it went to a local endpoint, and is reported as
 *     unlabelled so the reader knows the denomination was assumed.
 *   - A row that is not a usable event (no `data` object, no string `kind`) is skipped and counted, never a crash:
 *     the report still prints, with the verification diagnostics.
 *   - A denied call moved no money. Denials are COUNTED, never given a dollar value ("saved" would be fabricated).
 *   - Nothing here reads the live ledger balance. Budget status compares the vault's configured `budget` with the
 *     spend RECORDED in the chain, and says so.
 */

import { createHash } from "node:crypto";
import { types } from "node:util";
import type { PersistedAuditEvent } from "../audit/read.js";
import { providerOfModel } from "../ledger/pricing.js";

/** 1 usertoken = $0.0001 USD, everywhere (AGENTS.md). */
export const UT_TO_USD = 0.0001;

export const UNATTRIBUTED = "(unattributed)";

export type AgentKey =
	| "auto"
	| "cost-center"
	| "principal.id"
	| "principal.type"
	| "principal.origin"
	| "principal.unit"
	| "actor";

export const AGENT_KEYS: readonly AgentKey[] = [
	"auto",
	"cost-center",
	"principal.id",
	"principal.type",
	"principal.origin",
	"principal.unit",
	"actor",
];

declare const usdBrand: unique symbol;
declare const nominalBrand: unique symbol;
/**
 * Usertokens that are DOLLARS (a `usd-proxy` cost basis; an unlabelled row is assumed so and reported as such). The
 * dollar formatter accepts only this type, so a nominal-unit figure cannot be dollar-formatted: it is a compile error.
 */
export type UsdUt = number & { readonly [usdBrand]: true };
/** Nominal UNITS (a local, non-priced endpoint). Never summed with, or formatted as, dollars. */
export type NominalUt = number & { readonly [nominalBrand]: true };

declare const walletBrand: unique symbol;
/**
 * Session-WALLET units: what the governors' session counter enforces, i.e. usd-priced debits, nominal units and unlabelled
 * rows together, one usertoken wallet. The budget ratio is over this and only this. It is not dollars: the dollar
 * formatter refuses it, and `toWallet` is the ONE place a dollar amount and a nominal amount are added.
 */
export type WalletUt = number & { readonly [walletBrand]: true };

/** The one conversion point: usd-priced plus nominal units, as the enforcing counter adds them. */
export function toWallet(usd: number, nominal: number): WalletUt {
	return (usd + nominal) as WalletUt;
}

/** The same shape with the denomination brands removed: what the builder accumulates before the one audited cast. */
type Plain<T> = T extends UsdUt | NominalUt | WalletUt
	? number
	: T extends readonly (infer U)[]
		? readonly Plain<U>[]
		: T extends object
			? { [K in keyof T]: Plain<T[K]> }
			: T;

export interface ReportOptions {
	/** Exclusive end of the window, epoch ms. The window is `windowDays` × 24 h ending here. */
	endMs: number;
	windowDays?: number;
	agentKey?: AgentKey;
	/** With `cost-center` / `auto`: use this 0-based dot-separated segment of the cost center as the agent. */
	segment?: number;
	topN?: number;
	/** The configured budget in usertokens; 0 or absent means none configured. */
	budget?: number;
	/** Where `budget` came from, printed beside it ("vault config", "--budget", "tenant config"). */
	budgetSource?: string;
	/** The vault config exists but could not be read: the budget is unknown, which is not the same as none. */
	budgetUnreadable?: boolean;
	/**
	 * The governor's persisted counter (`spend-ledger.json`), read from the same snapshot: `{ value }` when it parsed as a
	 * number, `{ unreadable: true }` when the file exists and could not be read. Absent when there is no ledger file. It is
	 * NOT chain-verified and is reported only as "as recorded by the governor", beside the figure the chain gives.
	 */
	spendLedger?: { value: number } | { unreadable: true };
	/**
	 * Settlement shortfalls found in the writer's dead-letter queue, read from the same snapshot: a shortfall whose chain
	 * append failed is in the DLQ with the `posted` amount. `{ unreadable: true }` when the queue could not be read, or an
	 * entry failed its checksum or did not parse. NOT chain-verified. Absent means the caller did not read the queue, which
	 * is treated as unreadable: the headless proven figure is then an upper bound, never exact.
	 */
	deadLetters?: DeadLetters;
}

/** What the dead-letter queue says about capped posts. A plain file: corruption-detecting, not tamper-evident. */
export type DeadLetters = { shortfalls: ReadonlyMap<string, number> } | { unreadable: true };

/**
 * What the report may use from the dead-letter queue the verifier just read. Shortfall amounts are usable only from a queue read
 * cleanly: an unreadable queue, an unreadable line, or a dead-lettered shortfall that is not one leaves the headless proven
 * figure an UPPER bound, never an exact one.
 */
export function deadLettersForReport(d: {
	unreadable?: string;
	shortfalls?: ReadonlyMap<string, number>;
	shortfallsReliable?: boolean;
	missingByKind?: Record<string, number>;
}): DeadLetters {
	if (d.unreadable !== undefined || d.shortfalls === undefined) return { unreadable: true };
	if (d.shortfallsReliable === false || (d.missingByKind?.["<unreadable>"] ?? 0) > 0) {
		return { unreadable: true };
	}
	return { shortfalls: d.shortfalls };
}

export interface IntegrityInfo {
	verified: boolean;
	errors: readonly string[];
	chainLength: number;
	firstEvent: string | null;
	lastEvent: string | null;
	/**
	 * The UTC instant the vault was read (taken before the audit directory was listed). The VERIFIED claim is about the
	 * chain as it stood at this instant, not about the vault after the run; the renderers print it beside the verdict.
	 */
	readAtIso?: string;
}

export interface Row {
	key: string;
	calls: number;
	ut: UsdUt;
	/** Share of confirmed spend, 0..1. */
	share: number;
}

export interface ModelRow extends Row {
	provider: string;
	costBasis: string[];
}

export interface TopCost {
	id: string;
	timestamp: string;
	model: string;
	agent: string;
	transferId: string;
	ut: UsdUt;
	hash: string;
}

export interface TierBreakdown {
	/** Calls priced from provider-reported four-tier usage. */
	calls: number;
	/** Their metered cost (Σ data.cost). */
	costUt: UsdUt;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	/** TOTAL cache-write tokens (5-minute plus 1-hour). */
	cacheWriteTokens: number;
	/** Of which written to the 1-hour cache, priced at its own rate (`data.cacheWrite1h`). */
	cacheWrite1hTokens: number;
	/** tokens × appliedRates / 1000, per tier. Unrounded: per-call cost is ceil'd, so the tiers sum to ≈ costUt. */
	inputUt: UsdUt;
	outputUt: UsdUt;
	cacheReadUt: UsdUt;
	/** TOTAL cache-write cost: the 5-minute remainder at `cacheWritePer1k` plus the 1-hour tokens at their own rate. */
	cacheWriteUt: UsdUt;
	/** Of which the 1-hour tokens. */
	cacheWrite1hUt: UsdUt;
	/** cacheWriteUt / Σ tiers, 0..1; `null` when there is nothing to divide. A cost DRIVER, never "avoidable". */
	cacheWriteShare: number | null;
	/** Σ tiers − costUt: the rounding the per-call ceil introduces. Printed so the tiers visibly reconcile. */
	roundingUt: UsdUt;
}

export interface ReportModel {
	window: { startIso: string; endIso: string; days: number };
	integrity: IntegrityInfo;
	agentKey: { requested: AgentKey; segment: number | null };
	totals: {
		/** Spend: confirmed `llm_call` cost denominated in dollars (see the module comment). */
		confirmedUt: UsdUt;
		confirmedCalls: number;
		/** The part of confirmed spend whose usage was an ESTIMATE (no provider-reported counts). */
		estimatedUt: UsdUt;
		estimatedCalls: number;
		/** The part of confirmed spend whose row records no `costBasis`: its denomination is ASSUMED to be dollars. */
		unlabelledUt: UsdUt;
		unlabelledCalls: number;
		/** `llm_call`s with a `settlement_ambiguous` for the same transfer, or an explicit `settled: false`: not spent. */
		unconfirmedUt: UsdUt;
		unconfirmedCalls: number;
		/** Unconfirmed calls denominated in nominal units: counted here, never added to `unconfirmedUt` (dollars). */
		unconfirmedNominalCalls: number;
		unconfirmedNominalUt: NominalUt;
		/** Unconfirmed calls whose record states no denomination: counted here, never added to `unconfirmedUt` (dollars). */
		unconfirmedUnlabelledCalls: number;
		unconfirmedUnlabelledUt: UsdUt;
		/** Of those, the ones that are an explicit `settled: false` (the rest have a settlement_ambiguous record). */
		unsettledCalls: number;
		/** Of the unconfirmed calls, those contradicted by another record for the same transfer (a failure or ambiguity marker, a release, an unknown kind). */
		contradictedCalls: number;
		/** Calls whose hold was proven released: nothing was charged, and they are in no spend or budget figure. */
		releasedCalls: number;
		/** Of the unconfirmed, those with no `transferId` to correlate. */
		uncorrelatedCalls: number;
		/** Confirmed spend whose post is PROVEN by a record written after it (a headless record, or a `settlement_shortfall`). */
		postProvenUt: UsdUt;
		postProvenCalls: number;
		/**
		 * A headless call the ledger answered with NO shortfall record on the chain, when the dead-letter queue could not rule
		 * out a capped post: its metered cost is an UPPER bound on what moved (the ledger caps at the hold). In neither
		 * `postProvenUt` (the exact part) nor anywhere else as an exact figure.
		 */
		postProvenUpperUt: UsdUt;
		postProvenUpperCalls: number;
		/** Part of `postProvenUt`: the posted amount comes from a dead-lettered shortfall (the queue is not chain-verified). */
		postProvenDeadLetterUt: UsdUt;
		postProvenDeadLetterCalls: number;
		/** Governed actions that are unconfirmed (same rules as calls): counted here, never added to `actionUt`. */
		unconfirmedActionCalls: number;
		unconfirmedActionUt: UsdUt;
		/** `costBasis: "nominal"` rows (or an unlabelled local-endpoint row): unit counts, excluded from dollar totals. */
		nominalCalls: number;
		nominalUt: NominalUt;
		/** Governed non-LLM actions (kind = action.kind, `data.actionName`): a separate line, never merged. */
		actionUt: UsdUt;
		actionCalls: number;
		/** `llm_call` rows in the window with no usable cost, or an unreadable timestamp. */
		malformedCalls: number;
		/** Rows that are not events at all (no `data` object, no string `kind`): skipped. */
		malformedEvents: number;
	};
	/** `settlement_shortfall`: the metered cost exceeded what the ledger could post. */
	shortfall: { events: number; ut: UsdUt };
	byAgent: Row[];
	/**
	 * Spend by `principal.origin` (a plugin-metered Claude Code session is `claude-code:<session id>`), when any call
	 * carries one. A second view beside the agent table: the agent key answers "which agent", this answers "which
	 * session / client". Empty when no call records an origin.
	 */
	bySession: Row[];
	byModel: ModelRow[];
	tiers: TierBreakdown;
	topCosts: TopCost[];
	/** Confirmed spend per hour of the window, oldest first; length = days × 24. */
	hourlyUt: UsdUt[];
	/**
	 * The configured budget is the SESSION wallet's. What provably debits it: every `llm_call` and governed action that
	 * carries NO cost center, in usertokens (a nominal local call debits its units too).
	 *
	 * A call WITH a cost center is a different matter, and the chain does not say who paid: with a ledger it debits that
	 * cost-center envelope, but a dry-run call attributed to a cost center still debits the session. A label is not proof of
	 * a payer, so that spend is reported as ATTRIBUTED (payer not recorded) and bounds the answer instead of being assumed
	 * away: `usedFraction` counts only the unattributed spend (a lower bound), `usedFractionUpper` adds the attributed
	 * spend (the most it could be). Both exclude an ambiguous, voided or `settled: false` settle.
	 */
	budget: {
		configuredUt: UsdUt | null;
		/** The budget could not be determined (its config was unreadable). Distinct from `configuredUt: null` (none set). */
		unknown: boolean;
		source: string | null;
		/** Spend with no cost center, in the window / over the whole chain: it debited the session wallet. */
		windowSessionUt: UsdUt;
		recordedSessionUt: UsdUt;
		/** Spend WITH a cost center, in the window / over the whole chain: payer not recorded (envelope, or session in dry run). */
		windowAttributedUt: UsdUt;
		recordedAttributedUt: UsdUt;
		/** The same four figures for NOMINAL units (a local call debits its units too). Never summed with the dollar ones. */
		windowSessionNominal: NominalUt;
		recordedSessionNominal: NominalUt;
		windowAttributedNominal: NominalUt;
		recordedAttributedNominal: NominalUt;
		/**
		 * The budget's own unit: ALL session-wallet debits (usd-priced + nominal + unlabelled), matching what enforcement
		 * counts. `usedFraction` and the over-budget checks are over these; the usd and nominal figures above are the split.
		 */
		windowSessionWallet: WalletUt;
		recordedSessionWallet: WalletUt;
		windowAttributedWallet: WalletUt;
		recordedAttributedWallet: WalletUt;
		/**
		 * UNCERTAIN transfers: the chain's evidence does not say whether the governor's counter added them (a settled call a
		 * void marker contradicts, a settle marked unsettled with nothing else). Counted and disclosed, in NEITHER bound's
		 * definite figure: the lower bound is the definite wallet, the upper bound adds these (and the attributed spend).
		 */
		recordedSessionUncertain: WalletUt;
		/**
		 * Wallet units whose DENOMINATION the chain does not say (a standalone shortfall: it carries `actual` and `posted`
		 * but no cost basis). In the wallet (the governor counted them) and in NEITHER the usd-priced nor the nominal figure.
		 */
		recordedSessionUndenominated: WalletUt;
		recordedAttributedUndenominated: WalletUt;
		/** The same undenominated units that fall inside the report window (they are in `windowSessionWallet`). */
		windowSessionUndenominated: WalletUt;
		windowAttributedUndenominated: WalletUt;
		recordedAttributedUncertain: WalletUt;
		uncertainTransfers: number;
		/** 0..1 lower bound (session spend only), clamped; `null` when no budget is configured. */
		usedFraction: number | null;
		/** 0..1 upper bound (session + attributed spend), clamped; `null` when no budget is configured. */
		usedFractionUpper: number | null;
		/** The unattributed spend alone exceeds the budget, and the governor's own counter does not contradict it. */
		overBudget: boolean;
		/**
		 * The lower bound exceeds the budget but the governor's persisted counter is BELOW it. A bare SDK call is
		 * recorded before its budget commit, so after a crash between the two the chain can include a call the counter never
		 * added. No definite over-budget claim is made then: it is shown as a range ("possibly over"). Neutral by design: the
		 * report does not say which leg is wrong.
		 */
		overBudgetDisputed: boolean;
		/** Only counting the attributed spend as well would exceed it: the payer decides. */
		possiblyOverBudget: boolean;
	};
	governance: Record<string, number>;
	/**
	 * The governor's persisted counter against the chain: a third reconciliation leg that catches drift either way. NOT
	 * chain-verified (the spend ledger is a plain file), so it is never part of the VERIFIED claim. `differs` is true when
	 * the recorded figure falls outside what the chain accounts for: below the session-wallet debits, or above them plus
	 * everything attributed to a cost center (whose payer the chain does not record). `null` when there is no ledger file.
	 */
	spendLedger: {
		recorded: number | null;
		unreadable: boolean;
		differs: boolean;
		/** recorded minus the chain's session-wallet total, when it differs (negative: the governor counted less). */
		difference: number | null;
	};
	/**
	 * `settlement_unrecoverable`: the provider SERVED the call but its hold was gone and the ledger never charged it. The
	 * record has usage and NO cost, so it is disclosed here (a count and the reported usage) and is in NO spend total.
	 */
	unrecoverable: {
		records: number;
		/**
		 * Of those, the records whose transfer ALSO has a spend record in this chain: the server writes this record when a
		 * settle is retried after a restart or an eviction from its settled-memory, so "never charged" would be false for
		 * them. The rest have no known prior charge (unknown, not "never charged").
		 */
		priorChargeKnown: number;
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	};
	/**
	 * Records in the window of a kind this report does not read (anything outside the closed set it knows), counted by
	 * kind. A new record kind can never vanish silently: it shows up here until the report learns to read it.
	 */
	unrecognised: Record<string, number>;
	/**
	 * `ungoverned_call`: an attempt the caller opted out of governance for (`allowUngoverned`). The record is written before
	 * the SDK call, so it proves the call was attempted, not that it reached the provider. No hold, no budget check and no
	 * cost, so what it spent is not known. `calls` counts recorded attempts, by method, in NO spend, cost, budget,
	 * governed-call or action figure.
	 */
	ungoverned: { calls: number; byMethod: Record<string, number> };
	/**
	 * Records that only qualify a call (shortfall, ambiguity, implausible-usage note, failure markers) but whose transfer has
	 * NO spend record in the chain, by kind. `amount` is usertokens with no denomination assumed and is in no spend total.
	 */
	withoutCall: Record<string, { records: number; amount: number }>;
	/** Of those, standalone shortfalls: the ledger posted `posted` usertokens that no call record accounts for. */
	chargedUnrecorded: { records: number; posted: number };
	notes: string[];
}

const GOVERNANCE_KINDS = [
	"policy_denied",
	"ledger_rejected",
	"injection_detected",
	"anomaly_detected",
	"llm_call_failed",
	"stream_partial_delivery",
	"hold_released",
	"settlement_ambiguous",
] as const;

/** Every record kind this report reads or deliberately ignores. A kind outside this set is disclosed as unrecognised. */
const KNOWN_KINDS: ReadonlySet<string> = new Set([
	"llm_call",
	"settlement_shortfall",
	"usage_implausible",
	"settlement_unrecoverable",
	// Written by the budget primitives (cost-center envelopes) to the same chain; deliberately not read here.
	"budget_allocated",
	"budget_reclaimed",
	// An ungoverned call attempt through `allowUngoverned`: the record proves an attempt, counted by method, never as spend.
	"ungoverned_call",
	...GOVERNANCE_KINDS,
]);

/** A record that only qualifies a call, never being spend itself. */
function isQualifierKind(kind: string): boolean {
	return (
		// A standalone settlement_ambiguous is NOT listed here: it is already in the unconfirmed totals, and counting it in
		// two places would double-disclose it.
		kind === "settlement_shortfall" ||
		kind === "usage_implausible" ||
		kind === "llm_call_failed" ||
		kind.endsWith("_failed")
	);
}

/** Kinds that are never a governed action, even if one day they carry a `cost`. */
const NON_ACTION_KINDS = new Set<string>([
	"llm_call",
	"llm_call_failed",
	"settlement_ambiguous",
	"settlement_shortfall",
	"stream_partial_delivery",
	"hold_released",
	"policy_denied",
	"ledger_rejected",
	"injection_detected",
	"anomaly_detected",
	"chunk",
	// An ungoverned call attempt moved no metered money: the record proves an attempt. It carries no `actionName` today,
	// and listing it here keeps one that ever did (or carried a `cost`) out of the action totals.
	"ungoverned_call",
]);

const HOUR_MS = 3_600_000;

function str(v: unknown): string | undefined {
	return typeof v === "string" && v !== "" ? v : undefined;
}

function cost(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * An own DATA property holding a string, read without running any code: an accessor is never called and a Proxy is never
 * read through, so a label is what the record stored and nothing else.
 */
function ownStringDataProperty(obj: unknown, key: string): string | undefined {
	if (obj === null || typeof obj !== "object") return undefined;
	if (types.isProxy(obj)) return undefined;
	try {
		const d = Object.getOwnPropertyDescriptor(obj, key);
		return d !== undefined && "value" in d && typeof d.value === "string" ? d.value : undefined;
	} catch {
		return undefined;
	}
}

const UNKNOWN_METHOD = "(unknown method)";

function count(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

export function detectProvider(model: string): string {
	// The pricing table's own provider data first: the single source of which vendor publishes which prefix.
	const known = providerOfModel(model);
	if (known !== undefined) return known;
	if (model.startsWith("claude")) return "anthropic";
	// OpenAI reasoning families are `o<digit>` (o1, o3, o4-mini, ...).
	if (model.startsWith("gpt") || /^o\d/.test(model)) return "openai";
	if (model.startsWith("gemini")) return "google";
	if (model.startsWith("command")) return "cohere";
	if (model.startsWith("mistral") || model.startsWith("mixtral")) return "mistral";
	return "unknown";
}

/** The agent an event is attributed to, by the requested key. Unattributed is a row of its own, never hidden. */
export function agentOf(
	e: PersistedAuditEvent,
	key: AgentKey,
	segment: number | undefined,
): string {
	const d = e.data;
	const principal =
		d["principal"] !== null && typeof d["principal"] === "object"
			? (d["principal"] as Record<string, unknown>)
			: undefined;
	const costCenter = (): string | undefined => {
		const cc = str(d["costCenter"]);
		if (cc === undefined) return undefined;
		if (segment === undefined) return cc;
		return str(cc.split(".")[segment]);
	};
	switch (key) {
		case "cost-center":
			return costCenter() ?? UNATTRIBUTED;
		case "principal.id":
			return str(principal?.["id"]) ?? UNATTRIBUTED;
		case "principal.type":
			return str(principal?.["type"]) ?? UNATTRIBUTED;
		case "principal.origin":
			return str(principal?.["origin"]) ?? UNATTRIBUTED;
		case "principal.unit":
			return str(principal?.["unit"]) ?? UNATTRIBUTED;
		case "actor":
			// `trust()` always writes actor "local", which says nothing about WHO: treat it as unattributed.
			return e.actor === "local" || str(e.actor) === undefined ? UNATTRIBUTED : e.actor;
		default:
			// auto: the structural attribution first (a cost center is operator-declared), then the principal the
			// headless governor recorded, else unattributed. Never the actor string.
			return costCenter() ?? str(principal?.["id"]) ?? UNATTRIBUTED;
	}
}

function toRows(m: Map<string, { calls: number; ut: number }>, total: number): Plain<Row>[] {
	return [...m.entries()]
		.map(([key, v]) => ({ key, calls: v.calls, ut: v.ut, share: total > 0 ? v.ut / total : 0 }))
		.sort((a, b) => b.ut - a.ut || a.key.localeCompare(b.key));
}

/** A row the report can read: an object with a string `kind` and an object `data`. */
function isUsableEvent(e: unknown): e is PersistedAuditEvent {
	if (e === null || typeof e !== "object") return false;
	const r = e as Record<string, unknown>;
	return (
		typeof r["kind"] === "string" &&
		typeof r["timestamp"] === "string" &&
		r["data"] !== null &&
		typeof r["data"] === "object" &&
		!Array.isArray(r["data"])
	);
}

/**
 * The denomination a row's cost is in, from what the row RECORDS (`costBasis`), not from where the call went:
 * `usd-proxy` is dollars even for a GPU-amortized local endpoint; `nominal` is a unit count. A row with no `costBasis`
 * (headless rows) is `unlabelled`: counted as dollars, and reported as such, unless it says it went to a local endpoint.
 */
/** A governed action's spend record. A `<kind>_failed` marker is never one, whatever else it carries. */
function isActionEvent(e: PersistedAuditEvent): boolean {
	// Keyed on `actionName`: `governAction({ kind: "llm_call", name, cost })` is a supported descriptor and writes an
	// event whose kind IS "llm_call" but which is an ACTION, never a model call. A model call carries no actionName.
	const kindAllowed = e.kind === "llm_call" || !NON_ACTION_KINDS.has(e.kind);
	// typeof, not str(): an action named "" is still an accepted action (str() maps "" to undefined and dropped it from every total).
	return kindAllowed && !e.kind.endsWith("_failed") && typeof e.data["actionName"] === "string";
}

function denominationOf(e: PersistedAuditEvent): "usd" | "nominal" | "unlabelled" {
	const basis = e.data["costBasis"];
	if (basis === "usd-proxy") return "usd";
	if (basis === "nominal") return "nominal";
	return e.data["endpointClass"] === "local" ? "nominal" : "unlabelled";
}

/**
 * How the governors' session counter treated one TRANSFER, from a CLOSED set of evidence. Both governors add a call's
 * metered cost to `budgetSpent` once they decide to post it (govern.ts: the stream settle adds `streamCost` before its POST,
 * the non-stream settle adds `actualCost` after the `llm_call` append and before its POST; headless.ts: `settle()` adds
 * `actualCost` after the POST ATTEMPT, success or ambiguous; an abort or a release never adds). What the CHAIN can show of
 * that is only this evidence, per transfer:
 *   - DEBITED needs POSITIVE evidence the counter added it: a `settlement_shortfall` (a post happened), a
 *     `settlement_ambiguous` (the governor decided to post it; the add FOLLOWS the record on the headless path, so a crash
 *     between the two leaves it uncounted, which the spend-ledger leg catches), `ledgerPosted` on the record, or a settled
 *     call with no contrary marker;
 *   - NOT DEBITED needs a void or a release (`llm_call_failed`, `hold_released`) and NO post evidence;
 *   - everything else is UNCERTAIN: counted and disclosed, never folded into either bound. No catch-all arm may land in a
 *     definite class.
 * Post evidence OUTRANKS a failure marker (a post-commit failure follows a charge that happened). A settled call that a
 * void or release marker contradicts, with no post evidence, is uncertain. "Prior charge known" (an unrecoverable
 * record) is not post evidence for the transfer it names.
 */
type TransferClass = "debited" | "uncertain" | "not-debited";

interface TransferEvidence {
	spend?: PersistedAuditEvent; // the first call/action record
	spendSettledFalse: boolean;
	ledgerPosted: boolean;
	ambiguity?: PersistedAuditEvent;
	shortfall?: PersistedAuditEvent;
	void: boolean;
	release: boolean;
	/**
	 * Something the evidence set does not name sits beside the spend record: a sibling of an unrecognised kind, or a second
	 * spend record of one kind. It is not post evidence and not a void: the settled-call arm cannot call it definite.
	 */
	foreign: boolean;
}

function classifyTransfer(ev: TransferEvidence): TransferClass {
	const post =
		ev.shortfall !== undefined ||
		ev.ambiguity !== undefined ||
		ev.ledgerPosted ||
		(ev.spend !== undefined && !ev.spendSettledFalse && !ev.void && !ev.release && !ev.foreign);
	if (post) return "debited";
	if ((ev.void || ev.release) && ev.spend === undefined) return "not-debited";
	// A void or release marker beside a spend record that is not itself post evidence: the record says it was settled, the
	// marker says it was not. Uncertain. A spend record marked settled:false with nothing else: also uncertain. Anything
	// else the evidence set does not name is uncertain too: there is no catch-all into a definite class.
	return "uncertain";
}

/**
 * "This transfer's charge is known": the debited class AND no ambiguity. An ambiguous settle is counted by the governor's
 * counter, but whether the LEDGER charged it is exactly what the ambiguity says is unknown, so it is never claimed as
 * "already charged". Derived from the same evidence as `classifyTransfer`, never from the presence of a spend record.
 */
function chargeEvidenced(ev: TransferEvidence): boolean {
	// POST evidence, not merely a debit: a dry-run headless settle is 'debited' (the counter added it) and moved no money, and
	// an SDK call's record says nothing about the post. Only a record the ledger answered (ledgerPosted / postedAmount) or a
	// shortfall proves a charge; everything else reads unknown, the conservative direction.
	return (
		classifyTransfer(ev) === "debited" &&
		ev.ambiguity === undefined &&
		(ev.ledgerPosted || ev.shortfall !== undefined)
	);
}

/** The amount the counter would have added for a transfer, from the best record carrying it. */
function transferAmount(
	ev: TransferEvidence,
): { ut: number; event: PersistedAuditEvent } | undefined {
	for (const e of [ev.spend, ev.ambiguity]) {
		if (e === undefined) continue;
		const c = cost(e.data["cost"]);
		if (c !== undefined) return { ut: c, event: e };
	}
	if (ev.shortfall !== undefined) {
		const actual = cost(ev.shortfall.data["actual"]);
		if (actual !== undefined) return { ut: actual, event: ev.shortfall };
	}
	return undefined;
}

/**
 * Records that may sit beside a spend record for one transfer without contradicting it: a shortfall is the ledger
 * reporting the posted amount, an implausible-usage flag is an annotation. Any OTHER kind for the same transfer (a
 * failure, an ambiguity, a release, a kind this reader has never heard of) unconfirms the spend: a closed allowlist, so
 * a future kind defaults to unconfirmed rather than to charged.
 */
/**
 * The record `destroy()` writes for a terminal still in flight at its deadline: its void had not completed, so whether
 * the funds came back is not known. The prefix mirrors the reason text in `headless.ts` (a test pins that it is still
 * there).
 */
export const UNKNOWN_VOID_REASON_PREFIX = "governor destroyed (terminal still in flight";

function isUnknownVoidRelease(e: PersistedAuditEvent): boolean {
	const reason = e.data["reason"];
	return typeof reason === "string" && reason.startsWith(UNKNOWN_VOID_REASON_PREFIX);
}

const BENIGN_SIBLINGS: ReadonlySet<string> = new Set([
	"settlement_shortfall",
	"usage_implausible",
	"injection_detected",
	// A DETECTION is not an abort: govern.ts appends it when the anomaly detector trips, and a stream whose settlement wins the
	// abort race (or whose emitter cannot abort) still settles as an ordinary charged call. An abort that did void the call
	// leaves its own terminal (`llm_call_failed`, `stream_partial_delivery`), which contradicts the call on its own.
	"anomaly_detected",
]);

/**
 * The kinds recorded beside one transfer's spend record that can contradict it: everything but its own kind, a release
 * (judged on its own terms) and the benign allowlist. The ONE definition, read by `standing()` and by the budget
 * classifier alike, so an invented kind unconfirms the spend in the one and leaves the transfer uncertain in the other
 * instead of passing as definite in the second.
 */
function siblingKinds(ks: ReadonlyMap<string, number> | undefined, ownKind: string | undefined) {
	return [...(ks?.keys() ?? [])].filter(
		(k) => k !== ownKind && k !== "hold_released" && !BENIGN_SIBLINGS.has(k),
	);
}

export type Standing =
	| { kind: "confirmed"; postProven: boolean }
	| { kind: "unconfirmed"; reason: "unsettled" | "uncorrelated" | "contradicted" }
	| { kind: "released" };

export function buildWeeklyReport(
	events: readonly PersistedAuditEvent[],
	integrity: IntegrityInfo,
	opts: ReportOptions,
): ReportModel {
	return brand(buildPlain(events, integrity, opts));
}

/**
 * The ONE place the denomination brands are applied. The builder below keeps one accumulator per denomination and never
 * sums across them; this cast only stamps what it already kept apart.
 */
function brand(m: Plain<ReportModel>): ReportModel {
	return m as unknown as ReportModel;
}

function buildPlain(
	events: readonly PersistedAuditEvent[],
	integrity: IntegrityInfo,
	opts: ReportOptions,
): Plain<ReportModel> {
	const days = opts.windowDays ?? 7;
	const endMs = opts.endMs;
	const startMs = endMs - days * 24 * HOUR_MS;
	const agentKey = opts.agentKey ?? "auto";
	const topN = opts.topN ?? 10;

	// A row that is not an event (a null, a missing or non-object `data`, a non-string `kind`) cannot be read: it is skipped
	// and counted, so one bad line never turns the report into a crash with no verification diagnostics.
	const usable = events.filter(isUsableEvent);
	const malformedEvents = events.length - usable.length;

	// Whole-chain indexes: a sibling record can sit outside the window of the call it qualifies.
	const kindsByTransfer = new Map<string, Map<string, number>>();
	const unprovenReleases = new Set<string>();
	const postedByTransfer = new Map<string, number>();
	const spendTransfers = new Set<string>();
	const postProvenTransfers = new Set<string>();
	const shortfallByTransfer = new Map<string, number>();
	for (const e of usable) {
		const tid = str(e.data["transferId"]);
		if (tid === undefined) continue;
		const ks = kindsByTransfer.get(tid) ?? new Map<string, number>();
		ks.set(e.kind, (ks.get(e.kind) ?? 0) + 1);
		kindsByTransfer.set(tid, ks);
		// A release is proof of "not charged" only when its void is known to have completed.
		if (
			e.kind === "hold_released" &&
			(e.data["voidError"] !== undefined || isUnknownVoidRelease(e))
		) {
			unprovenReleases.add(tid);
		}
		const isAction = isActionEvent(e);
		if (e.kind === "llm_call" || isAction) {
			spendTransfers.add(tid);
			// A headless record says `ledgerPosted` only once the ledger ANSWERED the post: a dry run records
			// `settled: true` too, and moved no money.
			if (
				e.data["source"] === "headless" &&
				e.data["settled"] === true &&
				e.data["ledgerPosted"] === true
			)
				postProvenTransfers.add(tid);
		} else if (e.kind === "settlement_shortfall") {
			postProvenTransfers.add(tid);
			const sf = cost(e.data["shortfall"]);
			if (sf !== undefined) shortfallByTransfer.set(tid, sf);
			const posted = cost(e.data["posted"]);
			if (posted !== undefined) postedByTransfer.set(tid, posted);
		}
	}

	const standing = (e: PersistedAuditEvent): Standing => {
		const tid = str(e.data["transferId"]);
		if (e.data["settled"] === false) return { kind: "unconfirmed", reason: "unsettled" };
		if (tid === undefined) return { kind: "unconfirmed", reason: "uncorrelated" };
		const ks = kindsByTransfer.get(tid);
		const proven = postProvenTransfers.has(tid);
		// Two spend records of one kind for one transfer cannot both be the charge.
		if ((ks?.get(e.kind) ?? 0) > 1) return { kind: "unconfirmed", reason: "contradicted" };
		// Post evidence OUTRANKS a failure marker, as in `classifyTransfer`: a post-commit failure (failClosed) follows a
		// charge that already happened and must not turn it back into an uncharged call.
		const others = siblingKinds(ks, e.kind).filter((k) => !(proven && k.endsWith("_failed")));
		if (others.length > 0) return { kind: "unconfirmed", reason: "contradicted" };
		if (ks?.has("hold_released")) {
			// A release beside a proven post, or one whose void is not known to have completed, proves nothing.
			if (proven || unprovenReleases.has(tid))
				return { kind: "unconfirmed", reason: "contradicted" };
			return { kind: "released" };
		}
		return { kind: "confirmed", postProven: postProvenTransfers.has(tid) };
	};

	const t = {
		confirmedUt: 0,
		confirmedCalls: 0,
		estimatedUt: 0,
		estimatedCalls: 0,
		unconfirmedUt: 0,
		unconfirmedCalls: 0,
		unconfirmedNominalCalls: 0,
		unconfirmedNominalUt: 0,
		unconfirmedUnlabelledCalls: 0,
		unconfirmedUnlabelledUt: 0,
		contradictedCalls: 0,
		releasedCalls: 0,
		uncorrelatedCalls: 0,
		postProvenUt: 0,
		postProvenCalls: 0,
		postProvenUpperUt: 0,
		postProvenUpperCalls: 0,
		postProvenDeadLetterUt: 0,
		postProvenDeadLetterCalls: 0,
		unconfirmedActionCalls: 0,
		unconfirmedActionUt: 0,
		unlabelledUt: 0,
		unlabelledCalls: 0,
		unsettledCalls: 0,
		nominalCalls: 0,
		nominalUt: 0,
		actionUt: 0,
		actionCalls: 0,
		malformedCalls: 0,
		malformedEvents,
	};
	const agents = new Map<string, { calls: number; ut: number }>();
	const sessions = new Map<string, { calls: number; ut: number }>();
	const models = new Map<string, { calls: number; ut: number; basis: Set<string> }>();
	const tiers: Plain<TierBreakdown> = {
		calls: 0,
		costUt: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cacheWrite1hTokens: 0,
		inputUt: 0,
		outputUt: 0,
		cacheReadUt: 0,
		cacheWriteUt: 0,
		cacheWrite1hUt: 0,
		cacheWriteShare: null,
		roundingUt: 0,
	};
	const tops: Plain<TopCost>[] = [];
	const hourly = new Array<number>(days * 24).fill(0);
	const governance: Record<string, number> = Object.fromEntries(
		GOVERNANCE_KINDS.map((k) => [k, 0]),
	);
	const unrecoverable = {
		records: 0,
		priorChargeKnown: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
	const unrecognised = new Map<string, number>();
	const ungovernedByMethod = new Map<string, number>();
	let ungovernedCalls = 0;
	// Per-transfer evidence for the budget leg (see classifyTransfer), over the WHOLE chain, in chain order.
	const evidence = new Map<string, TransferEvidence>();
	let anonymous = 0;
	for (const e of usable) {
		const k = str(e.data["transferId"]);
		const isSpend = (e.kind === "llm_call" && !isActionEvent(e)) || isActionEvent(e);
		const key = k ?? (isSpend ? `\u0000anon:${anonymous++}` : undefined);
		if (key === undefined) continue;
		const ev = evidence.get(key) ?? {
			spendSettledFalse: false,
			ledgerPosted: false,
			void: false,
			release: false,
			foreign: false,
		};
		evidence.set(key, ev);
		if (isSpend) {
			if (ev.spend === undefined) {
				ev.spend = e;
				ev.spendSettledFalse = e.data["settled"] === false;
			}
			if (e.data["ledgerPosted"] === true) ev.ledgerPosted = true;
		} else if (e.kind === "settlement_ambiguous") ev.ambiguity ??= e;
		else if (e.kind === "settlement_shortfall") {
			ev.shortfall ??= e;
			if (e.data["ledgerPosted"] === true) ev.ledgerPosted = true;
		} else if (e.kind === "hold_released") ev.release = true;
		else if (e.kind.endsWith("_failed")) ev.void = true;
	}
	for (const [key, ev] of evidence) {
		if (key.startsWith("\u0000")) continue;
		const ks = kindsByTransfer.get(key);
		const own = ev.spend?.kind;
		ev.foreign =
			siblingKinds(ks, own).some((k) => k !== "settlement_ambiguous" && !k.endsWith("_failed")) ||
			(own !== undefined && (ks?.get(own) ?? 0) > 1);
	}
	// SHA-256 of every spend transfer's id, computed once and only when an unrecoverable record asks (the record stores
	// the hash of the id, never the id).
	let spendHashes: Set<string> | undefined;
	const spendTransferHashes = (): Set<string> => {
		spendHashes ??= new Set(
			[...evidence.entries()]
				.filter(([key, ev]) => !key.startsWith("\u0000") && chargeEvidenced(ev))
				.map(([key]) => createHash("sha256").update(key).digest("hex")),
		);
		return spendHashes;
	};
	const orphaned = new Map<string, { records: number; amount: number }>();
	const orphanedCharge = { records: 0, posted: 0 };
	let shortfallEvents = 0;
	let shortfallUt = 0;
	let recordedSessionUt = 0;
	let recordedAttributedUt = 0;
	let windowSessionUt = 0;
	let windowAttributedUt = 0;
	// The same four, in NOMINAL units: a separate accumulator per denomination, so no sum ever crosses them.
	let recordedSessionNominal = 0;
	let recordedAttributedNominal = 0;
	let windowSessionNominal = 0;
	let windowAttributedNominal = 0;
	// UNCERTAIN transfers (counted and disclosed, in neither bound's definite figure): a single wallet number, no split.
	let recordedSessionUndenominated = 0;
	let recordedAttributedUndenominated = 0;
	let windowSessionUndenominated = 0;
	let windowAttributedUndenominated = 0;
	let recordedSessionUncertain = 0;
	let recordedAttributedUncertain = 0;
	let uncertainTransfers = 0;
	for (const ev of evidence.values()) {
		const klass = classifyTransfer(ev);
		if (klass === "not-debited") continue;
		const amt = transferAmount(ev);
		if (amt === undefined) continue;
		const attributed = str(amt.event.data["costCenter"]) !== undefined;
		if (klass === "uncertain") {
			uncertainTransfers += 1;
			if (attributed) recordedAttributedUncertain += amt.ut;
			else recordedSessionUncertain += amt.ut;
			continue;
		}
		const ms = Date.parse(amt.event.timestamp);
		const inWindow = Number.isFinite(ms) && ms >= startMs && ms < endMs;
		const nominal = denominationOf(amt.event) === "nominal";
		// A standalone shortfall or ambiguity (the call record never landed) has an amount but usually no denomination:
		// wallet units, out of the usd and nominal figures. A call record's own unlabelled cost stays where it was.
		if (
			(amt.event.kind === "settlement_shortfall" || amt.event.kind === "settlement_ambiguous") &&
			denominationOf(amt.event) === "unlabelled"
		) {
			if (attributed) recordedAttributedUndenominated += amt.ut;
			else recordedSessionUndenominated += amt.ut;
			if (inWindow) {
				if (attributed) windowAttributedUndenominated += amt.ut;
				else windowSessionUndenominated += amt.ut;
			}
			continue;
		}
		if (nominal) {
			if (attributed) recordedAttributedNominal += amt.ut;
			else recordedSessionNominal += amt.ut;
			if (inWindow) {
				if (attributed) windowAttributedNominal += amt.ut;
				else windowSessionNominal += amt.ut;
			}
		} else {
			if (attributed) recordedAttributedUt += amt.ut;
			else recordedSessionUt += amt.ut;
			if (inWindow) {
				if (attributed) windowAttributedUt += amt.ut;
				else windowSessionUt += amt.ut;
			}
		}
	}

	for (const e of usable) {
		const tid = str(e.data["transferId"]);
		const ms = Date.parse(e.timestamp);
		const inWindow = Number.isFinite(ms) && ms >= startMs && ms < endMs;

		if (e.kind === "llm_call" && !isActionEvent(e)) {
			const c = cost(e.data["cost"]);
			const denomination = denominationOf(e);
			if (!Number.isFinite(ms)) {
				t.malformedCalls += 1;
				continue;
			}
			if (!inWindow) continue;
			if (c === undefined) {
				t.malformedCalls += 1;
				continue;
			}
			const st = standing(e);
			if (st.kind === "released") {
				t.releasedCalls += 1;
				continue;
			}
			if (st.kind === "unconfirmed") {
				// Unconfirmed NOMINAL units are not dollars: they are counted, never added to the dollar figure.
				if (denomination === "nominal") {
					t.unconfirmedNominalCalls += 1;
					t.unconfirmedNominalUt += c;
				} else if (denomination === "unlabelled") {
					t.unconfirmedUnlabelledCalls += 1;
					t.unconfirmedUnlabelledUt += c;
				} else t.unconfirmedUt += c;
				t.unconfirmedCalls += 1;
				if (st.reason === "unsettled") t.unsettledCalls += 1;
				else if (st.reason === "uncorrelated") t.uncorrelatedCalls += 1;
				else t.contradictedCalls += 1;
				continue;
			}
			if (denomination === "nominal") {
				t.nominalCalls += 1;
				t.nominalUt += c;
				continue;
			}
			t.confirmedUt += c;
			t.confirmedCalls += 1;
			if (st.postProven) {
				// What the ledger POSTED, not the metered cost: a capped post records the lower figure.
				const chainPosted = tid !== undefined ? postedByTransfer.get(tid) : undefined;
				// A USABLE amount only. A shortfall record means the post was LESS than the metered cost, so one whose `posted` is
				// absent or not a count says "capped" without saying by how much: that is an upper bound, never the metered cost as
				// if it were exact.
				const recorded = cost(e.data["postedAmount"]);
				const dl = opts.deadLetters;
				const dead =
					tid !== undefined && dl !== undefined && "shortfalls" in dl
						? dl.shortfalls.get(tid)
						: undefined;
				if (chainPosted !== undefined) {
					t.postProvenUt += chainPosted;
					t.postProvenCalls += 1;
				} else if (recorded !== undefined) {
					// A record that carries what the ledger POSTED (`postedAmount`, written with the call) is exact by construction:
					// no later append is needed to tell a capped post from a full one.
					t.postProvenUt += recorded;
					t.postProvenCalls += 1;
				} else if (dead !== undefined) {
					// Only a dead-lettered shortfall (the writer's queue, read once with the completeness check) gives the posted
					// amount for an older record; an EMPTY queue proves nothing, because the shortfall may not have been appended yet.
					t.postProvenUt += dead;
					t.postProvenCalls += 1;
					t.postProvenDeadLetterUt += dead;
					t.postProvenDeadLetterCalls += 1;
				} else {
					// This record format cannot tell a capped post from an uncapped one (the shortfall is appended AFTER the call,
					// so a snapshot between the two appends, or a crash between them, sees the same shape), and a shortfall with no
					// usable amount does not say how much moved. At most the metered cost moved.
					t.postProvenUpperUt += c;
					t.postProvenUpperCalls += 1;
				}
			}
			if (denomination === "unlabelled") {
				t.unlabelledUt += c;
				t.unlabelledCalls += 1;
			}
			const model = str(e.data["model"]) ?? "unknown";
			const agent = agentOf(e, agentKey, opts.segment);
			const a = agents.get(agent) ?? { calls: 0, ut: 0 };
			a.calls += 1;
			a.ut += c;
			agents.set(agent, a);
			const origin = agentOf(e, "principal.origin", undefined);
			if (origin !== UNATTRIBUTED) {
				const sRow = sessions.get(origin) ?? { calls: 0, ut: 0 };
				sRow.calls += 1;
				sRow.ut += c;
				sessions.set(origin, sRow);
			}
			const m = models.get(model) ?? { calls: 0, ut: 0, basis: new Set<string>() };
			m.calls += 1;
			m.ut += c;
			const basis = str(e.data["costBasis"]);
			const source = str(e.data["rateSource"]);
			m.basis.add(
				basis === undefined && source === undefined
					? "not recorded"
					: `${basis ?? "?"}/${source ?? "?"}`,
			);
			models.set(model, m);
			const hour = Math.min(days * 24 - 1, Math.floor((ms - startMs) / HOUR_MS));
			hourly[hour] = (hourly[hour] ?? 0) + c;

			if (e.data["usageSource"] === "estimated") {
				t.estimatedUt += c;
				t.estimatedCalls += 1;
			} else {
				const u = e.data["usage"];
				const r = e.data["appliedRates"];
				if (
					e.data["usageSource"] === "provider" &&
					u !== null &&
					typeof u === "object" &&
					r !== null &&
					typeof r === "object"
				) {
					const uu = u as Record<string, unknown>;
					const rr = r as Record<string, unknown>;
					const inp = count(uu["inputTokens"]);
					const out = count(uu["outputTokens"]);
					const cr = count(uu["cacheReadTokens"]);
					const cw = count(uu["cacheWriteTokens"]);
					// The 1-hour share of the write total, with the rate it was priced at (a sibling of `usage` on the
					// event, as on the receipt). Clamped to the write total so a malformed row cannot make the 5-minute
					// remainder negative.
					const w1 = e.data["cacheWrite1h"];
					const w1Rec =
						w1 !== null && typeof w1 === "object" ? (w1 as Record<string, unknown>) : undefined;
					const cw1h = Math.min(cw, count(w1Rec?.["tokens"]));
					const r1h = count(w1Rec?.["ratePer1k"]);
					// An absent cache rate prices at the input rate (AGENTS.md D1), so the tier split follows suit.
					const rin = count(rr["inputPer1k"]);
					const rout = count(rr["outputPer1k"]);
					const rcr = typeof rr["cacheReadPer1k"] === "number" ? count(rr["cacheReadPer1k"]) : rin;
					const rcw =
						typeof rr["cacheWritePer1k"] === "number" ? count(rr["cacheWritePer1k"]) : rin;
					tiers.calls += 1;
					tiers.costUt += c;
					tiers.inputTokens += inp;
					tiers.outputTokens += out;
					tiers.cacheReadTokens += cr;
					tiers.cacheWriteTokens += cw;
					tiers.cacheWrite1hTokens += cw1h;
					tiers.inputUt += (inp * rin) / 1000;
					tiers.outputUt += (out * rout) / 1000;
					tiers.cacheReadUt += (cr * rcr) / 1000;
					tiers.cacheWriteUt += ((cw - cw1h) * rcw + cw1h * r1h) / 1000;
					tiers.cacheWrite1hUt += (cw1h * r1h) / 1000;
				}
			}
			// `id` and `hash` come from a vault that may be malformed: a missing or non-string one is an empty string,
			// never a crash in the renderer or the tie-break sort.
			tops.push({
				id: typeof e.id === "string" ? e.id : "",
				timestamp: e.timestamp,
				model,
				agent,
				transferId: tid ?? "",
				ut: c,
				hash: typeof e.hash === "string" ? e.hash : "",
			});
			const sf = tid !== undefined ? shortfallByTransfer.get(tid) : undefined;
			if (sf !== undefined && sf > 0) {
				shortfallEvents += 1;
				shortfallUt += sf;
			}
			continue;
		}

		if (!inWindow) continue;

		// ONE RULE for every record that only QUALIFIES a call (a shortfall, an ambiguity, an implausible-usage note, a
		// failure marker): with no spend record for its transfer it is disclosed as a record without its call. Its amount
		// is shown without assuming a denomination and is in no spend total. A standalone shortfall's `posted` is the
		// only evidence of a ledger charge whose call record never landed.
		if (isQualifierKind(e.kind) && (tid === undefined || !spendTransfers.has(tid))) {
			// Bounded like `unrecognised`: hostile kinds cannot grow the table without limit.
			const orphanKey = orphaned.size >= 50 && !orphaned.has(e.kind) ? "(more kinds)" : e.kind;
			const row = orphaned.get(orphanKey) ?? { records: 0, amount: 0 };
			row.records += 1;
			const shown =
				e.kind === "settlement_shortfall" ? cost(e.data["posted"]) : cost(e.data["cost"]);
			if (shown !== undefined) row.amount += shown;
			orphaned.set(orphanKey, row);
			if (e.kind === "settlement_shortfall") {
				orphanedCharge.records += 1;
				orphanedCharge.posted += cost(e.data["posted"]) ?? 0;
			}
		}

		// An ambiguity with no spend record of its own (a stream that never reached its audit append): the cost it
		// carries is unconfirmed spend, shown, never dropped.
		if (e.kind === "settlement_ambiguous" && (tid === undefined || !spendTransfers.has(tid))) {
			const c = cost(e.data["cost"]);
			if (str(e.data["actionKind"]) !== undefined || str(e.data["actionName"]) !== undefined) {
				// An action's ambiguity belongs to the action totals, never to model spend.
				t.unconfirmedActionCalls += 1;
				if (c !== undefined) t.unconfirmedActionUt += c;
			} else {
				// A standalone ambiguity usually carries no denomination: it is shown, never assumed to be dollars.
				const d = denominationOf(e);
				if (d === "nominal") {
					t.unconfirmedNominalCalls += 1;
					if (c !== undefined) t.unconfirmedNominalUt += c;
				} else if (d === "unlabelled") {
					t.unconfirmedUnlabelledCalls += 1;
					if (c !== undefined) t.unconfirmedUnlabelledUt += c;
				} else if (c !== undefined) t.unconfirmedUt += c;
				t.unconfirmedCalls += 1;
				t.contradictedCalls += 1;
			}
		}

		if ((GOVERNANCE_KINDS as readonly string[]).includes(e.kind)) {
			governance[e.kind] = (governance[e.kind] ?? 0) + 1;
			continue;
		}
		// A governed non-LLM action: its own line, never merged into model spend.
		if (isActionEvent(e)) {
			const c = cost(e.data["cost"]);
			if (c === undefined) continue;
			const st = standing(e);
			if (st.kind === "confirmed") {
				t.actionUt += c;
				t.actionCalls += 1;
			} else if (st.kind === "unconfirmed") {
				t.unconfirmedActionUt += c;
				t.unconfirmedActionCalls += 1;
			}
		} else if (e.kind === "settlement_unrecoverable") {
			// Served, never charged: usage and no cost. Disclosed, in no spend or budget figure.
			unrecoverable.records += 1;
			const idHash = str(e.data["transferIdHash"]);
			if (idHash !== undefined && spendTransferHashes().has(idHash))
				unrecoverable.priorChargeKnown += 1;
			const u = e.data["usage"];
			const uu = u !== null && typeof u === "object" ? (u as Record<string, unknown>) : {};
			unrecoverable.inputTokens += count(uu["inputTokens"]);
			unrecoverable.outputTokens += count(uu["outputTokens"]);
			unrecoverable.cacheReadTokens += count(uu["cacheReadTokens"]);
			unrecoverable.cacheWriteTokens += count(uu["cacheWriteTokens"]);
		} else if (!KNOWN_KINDS.has(e.kind) && !e.kind.endsWith("_failed")) {
			// A kind outside the closed set this report reads: counted, never dropped. Bounded so hostile kinds cannot
			// grow the table without limit.
			const key = unrecognised.size >= 50 && !unrecognised.has(e.kind) ? "(more kinds)" : e.kind;
			unrecognised.set(key, (unrecognised.get(key) ?? 0) + 1);
		} else if (e.kind === "ungoverned_call") {
			// After the known-kinds gate, so KNOWN_KINDS stays the one place a kind becomes readable. Counted by method and
			// added to no figure: a `cost` it carries is never summed. The label is vault data, bounded like `unrecognised`.
			ungovernedCalls += 1;
			const method = ownStringDataProperty(e.data, "method");
			const label = method === undefined || method === "" ? UNKNOWN_METHOD : method;
			const key =
				ungovernedByMethod.size >= 50 && !ungovernedByMethod.has(label) ? "(more methods)" : label;
			ungovernedByMethod.set(key, (ungovernedByMethod.get(key) ?? 0) + 1);
		}
	}

	const tierSum = tiers.inputUt + tiers.outputUt + tiers.cacheReadUt + tiers.cacheWriteUt;
	tiers.cacheWriteShare = tierSum > 0 ? tiers.cacheWriteUt / tierSum : null;
	tiers.roundingUt = tierSum - tiers.costUt;

	const configured = typeof opts.budget === "number" && opts.budget > 0 ? opts.budget : null;
	const sessionWallet = recordedSessionUt + recordedSessionNominal + recordedSessionUndenominated;
	const upperWallet =
		sessionWallet +
		recordedSessionUncertain +
		recordedAttributedUt +
		recordedAttributedNominal +
		recordedAttributedUndenominated +
		recordedAttributedUncertain;
	const ledger = opts.spendLedger;
	// The counter is BELOW the lower bound: the one disagreement that could make a definite claim false (see overBudgetDisputed).
	const counterBelowLower =
		ledger !== undefined && !("unreadable" in ledger) && ledger.value < sessionWallet;
	const spendLedgerLeg =
		ledger === undefined
			? { recorded: null, unreadable: false, differs: false, difference: null }
			: "unreadable" in ledger
				? { recorded: null, unreadable: true, differs: true, difference: null }
				: {
						recorded: ledger.value,
						unreadable: false,
						differs: ledger.value < sessionWallet || ledger.value > upperWallet,
						difference:
							ledger.value < sessionWallet || ledger.value > upperWallet
								? ledger.value - sessionWallet
								: null,
					};
	const notes: string[] = [];
	if (!integrity.verified) {
		notes.push(
			"The audit chain did NOT verify. Every figure below is computed from an UNVERIFIED chain and must not be relied on.",
		);
	}
	if (t.unconfirmedCalls > 0) {
		notes.push(
			`${t.unconfirmedCalls} call(s) are unconfirmed (${t.contradictedCalls} with a failure, ambiguity or other record beside them, ${t.unsettledCalls} explicitly settled: false, ${t.uncorrelatedCalls} with no transfer id): the ledger charge is not proven. They are shown as unconfirmed, not counted as spent.`,
		);
	}
	if (t.unconfirmedActionCalls > 0) {
		notes.push(
			`${t.unconfirmedActionCalls} governed action(s) are unconfirmed on the same rules and are not in the action total.`,
		);
	}
	if (shortfallEvents > 0) {
		notes.push(
			`${shortfallEvents} settlement(s) were capped at the ledger hold. Budget figures use the METERED spend (what the provider charges); the ledger posted ${shortfallUt} usertoken(s) less, shown on the shortfall line.`,
		);
	}
	if (t.releasedCalls > 0) {
		notes.push(
			`${t.releasedCalls} call(s) had their hold released (hold_released): nothing was charged. They are in no spend or budget figure.`,
		);
	}
	if (t.unconfirmedUnlabelledCalls > 0) {
		notes.push(
			`${t.unconfirmedUnlabelledCalls} unconfirmed call(s) record no denomination (${t.unconfirmedUnlabelledUt} usertokens): they are not shown as dollars.`,
		);
	}
	if (t.unconfirmedNominalCalls > 0) {
		notes.push(
			`${t.unconfirmedNominalCalls} unconfirmed call(s) are denominated in nominal units and are not shown as dollars.`,
		);
	}
	if (recordedAttributedUt > 0) {
		notes.push(
			"Spend carrying a cost center is reported as attributed: the chain does not record whether the cost-center envelope or the session paid, so it bounds the budget figure instead of being assumed away.",
		);
	}
	if (t.unlabelledCalls > 0) {
		notes.push(
			`${t.unlabelledCalls} confirmed call(s) record no cost basis (older headless rows): they are shown as dollars at the usertoken rate, separately labelled, and may include nominal units.`,
		);
	}
	if (t.malformedEvents > 0) {
		notes.push(
			`${t.malformedEvents} row(s) in the chain were not readable events and are in no figure.`,
		);
	}
	if (t.estimatedCalls > 0) {
		notes.push(
			`${t.estimatedCalls} confirmed call(s) were priced from an ESTIMATE (the provider reported no usage); they have no token split.`,
		);
	}
	if (t.nominalCalls > 0) {
		notes.push(
			`${t.nominalCalls} call(s) are denominated in nominal units (a local endpoint) and are excluded from dollar totals.`,
		);
	}
	if (t.malformedCalls > 0) {
		notes.push(
			`${t.malformedCalls} llm_call row(s) had no readable cost or timestamp and are in no figure.`,
		);
	}
	const unattributed = agents.get(UNATTRIBUTED);
	if (unattributed !== undefined && unattributed.ut > 0) {
		notes.push(
			`${unattributed.calls} call(s) carry no ${agentKey === "auto" ? "cost center or principal" : agentKey}; they are one row, not spread across agents.`,
		);
	}

	return {
		window: {
			startIso: new Date(startMs).toISOString(),
			endIso: new Date(endMs).toISOString(),
			days,
		},
		integrity,
		agentKey: { requested: agentKey, segment: opts.segment ?? null },
		totals: t,
		shortfall: { events: shortfallEvents, ut: shortfallUt },
		byAgent: toRows(agents, t.confirmedUt),
		bySession: toRows(sessions, t.confirmedUt),
		byModel: [...models.entries()]
			.map(([key, v]) => ({
				key,
				provider: detectProvider(key),
				calls: v.calls,
				ut: v.ut,
				share: t.confirmedUt > 0 ? v.ut / t.confirmedUt : 0,
				costBasis: [...v.basis].sort(),
			}))
			.sort((a, b) => b.ut - a.ut || a.key.localeCompare(b.key)),
		tiers,
		topCosts: tops.sort((a, b) => b.ut - a.ut || a.id.localeCompare(b.id)).slice(0, topN),
		hourlyUt: hourly,
		budget: {
			configuredUt: configured,
			unknown: opts.budgetUnreadable === true,
			source: configured === null ? null : (opts.budgetSource ?? "vault config"),
			windowSessionUt,
			recordedSessionUt,
			windowAttributedUt,
			recordedAttributedUt,
			windowSessionNominal,
			recordedSessionNominal,
			windowAttributedNominal,
			recordedAttributedNominal,
			windowSessionWallet: windowSessionUt + windowSessionNominal + windowSessionUndenominated,
			recordedSessionWallet:
				recordedSessionUt + recordedSessionNominal + recordedSessionUndenominated,
			recordedSessionUndenominated,
			recordedAttributedUndenominated,
			windowSessionUndenominated,
			windowAttributedUndenominated,
			windowAttributedWallet:
				windowAttributedUt + windowAttributedNominal + windowAttributedUndenominated,
			recordedAttributedWallet:
				recordedAttributedUt + recordedAttributedNominal + recordedAttributedUndenominated,
			recordedSessionUncertain,
			recordedAttributedUncertain,
			uncertainTransfers,
			usedFraction: configured === null ? null : Math.min(1, sessionWallet / configured),
			usedFractionUpper: configured === null ? null : Math.min(1, upperWallet / configured),
			overBudget: configured !== null && sessionWallet > configured && !counterBelowLower,
			overBudgetDisputed: configured !== null && sessionWallet > configured && counterBelowLower,
			possiblyOverBudget:
				configured !== null &&
				((sessionWallet > configured && counterBelowLower) ||
					(sessionWallet <= configured && upperWallet > configured)),
		},
		governance,
		unrecoverable,
		spendLedger: spendLedgerLeg,
		withoutCall: Object.fromEntries([...orphaned.entries()].sort(([a], [b]) => a.localeCompare(b))),
		chargedUnrecorded: orphanedCharge,
		unrecognised: Object.fromEntries(
			[...unrecognised.entries()].sort(([a], [b]) => a.localeCompare(b)),
		),
		ungoverned: {
			calls: ungovernedCalls,
			byMethod: Object.fromEntries(
				[...ungovernedByMethod.entries()].sort(([a], [b]) => a.localeCompare(b)),
			),
		},
		notes,
	};
}
