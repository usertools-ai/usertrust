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
 */

// ── Types ──

export interface EntropyEventInput {
	kind: string;
	data: Record<string, unknown>;
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
 * Signal 1: Policy violations
 *
 * Events where kind contains "policy" and data indicates a deny/block decision.
 */
export function extractPolicyViolations(events: EntropyEventInput[]): EntropySignal {
	const policyEvents = events.filter((e) => e.kind.includes("policy"));
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

/**
 * Signal 2: Budget utilization
 *
 * Events with budget data where utilization exceeds 80%.
 */
export function extractBudgetUtilization(events: EntropyEventInput[]): EntropySignal {
	let hits = 0;
	let total = 0;

	for (const e of events) {
		const budget = e.data.budget;
		const spent = e.data.spent;
		const remaining = e.data.budgetRemaining;
		const budgetTotal = e.data.budgetTotal;

		if (typeof budget === "number" && typeof spent === "number" && budget > 0) {
			total++;
			if (spent / budget > 0.8) {
				hits++;
			}
		} else if (
			typeof remaining === "number" &&
			typeof budgetTotal === "number" &&
			budgetTotal > 0
		) {
			total++;
			if ((budgetTotal - remaining) / budgetTotal > 0.8) {
				hits++;
			}
		}
	}

	return {
		condition: "budget_utilization",
		label: "Budget utilization (>80%)",
		value: total > 0 ? hits / total : 0,
		hits,
		total,
	};
}

/**
 * Signal 3: Chain integrity
 *
 * Events indicating hash chain verification failures or audit degradation.
 */
export function extractChainIntegrity(events: EntropyEventInput[]): EntropySignal {
	let hits = 0;
	let total = 0;

	for (const e of events) {
		if (e.kind.includes("audit") || e.kind.includes("chain") || e.kind.includes("verify")) {
			total++;
			const valid = e.data.valid;
			const degraded = e.data.degraded;
			const errors = e.data.errors;

			if (valid === false || degraded === true || (Array.isArray(errors) && errors.length > 0)) {
				hits++;
			}
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
		const piiCount = e.data.piiCount;
		const piiAction = e.data.piiAction;

		if (
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
 * Signal 5: Circuit breaker trips
 *
 * Events where circuit breakers were triggered.
 */
export function extractCircuitBreakerTrips(events: EntropyEventInput[]): EntropySignal {
	let hits = 0;
	let total = 0;

	for (const e of events) {
		if (
			e.kind.includes("circuit") ||
			e.kind.includes("breaker") ||
			e.data.circuitBreaker !== undefined
		) {
			total++;
			const state = e.data.circuitBreakerState ?? e.data.state;
			const tripped = e.data.circuitBreakerTripped ?? e.data.tripped;

			if (state === "open" || state === "half-open" || tripped === true) {
				hits++;
			}
		}
	}

	return {
		condition: "circuit_breaker_trips",
		label: "Circuit breaker trips",
		value: total > 0 ? hits / total : 0,
		hits,
		total,
	};
}

/**
 * Signal 6: Pattern memory hits
 *
 * Events where pattern memory detected recurring issues or anomalies.
 */
export function extractPatternMemoryHits(events: EntropyEventInput[]): EntropySignal {
	let hits = 0;
	let total = 0;

	for (const e of events) {
		if (
			e.kind.includes("pattern") ||
			e.kind.includes("memory") ||
			e.data.patternMatch !== undefined
		) {
			total++;
			const match = e.data.patternMatch;
			const anomaly = e.data.anomalyDetected;
			const recurring = e.data.recurringIssue;

			if (match === true || anomaly === true || recurring === true) {
				hits++;
			}
		}
	}

	return {
		condition: "pattern_memory_hits",
		label: "Pattern memory hits",
		value: total > 0 ? hits / total : 0,
		hits,
		total,
	};
}

// ── Composite ──

const EXTRACTORS = [
	extractPolicyViolations,
	extractBudgetUtilization,
	extractChainIntegrity,
	extractPiiDetections,
	extractCircuitBreakerTrips,
	extractPatternMemoryHits,
] as const;

function classifyLevel(score: number): EntropyLevel {
	if (score >= 60) return "critical";
	if (score >= 30) return "elevated";
	return "low";
}

/**
 * Compute the composite entropy report from audit events.
 *
 * Each of the 6 signals contributes equally (weight = 1/6).
 * The composite score is 0–100.
 *
 * @param events - Array of audit events to analyze
 * @returns Entropy report with composite score and per-signal breakdown
 */
export function computeEntropyScore(events: EntropyEventInput[]): EntropyReport {
	const signals = EXTRACTORS.map((fn) => fn(events));

	const sum = signals.reduce((acc, s) => acc + s.value, 0);
	const rawScore = signals.length > 0 ? sum / signals.length : 0;
	const score = Math.round(rawScore * 100);

	return {
		score,
		level: classifyLevel(score),
		signals,
		computedAt: new Date().toISOString(),
		eventCount: events.length,
	};
}
