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

/** A scripted RNG yielding the given floats in order, then repeating the last. */
function scriptedRng(values: number[]): Xoshiro256 {
	let i = 0;
	const nextFloat = () => {
		const v = values[Math.min(i, values.length - 1)] ?? 0;
		i += 1;
		return v;
	};
	return { nextFloat } as unknown as Xoshiro256;
}

describe("sampleTriangular edge branches", () => {
	it("returns the point value when min === max (zero range)", () => {
		expect(sampleTriangular(new Xoshiro256(1), 5, 5, 5)).toBe(5);
	});

	it("takes the lower-tail branch when u < f(c)", () => {
		// min=0, mode=5, max=10 -> f(c)=0.5; u=0.1 -> lower tail.
		const v = sampleTriangular(scriptedRng([0.1]), 0, 5, 10);
		expect(v).toBeGreaterThanOrEqual(0);
		expect(v).toBeLessThanOrEqual(5);
	});

	it("takes the upper-tail branch when u >= f(c)", () => {
		const v = sampleTriangular(scriptedRng([0.9]), 0, 5, 10);
		expect(v).toBeGreaterThanOrEqual(5);
		expect(v).toBeLessThanOrEqual(10);
	});
});

describe("sampleNormal LOG_FLOOR guard", () => {
	it("stays finite when the RNG yields exactly 0 (Math.log(0) guard)", () => {
		const v = sampleNormal(scriptedRng([0, 0.5]), 10, 2);
		expect(Number.isFinite(v)).toBe(true);
	});
});

describe("rateToBetaParams edge branches", () => {
	it("returns the uniform Beta(1,1) when spread collapses variance to 0", () => {
		expect(rateToBetaParams(0.5, 0)).toEqual({ alpha: 1, beta: 1 });
	});

	it("clamps the mean into [0.05, 0.95]", () => {
		const high = rateToBetaParams(0.99);
		const low = rateToBetaParams(0.0);
		expect(high.alpha).toBeGreaterThanOrEqual(1);
		expect(high.beta).toBeGreaterThanOrEqual(1);
		expect(low.alpha).toBeGreaterThanOrEqual(1);
		expect(low.beta).toBeGreaterThanOrEqual(1);
	});

	it("produces well-formed shape params for a normal spread", () => {
		const { alpha, beta } = rateToBetaParams(0.5, 0.2);
		expect(alpha).toBeGreaterThanOrEqual(1);
		expect(beta).toBeGreaterThanOrEqual(1);
	});
});

describe("sampleBeta gamma shape branches", () => {
	it("samples on (0,1) when both shape params are < 1 (shape<1 recursion path)", () => {
		const rng = new Xoshiro256(3);
		for (let i = 0; i < 50; i++) {
			const v = sampleBeta(rng, 0.5, 0.5);
			expect(v).toBeGreaterThan(0);
			expect(v).toBeLessThan(1);
		}
	});

	it("samples on (0,1) for shape params >= 1", () => {
		const v = sampleBeta(new Xoshiro256(4), 2, 5);
		expect(v).toBeGreaterThan(0);
		expect(v).toBeLessThan(1);
	});
});

describe("sampleUniform / sampleLognormal basics", () => {
	it("sampleUniform stays within [min, max)", () => {
		const rng = new Xoshiro256(5);
		for (let i = 0; i < 100; i++) {
			const v = sampleUniform(rng, -2, 8);
			expect(v).toBeGreaterThanOrEqual(-2);
			expect(v).toBeLessThan(8);
		}
	});

	it("sampleLognormal is strictly positive", () => {
		const rng = new Xoshiro256(6);
		for (let i = 0; i < 100; i++) {
			expect(sampleLognormal(rng, 100, 0.5)).toBeGreaterThan(0);
		}
	});
});
