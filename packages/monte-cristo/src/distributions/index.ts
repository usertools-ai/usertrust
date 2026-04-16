// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// Statistical distribution samplers — each takes a Xoshiro256 RNG instance
// and returns a single sample drawn from the named distribution.
//
// Provenance: math ported from PRISM Monte Carlo engine
// (monday-roi-calculator: src/utils/distributions.js). API re-shaped to
// accept the Xoshiro256 class directly (dependency-injected — critical for
// determinism: the same RNG instance, sampled in the same order, will
// always produce the same sequence of draws).
//
// Domain note: these are pure math primitives. Governance-specific
// simulators (token-spend projection, policy what-if, risk scenarios)
// compose them downstream; this module has no AI/governance vocabulary.

import type { Xoshiro256 } from "../rng/xoshiro256.js";

const TWO_PI = 2 * Math.PI;
const LOG_FLOOR = 1e-10; // guards Math.log(0)

/**
 * Sample from a normal (Gaussian) distribution with the given mean and
 * standard deviation. Uses the Box-Muller transform — consumes 2 RNG draws.
 */
export function sampleNormal(rng: Xoshiro256, mean: number, stddev: number): number {
	const u1 = rng.nextFloat() || LOG_FLOOR;
	const u2 = rng.nextFloat();
	const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(TWO_PI * u2);
	return mean + z * stddev;
}

/**
 * Sample from a triangular distribution defined by its minimum, mode, and
 * maximum. Uses inverse-transform sampling — consumes 1 RNG draw. Useful
 * for "PERT-style" estimates (best/likely/worst) where you have rough
 * bounds but no formal distribution.
 *
 * Preconditions: min <= mode <= max, and min < max.
 */
export function sampleTriangular(rng: Xoshiro256, min: number, mode: number, max: number): number {
	const u = rng.nextFloat();
	const range = max - min;
	if (range === 0) return min;
	const fc = (mode - min) / range;
	if (u < fc) {
		return min + Math.sqrt(u * range * (mode - min));
	}
	return max - Math.sqrt((1 - u) * range * (max - mode));
}

/**
 * Sample from a lognormal distribution parameterized by its median and
 * the sigma of the underlying normal. Always non-negative — appropriate
 * for quantities like cost projections, latency tails, and other
 * heavy-right-skewed values that can never go below zero.
 *
 * Implementation: log(median) gives mu of the underlying normal, then
 * exp(N(mu, sigma)) produces the lognormal draw.
 */
export function sampleLognormal(rng: Xoshiro256, median: number, sigma: number): number {
	const mu = Math.log(median);
	return Math.exp(sampleNormal(rng, mu, sigma));
}

/**
 * Sample from a Beta(alpha, beta) distribution on (0, 1). Built from two
 * gamma draws (Marsaglia & Tsang's method). Useful for modeling rates,
 * proportions, and probabilities with bounded uncertainty.
 *
 * Preconditions: alpha > 0, beta > 0.
 */
export function sampleBeta(rng: Xoshiro256, alpha: number, beta: number): number {
	const x = sampleGamma(rng, alpha);
	const y = sampleGamma(rng, beta);
	return x / (x + y);
}

/**
 * Sample uniformly from [min, max). Single RNG draw, scaled and shifted.
 */
export function sampleUniform(rng: Xoshiro256, min: number, max: number): number {
	return min + rng.nextFloat() * (max - min);
}

/**
 * Helper for translating a target rate (and a spread) into Beta(alpha, beta)
 * shape parameters. Useful when callers want to express uncertainty as
 * "around X, give or take Y" rather than picking alpha/beta by hand.
 *
 * Mean is clamped to [0.05, 0.95] and the resulting alpha/beta are clamped
 * to >= 1 to keep the distribution unimodal and well-behaved at the edges.
 */
export function rateToBetaParams(
	targetRate: number,
	spread = 0.15,
): { alpha: number; beta: number } {
	const mean = Math.max(0.05, Math.min(0.95, targetRate));
	const low = Math.max(0.01, mean - spread);
	const high = Math.min(0.99, mean + spread);
	const variance = ((high - low) / 4) ** 2;
	if (variance <= 0) {
		return { alpha: 1, beta: 1 };
	}
	const k = (mean * (1 - mean)) / variance - 1;
	const alpha = mean * k;
	const beta = (1 - mean) * k;
	return { alpha: Math.max(1, alpha), beta: Math.max(1, beta) };
}

// --- Internal helpers ----------------------------------------------------

function sampleStdNormal(rng: Xoshiro256): number {
	const u1 = rng.nextFloat() || LOG_FLOOR;
	const u2 = rng.nextFloat();
	return Math.sqrt(-2 * Math.log(u1)) * Math.cos(TWO_PI * u2);
}

/**
 * Marsaglia & Tsang's method for sampling from Gamma(shape, 1).
 * For shape < 1: use the identity Gamma(a) = Gamma(a+1) * U^(1/a).
 * For shape >= 1: rejection-sample using a transformed normal.
 */
function sampleGamma(rng: Xoshiro256, shape: number): number {
	if (shape < 1) {
		const u = rng.nextFloat() || LOG_FLOOR;
		return sampleGamma(rng, shape + 1) * u ** (1 / shape);
	}
	const d = shape - 1 / 3;
	const c = 1 / Math.sqrt(9 * d);
	// The rejection loop terminates with probability 1 (mean ~1.04 trials);
	// cap iterations defensively to avoid any pathological infinite loop.
	for (let attempt = 0; attempt < 1024; attempt++) {
		let x = 0;
		let v = 0;
		do {
			x = sampleStdNormal(rng);
			v = 1 + c * x;
		} while (v <= 0);
		v = v * v * v;
		const u = rng.nextFloat();
		if (u < 1 - 0.0331 * x * x * x * x) return d * v;
		if (Math.log(u || LOG_FLOOR) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
			return d * v;
		}
	}
	// Extremely unlikely fallback — return the mean of Gamma(shape, 1).
	return shape;
}
