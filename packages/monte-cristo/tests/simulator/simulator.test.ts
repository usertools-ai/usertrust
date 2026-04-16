// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { sampleNormal, sampleUniform } from "../../src/distributions/index.js";
import { Xoshiro256 } from "../../src/rng/xoshiro256.js";
import {
	type SimulationComplete,
	type SimulationProgress,
	computePercentiles,
	percentileFromSorted,
	runSimulation,
	runSimulationStreaming,
} from "../../src/simulator/index.js";

describe("runSimulation", () => {
	it("computes percentiles, mean, stddev for a uniform draw", () => {
		const rng = new Xoshiro256(42);
		const result = runSimulation({
			iterations: 10_000,
			rng,
			sample: (r) => sampleUniform(r, 0, 100),
		});
		expect(result.iterations).toBe(10_000);
		expect(result.dropped).toBe(0);
		// Uniform(0, 100) -> mean ~ 50, stddev ~ 100/sqrt(12) ~ 28.87
		expect(result.mean).toBeGreaterThan(49);
		expect(result.mean).toBeLessThan(51);
		expect(result.stddev).toBeGreaterThan(28);
		expect(result.stddev).toBeLessThan(30);
		// Percentile envelope ordering
		expect(result.percentiles.p5).toBeLessThan(result.percentiles.p25);
		expect(result.percentiles.p25).toBeLessThan(result.percentiles.p50);
		expect(result.percentiles.p50).toBeLessThan(result.percentiles.p75);
		expect(result.percentiles.p75).toBeLessThan(result.percentiles.p95);
		expect(result.percentiles.p95).toBeLessThan(result.percentiles.p99);
		// Median ~ 50 for uniform
		expect(Math.abs(result.percentiles.p50 - 50)).toBeLessThan(2);
	});

	it("reproduces identical results with the same seed", () => {
		const r1 = runSimulation({
			iterations: 5_000,
			rng: new Xoshiro256(1234),
			sample: (r) => sampleNormal(r, 50, 10),
		});
		const r2 = runSimulation({
			iterations: 5_000,
			rng: new Xoshiro256(1234),
			sample: (r) => sampleNormal(r, 50, 10),
		});
		expect(r2).toEqual(r1);
	});

	it("produces different results for different seeds", () => {
		const r1 = runSimulation({
			iterations: 1_000,
			rng: new Xoshiro256(1),
			sample: (r) => sampleNormal(r, 50, 10),
		});
		const r2 = runSimulation({
			iterations: 1_000,
			rng: new Xoshiro256(2),
			sample: (r) => sampleNormal(r, 50, 10),
		});
		expect(r2.percentiles.p50).not.toBe(r1.percentiles.p50);
	});

	it("normal(mean=100, stddev=15) recovers analytical percentiles", () => {
		const result = runSimulation({
			iterations: 50_000,
			rng: new Xoshiro256(7),
			sample: (r) => sampleNormal(r, 100, 15),
		});
		// p50 ~ 100, p5 ~ 100 - 1.645*15 ~ 75.3, p95 ~ 124.7
		expect(Math.abs(result.percentiles.p50 - 100)).toBeLessThan(1);
		expect(Math.abs(result.percentiles.p5 - 75.3)).toBeLessThan(1.5);
		expect(Math.abs(result.percentiles.p95 - 124.7)).toBeLessThan(1.5);
	});

	it("counts dropped non-finite samples instead of throwing", () => {
		let i = 0;
		const result = runSimulation({
			iterations: 100,
			rng: new Xoshiro256(0),
			sample: () => (i++ % 2 === 0 ? Number.NaN : 1),
		});
		expect(result.iterations).toBe(50);
		expect(result.dropped).toBe(50);
	});

	it("throws when all samples are non-finite", () => {
		expect(() =>
			runSimulation({
				iterations: 10,
				rng: new Xoshiro256(0),
				sample: () => Number.POSITIVE_INFINITY,
			}),
		).toThrow(/all samples were non-finite/);
	});

	it("throws on iterations < 1", () => {
		expect(() =>
			runSimulation({
				iterations: 0,
				rng: new Xoshiro256(0),
				sample: () => 1,
			}),
		).toThrow(/positive integer/);
	});

	it("records min and max correctly", () => {
		const samples = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
		let i = 0;
		const result = runSimulation({
			iterations: samples.length,
			rng: new Xoshiro256(0),
			sample: () => samples[i++] as number,
		});
		expect(result.min).toBe(1);
		expect(result.max).toBe(9);
	});
});

describe("runSimulationStreaming", () => {
	it("yields progress events at the configured interval", () => {
		const events = [];
		for (const ev of runSimulationStreaming({
			iterations: 1_000,
			rng: new Xoshiro256(0),
			sample: (r) => sampleUniform(r, 0, 1),
			progressInterval: 250,
		})) {
			events.push(ev);
		}
		const progress = events.filter((e): e is SimulationProgress => e.type === "progress");
		const complete = events.filter((e): e is SimulationComplete => e.type === "complete");
		expect(progress.length).toBe(4); // 250, 500, 750, 1000
		expect(complete.length).toBe(1);
		expect(complete[0]?.completed).toBe(1_000);
	});

	it("final result matches non-streaming runSimulation", () => {
		const r1 = runSimulation({
			iterations: 2_000,
			rng: new Xoshiro256(99),
			sample: (r) => sampleNormal(r, 0, 1),
		});
		let r2: SimulationComplete | undefined;
		for (const ev of runSimulationStreaming({
			iterations: 2_000,
			rng: new Xoshiro256(99),
			sample: (r) => sampleNormal(r, 0, 1),
			progressInterval: 500,
		})) {
			if (ev.type === "complete") r2 = ev;
		}
		expect(r2?.result).toEqual(r1);
	});
});

describe("computePercentiles", () => {
	it("returns zeros for empty input", () => {
		const p = computePercentiles([]);
		expect(p).toEqual({ p5: 0, p25: 0, p50: 0, p75: 0, p95: 0, p99: 0 });
	});

	it("computes percentiles in sorted order", () => {
		const samples = Array.from({ length: 100 }, (_, i) => i + 1);
		const p = computePercentiles(samples);
		expect(p.p5).toBeLessThanOrEqual(p.p25);
		expect(p.p25).toBeLessThanOrEqual(p.p50);
		expect(p.p50).toBeLessThanOrEqual(p.p95);
	});
});

describe("percentileFromSorted", () => {
	it("returns 0 for empty array", () => {
		expect(percentileFromSorted([], 50)).toBe(0);
	});

	it("uses nearest-rank convention", () => {
		const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
		// p50 of 10 elements -> idx = floor(0.5*10) = 5 -> 60
		expect(percentileFromSorted(sorted, 50)).toBe(60);
	});
});
