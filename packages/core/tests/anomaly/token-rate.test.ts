// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { createAnomalyDetector } from "../../src/anomaly/detector.js";

describe("token-rate anomaly signal", () => {
	it("does not trip when disabled (default off)", () => {
		const detector = createAnomalyDetector(undefined, { now: () => 0 });
		// Even at huge rate, default config has enabled=false
		for (let i = 0; i < 100; i++) {
			detector.observe({
				kind: "chunk",
				deltaTokens: 10_000,
				cumulativeInputTokens: 0,
				cumulativeOutputTokens: i * 10_000,
				at: i * 10,
			});
		}
		expect(detector.check()).toEqual({ tripped: false });
	});

	it("trips on sustained high-rate chunks (3 consecutive 2s windows above 500 tok/s)", () => {
		let nowMs = 0;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				tokenRate: { thresholdTokPerSec: 500, windowMs: 2_000, consecutiveWindows: 3 },
			},
			{ now: () => nowMs },
		);
		// Emit 1500 tokens per 2s window for 7 seconds — well above 500 tok/s.
		// Spread chunks every 100ms. 1500 tokens / 2s = 750 tok/s.
		for (let t = 0; t <= 7_000; t += 100) {
			nowMs = t;
			detector.observe({
				kind: "chunk",
				deltaTokens: 75,
				cumulativeInputTokens: 0,
				cumulativeOutputTokens: (t / 100) * 75,
			});
		}
		const verdict = detector.check();
		expect(verdict.tripped).toBe(true);
		if (verdict.tripped) {
			expect(verdict.kind).toBe("token_rate");
			expect(verdict.metric).toBeGreaterThanOrEqual(500);
		}
	});

	it("does NOT trip on a brief spike (1-2 hot windows then quiet)", () => {
		let nowMs = 0;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				tokenRate: { thresholdTokPerSec: 500, windowMs: 2_000, consecutiveWindows: 3 },
			},
			{ now: () => nowMs },
		);
		// First 2s window: 2000 tokens → 1000 tok/s (HOT)
		for (let i = 0; i < 20; i++) {
			nowMs = i * 100;
			detector.observe({
				kind: "chunk",
				deltaTokens: 100,
				cumulativeInputTokens: 0,
				cumulativeOutputTokens: (i + 1) * 100,
			});
		}
		// Next 4s: silence → consecutive resets to 0
		for (let t = 2_000; t <= 6_000; t += 100) {
			nowMs = t;
			detector.observe({
				kind: "chunk",
				deltaTokens: 0,
				cumulativeInputTokens: 0,
				cumulativeOutputTokens: 2_000,
			});
		}
		const verdict = detector.check();
		expect(verdict.tripped).toBe(false);
	});

	it("tripped state persists across check() calls until reset()", () => {
		let nowMs = 0;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				tokenRate: { thresholdTokPerSec: 100, windowMs: 1_000, consecutiveWindows: 1 },
				cooldownMs: 60_000,
			},
			{ now: () => nowMs },
		);
		// Push 200 tokens in 1s → 200 tok/s, well above 100.
		for (let i = 0; i < 10; i++) {
			nowMs = i * 100;
			detector.observe({
				kind: "chunk",
				deltaTokens: 20,
				cumulativeInputTokens: 0,
				cumulativeOutputTokens: (i + 1) * 20,
			});
		}
		nowMs = 1_500;
		// Trigger window roll-over with one more chunk
		detector.observe({
			kind: "chunk",
			deltaTokens: 0,
			cumulativeInputTokens: 0,
			cumulativeOutputTokens: 200,
		});

		const v1 = detector.check();
		expect(v1.tripped).toBe(true);
		const v2 = detector.check();
		expect(v2.tripped).toBe(true);

		detector.reset();
		const v3 = detector.check();
		expect(v3.tripped).toBe(false);
	});

	it("auto-recovers after cooldownMs", () => {
		let nowMs = 0;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				tokenRate: { thresholdTokPerSec: 100, windowMs: 1_000, consecutiveWindows: 1 },
				cooldownMs: 5_000,
			},
			{ now: () => nowMs },
		);
		// Trip the detector
		for (let i = 0; i < 10; i++) {
			nowMs = i * 100;
			detector.observe({
				kind: "chunk",
				deltaTokens: 20,
				cumulativeInputTokens: 0,
				cumulativeOutputTokens: (i + 1) * 20,
			});
		}
		nowMs = 1_500;
		detector.observe({
			kind: "chunk",
			deltaTokens: 0,
			cumulativeInputTokens: 0,
			cumulativeOutputTokens: 200,
		});
		expect(detector.isTripped()).toBe(true);

		// Advance past cooldown
		nowMs = 1_500 + 5_001;
		expect(detector.isTripped()).toBe(false);
		expect(detector.check()).toEqual({ tripped: false });
	});
});
