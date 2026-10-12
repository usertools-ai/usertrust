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

import type { PersistedAuditEvent } from "../audit/read.js";

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
}

export interface IntegrityInfo {
	verified: boolean;
	errors: readonly string[];
	chainLength: number;
	firstEvent: string | null;
	lastEvent: string | null;
}

export interface Row {
	key: string;
	calls: number;
	ut: number;
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
	ut: number;
	hash: string;
}

export interface TierBreakdown {
	/** Calls priced from provider-reported four-tier usage. */
	calls: number;
	/** Their metered cost (Σ data.cost). */
	costUt: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	/** TOTAL cache-write tokens (5-minute plus 1-hour). */
	cacheWriteTokens: number;
	/** Of which written to the 1-hour cache, priced at its own rate (`data.cacheWrite1h`). */
	cacheWrite1hTokens: number;
	/** tokens × appliedRates / 1000, per tier. Unrounded: per-call cost is ceil'd, so the tiers sum to ≈ costUt. */
	inputUt: number;
	outputUt: number;
	cacheReadUt: number;
	/** TOTAL cache-write cost: the 5-minute remainder at `cacheWritePer1k` plus the 1-hour tokens at their own rate. */
	cacheWriteUt: number;
	/** Of which the 1-hour tokens. */
	cacheWrite1hUt: number;
	/** cacheWriteUt / Σ tiers, 0..1; `null` when there is nothing to divide. A cost DRIVER, never "avoidable". */
	cacheWriteShare: number | null;
	/** Σ tiers − costUt: the rounding the per-call ceil introduces. Printed so the tiers visibly reconcile. */
	roundingUt: number;
}

export interface ReportModel {
	window: { startIso: string; endIso: string; days: number };
	integrity: IntegrityInfo;
	agentKey: { requested: AgentKey; segment: number | null };
	totals: {
		/** Spend: confirmed `llm_call` cost denominated in dollars (see the module comment). */
		confirmedUt: number;
		confirmedCalls: number;
		/** The part of confirmed spend whose usage was an ESTIMATE (no provider-reported counts). */
		estimatedUt: number;
		estimatedCalls: number;
		/** The part of confirmed spend whose row records no `costBasis`: its denomination is ASSUMED to be dollars. */
		unlabelledUt: number;
		unlabelledCalls: number;
		/** `llm_call`s with a `settlement_ambiguous` for the same transfer, or an explicit `settled: false`: not spent. */
		unconfirmedUt: number;
		unconfirmedCalls: number;
		/** Unconfirmed calls denominated in nominal units: counted here, never added to `unconfirmedUt` (dollars). */
		unconfirmedNominalCalls: number;
		/** Of those, the ones that are an explicit `settled: false` (the rest have a settlement_ambiguous record). */
		unsettledCalls: number;
		/** Of the unconfirmed calls, those contradicted by another record for the same transfer (a failure or ambiguity marker, a release, an unknown kind). */
		contradictedCalls: number;
		/** Calls whose hold was proven released: nothing was charged, and they are in no spend or budget figure. */
		releasedCalls: number;
		/** Of the unconfirmed, those with no `transferId` to correlate. */
		uncorrelatedCalls: number;
		/** Confirmed spend whose post is PROVEN by a record written after it (a headless record, or a `settlement_shortfall`). */
		postProvenUt: number;
		postProvenCalls: number;
		/** Governed actions that are unconfirmed (same rules as calls): counted here, never added to `actionUt`. */
		unconfirmedActionCalls: number;
		unconfirmedActionUt: number;
		/** `costBasis: "nominal"` rows (or an unlabelled local-endpoint row): unit counts, excluded from dollar totals. */
		nominalCalls: number;
		nominalUt: number;
		/** Governed non-LLM actions (kind = action.kind, `data.actionName`): a separate line, never merged. */
		actionUt: number;
		actionCalls: number;
		/** `llm_call` rows in the window with no usable cost, or an unreadable timestamp. */
		malformedCalls: number;
		/** Rows that are not events at all (no `data` object, no string `kind`): skipped. */
		malformedEvents: number;
	};
	/** `settlement_shortfall`: the metered cost exceeded what the ledger could post. */
	shortfall: { events: number; ut: number };
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
	hourlyUt: number[];
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
		configuredUt: number | null;
		source: string | null;
		/** Spend with no cost center, in the window / over the whole chain: it debited the session wallet. */
		windowSessionUt: number;
		recordedSessionUt: number;
		/** Spend WITH a cost center, in the window / over the whole chain: payer not recorded (envelope, or session in dry run). */
		windowAttributedUt: number;
		recordedAttributedUt: number;
		/** 0..1 lower bound (session spend only), clamped; `null` when no budget is configured. */
		usedFraction: number | null;
		/** 0..1 upper bound (session + attributed spend), clamped; `null` when no budget is configured. */
		usedFractionUpper: number | null;
		/** The unattributed spend alone exceeds the budget. */
		overBudget: boolean;
		/** Only counting the attributed spend as well would exceed it: the payer decides. */
		possiblyOverBudget: boolean;
	};
	governance: Record<string, number>;
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
]);

const HOUR_MS = 3_600_000;

function str(v: unknown): string | undefined {
	return typeof v === "string" && v !== "" ? v : undefined;
}

function cost(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function count(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

export function detectProvider(model: string): string {
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

function toRows(m: Map<string, { calls: number; ut: number }>, total: number): Row[] {
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
	return (
		!NON_ACTION_KINDS.has(e.kind) &&
		!e.kind.endsWith("_failed") &&
		str(e.data["actionName"]) !== undefined
	);
}

function denominationOf(e: PersistedAuditEvent): "usd" | "nominal" | "unlabelled" {
	const basis = e.data["costBasis"];
	if (basis === "usd-proxy") return "usd";
	if (basis === "nominal") return "nominal";
	return e.data["endpointClass"] === "local" ? "nominal" : "unlabelled";
}

/**
 * What a row debited, and from which wallet: a finite non-negative `cost` on an `llm_call` or a governed action,
 * unless the settle is ambiguous or explicitly `settled: false`. A row carrying a cost center debits that envelope, not
 * the session wallet the configured budget belongs to. `undefined` for a row that debited nothing readable.
 */
function walletDebit(
	e: PersistedAuditEvent,
	standing: (e: PersistedAuditEvent) => Standing,
): { ut: number; attributed: boolean } | undefined {
	const isCall = e.kind === "llm_call";
	const isAction = isActionEvent(e);
	if (!isCall && !isAction) return undefined;
	const c = cost(e.data["cost"]);
	if (c === undefined || standing(e).kind !== "confirmed") return undefined;
	return { ut: c, attributed: str(e.data["costCenter"]) !== undefined };
}

/**
 * Records that may sit beside a spend record for one transfer without contradicting it: a shortfall is the ledger
 * reporting the posted amount, an implausible-usage flag is an annotation. Any OTHER kind for the same transfer (a
 * failure, an ambiguity, a release, a kind this reader has never heard of) unconfirms the spend: a closed allowlist, so
 * a future kind defaults to unconfirmed rather than to charged.
 */
const BENIGN_SIBLINGS: ReadonlySet<string> = new Set(["settlement_shortfall", "usage_implausible"]);

export type Standing =
	| { kind: "confirmed"; postProven: boolean }
	| { kind: "unconfirmed"; reason: "unsettled" | "uncorrelated" | "contradicted" }
	| { kind: "released" };

export function buildWeeklyReport(
	events: readonly PersistedAuditEvent[],
	integrity: IntegrityInfo,
	opts: ReportOptions,
): ReportModel {
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
	const kindsByTransfer = new Map<string, Set<string>>();
	const spendTransfers = new Set<string>();
	const postProvenTransfers = new Set<string>();
	const shortfallByTransfer = new Map<string, number>();
	for (const e of usable) {
		const tid = str(e.data["transferId"]);
		if (tid === undefined) continue;
		const ks = kindsByTransfer.get(tid) ?? new Set<string>();
		ks.add(e.kind);
		kindsByTransfer.set(tid, ks);
		const isAction = isActionEvent(e);
		if (e.kind === "llm_call" || isAction) {
			spendTransfers.add(tid);
			// A headless record is written after the ledger answered the post.
			if (e.data["source"] === "headless" && e.data["settled"] === true)
				postProvenTransfers.add(tid);
		} else if (e.kind === "settlement_shortfall") {
			postProvenTransfers.add(tid);
			const sf = cost(e.data["shortfall"]);
			if (sf !== undefined) shortfallByTransfer.set(tid, sf);
		}
	}

	const standing = (e: PersistedAuditEvent): Standing => {
		const tid = str(e.data["transferId"]);
		if (e.data["settled"] === false) return { kind: "unconfirmed", reason: "unsettled" };
		if (tid === undefined) return { kind: "unconfirmed", reason: "uncorrelated" };
		const ks = kindsByTransfer.get(tid);
		if (ks?.has("hold_released")) return { kind: "released" };
		for (const k of ks ?? []) {
			if (k !== e.kind && !BENIGN_SIBLINGS.has(k))
				return { kind: "unconfirmed", reason: "contradicted" };
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
		contradictedCalls: 0,
		releasedCalls: 0,
		uncorrelatedCalls: 0,
		postProvenUt: 0,
		postProvenCalls: 0,
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
	const tiers: TierBreakdown = {
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
	const tops: TopCost[] = [];
	const hourly = new Array<number>(days * 24).fill(0);
	const governance: Record<string, number> = Object.fromEntries(
		GOVERNANCE_KINDS.map((k) => [k, 0]),
	);
	let shortfallEvents = 0;
	let shortfallUt = 0;
	let recordedSessionUt = 0;
	let recordedAttributedUt = 0;
	let windowSessionUt = 0;
	let windowAttributedUt = 0;

	for (const e of usable) {
		const tid = str(e.data["transferId"]);
		const ms = Date.parse(e.timestamp);
		const inWindow = Number.isFinite(ms) && ms >= startMs && ms < endMs;

		// BUDGET: every debit of a wallet, `llm_call` and governed action alike, over the WHOLE chain. A call attributed to
		// a cost-center envelope debits that envelope, not the session wallet the configured budget belongs to.
		const wallet = walletDebit(e, standing);
		if (wallet !== undefined) {
			if (wallet.attributed) recordedAttributedUt += wallet.ut;
			else recordedSessionUt += wallet.ut;
			if (inWindow) {
				if (wallet.attributed) windowAttributedUt += wallet.ut;
				else windowSessionUt += wallet.ut;
			}
		}

		if (e.kind === "llm_call") {
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
				if (denomination === "nominal") t.unconfirmedNominalCalls += 1;
				else t.unconfirmedUt += c;
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
				t.postProvenUt += c;
				t.postProvenCalls += 1;
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

		// An ambiguity with no spend record of its own (a stream that never reached its audit append): the cost it
		// carries is unconfirmed spend, shown, never dropped.
		if (e.kind === "settlement_ambiguous" && (tid === undefined || !spendTransfers.has(tid))) {
			const c = cost(e.data["cost"]);
			if (denominationOf(e) === "nominal") t.unconfirmedNominalCalls += 1;
			else if (c !== undefined) t.unconfirmedUt += c;
			t.unconfirmedCalls += 1;
			t.contradictedCalls += 1;
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
		}
	}

	const tierSum = tiers.inputUt + tiers.outputUt + tiers.cacheReadUt + tiers.cacheWriteUt;
	tiers.cacheWriteShare = tierSum > 0 ? tiers.cacheWriteUt / tierSum : null;
	tiers.roundingUt = tierSum - tiers.costUt;

	const configured = typeof opts.budget === "number" && opts.budget > 0 ? opts.budget : null;
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
	if (t.releasedCalls > 0) {
		notes.push(
			`${t.releasedCalls} call(s) had their hold released (hold_released): nothing was charged. They are in no spend or budget figure.`,
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
			`${t.unlabelledCalls} confirmed call(s) record no cost basis (headless rows); their denomination is assumed to be dollars at the usertoken rate.`,
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
			source: configured === null ? null : (opts.budgetSource ?? "vault config"),
			windowSessionUt,
			recordedSessionUt,
			windowAttributedUt,
			recordedAttributedUt,
			usedFraction: configured === null ? null : Math.min(1, recordedSessionUt / configured),
			usedFractionUpper:
				configured === null
					? null
					: Math.min(1, (recordedSessionUt + recordedAttributedUt) / configured),
			overBudget: configured !== null && recordedSessionUt > configured,
			possiblyOverBudget:
				configured !== null &&
				recordedSessionUt <= configured &&
				recordedSessionUt + recordedAttributedUt > configured,
		},
		governance,
		notes,
	};
}
