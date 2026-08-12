// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Entropy Diagnostics — Governance Health Signal
 *
 * Derives 6 entropy signals from audit event data to assess governance
 * health. Entropy is a diagnostic signal, not a runtime gate.
 *
 * Signals:
 *   1. Policy violations
 *   2. Budget utilization
 *   3. Chain integrity
 *   4. PII detections
 *   5. Circuit breaker trips
 *   6. Pattern memory hits
 *
 * Returns a composite score 0–100 (0 = healthy, 100 = maximum entropy).
 *
 * ── PRODUCER PARITY ──
 *
 * These signals read events written elsewhere, so their matchers are a CONTRACT
 * with the producers in `src/` — and nothing in the type system holds the two
 * sides together. Field names here must be the field names written there.
 *
 * `tests/audit/entropy-producer-parity.test.ts` is that contract, executable:
 * every fixture in it is copied from a real `appendEvent` call site and cited by
 * file:line, so a producer whose shape drifts away from a signal fails there.
 * Hand-written fixtures cannot do this job — a matcher and a fixture invented
 * together will agree with each other and with nothing else. Extend THAT file
 * when a producer changes, and if the change stops a signal firing, the signal is
 * what needs updating.
 *
 * Two signals — budget utilization and chain integrity — cannot be derived from
 * chain events at all: no producer writes budget totals, and chain validity is a
 * property of the log rather than of any event in it. They are supplied by the
 * caller through {@link EntropyContext}, which is what `cli/health.ts` already
 * computes for its own per-line display.
 */

// ── Types ──

export interface EntropyEventInput {
	kind: string;
	data: Record<string, unknown>;
}

/**
 * Facts the caller knows that the event stream cannot carry.
 *
 * Optional so a caller with only events still gets the four event-derived
 * signals; the two context-derived signals then report `total: 0` (no data)
 * rather than a fabricated zero.
 */
export interface EntropyContext {
	/** Session budget and cumulative spend, in usertokens. */
	budget?: { total: number; spent: number };
	/** The result of an actual `verifyChain` run over the audit log. */
	chain?: { valid: boolean; errors?: readonly string[] };
}

export interface EntropySignal {
	/** Machine-readable condition identifier */
	condition: string;
	/** Human-readable label */
	label: string;
	/** Signal value 0–1 (0 = no entropy, 1 = full entropy) */
	value: number;
	/** Number of events exhibiting this condition */
	hits: number;
	/** Total relevant events evaluated */
	total: number;
}

export type EntropyLevel = "low" | "elevated" | "critical";

export interface EntropyReport {
	/** Composite score 0–100 (weighted average of all signals, scaled) */
	score: number;
	/** Human-readable level derived from score */
	level: EntropyLevel;
	/** Per-signal breakdown */
	signals: EntropySignal[];
	/** ISO-8601 timestamp when the report was computed */
	computedAt: string;
	/** Number of events analyzed */
	eventCount: number;
}

// ── Signal extractors ──

/**
 * Governance DENIAL kinds, named explicitly rather than matched by substring.
 *
 * `policy_denied` happens to contain "policy"; `ledger_rejected` does not, and
 * a substring filter alone therefore made an atomic ledger refusal — the
 * worst-diagnosed denial class there is — invisible to `usertrust health`.
 */
const DENIAL_EVENT_KINDS = new Set(["policy_denied", "ledger_rejected"]);

/**
 * Evidence-bearing array test.
 *
 * An EMPTY array is not a detection — `redactPII` only attaches `piiDetected`
 * when `detection.found`, but a future producer attaching `[]` unconditionally
 * must not turn every event into a PII hit.
 */
function nonEmptyArray(v: unknown): boolean {
	return Array.isArray(v) && v.length > 0;
}

/**
 * Signal 1: Policy violations
 *
 * Events where kind contains "policy", or is a governance denial kind, and data
 * indicates a deny/block decision.
 */
export function extractPolicyViolations(events: EntropyEventInput[]): EntropySignal {
	const policyEvents = events.filter(
		(e) => e.kind.includes("policy") || DENIAL_EVENT_KINDS.has(e.kind),
	);
	let hits = 0;

	for (const e of policyEvents) {
		const decision = e.data.decision;
		if (decision === "deny" || decision === "block" || decision === "blocked") {
			hits++;
		}
	}

	const total = policyEvents.length;
	return {
		condition: "policy_violations",
		label: "Policy violations",
		value: total > 0 ? hits / total : 0,
		hits,
		total,
	};
}

/** Utilization above which budget burn starts contributing entropy. */
const BUDGET_PRESSURE_FLOOR = 0.8;

/**
 * Signal 2: Budget utilization
 *
 * NO audit event carries a budget total. The old implementation looked for
 * `data.spent` / `data.budgetTotal` (never written by anything) and for a
 * NUMERIC `data.budget` — the one event that does carry `budget`,
 * `policy_denied`, carries it as an OBJECT (`{estimatedCost, budgetRemaining}`),
 * which fails `typeof === "number"`. Neither shape is reachable from the event
 * stream.
 *
 * Utilization is a property of the session, not of any event, so it comes from
 * {@link EntropyContext}. Falls back to summing `llm_call.cost` when the caller
 * supplies a total but no spend.
 *
 * Ramped, not binary: entropy stays 0 up to {@link BUDGET_PRESSURE_FLOOR} and
 * rises to 1 at exhaustion, so an ordinary half-spent budget still scores
 * healthy and a nearly-exhausted one is visible before it denies.
 */
export function extractBudgetUtilization(
	events: EntropyEventInput[],
	context?: EntropyContext,
): EntropySignal {
	const budget = context?.budget;
	const base = {
		condition: "budget_utilization",
		label: `Budget utilization (>${Math.round(BUDGET_PRESSURE_FLOOR * 100)}%)`,
	};

	// No total means no denominator — report "no data", never a fabricated zero.
	if (budget === undefined || !Number.isFinite(budget.total) || budget.total <= 0) {
		return { ...base, value: 0, hits: 0, total: 0 };
	}

	let spent = budget.spent;
	if (!Number.isFinite(spent)) {
		spent = 0;
		for (const e of events) {
			if (e.kind !== "llm_call") continue;
			const cost = e.data.cost;
			if (typeof cost === "number" && Number.isFinite(cost)) spent += cost;
		}
	}

	const utilization = Math.max(0, spent) / budget.total;
	const value =
		utilization > BUDGET_PRESSURE_FLOOR
			? Math.min(1, (utilization - BUDGET_PRESSURE_FLOOR) / (1 - BUDGET_PRESSURE_FLOOR))
			: 0;

	return { ...base, value, hits: value > 0 ? 1 : 0, total: 1 };
}

/**
 * Signal 3: Chain integrity
 *
 * The old implementation required the event KIND to contain "audit", "chain" or
 * "verify". No producer kind does — the real kinds are `llm_call`,
 * `llm_call_failed`, `settlement_ambiguous`, `settlement_shortfall`,
 * `anomaly_detected`, `injection_detected`, `stream_partial_delivery`,
 * `policy_denied`, `ledger_rejected`, `budget_allocated` and the tool-action
 * kinds, so no event ever matched on kind alone.
 *
 * Two genuinely different integrity facts feed this now:
 *
 *   - **The log itself**, via {@link EntropyContext.chain} — whether `verifyChain`
 *     accepts the hash chain. That is a property of the FILE and appears in no
 *     event, which is why it has to be passed in.
 *   - **Money↔audit desync**, via `settlement_ambiguous` — the audit chain records
 *     a spend the ledger may or may not hold. The chain hashes are intact, but the
 *     record no longer provably matches the money, which is the same question an
 *     operator is asking when they ask about integrity.
 *
 * `settlement_shortfall` is deliberately NOT counted: a truncated post is a
 * RECONCILED outcome with both halves recorded, not a desync.
 */
export function extractChainIntegrity(
	events: EntropyEventInput[],
	context?: EntropyContext,
): EntropySignal {
	let hits = 0;
	let total = 0;

	const chain = context?.chain;
	if (chain !== undefined) {
		total++;
		if (!chain.valid || (chain.errors !== undefined && chain.errors.length > 0)) hits++;
	}

	// Rate, not presence: every settlement terminal is an observation, and the
	// ambiguous ones are the failures. Counting only the failures would pin the
	// signal near 1.0 on a single ambiguous settlement in a million clean calls.
	for (const e of events) {
		if (e.kind === "llm_call") total++;
		else if (e.kind === "settlement_ambiguous") {
			total++;
			hits++;
		}
	}

	return {
		condition: "chain_integrity",
		label: "Chain integrity failures",
		value: total > 0 ? hits / total : 0,
		hits,
		total,
	};
}

/**
 * Signal 4: PII detections
 *
 * Events where PII was detected in the data flow.
 */
export function extractPiiDetections(events: EntropyEventInput[]): EntropySignal {
	let hits = 0;
	const total = events.length;

	for (const e of events) {
		const pii = e.data.piiDetected;
		const piiTypes = e.data.piiTypes;
		const piiPaths = e.data.piiPaths;
		const piiCount = e.data.piiCount;
		const piiAction = e.data.piiAction;

		if (
			// `govern.ts:2391` and `:1778` write `piiDetected =
			// piiResult.detection.types` — a `string[]`, which is the shape to match.
			// An array is never `=== true`, so the boolean form below cannot stand in
			// for it.
			nonEmptyArray(pii) ||
			// `piiTypes` is the denial-event spelling (`denial-events.ts:76`),
			// written when PII BLOCKED the call outright.
			nonEmptyArray(piiTypes) ||
			nonEmptyArray(piiPaths) ||
			// Retained: a boolean or a count is a reasonable shape for a future
			// producer, and accepting it costs nothing.
			pii === true ||
			(typeof piiCount === "number" && piiCount > 0) ||
			piiAction === "redact" ||
			piiAction === "block"
		) {
			hits++;
		}
	}

	return {
		condition: "pii_detections",
		label: "PII detections",
		value: total > 0 ? hits / total : 0,
		hits,
		total,
	};
}

/**
 * Signal 5: Circuit breaker / anomaly aborts
 *
 * The old implementation required the kind to contain "circuit" or "breaker", or
 * `data.circuitBreaker` to be present. No kind matches, and `circuitBreaker`
 * appears in `src/` only as a CONFIG key (`config.circuitBreaker.failureThreshold`)
 * — never as event data. `circuitBreakerState` and `circuitBreakerTripped` are
 * written nowhere at all, so none of those names is reachable.
 *
 * What a breaker trip actually leaves on the chain is `anomaly_detected`
 * (`govern.ts:2073` mid-stream, `:2284` on the generic path) — the anomaly
 * detector firing and aborting the call. Provider failures that feed
 * `cb.recordFailure()` surface as `llm_call_failed`.
 *
 * The rate is against CALL TERMINALS, so one abort in a thousand clean calls
 * reads as one in a thousand.
 */
export function extractCircuitBreakerTrips(events: EntropyEventInput[]): EntropySignal {
	let hits = 0;
	let total = 0;

	for (const e of events) {
		const isTerminal =
			e.kind === "llm_call" || e.kind === "llm_call_failed" || e.kind === "anomaly_detected";
		const legacyShape =
			e.kind.includes("circuit") ||
			e.kind.includes("breaker") ||
			e.data.circuitBreaker !== undefined;
		if (!isTerminal && !legacyShape) continue;

		total++;
		const state = e.data.circuitBreakerState ?? e.data.state;
		const tripped = e.data.circuitBreakerTripped ?? e.data.tripped;

		if (
			e.kind === "anomaly_detected" ||
			e.kind === "llm_call_failed" ||
			state === "open" ||
			state === "half-open" ||
			tripped === true
		) {
			hits++;
		}
	}

	return {
		condition: "circuit_breaker_trips",
		label: "Circuit breaker / anomaly aborts",
		value: total > 0 ? hits / total : 0,
		hits,
		total,
	};
}

/**
 * Signal 6: Pattern matches (prompt-injection detections)
 *
 * The old implementation required the kind to contain "pattern" or "memory", or
 * `data.patternMatch` to be present. None exist. `patternMatch`,
 * `anomalyDetected` and `recurringIssue` are written nowhere in `src/` — note
 * the near-miss on the fourth: the producer writes the KIND `anomaly_detected`,
 * never a `data.anomalyDetected` boolean, so the two never met. It evaluated
 * zero events on every real chain.
 *
 * The real pattern-matching producer is the injection scanner, which writes
 * `injection_detected` carrying the matched `patterns` array and a `score`.
 */
export function extractPatternMemoryHits(events: EntropyEventInput[]): EntropySignal {
	let hits = 0;
	let total = 0;

	for (const e of events) {
		const isScanned =
			e.kind === "llm_call" || e.kind === "llm_call_failed" || e.kind === "injection_detected";
		const legacyShape =
			e.kind.includes("pattern") || e.kind.includes("memory") || e.data.patternMatch !== undefined;
		if (!isScanned && !legacyShape) continue;

		total++;
		if (
			e.kind === "injection_detected" ||
			nonEmptyArray(e.data.patterns) ||
			e.data.patternMatch === true ||
			e.data.anomalyDetected === true ||
			e.data.recurringIssue === true
		) {
			hits++;
		}
	}

	return {
		condition: "pattern_memory_hits",
		label: "Injection pattern matches",
		value: total > 0 ? hits / total : 0,
		hits,
		total,
	};
}

// ── Composite ──

const EXTRACTORS: ReadonlyArray<
	(events: EntropyEventInput[], context?: EntropyContext) => EntropySignal
> = [
	extractPolicyViolations,
	extractBudgetUtilization,
	extractChainIntegrity,
	extractPiiDetections,
	extractCircuitBreakerTrips,
	extractPatternMemoryHits,
];

function classifyLevel(score: number): EntropyLevel {
	if (score >= 60) return "critical";
	if (score >= 30) return "elevated";
	return "low";
}

/**
 * Compute the composite entropy report from audit events.
 *
 * The mean is taken over signals that actually HAVE data (`total > 0`), not over
 * all six. A flat six-way mean is what made the old score unable to leave
 * a narrow band: a signal with no observations used to vote zero and drag the
 * mean down by a full share, bounding what the live signals could express. A
 * signal with no observations now abstains instead of voting zero — so a caller
 * that supplies no {@link EntropyContext} is not silently penalised for it, and
 * a real problem in one live signal can still reach "critical".
 *
 * @param events - Array of audit events to analyze
 * @param context - Facts the event stream cannot carry (budget, chain validity)
 * @returns Entropy report with composite score and per-signal breakdown
 */
export function computeEntropyScore(
	events: EntropyEventInput[],
	context?: EntropyContext,
): EntropyReport {
	const signals = EXTRACTORS.map((fn) => fn(events, context));

	const scored = signals.filter((s) => s.total > 0);
	const sum = scored.reduce((acc, s) => acc + s.value, 0);
	const rawScore = scored.length > 0 ? sum / scored.length : 0;
	const score = Math.round(rawScore * 100);

	return {
		score,
		level: classifyLevel(score),
		signals,
		computedAt: new Date().toISOString(),
		eventCount: events.length,
	};
}
