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
	/**
	 * This signal ALONE justifies a critical headline, regardless of the others.
	 *
	 * Set by the extractor, which is the only place that knows what its own value
	 * means. The composite previously inferred dominance from `value >= 1`, and
	 * that works for a binary signal and silently fails for a RATE — where 1.0
	 * means "every observation was bad" rather than "something disqualifying
	 * happened". Signals that measure proportions (policy denials, PII, injection)
	 * deliberately never set this: a single denial is governance working, and a
	 * monitor that cries wolf gets muted, taking the real signal with it.
	 */
	critical?: boolean;
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

	// NO fallback to summing `llm_call.cost`. An ATTRIBUTED call debits its
	// cost-center envelope and deliberately does NOT move session `budgetSpent`
	// (AGENTS.md; `govern.ts` sessionShare), so summing chain costs against the
	// SESSION budget counts money the session never paid — cost-center-heavy
	// traffic would report an untouched session budget as exhausted. Only the
	// caller knows the persisted session spend, so without it this abstains.
	if (!Number.isFinite(budget.spent)) {
		return { ...base, value: 0, hits: 0, total: 0 };
	}

	const utilization = Math.max(0, budget.spent) / budget.total;
	const value =
		utilization > BUDGET_PRESSURE_FLOOR
			? Math.min(1, (utilization - BUDGET_PRESSURE_FLOOR) / (1 - BUDGET_PRESSURE_FLOOR))
			: 0;

	// An EXHAUSTED budget is an operational state, not a proportion of one. With
	// four other live signals clean, exhaustion scored 1 against their 0s for a
	// mean of 20 — "healthy", at 100% utilization. That is the same averaging
	// dilution the chain signal already had a floor for, and I fixed it there and
	// left it here: I had identified the CLASS in the comment beside that floor
	// and then applied it to one member.
	return { ...base, value, hits: value > 0 ? 1 : 0, total: 1, critical: utilization >= 1 };
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
	const chain = context?.chain;
	const chainFailed =
		chain !== undefined &&
		(!chain.valid || (chain.errors !== undefined && chain.errors.length > 0));

	// Desync rate, deduplicated BY TRANSFER. `settlement_ambiguous` is a
	// CORRECTION appended alongside the same transfer's primary terminal, so
	// counting events would score one failed settlement as 1/2 — and keying on
	// `transferId` rather than on a list of kinds keeps this correct for the
	// dynamic `<action.kind>` terminals, which cannot be enumerated here.
	const observedTransfers = new Set<string>();
	const ambiguousTransfers = new Set<string>();
	for (const e of events) {
		const id = e.data.transferId;
		if (typeof id !== "string" || id === "") continue;
		// SETTLEMENT ATTEMPTS only. A denial, an anomaly abort and a partial
		// delivery all carry a `transferId` but never reached settlement, so
		// counting them as observations diluted the rate against calls that could
		// not have desynced: one ambiguous settlement among 99 denials read as a
		// 1% desync rate when 100% of actual settlement attempts had failed.
		// `settled` is the discriminator rather than a kind list, because the
		// governed-action terminals are dynamic (`<action.kind>`) and cannot be
		// enumerated from here.
		const isSettlementAttempt =
			e.data.settled !== undefined ||
			e.kind === "settlement_ambiguous" ||
			e.kind === "settlement_shortfall";
		if (!isSettlementAttempt) continue;
		observedTransfers.add(id);
		if (e.kind === "settlement_ambiguous") ambiguousTransfers.add(id);
	}
	const desyncRate =
		observedTransfers.size > 0 ? ambiguousTransfers.size / observedTransfers.size : 0;

	// A failed chain verification is BINARY and DOMINATES. Averaging it into the
	// desync rate made it `1 / (N + 1)`: one verification failure invalidates the
	// entire chain no matter how many calls preceded it, so a large tampered
	// vault would otherwise dilute its own tampering down to nearly nothing —
	// the bigger the vault, the healthier it would look.
	const value = chainFailed ? 1 : desyncRate;
	const hits = (chainFailed ? 1 : 0) + ambiguousTransfers.size;
	const total = (chain !== undefined ? 1 : 0) + observedTransfers.size;

	return {
		condition: "chain_integrity",
		label: "Chain integrity failures",
		value,
		hits,
		total,
		// PRESENCE, not rate. The composite used to floor on `value >= 1`, which for
		// this signal is an ambiguity RATE — so it only fired when EVERY observed
		// settlement was ambiguous. One ambiguous settlement beside one clean one
		// scored 0.5, the headline stayed healthy, and the chain line printed
		// `[critical]` right underneath it. Two readings of one fact, disagreeing.
		//
		// The signal knows whether it saw something disqualifying; the composite
		// should not have to re-derive that from a number whose meaning it cannot
		// see. A chain that failed, or a settlement nobody can resolve, is not a
		// proportion of a problem.
		critical: chainFailed || ambiguousTransfers.size > 0,
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
	// KEYED BY TRANSFER, not by event. One anomaly-aborted stream writes BOTH
	// `anomaly_detected` and `stream_partial_delivery` with the same transferId,
	// so counting events made a single aborted call report hits=1 total=2
	// value=0.5 — a call cannot be half-aborted. Each governed call contributes
	// one observation and at most one hit.
	const observed = new Set<string>();
	const aborted = new Set<string>();
	// Records with no transferId (legacy or malformed) still count, keyed by a
	// per-event token so they cannot collide with each other or with a real id.
	let anonymous = 0;
	let anonymousHits = 0;

	// A DETECTION IS NOT AN ABORT. `govern.ts` appends `anomaly_detected` and only
	// THEN calls `emitter.abort()` if the emitter has one — so an emitter without
	// `abort`, or a settlement that wins the race, leaves a detection followed by a
	// perfectly ordinary settled call. Counting the detection made that a hit and
	// reported an abort that never happened.
	//
	// This is the same rule the receipt verifier settled on for the same event,
	// which is why it is stated the same way: a detection is evidence that
	// something FIRED, never that the call STOPPED. Only a correlated failure
	// terminal is evidence of the stop.
	const stoppedIds = new Set<string>();
	for (const e of events) {
		const id = e.data.transferId;
		if (typeof id !== "string" || id === "") continue;
		if (
			e.kind === "stream_partial_delivery" ||
			e.kind === "llm_call_failed" ||
			e.kind.endsWith("_failed") ||
			e.data.settled === false
		) {
			stoppedIds.add(id);
		}
	}

	for (const e of events) {
		const isTerminal =
			e.kind === "llm_call" ||
			e.kind === "llm_call_failed" ||
			e.kind === "anomaly_detected" ||
			e.kind === "stream_partial_delivery" ||
			e.data.settled !== undefined ||
			e.kind.endsWith("_failed");
		const legacyShape =
			e.kind.includes("circuit") ||
			e.kind.includes("breaker") ||
			e.data.circuitBreaker !== undefined;
		if (!isTerminal && !legacyShape) continue;

		const state = e.data.circuitBreakerState ?? e.data.state;
		const tripped = e.data.circuitBreakerTripped ?? e.data.tripped;
		// `llm_call_failed` is an observation, NOT a hit: the breaker opens on the
		// fifth consecutive failure by default, so counting the first ordinary
		// provider error as a trip reports trips that never happened.
		const id = e.data.transferId;
		// A detection counts only where a correlated failure terminal shows the call
		// actually stopped. With no transferId there is nothing to correlate against,
		// so the legacy shape keeps its old behaviour rather than silently losing
		// hits in old vaults — an under-count here would hide real aborts.
		const correlatable = typeof id === "string" && id !== "";
		const detectionStopped =
			e.kind === "anomaly_detected" && (!correlatable || stoppedIds.has(id as string));
		const isHit = detectionStopped || state === "open" || state === "half-open" || tripped === true;

		if (typeof id === "string" && id !== "") {
			observed.add(id);
			if (isHit) aborted.add(id);
		} else {
			anonymous++;
			if (isHit) anonymousHits++;
		}
	}

	const total = observed.size + anonymous;
	const hits = aborted.size + anonymousHits;
	return {
		condition: "circuit_breaker_trips",
		label: "Anomaly aborts",
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
	// KEYED BY TRANSFER, like the anomaly signal, and for the same three reasons.
	//
	//  - One scanned call can write MORE THAN ONE terminal: under `failClosed`
	//    after a sticky audit degradation it appends its `llm_call` (or action
	//    event), commits, then appends the matching `_failed` with the same id.
	//    Counting events made one call two observations.
	//  - `injection_detected` now carries its own `transferId` (`govern.ts`), so a
	//    detection is attributed to ITS call. Reconciling aggregate counts
	//    mis-attributed whenever a detected call was rejected and a different
	//    clean call completed — reporting 1/1 where the truth was 1/2.
	//  - A detection whose call never reached a terminal still has to count, or
	//    the signal disappears exactly when the flagged call did not complete.
	const scanned = new Set<string>();
	const detected = new Set<string>();
	let anonymousScanned = 0;
	let anonymousDetected = 0;

	const evidence = (e: EntropyEventInput): boolean =>
		e.kind === "injection_detected" ||
		nonEmptyArray(e.data.injectionPatterns) ||
		nonEmptyArray(e.data.patterns) ||
		e.data.patternMatch === true ||
		e.data.anomalyDetected === true ||
		e.data.recurringIssue === true;

	for (const e of events) {
		// HEADLESS calls never ran injection detection. `createGovernor()` writes
		// its terminals with `source: "headless"` and performs no scan, so counting
		// them as clean scans padded the denominator with calls that could not have
		// been hits. An unscanned call is not a clean one.
		if (e.data.source === "headless") continue;

		const isDetection = e.kind === "injection_detected";
		// Outcomes known to have reached the scanner. `stream_partial_delivery` is
		// emitted AFTER scanning, so a failed stream is a scanned call; a denial
		// counts only when it carries `injectionPatterns`, because a denial can
		// fire before detection runs.
		const reachedScanner =
			e.data.settled !== undefined ||
			e.kind === "llm_call" ||
			e.kind === "llm_call_failed" ||
			e.kind === "stream_partial_delivery" ||
			e.kind.endsWith("_failed") ||
			nonEmptyArray(e.data.injectionPatterns);
		const legacyShape =
			e.kind.includes("pattern") || e.kind.includes("memory") || e.data.patternMatch !== undefined;
		if (!isDetection && !reachedScanner && !legacyShape) continue;

		const id = e.data.transferId;
		const hasId = typeof id === "string" && id !== "";
		if (hasId) {
			scanned.add(id as string);
			if (evidence(e)) detected.add(id as string);
		} else {
			// No id to key on — count it, but keep it out of the sets so it cannot
			// collide with a real transfer or with another anonymous record.
			anonymousScanned++;
			if (evidence(e)) anonymousDetected++;
		}
	}

	const total = scanned.size + anonymousScanned;
	const hits = detected.size + anonymousDetected;

	return {
		condition: "pattern_memory_hits",
		label: "Injection pattern matches",
		value: total > 0 ? Math.min(1, hits / total) : 0,
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

/** Score at or above which a report is "critical". */
const CRITICAL_SCORE = 60;

function classifyLevel(score: number): EntropyLevel {
	if (score >= CRITICAL_SCORE) return "critical";
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
	let score = Math.round(rawScore * 100);

	// DOMINANCE AT REPORT LEVEL, not only inside signal 3. Making the chain
	// signal binary was necessary and not sufficient: a tampered vault with
	// otherwise-clean calls yields signal values [0, 1, 0, 0, 0], whose mean is
	// 20 — "low", i.e. healthy, for a chain that failed verification. Averaging a
	// total loss of audit integrity against unrelated healthy signals is the same
	// dilution one layer up. A chain that does not verify invalidates the whole
	// audit claim, so nothing else can average it back down.
	// ANY signal that declares itself critical floors the composite — the rule is
	// no longer "chain, and only chain, and only when its rate saturates".
	//
	// The old form compared `chainSignal.value >= 1` and so encoded THREE things
	// the composite had no business knowing: which signal dominates, that its
	// value is binary rather than a rate, and that no other signal ever could.
	// All three were wrong in different ways — budget exhaustion diluted to a
	// score of 20, and a single ambiguous settlement among clean ones never
	// reached the threshold at all.
	if (scored.some((s) => s.critical === true)) {
		score = Math.max(score, CRITICAL_SCORE);
	}

	return {
		score,
		level: classifyLevel(score),
		signals,
		computedAt: new Date().toISOString(),
		eventCount: events.length,
	};
}
