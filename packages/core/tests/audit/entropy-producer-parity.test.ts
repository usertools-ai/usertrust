// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Producer parity for the entropy signals.
 *
 * The pre-existing `entropy.test.ts` feeds INVENTED event kinds — `policy.evaluate`,
 * `spend`, `audit.verify`, `chain.check`, `scan` — none of which any producer in
 * `src/` ever writes. A matcher and a fixture invented together agree with each
 * other and with nothing else, which is why that suite could pass without the
 * signals matching a single real event.
 *
 * This file is the seam that keeps that from recurring: every event below is copied
 * from an actual `appendEvent` call site, cited by file:line. A signal that stops
 * matching real producer output fails HERE, where the pre-existing suite stays green.
 *
 * When a producer changes an event's shape, change it here too — and if that makes a
 * signal stop firing, the signal is what needs fixing, not this file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// ── Producer-shaped fixtures, each copied from its call site ──

/** `govern.ts:2394` — the settled-spend event, the most common event on any chain. */
const llmCall = (over: Record<string, unknown> = {}): EntropyEventInput => ({
	kind: "llm_call",
	data: {
		model: "claude-sonnet-4-6",
		cost: 120,
		settled: true,
		transferId: "t-1",
		usageSource: "provider",
		appliedRates: { input: 3, output: 15 },
		pricingTableVersion: 7,
		endpointClass: "cloud",
		costBasis: "provider",
		rateSource: "table",
		...over,
	},
});

/** `govern.ts:2391` — PII rides on `llm_call` as `string[]`, never a boolean. */
const llmCallWithPii = (): EntropyEventInput =>
	llmCall({ piiDetected: ["email", "phone"], piiPaths: ["messages[0].content"] });

/** `audit/denial-events.ts:196` — `buildPolicyDeniedData`. */
const policyDenied = (): EntropyEventInput => ({
	kind: "policy_denied",
	data: {
		schemaVersion: 1,
		decision: "deny",
		denialClass: "policy",
		model: "claude-sonnet-4-6",
		policyRules: [{ id: "r1", name: "no-secrets" }],
		error: "policy denied",
	},
});

/** `audit/denial-events.ts:228` — `buildLedgerRejectedData`. */
const ledgerRejected = (): EntropyEventInput => ({
	kind: "ledger_rejected",
	data: {
		schemaVersion: 1,
		decision: "deny",
		model: "claude-sonnet-4-6",
		transferId: "t-2",
		estimatedCost: 999,
		error: "insufficient balance",
	},
});

/** `govern.ts:2073` and `:2284` — the anomaly breaker's own event. */
const anomalyDetected = (): EntropyEventInput => ({
	kind: "anomaly_detected",
	data: {
		anomalyKind: "token_rate",
		message: "token rate exceeded",
		metric: 5000,
		threshold: 1000,
		model: "claude-sonnet-4-6",
		transferId: "t-3",
		provider: "anthropic",
	},
});

/** `govern.ts:2466` — POST failed after the provider call succeeded. */
const settlementAmbiguous = (): EntropyEventInput => ({
	kind: "settlement_ambiguous",
	data: {
		model: "claude-sonnet-4-6",
		cost: 120,
		transferId: "t-4",
		error: "pending_transfer_expired",
	},
});

/** The injection scanner's event. */
const injectionDetected = (): EntropyEventInput => ({
	kind: "injection_detected",
	data: { actionKind: "tool", actionName: "bash", patterns: ["ignore previous"], score: 0.9 },
});

describe("entropy signals vs. what producers actually write", () => {
	describe("signal 1 — policy violations (WIRED)", () => {
		it("counts a real policy_denied", () => {
			const s = extractPolicyViolations([policyDenied(), llmCall()]);
			expect(s.hits).toBe(1);
			expect(s.value).toBeGreaterThan(0);
		});

		it("counts a real ledger_rejected", () => {
			const s = extractPolicyViolations([ledgerRejected(), llmCall()]);
			expect(s.hits).toBe(1);
		});
	});

	describe("signal 2 — budget utilization", () => {
		// No producer writes `spent` or `budgetTotal`, and `policy_denied.budget` is
		// an OBJECT (`typeof === "number"` is false), so this can never come from the
		// event stream. It comes from the caller, which is what health.ts already had.
		it("abstains with no context rather than voting a fabricated zero", () => {
			const s = extractBudgetUtilization([llmCall(), policyDenied()]);
			expect(s.total).toBe(0);
		});

		it("stays quiet below the pressure floor", () => {
			const s = extractBudgetUtilization([], { budget: { total: 1000, spent: 500 } });
			expect(s.value).toBe(0);
			expect(s.hits).toBe(0);
		});

		it("ramps above the pressure floor", () => {
			const s = extractBudgetUtilization([], { budget: { total: 1000, spent: 900 } });
			expect(s.value).toBeCloseTo(0.5, 5);
			expect(s.hits).toBe(1);
		});

		it("ABSTAINS rather than summing chain costs when session spend is unknown", () => {
			// It must NOT sum `llm_call.cost`. An attributed call debits its
			// cost-center envelope and deliberately does not move session
			// `budgetSpent`, so summing chain costs against the SESSION budget
			// counts money the session never paid — cost-center-heavy traffic would
			// report an untouched session budget as exhausted.
			const events = Array.from({ length: 10 }, () => llmCall({ cost: 95 }));
			const s = extractBudgetUtilization(events, {
				budget: { total: 1000, spent: Number.NaN },
			});
			expect(s.total).toBe(0);
			expect(s.value).toBe(0);
		});
	});

	describe("signal 3 — chain integrity", () => {
		it("fires on a real degraded/ambiguous settlement", () => {
			// Requires the kind to contain "audit"/"chain"/"verify". No producer kind
			// does — kind alone cannot select these.
			const s = extractChainIntegrity([settlementAmbiguous(), llmCall()]);
			expect(s.total).toBeGreaterThan(0);
			expect(s.hits).toBeGreaterThan(0);
		});
	});

	describe("signal 4 — PII detections", () => {
		it("counts PII carried as string[] on llm_call", () => {
			// `piiDetected` is `piiResult.detection.types` — an array is never `=== true`.
			// The array form is the one the producer writes.
			const events = [llmCallWithPii(), llmCallWithPii(), llmCall()];
			const s = extractPiiDetections(events);
			expect(s.hits).toBe(2);
			expect(s.value).toBeGreaterThan(0);
		});

		it("does not count an absent or empty detection", () => {
			expect(extractPiiDetections([llmCall()]).hits).toBe(0);
			expect(extractPiiDetections([llmCall({ piiDetected: [] })]).hits).toBe(0);
		});
	});

	describe("signal 5 — circuit breaker / anomaly aborts", () => {
		it("fires on a real anomaly_detected", () => {
			// No kind contains "circuit"/"breaker" and no producer writes
			// `data.circuitBreaker`; `anomaly_detected` is the real shape.
			const s = extractCircuitBreakerTrips([anomalyDetected(), llmCall()]);
			expect(s.total).toBeGreaterThan(0);
			expect(s.hits).toBeGreaterThan(0);
		});
	});

	describe("signal 6 — pattern / recurring issues", () => {
		it("fires on repeated injection detections", () => {
			// Requires kind to contain "pattern"/"memory", or `data.patternMatch`.
			// Neither exists; `injection_detected` is the real shape.
			const s = extractPatternMemoryHits([injectionDetected(), injectionDetected(), llmCall()]);
			expect(s.total).toBeGreaterThan(0);
			expect(s.hits).toBeGreaterThan(0);
		});
	});

	describe("composite", () => {
		it("a chain carrying real trouble is reflected in the score", () => {
			const events: EntropyEventInput[] = [
				...Array.from({ length: 20 }, () => llmCallWithPii()),
				policyDenied(),
				ledgerRejected(),
				anomalyDetected(),
				settlementAmbiguous(),
				injectionDetected(),
				injectionDetected(),
			];
			const report = computeEntropyScore(events);
			// Every signal below has a real producer behind it.
			expect(report.score).toBeGreaterThan(0);
			expect(report.level).not.toBe("low");
		});

		it("a clean chain still scores zero", () => {
			const report = computeEntropyScore(Array.from({ length: 20 }, () => llmCall()));
			expect(report.score).toBe(0);
			expect(report.level).toBe("low");
		});
	});
});

// ── Drift detection against the producer SOURCE ──

/**
 * The fixtures above are hand-copied literals, and Codex correctly pointed out
 * what that means: if `govern.ts` renames `piiDetected`, every test above stays
 * green, because the fixture would be renamed only if a human noticed. A test
 * whose fixtures and matchers were written together agrees with itself and with
 * nothing else — which is precisely the criticism this file exists to make of
 * the suite it supplements. It applied here too.
 *
 * These cases close that by reading the PRODUCER SOURCE. Every kind and field
 * name the extractors match must still literally appear in the file that writes
 * it, so a rename in `govern.ts` fails HERE rather than silently unwiring a
 * signal again.
 *
 * It is a name-level check, not a semantic one — it cannot see a field that
 * changes type or meaning. It is the strongest link available without booting a
 * governor, and it catches the specific failure that produced this whole class:
 * a consumer matching a name no producer writes.
 */
describe("drift detection — matched names must exist in the producer source", () => {
	const SRC = join(import.meta.dirname, "..", "..", "src");
	const govern = readFileSync(join(SRC, "govern.ts"), "utf-8");
	const denials = readFileSync(join(SRC, "audit", "denial-events.ts"), "utf-8");
	const corpus = `${govern}\n${denials}`;

	const KINDS = [
		"llm_call",
		"llm_call_failed",
		"anomaly_detected",
		"injection_detected",
		"settlement_ambiguous",
		"policy_denied",
		"ledger_rejected",
	];

	const FIELDS = [
		"piiDetected", // signal 4, on llm_call
		"piiTypes", // signal 4, on the denial path
		"injectionPatterns", // signal 6, block mode
		"patterns", // signal 6, warn mode
		"decision", // signal 1
		"transferId", // signals 3 and 6 correlate on this
		"cost", // budget context fallback + receipts
	];

	it.each(KINDS)("producer still writes the kind %s", (kind) => {
		expect(corpus).toContain(`"${kind}"`);
	});

	it.each(FIELDS)("producer still writes the field %s", (field) => {
		expect(corpus).toMatch(new RegExp(`\\b${field}\\b`));
	});

	it("PII still rides as an ARRAY, which is the whole reason signal 4 was blind", () => {
		// Pins the SHAPE, not just the name: `detection.types` is a string[], and a
		// producer switching it to a boolean would silently re-break the matcher in
		// the opposite direction.
		expect(govern).toMatch(/piiDetected\s*=\s*\w+\.detection\.types/);
	});

	it("the anomaly reason is a KIND, never a data.anomalyDetected boolean", () => {
		// The original near-miss: the extractor looked for `data.anomalyDetected`
		// while the producer wrote the kind `anomaly_detected`. If a producer ever
		// adds that boolean, this fails and the matcher should be revisited.
		expect(corpus).not.toMatch(/\banomalyDetected\s*:/);
	});
});
