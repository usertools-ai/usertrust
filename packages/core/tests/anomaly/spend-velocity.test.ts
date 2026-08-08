// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { createAnomalyDetector } from "../../src/anomaly/detector.js";
import type { AnomalyChunkEvent } from "../../src/anomaly/types.js";
import { getModelRates } from "../../src/ledger/pricing.js";

const USERTOKENS_PER_DOLLAR = 10_000;

describe("spend-velocity anomaly signal", () => {
	it("trips when $/min exceeds threshold", () => {
		let nowMs = 0;
		// Fixed cost calculator: returns the cumulative output tokens as dollars
		const costCalc = (_m: string, _i: number, output: number) => output;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				spendVelocity: { thresholdDollarsPerMin: 1.0, windowMs: 10_000 },
			},
			{ now: () => nowMs, costCalculator: costCalc, model: "test" },
		);
		// Push $0.20 over 10 seconds = $1.20/min — over threshold
		for (let t = 0; t <= 10_000; t += 1_000) {
			nowMs = t;
			detector.observe({
				kind: "chunk",
				deltaTokens: 0,
				cumulativeInputTokens: 0,
				cumulativeOutputTokens: (t / 1_000) * 0.02, // $0.02 per second = $1.20/min
			});
		}
		const verdict = detector.check();
		expect(verdict.tripped).toBe(true);
		if (verdict.tripped) {
			expect(verdict.kind).toBe("spend_velocity");
			expect(verdict.metric).toBeGreaterThanOrEqual(1.0);
		}
	});

	it("does NOT trip when spend rate is below threshold", () => {
		let nowMs = 0;
		const costCalc = (_m: string, _i: number, output: number) => output;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				spendVelocity: { thresholdDollarsPerMin: 1.0, windowMs: 10_000 },
			},
			{ now: () => nowMs, costCalculator: costCalc, model: "test" },
		);
		// $0.05 over 10s → $0.30/min — under threshold
		for (let t = 0; t <= 10_000; t += 1_000) {
			nowMs = t;
			detector.observe({
				kind: "chunk",
				deltaTokens: 0,
				cumulativeInputTokens: 0,
				cumulativeOutputTokens: (t / 1_000) * 0.005,
			});
		}
		const verdict = detector.check();
		expect(verdict.tripped).toBe(false);
	});

	it("rolling window discards stale samples", () => {
		let nowMs = 0;
		const costCalc = (_m: string, _i: number, output: number) => output;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				spendVelocity: { thresholdDollarsPerMin: 1.0, windowMs: 10_000 },
			},
			{ now: () => nowMs, costCalculator: costCalc, model: "test" },
		);
		// First push high spend at t=0..2000
		for (let t = 0; t <= 2_000; t += 100) {
			nowMs = t;
			detector.observe({
				kind: "chunk",
				deltaTokens: 0,
				cumulativeInputTokens: 0,
				cumulativeOutputTokens: (t / 100) * 0.1, // huge
			});
		}
		// Wait until past the window — only one stale sample left
		nowMs = 30_000;
		// Push another sample with slow rate
		detector.observe({
			kind: "chunk",
			deltaTokens: 0,
			cumulativeInputTokens: 0,
			cumulativeOutputTokens: 2.1, // very small delta from clamped boundary
		});
		nowMs = 35_000;
		detector.observe({
			kind: "chunk",
			deltaTokens: 0,
			cumulativeInputTokens: 0,
			cumulativeOutputTokens: 2.11,
		});

		const verdict = detector.check();
		// With ~$0.01 over 5s ≈ $0.12/min — below 1.0
		expect(verdict.tripped).toBe(false);
	});

	it("cooldown auto-resets after configured ms", () => {
		let nowMs = 0;
		const costCalc = (_m: string, _i: number, output: number) => output;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				spendVelocity: { thresholdDollarsPerMin: 1.0, windowMs: 5_000 },
				cooldownMs: 5_000,
			},
			{ now: () => nowMs, costCalculator: costCalc, model: "test" },
		);
		// Trip
		for (let t = 0; t <= 5_000; t += 500) {
			nowMs = t;
			detector.observe({
				kind: "chunk",
				deltaTokens: 0,
				cumulativeInputTokens: 0,
				cumulativeOutputTokens: (t / 1_000) * 0.05,
			});
		}
		expect(detector.isTripped()).toBe(true);

		// Advance past cooldown
		nowMs = 5_000 + 5_001;
		expect(detector.isTripped()).toBe(false);
	});

	it("ignores negative or NaN cumulative values", () => {
		let nowMs = 0;
		const costCalc = (_m: string, _i: number, output: number) => output;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				spendVelocity: { thresholdDollarsPerMin: 1.0, windowMs: 10_000 },
			},
			{ now: () => nowMs, costCalculator: costCalc, model: "test" },
		);
		nowMs = 0;
		detector.observe({
			kind: "chunk",
			deltaTokens: 0,
			cumulativeInputTokens: 0,
			cumulativeOutputTokens: Number.NaN,
		});
		nowMs = 1_000;
		detector.observe({
			kind: "chunk",
			deltaTokens: 0,
			cumulativeInputTokens: 0,
			cumulativeOutputTokens: -5,
		});
		const v = detector.check();
		expect(v.tripped).toBe(false);
	});

	it("named: a cache-read flood is visible at its true spend rate — the same flood pre-fix computed ~zero velocity (spec D7)", () => {
		let nowMs = 0;
		const model = "claude-sonnet-4-6";

		// Pre-fix shape: AnomalyChunkEvent carried no cache tiers at all, so a
		// calculator could only ever see fresh input/output. A flood that is
		// almost entirely cache reads (near-zero fresh input/output, exactly the
		// 1.14B-cache-read-day shape) priced at ~$0 the whole time — the bug this
		// ship exists to kill, reproduced here for contrast.
		const preFixCalculator = (_m: string, inputTokens: number, outputTokens: number): number => {
			const rates = getModelRates(model);
			return (
				(rates.inputPer1k * (inputTokens / 1000) + rates.outputPer1k * (outputTokens / 1000)) /
				USERTOKENS_PER_DOLLAR
			);
		};
		const preFixDetector = createAnomalyDetector(
			{ enabled: true, spendVelocity: { thresholdDollarsPerMin: 1.0, windowMs: 10_000 } },
			{ now: () => nowMs, costCalculator: preFixCalculator, model },
		);

		// Post-fix: the BUILT-IN default calculator (no injected override) reads
		// the event's cumulative cache tiers and prices all four tiers, unfloored.
		const postFixDetector = createAnomalyDetector(
			{ enabled: true, spendVelocity: { thresholdDollarsPerMin: 1.0, windowMs: 10_000 } },
			{ now: () => nowMs, model },
		);

		// Fresh input/output stay flat and tiny; cache reads flood in at 200k
		// tok/s — the recorded-day shape compressed into a 10s observation window.
		for (let t = 0; t <= 10_000; t += 1_000) {
			nowMs = t;
			const event: AnomalyChunkEvent = {
				kind: "chunk",
				deltaTokens: 0,
				cumulativeInputTokens: 10,
				cumulativeOutputTokens: 5,
				cumulativeCacheReadTokens: (t / 1_000) * 200_000,
				cumulativeCacheWriteTokens: 0,
				model,
			};
			preFixDetector.observe(event);
			postFixDetector.observe(event);
		}

		const preFixVerdict = preFixDetector.check();
		const postFixVerdict = postFixDetector.check();

		// Pre-fix: cache reads were invisible to the calculator — cumulative cost
		// never moves off its flat input/output floor, so velocity never trips.
		expect(preFixVerdict.tripped).toBe(false);

		// Post-fix: the four-tier no-floor cost sees the flood at its true rate.
		expect(postFixVerdict.tripped).toBe(true);
		if (postFixVerdict.tripped) {
			expect(postFixVerdict.kind).toBe("spend_velocity");
			expect(postFixVerdict.metric).toBeGreaterThanOrEqual(1.0);
		}
	});
});
