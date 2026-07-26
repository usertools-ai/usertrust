// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * local-anomaly.test.ts — M2 scoped anomaly governance.
 *
 * Covers: per-event model/endpointClass overrides, local token-rate thresholds
 * (localThresholdTokPerSec default 5000 + perModel trailing-* globs), and
 * dual-denomination spend velocity (cloud dollars vs local nominal usertokens).
 *
 * Pinned explicit behavior: with the default local rate {0,0}, per-chunk nominal
 * cost is a constant floor of 1, so spend_velocity CANNOT trip on default local
 * config — token_rate is the primary local signal. Velocity becomes meaningful
 * when the operator sets nonzero local rates (amortized-usd showback).
 */

import { describe, expect, it, vi } from "vitest";
import { createAnomalyDetector } from "../../src/anomaly/detector.js";
import {
	createSpendVelocitySignal,
	resolveSpendVelocityConfig,
} from "../../src/anomaly/signals/spend-velocity.js";
import type { AnomalyChunkEvent } from "../../src/anomaly/types.js";
import { costFromRates, resolveRates } from "../../src/ledger/pricing.js";
import { type TrustConfig, TrustConfigSchema } from "../../src/shared/types.js";

const USERTOKENS_PER_DOLLAR = 10_000;

/**
 * Mirrors the calculator govern.ts injects (Task 2): resolves rates from the
 * event's model/endpointClass and returns dollars for cloud-scope events,
 * nominal usertokens for local-scope events.
 */
function makeScopedCalculator(config: TrustConfig) {
	return (
		model: string,
		inputTokens: number,
		outputTokens: number,
		event?: AnomalyChunkEvent,
	): number => {
		const scope = event?.endpointClass ?? "cloud";
		const resolution = resolveRates(event?.model ?? model, scope, config);
		const usertokens = costFromRates(resolution.rates, inputTokens, outputTokens);
		return scope === "local" ? usertokens : usertokens / USERTOKENS_PER_DOLLAR;
	};
}

function localChunk(overrides: Partial<AnomalyChunkEvent> = {}): AnomalyChunkEvent {
	return {
		kind: "chunk",
		deltaTokens: 0,
		cumulativeInputTokens: 0,
		cumulativeOutputTokens: 0,
		model: "llama3.3:70b",
		endpointClass: "local",
		...overrides,
	};
}

describe("local token-rate thresholds", () => {
	function driveLocalStream(
		detector: ReturnType<typeof createAnomalyDetector>,
		setNow: (t: number) => void,
		tokPerSec: number,
	): void {
		// deltaTokens every 100ms, sustained for 3 seconds.
		const delta = tokPerSec / 10;
		for (let t = 0; t <= 3_000; t += 100) {
			setNow(t);
			detector.observe(
				localChunk({
					deltaTokens: delta,
					cumulativeOutputTokens: (t / 100 + 1) * delta,
					at: t,
				}),
			);
		}
	}

	it("local stream at 6000 tok/s trips at the default local threshold (5000), named in the verdict", () => {
		let nowMs = 0;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				// localThresholdTokPerSec intentionally unset — the signal defaults it to 5000.
				tokenRate: { thresholdTokPerSec: 500, windowMs: 1_000, consecutiveWindows: 2 },
				spendVelocity: { thresholdDollarsPerMin: 1e9, localThresholdUsertokensPerMin: 1e9 },
			},
			{ now: () => nowMs },
		);
		driveLocalStream(
			detector,
			(t) => {
				nowMs = t;
			},
			6_000,
		);
		const verdict = detector.check();
		expect(verdict.tripped).toBe(true);
		if (verdict.tripped) {
			expect(verdict.kind).toBe("token_rate");
			// Local default threshold applied — NOT the cloud 500.
			expect(verdict.threshold).toBe(5_000);
			expect(verdict.metric).toBeGreaterThanOrEqual(5_000);
			expect(verdict.message).toContain("localThresholdTokPerSec");
		}
	});

	it('same 6000 tok/s with perModel {"llama3.3*": 10000} does NOT trip', () => {
		let nowMs = 0;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				tokenRate: {
					thresholdTokPerSec: 500,
					windowMs: 1_000,
					consecutiveWindows: 2,
					perModel: { "llama3.3*": 10_000 },
				},
				spendVelocity: { thresholdDollarsPerMin: 1e9, localThresholdUsertokensPerMin: 1e9 },
			},
			{ now: () => nowMs },
		);
		driveLocalStream(
			detector,
			(t) => {
				nowMs = t;
			},
			6_000,
		);
		expect(detector.check().tripped).toBe(false);
	});

	it("perModel glob below the observed rate trips and names the pattern in the verdict", () => {
		let nowMs = 0;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				tokenRate: {
					thresholdTokPerSec: 500,
					windowMs: 1_000,
					consecutiveWindows: 2,
					perModel: { "llama3.3*": 5_500 },
				},
				spendVelocity: { thresholdDollarsPerMin: 1e9, localThresholdUsertokensPerMin: 1e9 },
			},
			{ now: () => nowMs },
		);
		driveLocalStream(
			detector,
			(t) => {
				nowMs = t;
			},
			6_000,
		);
		const verdict = detector.check();
		expect(verdict.tripped).toBe(true);
		if (verdict.tripped) {
			expect(verdict.kind).toBe("token_rate");
			expect(verdict.threshold).toBe(5_500);
			expect(verdict.message).toContain('perModel["llama3.3*"]');
		}
	});

	it("local event without a model skips perModel and uses the local threshold", () => {
		let nowMs = 0;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				tokenRate: {
					thresholdTokPerSec: 500,
					windowMs: 1_000,
					consecutiveWindows: 2,
					perModel: { "llama3.3*": 10_000 },
				},
				spendVelocity: { thresholdDollarsPerMin: 1e9, localThresholdUsertokensPerMin: 1e9 },
			},
			{ now: () => nowMs },
		);
		// 6000 tok/s local stream with NO model on the events.
		for (let t = 0; t <= 3_000; t += 100) {
			nowMs = t;
			detector.observe({
				kind: "chunk",
				deltaTokens: 600,
				cumulativeInputTokens: 0,
				cumulativeOutputTokens: (t / 100 + 1) * 600,
				endpointClass: "local",
			});
		}
		const verdict = detector.check();
		expect(verdict.tripped).toBe(true);
		if (verdict.tripped) {
			expect(verdict.threshold).toBe(5_000);
			expect(verdict.message).toContain("localThresholdTokPerSec");
		}
	});

	it("perModel with no matching pattern falls through to the local threshold", () => {
		let nowMs = 0;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				tokenRate: {
					thresholdTokPerSec: 500,
					windowMs: 1_000,
					consecutiveWindows: 2,
					perModel: { "qwen*": 10_000 },
				},
				spendVelocity: { thresholdDollarsPerMin: 1e9, localThresholdUsertokensPerMin: 1e9 },
			},
			{ now: () => nowMs },
		);
		driveLocalStream(
			detector,
			(t) => {
				nowMs = t;
			},
			6_000,
		);
		const verdict = detector.check();
		expect(verdict.tripped).toBe(true);
		if (verdict.tripped) {
			expect(verdict.threshold).toBe(5_000);
			expect(verdict.message).toContain("localThresholdTokPerSec");
		}
	});

	it("cloud stream math unchanged: 750 tok/s trips at 500 even with local/perModel config present", () => {
		let nowMs = 0;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				tokenRate: {
					thresholdTokPerSec: 500,
					localThresholdTokPerSec: 5_000,
					// perModel applies to LOCAL-scope events only — must not touch cloud.
					perModel: { "claude*": 1_000_000 },
					windowMs: 2_000,
					consecutiveWindows: 3,
				},
				spendVelocity: { thresholdDollarsPerMin: 1e9 },
			},
			{ now: () => nowMs },
		);
		// 75 tokens every 100ms = 750 tok/s for 7s — no endpointClass (legacy cloud events).
		for (let t = 0; t <= 7_000; t += 100) {
			nowMs = t;
			detector.observe({
				kind: "chunk",
				deltaTokens: 75,
				cumulativeInputTokens: 0,
				cumulativeOutputTokens: (t / 100) * 75,
				model: "claude-sonnet-4-6",
			});
		}
		const verdict = detector.check();
		expect(verdict.tripped).toBe(true);
		if (verdict.tripped) {
			expect(verdict.kind).toBe("token_rate");
			expect(verdict.threshold).toBe(500);
			expect(verdict.message).not.toContain("localThresholdTokPerSec");
			expect(verdict.message).not.toContain("perModel");
		}
	});
});

describe("token-rate cross-scope isolation (interleaved cloud + local)", () => {
	function cloudChunk(deltaTokens: number, t: number, cumOut: number): AnomalyChunkEvent {
		return {
			kind: "chunk",
			deltaTokens,
			cumulativeInputTokens: 0,
			cumulativeOutputTokens: cumOut,
			model: "claude-sonnet-4-6",
			at: t,
		};
	}

	it("a cloud runaway (750 tok/s) interleaved with a slow local stream STILL trips at the cloud 500", () => {
		let nowMs = 0;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				tokenRate: {
					thresholdTokPerSec: 500,
					localThresholdTokPerSec: 5_000,
					windowMs: 1_000,
					consecutiveWindows: 2,
				},
				spendVelocity: { thresholdDollarsPerMin: 1e9, localThresholdUsertokensPerMin: 1e9 },
			},
			{ now: () => nowMs },
		);
		// Each step: a hot cloud chunk (75/100ms = 750 tok/s) THEN a slow local chunk
		// (10/100ms = 100 tok/s). Local is observed LAST on purpose — with a single
		// shared threshold it would leave 5000 in effect and the cloud window would
		// evade; per-scope windows judge cloud on its own 500.
		let cloudOut = 0;
		let localOut = 0;
		for (let t = 0; t <= 3_000; t += 100) {
			nowMs = t;
			cloudOut += 75;
			detector.observe(cloudChunk(75, t, cloudOut));
			localOut += 10;
			detector.observe(localChunk({ deltaTokens: 10, cumulativeOutputTokens: localOut, at: t }));
		}
		const verdict = detector.check();
		expect(verdict.tripped).toBe(true);
		if (verdict.tripped) {
			expect(verdict.kind).toBe("token_rate");
			// Cloud window judged at its own 500 — NOT the interleaved local 5000.
			expect(verdict.threshold).toBe(500);
			expect(verdict.metric).toBeGreaterThanOrEqual(500);
			expect(verdict.message).not.toContain("localThresholdTokPerSec");
			expect(verdict.message).not.toContain("perModel");
		}
	});

	it("a local stream at 3000 tok/s interleaved with a slow cloud stream does NOT trip", () => {
		let nowMs = 0;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				tokenRate: {
					thresholdTokPerSec: 500,
					localThresholdTokPerSec: 5_000,
					windowMs: 1_000,
					consecutiveWindows: 2,
				},
				spendVelocity: { thresholdDollarsPerMin: 1e9, localThresholdUsertokensPerMin: 1e9 },
			},
			{ now: () => nowMs },
		);
		// Local 300/100ms = 3000 tok/s (< 5000, legitimate fast GPU) interleaved with a
		// slow cloud 10/100ms = 100 tok/s (< 500). Neither window crosses its own
		// threshold — a shared window would sum both (3100 tok/s) and could false-trip.
		let localOut = 0;
		let cloudOut = 0;
		for (let t = 0; t <= 3_000; t += 100) {
			nowMs = t;
			localOut += 300;
			detector.observe(localChunk({ deltaTokens: 300, cumulativeOutputTokens: localOut, at: t }));
			cloudOut += 10;
			detector.observe(cloudChunk(10, t, cloudOut));
		}
		expect(detector.check().tripped).toBe(false);
	});
});

describe("dual-denomination spend velocity", () => {
	it("local nonzero-rate velocity trips at localThresholdUsertokensPerMin (default 10000), unit in verdict", () => {
		let nowMs = 0;
		// Operator showback rates: 1 usertoken per output token.
		const config = TrustConfigSchema.parse({
			budget: 1_000,
			local: { defaultRate: { inputPer1k: 0, outputPer1k: 1_000 } },
		});
		const detector = createAnomalyDetector(
			{
				enabled: true,
				tokenRate: { thresholdTokPerSec: 1e9, localThresholdTokPerSec: 1e9 },
				// localThresholdUsertokensPerMin intentionally unset — signal defaults to 10_000.
				spendVelocity: { thresholdDollarsPerMin: 1e9, windowMs: 10_000 },
			},
			{ now: () => nowMs, costCalculator: makeScopedCalculator(config) },
		);
		// Cumulative output grows 500 tok/s → 500 ut/s → 30_000 ut/min >> 10_000.
		for (let t = 0; t <= 10_000; t += 500) {
			nowMs = t;
			detector.observe(localChunk({ cumulativeOutputTokens: (t / 1_000) * 500 }));
		}
		const verdict = detector.check();
		expect(verdict.tripped).toBe(true);
		if (verdict.tripped) {
			expect(verdict.kind).toBe("spend_velocity");
			expect(verdict.threshold).toBe(10_000);
			expect(verdict.metric).toBeGreaterThanOrEqual(10_000);
			// Never fake dollars for nominal spend.
			expect(verdict.message).toContain("usertokens/min");
			expect(verdict.message).not.toContain("$");
		}
		// Idempotent while tripped (cooldown): re-check keeps the usertoken verdict.
		const again = detector.check();
		expect(again.tripped).toBe(true);
		if (again.tripped) {
			expect(again.kind).toBe("spend_velocity");
			expect(again.message).toContain("usertokens/min");
		}
	});

	it("local cumulative regression is clamped monotonic (no trip, no negative velocity)", () => {
		let nowMs = 0;
		const config = TrustConfigSchema.parse({
			budget: 1_000,
			local: { defaultRate: { inputPer1k: 0, outputPer1k: 1_000 } },
		});
		const detector = createAnomalyDetector(
			{
				enabled: true,
				tokenRate: { thresholdTokPerSec: 1e9, localThresholdTokPerSec: 1e9 },
				spendVelocity: { thresholdDollarsPerMin: 1e9, localThresholdUsertokensPerMin: 60 },
			},
			{ now: () => nowMs, costCalculator: makeScopedCalculator(config) },
		);
		// Cumulative output regresses mid-stream (provider glitch) — clamped to last.
		for (const [t, cumOut] of [
			[0, 1_000],
			[1_000, 500],
			[5_000, 1_000],
			[10_000, 1_000],
		] as const) {
			nowMs = t;
			detector.observe(localChunk({ cumulativeOutputTokens: cumOut }));
		}
		expect(detector.check().tripped).toBe(false);
	});

	it("explicit localThresholdUsertokensPerMin is respected (raised threshold does not trip)", () => {
		let nowMs = 0;
		const config = TrustConfigSchema.parse({
			budget: 1_000,
			local: { defaultRate: { inputPer1k: 0, outputPer1k: 1_000 } },
		});
		const detector = createAnomalyDetector(
			{
				enabled: true,
				tokenRate: { thresholdTokPerSec: 1e9, localThresholdTokPerSec: 1e9 },
				spendVelocity: {
					thresholdDollarsPerMin: 1e9,
					localThresholdUsertokensPerMin: 100_000,
					windowMs: 10_000,
				},
			},
			{ now: () => nowMs, costCalculator: makeScopedCalculator(config) },
		);
		// Same 30_000 ut/min stream — below the raised 100_000 threshold.
		for (let t = 0; t <= 10_000; t += 500) {
			nowMs = t;
			detector.observe(localChunk({ cumulativeOutputTokens: (t / 1_000) * 500 }));
		}
		expect(detector.check().tripped).toBe(false);
	});

	it("zero-rate local velocity never trips (default local config; token_rate is the primary local signal)", () => {
		let nowMs = 0;
		// Default config: local.defaultRate is {0,0} → cumulative nominal cost is a
		// constant floor of 1 → velocity is exactly 0 ut/min, forever.
		const config = TrustConfigSchema.parse({ budget: 1_000 });
		const detector = createAnomalyDetector(
			{
				enabled: true,
				tokenRate: { thresholdTokPerSec: 1e9, localThresholdTokPerSec: 1e9 },
				// Absurdly low local threshold: even 60 ut/min cannot trip on a flat cumulative.
				spendVelocity: { thresholdDollarsPerMin: 1e9, localThresholdUsertokensPerMin: 60 },
			},
			{ now: () => nowMs, costCalculator: makeScopedCalculator(config) },
		);
		// A million output tokens over 10 seconds — free inference, flat nominal cost.
		for (let t = 0; t <= 10_000; t += 500) {
			nowMs = t;
			detector.observe(localChunk({ cumulativeOutputTokens: (t / 10) * 1_000 }));
		}
		expect(detector.check().tripped).toBe(false);
	});

	it("zero-rate local velocity never trips with the built-in default calculator either", () => {
		let nowMs = 0;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				tokenRate: { thresholdTokPerSec: 1e9, localThresholdTokPerSec: 1e9 },
				spendVelocity: { thresholdDollarsPerMin: 1e9, localThresholdUsertokensPerMin: 60 },
			},
			{ now: () => nowMs }, // no injected calculator
		);
		for (let t = 0; t <= 10_000; t += 500) {
			nowMs = t;
			detector.observe(localChunk({ cumulativeOutputTokens: (t / 10) * 1_000 }));
		}
		expect(detector.check().tripped).toBe(false);
	});

	it("cloud spend-velocity math unchanged: $/min verdict with dollar threshold (3-arg legacy calculator)", () => {
		let nowMs = 0;
		// Legacy 3-arg calculator stays assignable (backward compatible).
		const costCalc = (_m: string, _i: number, output: number) => output;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				spendVelocity: {
					thresholdDollarsPerMin: 1.0,
					localThresholdUsertokensPerMin: 1e9,
					windowMs: 10_000,
				},
			},
			{ now: () => nowMs, costCalculator: costCalc, model: "test" },
		);
		// $0.02/s = $1.20/min — over the $1/min threshold. No endpointClass (legacy events).
		for (let t = 0; t <= 10_000; t += 1_000) {
			nowMs = t;
			detector.observe({
				kind: "chunk",
				deltaTokens: 0,
				cumulativeInputTokens: 0,
				cumulativeOutputTokens: (t / 1_000) * 0.02,
			});
		}
		const verdict = detector.check();
		expect(verdict.tripped).toBe(true);
		if (verdict.tripped) {
			expect(verdict.kind).toBe("spend_velocity");
			expect(verdict.threshold).toBe(1.0);
			expect(verdict.metric).toBeGreaterThanOrEqual(1.0);
			expect(verdict.message).toContain("$/min");
			expect(verdict.message).not.toContain("usertokens");
		}
	});
});

describe("spend-velocity signal: mixed-scope denomination reporting", () => {
	it("non-tripped check reports the denomination closer to its threshold", () => {
		const signal = createSpendVelocitySignal(
			resolveSpendVelocityConfig({
				thresholdDollarsPerMin: 100,
				localThresholdUsertokensPerMin: 1_000,
				windowMs: 60_000,
			}),
		);
		// cloud: $10/min → 10% of threshold; local: 500 ut/min → 50% of threshold.
		signal.observe(0, 0, "cloud");
		signal.observe(0, 0, "local");
		signal.observe(10, 60_000, "cloud");
		signal.observe(500, 60_000, "local");
		const r = signal.check(60_000);
		expect(r.tripped).toBe(false);
		expect(r.unit).toBe("usertokens");
		expect(r.thresholdLabel).toBe("localThresholdUsertokensPerMin");
		expect(r.metric).toBeCloseTo(500);

		// Flip: cloud closer to its threshold → dollars reported.
		signal.reset();
		signal.observe(0, 0, "cloud");
		signal.observe(0, 0, "local");
		signal.observe(90, 60_000, "cloud");
		signal.observe(100, 60_000, "local");
		const r2 = signal.check(60_000);
		expect(r2.tripped).toBe(false);
		expect(r2.unit).toBe("dollars");
		expect(r2.metric).toBeCloseTo(90);
	});
});

describe("per-event calculator seam", () => {
	it("per-event model override and the event object reach the injected calculator", () => {
		const seen: Array<{
			model: string;
			eventModel: string | undefined;
			scope: string | undefined;
		}> = [];
		const calc = vi.fn(
			(model: string, _input: number, _output: number, event?: AnomalyChunkEvent): number => {
				seen.push({ model, eventModel: event?.model, scope: event?.endpointClass });
				return 0;
			},
		);
		const detector = createAnomalyDetector(
			{ enabled: true },
			{ model: "governor-default", costCalculator: calc, now: () => 0 },
		);

		const localEvent = localChunk({ model: "qwen2.5:7b" });
		detector.observe(localEvent);
		detector.observe({
			kind: "chunk",
			deltaTokens: 0,
			cumulativeInputTokens: 0,
			cumulativeOutputTokens: 0,
		});

		// Event model overrides options.model; the observed event is passed through.
		expect(seen[0]).toEqual({ model: "qwen2.5:7b", eventModel: "qwen2.5:7b", scope: "local" });
		expect(calc.mock.calls[0]?.[3]).toBe(localEvent);
		// Without an event model, options.model is the fallback.
		expect(seen[1]).toEqual({ model: "governor-default", eventModel: undefined, scope: undefined });
	});
});
