// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	rateToBetaParams,
	sampleBeta,
	sampleLognormal,
	sampleNormal,
	sampleTriangular,
	sampleUniform,
} from "../../src/distributions/index.js";
import { Xoshiro256 } from "../../src/rng/xoshiro256.js";

const N = 20_000;

function meanOf(values: number[]): number {
	return values.reduce((s, v) => s + v, 0) / values.length;
}

function stddevOf(values: number[]): number {
	const m = meanOf(values);
	const v = values.reduce((s, x) => s + (x - m) ** 2, 0) / values.length;
	return Math.sqrt(v);
}

describe("sampleNormal", () => {
	it("approximates target mean and stddev", () => {
		const rng = new Xoshiro256(1);
		const samples = Array.from({ length: N }, () => sampleNormal(rng, 100, 15));
		expect(meanOf(samples)).toBeGreaterThan(99);
		expect(meanOf(samples)).toBeLessThan(101);
		expect(stddevOf(samples)).toBeGreaterThan(14.5);
		expect(stddevOf(samples)).toBeLessThan(15.5);
	});

	it("is deterministic for the same seed", () => {
		const a = new Xoshiro256(42);
		const b = new Xoshiro256(42);
		expect(sampleNormal(a, 0, 1)).toBe(sampleNormal(b, 0, 1));
	});
});

describe("sampleTriangular", () => {
	it("respects min/max bounds", () => {
		const rng = new Xoshiro256(2);
		for (let i = 0; i < N; i++) {
			const v = sampleTriangular(rng, 10, 20, 30);
			expect(v).toBeGreaterThanOrEqual(10);
			expect(v).toBeLessThanOrEqual(30);
		}
	});

	it("approximates the analytical mean (min+mode+max)/3", () => {
		const rng = new Xoshiro256(3);
		const samples = Array.from({ length: N }, () => sampleTriangular(rng, 10, 20, 30));
		const expectedMean = (10 + 20 + 30) / 3;
		expect(Math.abs(meanOf(samples) - expectedMean)).toBeLessThan(0.3);
	});

	it("collapses to the point when min == max", () => {
		const rng = new Xoshiro256(4);
		expect(sampleTriangular(rng, 5, 5, 5)).toBe(5);
	});

	it("is deterministic", () => {
		const a = new Xoshiro256(99);
		const b = new Xoshiro256(99);
		expect(sampleTriangular(a, 0, 5, 10)).toBe(sampleTriangular(b, 0, 5, 10));
	});
});

describe("sampleLognormal", () => {
	it("never produces negative values", () => {
		const rng = new Xoshiro256(5);
		for (let i = 0; i < N; i++) {
			expect(sampleLognormal(rng, 100, 0.5)).toBeGreaterThan(0);
		}
	});

	it("is right-skewed (mean > median)", () => {
		const rng = new Xoshiro256(6);
		const samples = Array.from({ length: N }, () => sampleLognormal(rng, 100, 0.5));
		samples.sort((a, b) => a - b);
		const median = samples[Math.floor(samples.length / 2)] as number;
		const mean = meanOf(samples);
		expect(mean).toBeGreaterThan(median);
	});

	it("median sample approximates the median parameter", () => {
		const rng = new Xoshiro256(7);
		const samples = Array.from({ length: N }, () => sampleLognormal(rng, 100, 0.4));
		samples.sort((a, b) => a - b);
		const empirical = samples[Math.floor(samples.length / 2)] as number;
		expect(empirical).toBeGreaterThan(95);
		expect(empirical).toBeLessThan(105);
	});
});

describe("sampleBeta", () => {
	it("stays in (0, 1)", () => {
		const rng = new Xoshiro256(8);
		for (let i = 0; i < N; i++) {
			const v = sampleBeta(rng, 2, 5);
			expect(v).toBeGreaterThan(0);
			expect(v).toBeLessThan(1);
		}
	});

	it("Beta(2, 5) has mean ~ 2/7 ≈ 0.286", () => {
		const rng = new Xoshiro256(9);
		const samples = Array.from({ length: N }, () => sampleBeta(rng, 2, 5));
		expect(Math.abs(meanOf(samples) - 2 / 7)).toBeLessThan(0.01);
	});

	it("Beta(5, 2) has mean ~ 5/7 ≈ 0.714 (mirror of above)", () => {
		const rng = new Xoshiro256(10);
		const samples = Array.from({ length: N }, () => sampleBeta(rng, 5, 2));
		expect(Math.abs(meanOf(samples) - 5 / 7)).toBeLessThan(0.01);
	});

	it("handles shape < 1 path (uses recursion + power)", () => {
		const rng = new Xoshiro256(11);
		const samples = Array.from({ length: 1000 }, () => sampleBeta(rng, 0.5, 0.5));
		for (const v of samples) {
			expect(v).toBeGreaterThan(0);
			expect(v).toBeLessThan(1);
		}
	});
});

describe("sampleUniform", () => {
	it("stays in [min, max)", () => {
		const rng = new Xoshiro256(12);
		for (let i = 0; i < N; i++) {
			const v = sampleUniform(rng, -5, 5);
			expect(v).toBeGreaterThanOrEqual(-5);
			expect(v).toBeLessThan(5);
		}
	});

	it("mean approximates (min+max)/2", () => {
		const rng = new Xoshiro256(13);
		const samples = Array.from({ length: N }, () => sampleUniform(rng, 0, 10));
		expect(Math.abs(meanOf(samples) - 5)).toBeLessThan(0.15);
	});
});

describe("rateToBetaParams", () => {
	it("returns alpha, beta >= 1 for normal inputs", () => {
		const { alpha, beta } = rateToBetaParams(0.5, 0.15);
		expect(alpha).toBeGreaterThanOrEqual(1);
		expect(beta).toBeGreaterThanOrEqual(1);
	});

	it("samples cluster near targetRate", () => {
		const target = 0.3;
		const { alpha, beta } = rateToBetaParams(target, 0.1);
		const rng = new Xoshiro256(14);
		const samples = Array.from({ length: N }, () => sampleBeta(rng, alpha, beta));
		expect(Math.abs(meanOf(samples) - target)).toBeLessThan(0.05);
	});

	it("clamps target to [0.05, 0.95]", () => {
		const low = rateToBetaParams(0.001, 0.1);
		const high = rateToBetaParams(0.999, 0.1);
		expect(low.alpha).toBeGreaterThan(0);
		expect(high.beta).toBeGreaterThan(0);
	});
});
