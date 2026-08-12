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
 *
 * ── A FIXED KIND LIST IS A SMELL ──
 *
 * Wherever the producer's kinds are CALLER-SUPPLIED, matching on a hard-coded
 * list of kinds is wrong by construction. `governActionImpl` writes
 * `<action.kind>` on success and `<action.kind>_failed` on failure and drives the
 * same circuit breaker an LLM call does, so a signal filtering on `llm_call` /
 * `llm_call_failed` reported ZERO observations for an action-only deployment.
 *
 * That mistake was present in three signals at once, and two of them were fixed a
 * round before the third — each signal had to learn it separately rather than
 * once, which is exactly what this file was supposed to prevent and did not,
 * because it pins NAMES and not SHAPE. Discriminate on structure instead:
 * `settled` for a settlement terminal, a `_failed` suffix for a failure terminal.
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

/**
 * The injection scanner's event. Carries `transferId` — the producer mints it
 * before scanning, so a detection can be attributed to ITS call rather than
 * reconciled against aggregate counts.
 */
const injectionDetected = (transferId = "inj-1"): EntropyEventInput => ({
	kind: "injection_detected",
	data: {
		actionKind: "tool",
		actionName: "bash",
		patterns: ["ignore previous"],
		score: 0.9,
		transferId,
	},
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

	/**
	 * Each entry pins the field as an EMITTED KEY, not as an identifier that
	 * merely occurs somewhere. The first cut of this check matched
	 * `\bpatterns\b`, which `injectionResult.patterns` satisfies on the READ
	 * side — so renaming the emitted key `patterns:` to `matches:` would have
	 * left this green while the extractor stopped seeing warn-mode events. That
	 * is the same half-measure this file exists to catch, inside the check
	 * written to catch it.
	 */
	const EMITTED_KEYS: ReadonlyArray<readonly [string, RegExp]> = [
		// Assigned onto the audit payload rather than written as a literal key.
		["piiDetected", /auditData\.piiDetected\s*=|auditEventData\.piiDetected\s*=/],
		["piiTypes", /\bpiiTypes\s*:/],
		["injectionPatterns", /\binjectionPatterns\s*:/],
		["patterns", /\bpatterns\s*:\s*injectionResult\.patterns/],
		["decision", /\bdecision\s*:\s*"deny"/],
		["transferId", /\btransferId\s*[,:]/],
		["settled", /\bsettled\s*:/],
	];

	it.each(KINDS)("producer still writes the kind %s", (kind) => {
		expect(corpus).toContain(`"${kind}"`);
	});

	it.each(EMITTED_KEYS)("producer still EMITS %s as a data key", (_name, pattern) => {
		expect(corpus).toMatch(pattern);
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

describe("governed actions exercise the same signals as llm calls", () => {
	/**
	 * `governActionImpl` writes `<action.kind>` on success and
	 * `<action.kind>_failed` on failure, and calls `cb.recordFailure()` on the
	 * SAME breaker. Kind lists cannot enumerate these — the action kind is
	 * caller-supplied — so any signal keyed on a fixed list of `llm_call*` kinds
	 * reports zero observations for an action-only deployment while that
	 * deployment drives the breaker exactly as an LLM workload does.
	 */
	// DISTINCT ids per call. The breaker signal is keyed by transfer — one aborted
	// stream writes both `anomaly_detected` and `stream_partial_delivery` under one
	// id, and a call cannot be half-aborted — so a fixture reusing one id models
	// one call, not two.
	let actionSeq = 0;
	const actionOk = (): EntropyEventInput => ({
		kind: "tool_use",
		data: { actionName: "bash", cost: 5, settled: true, transferId: `a-ok-${actionSeq++}` },
	});
	const actionFailed = (): EntropyEventInput => ({
		kind: "tool_use_failed",
		data: { actionName: "bash", error: "boom", transferId: "a-2" },
	});

	it("counts governed actions in the breaker signal", () => {
		const s = extractCircuitBreakerTrips([actionOk(), actionOk(), actionFailed()]);
		expect(s.total).toBe(3);
	});

	it("counts governed actions in the settlement denominator", () => {
		const s = extractChainIntegrity([
			actionOk(),
			{ kind: "settlement_ambiguous", data: { transferId: "a-3", error: "expired" } },
		]);
		expect(s.total).toBeGreaterThan(1);
	});

	it("counts governed actions in the injection denominator", () => {
		// The detection carries the id of the call it flagged, so it correlates
		// rather than adding a phantom observation.
		const flagged = actionOk();
		const clean = actionOk();
		const s = extractPatternMemoryHits([
			flagged,
			clean,
			injectionDetected(flagged.data.transferId as string),
		]);
		expect(s.total).toBe(2);
		expect(s.hits).toBe(1);
	});
});

describe("denominators must match the population the signal claims to measure", () => {
	const term = (kind: string, data: Record<string, unknown>): EntropyEventInput => ({ kind, data });

	it("ordinary failed streams are in the anomaly denominator", () => {
		// `finalizeStreamVoid` emits `stream_partial_delivery` — not
		// `llm_call_failed`, and with no `settled`. Omitting it measured anomaly
		// aborts against a population that excluded every ordinary stream failure,
		// so one anomaly among nine errors reported 1/1 instead of 1/10.
		const events = [
			term("anomaly_detected", { anomalyKind: "token_rate", transferId: "a" }),
			...Array.from({ length: 9 }, (_, i) =>
				term("stream_partial_delivery", { transferId: `s${i}`, error: "boom" }),
			),
		];
		const s = extractCircuitBreakerTrips(events);
		expect(s.total).toBe(10);
		expect(s.hits).toBe(1);
	});

	it("headless calls are NOT counted as clean injection scans", () => {
		// `createGovernor()` performs no injection detection, so its terminals are
		// unscanned rather than clean. Counting them padded the denominator with
		// calls that could not have been hits.
		const scanned = [
			term("llm_call", { cost: 1, settled: true, transferId: "t1" }),
			term("injection_detected", { patterns: ["x"], score: 1 }),
		];
		const withHeadless = [
			...scanned,
			...Array.from({ length: 20 }, (_, i) =>
				term("llm_call", { cost: 1, settled: true, transferId: `h${i}`, source: "headless" }),
			),
		];
		expect(extractPatternMemoryHits(withHeadless).total).toBe(
			extractPatternMemoryHits(scanned).total,
		);
	});

	it("a detection whose call never completed still reaches the score", () => {
		// `injection_detected` is written BEFORE the hold. If the hold is rejected,
		// no terminal matches — leaving hits > 0 and total 0, which the composite
		// discards as "no observations". The detection would vanish precisely when
		// the call it flagged did not complete.
		const events = [
			term("injection_detected", { patterns: ["ignore previous"], score: 1 }),
			term("ledger_rejected", { decision: "deny", transferId: "r1", estimatedCost: 5 }),
		];
		const s = extractPatternMemoryHits(events);
		expect(s.total).toBeGreaterThan(0);
		const report = computeEntropyScore(events);
		expect(
			report.signals.find((x) => x.condition === "pattern_memory_hits")?.total,
		).toBeGreaterThan(0);
	});
});

describe("one governed call contributes one observation", () => {
	it("an aborted stream is ONE call, not two events", () => {
		// A real streaming anomaly writes `anomaly_detected` AND
		// `stream_partial_delivery` under the same transferId. Counting events made
		// a single aborted call report 1/2 — a call cannot be half-aborted.
		const s = extractCircuitBreakerTrips([
			{ kind: "anomaly_detected", data: { anomalyKind: "token_rate", transferId: "tx1" } },
			{ kind: "stream_partial_delivery", data: { transferId: "tx1", error: "aborted" } },
		]);
		expect(s.total).toBe(1);
		expect(s.hits).toBe(1);
		expect(s.value).toBe(1);
	});

	it("clean failed streams are in the injection denominator", () => {
		// `stream_partial_delivery` is emitted AFTER injection scanning, so a clean
		// failed stream is a scanned call. Excluding it meant one detection among
		// nine clean failures reported 1/1 instead of 1/10.
		const events: EntropyEventInput[] = [
			{ kind: "injection_detected", data: { patterns: ["x"], score: 1, transferId: "s0" } },
			...Array.from({ length: 9 }, (_, i) => ({
				kind: "stream_partial_delivery",
				data: { transferId: `s${i}`, error: "boom" },
			})),
		];
		const s = extractPatternMemoryHits(events);
		expect(s.total).toBe(9);
		expect(s.hits).toBe(1);
	});
});
