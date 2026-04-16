// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { createAnomalyDetector } from "../../src/anomaly/detector.js";

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
});
