import { describe, expect, it } from "vitest";
import {
	type EntropyEventInput,
	computeEntropyScore,
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

	it("extractPolicyViolations returns 0 for no policy events", () => {
		const events: EntropyEventInput[] = [{ kind: "system.start", data: {} }];
		const signal = extractPolicyViolations(events);
		expect(signal.value).toBe(0);
		expect(signal.hits).toBe(0);
		expect(signal.total).toBe(0);
	});

	it("extractBudgetUtilization detects >80% usage", () => {
		const events: EntropyEventInput[] = [
			{ kind: "spend", data: { budget: 100, spent: 90 } }, // 90% → hit
			{ kind: "spend", data: { budget: 100, spent: 50 } }, // 50% → no hit
			{ kind: "spend", data: { budgetTotal: 1000, budgetRemaining: 100 } }, // 90% → hit
		];

		const signal = extractBudgetUtilization(events);
		expect(signal.hits).toBe(2);
		expect(signal.total).toBe(3);
	});

	it("extractBudgetUtilization returns 0 for no budget events", () => {
		const events: EntropyEventInput[] = [{ kind: "test", data: { foo: "bar" } }];
		const signal = extractBudgetUtilization(events);
		expect(signal.value).toBe(0);
	});

	it("extractChainIntegrity detects verification failures", () => {
		const events: EntropyEventInput[] = [
			{ kind: "audit.verify", data: { valid: true } },
			{ kind: "audit.verify", data: { valid: false } },
			{ kind: "chain.check", data: { degraded: true } },
			{ kind: "audit.verify", data: { errors: ["hash mismatch"] } },
		];

		const signal = extractChainIntegrity(events);
		expect(signal.hits).toBe(3);
		expect(signal.total).toBe(4);
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
		// 1 signal at 1.0, 5 signals at 0 → average = 1/6 → score ~17
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

	it("classifies level as elevated for score >= 30", () => {
		// Need enough signals to push above 30
		const events: EntropyEventInput[] = [
			{ kind: "policy.eval", data: { decision: "deny" } },
			{ kind: "audit.verify", data: { valid: false } },
			{ kind: "scan", data: { piiDetected: true } },
		];

		const report = computeEntropyScore(events);
		// Each of the 3 active signals is at 1.0
		// policyViolations: 1/1 = 1.0
		// chainIntegrity: 1/1 = 1.0
		// piiDetections: 1/3 (all 3 events counted, 1 PII hit)
		// budget: 0, circuit: 0, pattern: 0
		// Sum ≈ 1.0 + 0 + 1.0 + 0.33 + 0 + 0 = 2.33, avg = 2.33/6 ≈ 0.389 → 39
		expect(report.score).toBeGreaterThanOrEqual(30);
		expect(report.level).toBe("elevated");
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
	it("budgetRemaining/budgetTotal path with utilization <= 80% (no hit)", () => {
		const events: EntropyEventInput[] = [
			// 10% utilization via budgetRemaining/budgetTotal path
			{ kind: "spend", data: { budgetTotal: 1000, budgetRemaining: 900 } },
		];

		const signal = extractBudgetUtilization(events);
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
		const events: EntropyEventInput[] = [
			{ kind: "audit.verify", data: { valid: true, errors: [] } },
		];

		const signal = extractChainIntegrity(events);
		expect(signal.hits).toBe(0);
		expect(signal.total).toBe(1);
	});

	it("events matching verify in kind are counted", () => {
		const events: EntropyEventInput[] = [{ kind: "verify.result", data: { valid: true } }];

		const signal = extractChainIntegrity(events);
		expect(signal.total).toBe(1);
		expect(signal.hits).toBe(0);
	});
});
