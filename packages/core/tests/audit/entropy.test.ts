import { describe, expect, it } from "vitest";
import {
	computeEntropyScore,
	type EntropyEventInput,
	extractBudgetUtilization,
	extractChainIntegrity,
	extractCircuitBreakerTrips,
	extractPatternMemoryHits,
	extractPiiDetections,
	extractPolicyViolations,
} from "../../src/audit/entropy.js";

describe("Entropy — individual signals", () => {
	it("extractPolicyViolations counts deny/block decisions", () => {
		const events: EntropyEventInput[] = [
			{ kind: "policy.evaluate", data: { decision: "allow" } },
			{ kind: "policy.evaluate", data: { decision: "deny" } },
			{ kind: "policy.evaluate", data: { decision: "block" } },
			{ kind: "system.start", data: {} },
		];

		const signal = extractPolicyViolations(events);
		expect(signal.condition).toBe("policy_violations");
		expect(signal.hits).toBe(2);
		expect(signal.total).toBe(3); // 3 policy events
		expect(signal.value).toBeCloseTo(2 / 3);
	});

	it("extractPolicyViolations counts BOTH denial kinds", () => {
		// `ledger_rejected` does not contain "policy", so a kind-substring filter
		// alone makes an atomic ledger refusal invisible to `usertrust health` —
		// the worst-diagnosed denial class going unmeasured.
		const events: EntropyEventInput[] = [
			{ kind: "policy_denied", data: { decision: "deny", denialClass: "pii" } },
			{ kind: "ledger_rejected", data: { decision: "deny" } },
			{ kind: "llm_call", data: { settled: true } },
		];

		const signal = extractPolicyViolations(events);
		expect(signal.hits).toBe(2);
		expect(signal.total).toBe(2);
		expect(signal.value).toBe(1);
	});

	it("extractPolicyViolations returns 0 for no policy events", () => {
		const events: EntropyEventInput[] = [{ kind: "system.start", data: {} }];
		const signal = extractPolicyViolations(events);
		expect(signal.value).toBe(0);
		expect(signal.hits).toBe(0);
		expect(signal.total).toBe(0);
	});

	// REWRITTEN: the `spend` kind and the `spent`/`budgetTotal` fields this used to
	// assert are written by no producer anywhere in `src/`. Utilization now comes
	// from the caller's context, which is what `cli/health.ts` already computed.
	it("extractBudgetUtilization detects >80% usage from context", () => {
		const signal = extractBudgetUtilization([], { budget: { total: 100, spent: 90 } });
		expect(signal.hits).toBe(1);
		expect(signal.total).toBe(1);
		expect(signal.value).toBeGreaterThan(0);
	});

	it("extractBudgetUtilization returns 0 for no budget events", () => {
		const events: EntropyEventInput[] = [{ kind: "test", data: { foo: "bar" } }];
		const signal = extractBudgetUtilization(events);
		expect(signal.value).toBe(0);
	});

	// REWRITTEN: no producer kind contains "audit"/"chain"/"verify", so this used
	// to evaluate zero events. Chain validity is a property of the LOG and is now
	// supplied by the caller; money/audit desync arrives as `settlement_ambiguous`.
	it("extractChainIntegrity detects verification failures", () => {
		// Real producers always stamp `transferId`; the desync rate deduplicates on
		// it, because `settlement_ambiguous` is a CORRECTION appended alongside the
		// same transfer's primary terminal rather than a separate call.
		const events: EntropyEventInput[] = [
			{ kind: "llm_call", data: { cost: 1, settled: true, transferId: "t-1" } },
			{ kind: "llm_call", data: { cost: 1, settled: true, transferId: "t-2" } },
			{
				kind: "settlement_ambiguous",
				data: { cost: 1, error: "pending_transfer_expired", transferId: "t-2" },
			},
		];

		const signal = extractChainIntegrity(events, { chain: { valid: false } });
		// A failed chain verification is binary and dominates: it invalidates the
		// whole chain regardless of how many calls preceded it.
		expect(signal.value).toBe(1);
		expect(signal.hits).toBe(2); // invalid chain + one desynced transfer
		expect(signal.total).toBe(3); // chain check + two distinct transfers
	});

	it("extractPiiDetections counts PII findings", () => {
		const events: EntropyEventInput[] = [
			{ kind: "scan", data: { piiDetected: true } },
			{ kind: "scan", data: { piiCount: 3 } },
			{ kind: "scan", data: { piiAction: "redact" } },
			{ kind: "scan", data: { clean: true } },
		];

		const signal = extractPiiDetections(events);
		expect(signal.hits).toBe(3);
		expect(signal.total).toBe(4);
	});

	it("extractCircuitBreakerTrips counts open/tripped states", () => {
		const events: EntropyEventInput[] = [
			{ kind: "circuit.breaker", data: { state: "open" } },
			{ kind: "circuit.breaker", data: { state: "closed" } },
			{ kind: "system", data: { circuitBreaker: true, tripped: true } },
		];

		const signal = extractCircuitBreakerTrips(events);
		expect(signal.hits).toBe(2);
		expect(signal.total).toBe(3);
	});

	it("extractPatternMemoryHits counts pattern matches", () => {
		const events: EntropyEventInput[] = [
			{ kind: "pattern.detect", data: { patternMatch: true } },
			{ kind: "pattern.detect", data: { patternMatch: false } },
			{ kind: "memory.scan", data: { anomalyDetected: true } },
		];

		const signal = extractPatternMemoryHits(events);
		expect(signal.hits).toBe(2);
		expect(signal.total).toBe(3);
	});

	it("each signal contributes independently to score", () => {
		// Only policy violations present
		const policyOnly: EntropyEventInput[] = [{ kind: "policy.eval", data: { decision: "deny" } }];
		const report = computeEntropyScore(policyOnly);
		// One signal at 1.0; signals with no observations abstain.
		expect(report.score).toBeGreaterThan(0);
		expect(report.score).toBeLessThanOrEqual(100);

		// Only PII detections
		const piiOnly: EntropyEventInput[] = [{ kind: "scan", data: { piiDetected: true } }];
		const piiReport = computeEntropyScore(piiOnly);
		expect(piiReport.score).toBeGreaterThan(0);
	});
});

describe("Entropy — composite score", () => {
	it("returns score 0 for empty events", () => {
		const report = computeEntropyScore([]);
		expect(report.score).toBe(0);
		expect(report.level).toBe("low");
		expect(report.signals).toHaveLength(6);
		expect(report.eventCount).toBe(0);
	});

	it("returns score 0 for clean events", () => {
		const events: EntropyEventInput[] = [
			{ kind: "policy.eval", data: { decision: "allow" } },
			{ kind: "audit.verify", data: { valid: true } },
			{ kind: "scan", data: { clean: true } },
		];

		const report = computeEntropyScore(events);
		expect(report.score).toBe(0);
		expect(report.level).toBe("low");
	});

	it("returns score between 0 and 100", () => {
		const events: EntropyEventInput[] = [
			{ kind: "policy.eval", data: { decision: "deny" } },
			{ kind: "audit.verify", data: { valid: false } },
			{ kind: "scan", data: { piiDetected: true } },
			{ kind: "circuit.breaker", data: { state: "open" } },
			{ kind: "pattern.detect", data: { patternMatch: true } },
			{ kind: "spend", data: { budget: 100, spent: 95 } },
		];

		const report = computeEntropyScore(events);
		expect(report.score).toBeGreaterThanOrEqual(0);
		expect(report.score).toBeLessThanOrEqual(100);
	});

	it("classifies level as low for score < 30", () => {
		const events: EntropyEventInput[] = [
			{ kind: "policy.eval", data: { decision: "deny" } },
			{ kind: "policy.eval", data: { decision: "allow" } },
			{ kind: "policy.eval", data: { decision: "allow" } },
			{ kind: "policy.eval", data: { decision: "allow" } },
			{ kind: "policy.eval", data: { decision: "allow" } },
		];

		const report = computeEntropyScore(events);
		// 1/5 policy violations = 0.2, avg = 0.2/6 ≈ 0.033 → score ~3
		expect(report.level).toBe("low");
	});

	// REWRITTEN with real producer kinds. The old version used `policy.eval`,
	// `audit.verify` and `scan`, none of which any producer writes, and reached
	// "elevated" only because two of its three signals were fictional. Under the
	// flat six-way mean, signals with no observations voted zero and bounded what
	// the live ones could express.
	it("classifies level as elevated for score >= 30", () => {
		const events: EntropyEventInput[] = [
			{ kind: "policy_denied", data: { decision: "deny", denialClass: "policy" } },
			{ kind: "llm_call", data: { cost: 1, settled: true, piiDetected: ["email"] } },
			{ kind: "anomaly_detected", data: { anomalyKind: "token_rate", metric: 9e9 } },
		];

		// A VALID chain — so the level comes from the event-derived signals alone.
		const report = computeEntropyScore(events, { chain: { valid: true } });
		expect(report.score).toBeGreaterThanOrEqual(30);
		expect(report.level).toBe("elevated");
	});

	it("a FAILED chain verification cannot be averaged down to healthy", () => {
		// Report-level dominance. Otherwise a tampered vault with otherwise-clean
		// calls yields signal values [0, 1, 0, 0, 0] — mean 20, i.e. "low" — and a
		// chain that failed verification reads as healthy because the unrelated
		// signals were fine.
		const events: EntropyEventInput[] = Array.from({ length: 50 }, (_, i) => ({
			kind: "llm_call",
			data: { cost: 1, settled: true, transferId: `t-${i}` },
		}));

		const report = computeEntropyScore(events, { chain: { valid: false } });
		expect(report.level).toBe("critical");
	});

	it("classifies level as critical for score >= 60", () => {
		// All signals firing
		const events: EntropyEventInput[] = [
			{ kind: "policy.eval", data: { decision: "deny" } },
			{ kind: "audit.verify", data: { valid: false } },
			{
				kind: "pattern.memory",
				data: { patternMatch: true, piiDetected: true },
			},
			{
				kind: "circuit.breaker",
				data: { state: "open", piiDetected: true },
			},
			{
				kind: "spend",
				data: { budget: 100, spent: 95, piiDetected: true },
			},
		];

		const report = computeEntropyScore(events);
		expect(report.score).toBeGreaterThanOrEqual(60);
		expect(report.level).toBe("critical");
	});

	it("has exactly 6 signals in the report", () => {
		const report = computeEntropyScore([]);
		expect(report.signals).toHaveLength(6);
		const conditions = report.signals.map((s) => s.condition);
		expect(conditions).toContain("policy_violations");
		expect(conditions).toContain("budget_utilization");
		expect(conditions).toContain("chain_integrity");
		expect(conditions).toContain("pii_detections");
		expect(conditions).toContain("circuit_breaker_trips");
		expect(conditions).toContain("pattern_memory_hits");
	});

	it("computedAt is a valid ISO string", () => {
		const report = computeEntropyScore([]);
		const parsed = new Date(report.computedAt);
		expect(parsed.toISOString()).toBe(report.computedAt);
	});

	it("eventCount reflects the number of input events", () => {
		const events: EntropyEventInput[] = [
			{ kind: "a", data: {} },
			{ kind: "b", data: {} },
			{ kind: "c", data: {} },
		];
		const report = computeEntropyScore(events);
		expect(report.eventCount).toBe(3);
	});
});

describe("Entropy — budget utilization edge cases", () => {
	it("utilization <= 80% is not a hit", () => {
		// 10% utilization.
		const signal = extractBudgetUtilization([], { budget: { total: 1000, spent: 100 } });
		expect(signal.total).toBe(1);
		expect(signal.hits).toBe(0);
		expect(signal.value).toBe(0);
	});

	it("ignores events with budget=0 (division guard)", () => {
		const events: EntropyEventInput[] = [{ kind: "spend", data: { budget: 0, spent: 0 } }];

		const signal = extractBudgetUtilization(events);
		expect(signal.total).toBe(0);
		expect(signal.hits).toBe(0);
	});

	it("ignores events with budgetTotal=0 (division guard)", () => {
		const events: EntropyEventInput[] = [
			{ kind: "spend", data: { budgetTotal: 0, budgetRemaining: 0 } },
		];

		const signal = extractBudgetUtilization(events);
		expect(signal.total).toBe(0);
		expect(signal.hits).toBe(0);
	});
});

describe("Entropy — circuit breaker edge cases", () => {
	it("detects half-open state", () => {
		const events: EntropyEventInput[] = [{ kind: "circuit.breaker", data: { state: "half-open" } }];

		const signal = extractCircuitBreakerTrips(events);
		expect(signal.hits).toBe(1);
		expect(signal.total).toBe(1);
	});

	it("does not count closed state as tripped", () => {
		const events: EntropyEventInput[] = [{ kind: "circuit.breaker", data: { state: "closed" } }];

		const signal = extractCircuitBreakerTrips(events);
		expect(signal.hits).toBe(0);
		expect(signal.total).toBe(1);
	});

	it("counts circuitBreakerTripped via data field", () => {
		const events: EntropyEventInput[] = [
			{ kind: "system", data: { circuitBreaker: true, circuitBreakerTripped: true } },
		];

		const signal = extractCircuitBreakerTrips(events);
		expect(signal.hits).toBe(1);
		expect(signal.total).toBe(1);
	});
});

describe("Entropy — pattern memory edge cases", () => {
	it("counts recurringIssue as a hit", () => {
		const events: EntropyEventInput[] = [
			{ kind: "pattern.detect", data: { recurringIssue: true } },
		];

		const signal = extractPatternMemoryHits(events);
		expect(signal.hits).toBe(1);
		expect(signal.total).toBe(1);
	});

	it("does not count false values as hits", () => {
		const events: EntropyEventInput[] = [
			{
				kind: "pattern.detect",
				data: { patternMatch: false, anomalyDetected: false, recurringIssue: false },
			},
		];

		const signal = extractPatternMemoryHits(events);
		expect(signal.hits).toBe(0);
		expect(signal.total).toBe(1);
	});
});

describe("Entropy — policy violations edge cases", () => {
	it("counts 'blocked' decision as a violation", () => {
		const events: EntropyEventInput[] = [{ kind: "policy.eval", data: { decision: "blocked" } }];

		const signal = extractPolicyViolations(events);
		expect(signal.hits).toBe(1);
		expect(signal.total).toBe(1);
	});
});

describe("Entropy — PII detection edge cases", () => {
	it("counts piiAction=block as a detection", () => {
		const events: EntropyEventInput[] = [{ kind: "scan", data: { piiAction: "block" } }];

		const signal = extractPiiDetections(events);
		expect(signal.hits).toBe(1);
	});

	it("does not count piiCount=0 as a detection", () => {
		const events: EntropyEventInput[] = [{ kind: "scan", data: { piiCount: 0 } }];

		const signal = extractPiiDetections(events);
		expect(signal.hits).toBe(0);
	});
});

describe("Entropy — chain integrity edge cases", () => {
	it("counts empty errors array as healthy", () => {
		const signal = extractChainIntegrity([], { chain: { valid: true, errors: [] } });
		expect(signal.hits).toBe(0);
		expect(signal.total).toBe(1);
	});

	// REPLACES "events matching verify in kind are counted", which asserted the
	// defect itself: matching on a kind SUBSTRING is what made this signal look
	// alive against invented kinds while evaluating nothing on a real chain.
	it("does not invent observations from a kind substring", () => {
		const events: EntropyEventInput[] = [{ kind: "verify.result", data: { valid: true } }];

		const signal = extractChainIntegrity(events);
		expect(signal.total).toBe(0);
	});
});

/**
 * A DOMINANT SIGNAL CANNOT BE AVERAGED AWAY.
 *
 * The composite is a flat mean over live signals, so one saturated signal among
 * four clean ones scores 20 — "healthy". A floor existed for chain failure and
 * for nothing else, even though the comment beside it described the dilution as
 * a class. These are the two members that were left out.
 */
describe("computeEntropyScore — severity is declared by the signal, not inferred", () => {
	const clean: EntropyEventInput[] = [
		{ kind: "llm_call", data: { settled: true, cost: 10, transferId: "t1" } },
		{ kind: "llm_call", data: { settled: true, cost: 10, transferId: "t2" } },
	];

	it("an EXHAUSTED budget is critical, not a fifth of one", () => {
		const report = computeEntropyScore(clean, {
			budget: { total: 1000, spent: 1000 },
			chain: { valid: true },
		});
		expect(report.level).toBe("critical");
	});

	it("an ordinary half-spent budget stays healthy", () => {
		// The inverse, so the floor above is not just "always critical".
		const report = computeEntropyScore(clean, {
			budget: { total: 1000, spent: 500 },
			chain: { valid: true },
		});
		expect(report.level).toBe("low");
	});

	it("ONE ambiguous settlement among clean ones is critical", () => {
		// The old floor compared an ambiguity RATE against 1, so it only fired when
		// EVERY settlement was ambiguous. One-of-two scored 0.5 and the headline
		// stayed healthy while the chain line printed [critical].
		const mixed: EntropyEventInput[] = [
			{ kind: "llm_call", data: { settled: true, cost: 10, transferId: "t1" } },
			{ kind: "settlement_ambiguous", data: { transferId: "t2" } },
		];
		const report = computeEntropyScore(mixed, {
			budget: { total: 1000, spent: 10 },
			chain: { valid: true },
		});
		expect(report.level).toBe("critical");
		const chain = report.signals.find((s) => s.condition === "chain_integrity");
		expect(chain?.critical).toBe(true);
	});

	it("a policy DENIAL is governance working, and never floors the score", () => {
		// Denials are rate-like: a single denial saturating its signal must not
		// report critical, or the monitor cries wolf and gets muted.
		const denied: EntropyEventInput[] = [
			{ kind: "policy_denied", data: { decision: "deny", transferId: "t1" } },
		];
		const report = computeEntropyScore(denied, {
			budget: { total: 1000, spent: 10 },
			chain: { valid: true },
		});
		const policy = report.signals.find((s) => s.condition === "policy_violations");
		expect(policy?.value).toBe(1);
		expect(policy?.critical).toBeUndefined();
		expect(report.level).not.toBe("critical");
	});
});
