// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { createAnomalyDetector } from "../../src/anomaly/detector.js";

describe("injection-cascade anomaly signal", () => {
	it("trips on N injection events within window", () => {
		let nowMs = 0;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				injectionCascade: { eventCount: 3, windowMs: 60_000 },
			},
			{ now: () => nowMs },
		);
		nowMs = 1_000;
		detector.observe({ kind: "injection", patterns: ["a"] });
		nowMs = 2_000;
		detector.observe({ kind: "injection", patterns: ["b"] });
		expect(detector.check()).toEqual({ tripped: false });

		nowMs = 3_000;
		detector.observe({ kind: "injection", patterns: ["c"] });
		const verdict = detector.check();
		expect(verdict.tripped).toBe(true);
		if (verdict.tripped) {
			expect(verdict.kind).toBe("injection_cascade");
			expect(verdict.metric).toBe(3);
			expect(verdict.threshold).toBe(3);
		}
	});

	it("cleans up older events outside window", () => {
		let nowMs = 0;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				injectionCascade: { eventCount: 3, windowMs: 10_000 },
				cooldownMs: 0, // disable cooldown lock
			},
			{ now: () => nowMs },
		);
		// 2 injections at t=0, 1s
		nowMs = 0;
		detector.observe({ kind: "injection" });
		nowMs = 1_000;
		detector.observe({ kind: "injection" });

		// Advance past window
		nowMs = 12_000;
		// Only one new injection — outside window, should not trip
		detector.observe({ kind: "injection" });
		const v = detector.check();
		expect(v.tripped).toBe(false);
	});

	it("does NOT trip when injections are spaced beyond window", () => {
		let nowMs = 0;
		const detector = createAnomalyDetector(
			{
				enabled: true,
				injectionCascade: { eventCount: 3, windowMs: 5_000 },
			},
			{ now: () => nowMs },
		);
		// Spaced 10s apart — never more than 1 in window
		nowMs = 0;
		detector.observe({ kind: "injection" });
		nowMs = 10_000;
		detector.observe({ kind: "injection" });
		nowMs = 20_000;
		detector.observe({ kind: "injection" });
		const verdict = detector.check();
		expect(verdict.tripped).toBe(false);
	});

	it("stays disabled when enabled=false", () => {
		const nowMs = 0;
		const detector = createAnomalyDetector(
			{
				injectionCascade: { eventCount: 1, windowMs: 1_000 },
			},
			{ now: () => nowMs },
		);
		detector.observe({ kind: "injection" });
		detector.observe({ kind: "injection" });
		expect(detector.check()).toEqual({ tripped: false });
	});
});
