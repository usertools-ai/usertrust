// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The weekly spend report's MODEL: a pure function from an ordered audit chain to the figures a CFO reads.
 *
 * No filesystem, no clock, no network. Every figure is derived from event rows the model names, so a reader can
 * recompute it, and each rule below states what the figure is NOT, because the report is the one artifact a
 * customer forwards to someone who never saw the chain.
 *
 * What is counted as SPEND, and what is deliberately not:
 *   - `llm_call` with a finite, non-negative `data.cost`, in the window, whose `transferId` has NO
 *     `settlement_ambiguous` anywhere in the chain. `settled: true` on `llm_call` is written optimistically BEFORE the
 *     ledger POST (govern.ts), so it cannot be trusted alone: an ambiguous settle is UNCONFIRMED, never spent.
 *   - `endpointClass: "local"` rows carry a nominal 1-UT floor, not dollars: shown, excluded from dollar totals.
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
	/** `budget` from the vault config; 0 or absent means none configured. */
	budget?: number;
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
	cacheWriteTokens: number;
	/** tokens × appliedRates / 1000, per tier. Unrounded: per-call cost is ceil'd, so the tiers sum to ≈ costUt. */
	inputUt: number;
	outputUt: number;
	cacheReadUt: number;
	cacheWriteUt: number;
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
		/** Spend: confirmed, non-local `llm_call` cost. */
		confirmedUt: number;
		confirmedCalls: number;
		/** The part of confirmed spend whose usage was an ESTIMATE (no provider-reported counts). */
		estimatedUt: number;
		estimatedCalls: number;
		/** `llm_call`s with a later/earlier `settlement_ambiguous` for the same transfer: not counted as spent. */
		unconfirmedUt: number;
		unconfirmedCalls: number;
		/** `endpointClass: "local"` rows: nominal units, excluded from dollar totals. */
		localCalls: number;
		localNominalUt: number;
		/** Governed non-LLM actions (kind = action.kind, `data.actionName`): a separate line, never merged. */
		actionUt: number;
		actionCalls: number;
		/** `llm_call` rows in the window with no usable cost, or an unreadable timestamp. */
		malformedCalls: number;
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
	budget: {
		configuredUt: number | null;
		windowUt: number;
		/** Confirmed spend over the WHOLE chain (every time, same exclusions), the figure compared with the budget. */
		recordedUt: number;
		/** 0..1 used, clamped; `null` when no budget is configured. */
		usedFraction: number | null;
		overBudget: boolean;
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
	if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
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

	// Whole-chain indexes: an ambiguity or a shortfall can be recorded outside the window of the call it corrects.
	const ambiguous = new Set<string>();
	const shortfallByTransfer = new Map<string, number>();
	for (const e of events) {
		const tid = str(e.data["transferId"]);
		if (tid === undefined) continue;
		if (e.kind === "settlement_ambiguous") ambiguous.add(tid);
		else if (e.kind === "settlement_shortfall") {
			const s = cost(e.data["shortfall"]);
			if (s !== undefined) shortfallByTransfer.set(tid, s);
		}
	}

	const t = {
		confirmedUt: 0,
		confirmedCalls: 0,
		estimatedUt: 0,
		estimatedCalls: 0,
		unconfirmedUt: 0,
		unconfirmedCalls: 0,
		localCalls: 0,
		localNominalUt: 0,
		actionUt: 0,
		actionCalls: 0,
		malformedCalls: 0,
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
		inputUt: 0,
		outputUt: 0,
		cacheReadUt: 0,
		cacheWriteUt: 0,
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
	let recordedUt = 0;

	for (const e of events) {
		const tid = str(e.data["transferId"]);
		const ms = Date.parse(e.timestamp);
		const inWindow = Number.isFinite(ms) && ms >= startMs && ms < endMs;

		if (e.kind === "llm_call") {
			const c = cost(e.data["cost"]);
			const isAmbiguous = tid !== undefined && ambiguous.has(tid);
			const isLocal = e.data["endpointClass"] === "local";
			// Whole-chain recorded spend, for the budget comparison: same exclusions as the window figure.
			if (c !== undefined && !isAmbiguous && !isLocal) recordedUt += c;
			if (!Number.isFinite(ms)) {
				t.malformedCalls += 1;
				continue;
			}
			if (!inWindow) continue;
			if (c === undefined) {
				t.malformedCalls += 1;
				continue;
			}
			if (isAmbiguous) {
				t.unconfirmedUt += c;
				t.unconfirmedCalls += 1;
				continue;
			}
			if (isLocal) {
				t.localCalls += 1;
				t.localNominalUt += c;
				continue;
			}
			t.confirmedUt += c;
			t.confirmedCalls += 1;
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
					tiers.inputUt += (inp * rin) / 1000;
					tiers.outputUt += (out * rout) / 1000;
					tiers.cacheReadUt += (cr * rcr) / 1000;
					tiers.cacheWriteUt += (cw * rcw) / 1000;
				}
			}
			tops.push({
				id: e.id,
				timestamp: e.timestamp,
				model,
				agent,
				transferId: tid ?? "",
				ut: c,
				hash: e.hash,
			});
			const sf = tid !== undefined ? shortfallByTransfer.get(tid) : undefined;
			if (sf !== undefined && sf > 0) {
				shortfallEvents += 1;
				shortfallUt += sf;
			}
			continue;
		}

		if (!inWindow) continue;

		if ((GOVERNANCE_KINDS as readonly string[]).includes(e.kind)) {
			governance[e.kind] = (governance[e.kind] ?? 0) + 1;
			continue;
		}
		// A governed non-LLM action: its own line, never merged into model spend.
		if (!NON_ACTION_KINDS.has(e.kind) && str(e.data["actionName"]) !== undefined) {
			const c = cost(e.data["cost"]);
			if (c !== undefined && !(tid !== undefined && ambiguous.has(tid))) {
				t.actionUt += c;
				t.actionCalls += 1;
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
			`${t.unconfirmedCalls} call(s) have a settlement_ambiguous record: the ledger POST may not have completed. They are shown as unconfirmed, not counted as spent.`,
		);
	}
	if (t.estimatedCalls > 0) {
		notes.push(
			`${t.estimatedCalls} confirmed call(s) were priced from an ESTIMATE (the provider reported no usage); they have no token split.`,
		);
	}
	if (t.localCalls > 0) {
		notes.push(
			`${t.localCalls} call(s) went to a local endpoint and carry nominal units, excluded from dollar totals.`,
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
			windowUt: t.confirmedUt,
			recordedUt,
			usedFraction: configured === null ? null : Math.min(1, recordedUt / configured),
			overBudget: configured !== null && recordedUt > configured,
		},
		governance,
		notes,
	};
}
