// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// Monte Carlo simulator — runs N iterations of a caller-supplied sample
// function against a seeded RNG, then computes summary statistics
// (percentiles, mean, stddev) over the resulting draws.
//
// Provenance: percentile-extraction and aggregation logic ported from
// PRISM Monte Carlo engine (monday-roi-calculator: src/utils/monteCarlo.js).
// The original was tightly coupled to ROI domain types — this version
// generalizes it: callers pass any `sample(rng) => number` function and
// the simulator handles the bookkeeping. Governance simulators
// (token-spend projection, policy what-if, risk scenarios) consume this
// foundation; this module remains a pure math library.
//
// Determinism contract: same seed + same sample function -> identical
// output, byte for byte. Tests enforce this.

import type { Xoshiro256 } from "../rng/xoshiro256.js";

/**
 * Configuration for a single simulation run.
 * - `iterations` controls statistical resolution; 10K is a good default for
 *   percentile estimation, 100K+ for tail probability estimation.
 * - `rng` is supplied by the caller (DI for determinism).
 * - `sample(rng)` is called once per iteration and must return a finite
 *   number; non-finite samples are dropped from the result (and counted).
 * - `progressInterval` (optional) opts into the streaming variant — pair
 *   with `runSimulationStreaming` for incremental progress reporting.
 */
export interface SimulatorConfig {
	iterations: number;
	rng: Xoshiro256;
	sample: (rng: Xoshiro256) => number;
	progressInterval?: number;
}

/**
 * Standard percentile points reported for every simulation. Designed for
 * governance dashboards — p50 (median) for typical case, p5/p95 for the
 * "reasonable worst/best" envelope, p99 for tail-risk callouts.
 */
export interface Percentiles {
	p5: number;
	p25: number;
	p50: number;
	p75: number;
	p95: number;
	p99: number;
}

/**
 * Aggregated simulation output.
 * - `iterations`: number of finite samples actually used.
 * - `dropped`: count of non-finite samples skipped.
 * - `percentiles`: full p5..p99 envelope.
 * - `mean`/`stddev`: classical moments.
 * - `min`/`max`: observed extremes (note: extremes are noisy for small N).
 */
export interface SimulationResult {
	iterations: number;
	dropped: number;
	percentiles: Percentiles;
	mean: number;
	stddev: number;
	min: number;
	max: number;
}

/**
 * Streaming progress event emitted by `runSimulationStreaming` every
 * `progressInterval` iterations.
 */
export interface SimulationProgress {
	type: "progress";
	completed: number;
	total: number;
	partialPercentiles: Percentiles;
}

/**
 * Terminal event emitted by `runSimulationStreaming` after the last
 * iteration. Carries the full result.
 */
export interface SimulationComplete {
	type: "complete";
	completed: number;
	total: number;
	result: SimulationResult;
}

export type SimulationEvent = SimulationProgress | SimulationComplete;

/**
 * Run a complete Monte Carlo simulation and return summary statistics.
 *
 * Memory model: collects all samples in a single Float64Array sized
 * `iterations`, then sorts a copy for percentile extraction. This is
 * O(N log N) time and O(N) memory.
 *
 * Opportunity: for very large N (>10M) consider a streaming p-quantile
 * algorithm (P-Squared, t-digest) to keep memory bounded — not needed
 * for current governance use cases (typical N=10K..100K).
 */
export function runSimulation(config: SimulatorConfig): SimulationResult {
	if (!Number.isFinite(config.iterations) || config.iterations < 1) {
		throw new Error("runSimulation: iterations must be a positive integer");
	}
	const n = Math.floor(config.iterations);
	const buffer = new Float64Array(n);
	let kept = 0;
	let dropped = 0;
	let sum = 0;
	let sumSq = 0;
	let minVal = Number.POSITIVE_INFINITY;
	let maxVal = Number.NEGATIVE_INFINITY;

	for (let i = 0; i < n; i++) {
		const v = config.sample(config.rng);
		if (!Number.isFinite(v)) {
			dropped++;
			continue;
		}
		buffer[kept++] = v;
		sum += v;
		sumSq += v * v;
		if (v < minVal) minVal = v;
		if (v > maxVal) maxVal = v;
	}

	if (kept === 0) {
		throw new Error("runSimulation: all samples were non-finite — check sample()");
	}

	const finite = buffer.slice(0, kept);
	const mean = sum / kept;
	// Population variance (N denominator) — appropriate when treating the
	// simulated draws as the full population we care about.
	const variance = Math.max(0, sumSq / kept - mean * mean);
	const stddev = Math.sqrt(variance);

	return {
		iterations: kept,
		dropped,
		percentiles: computePercentiles(finite),
		mean,
		stddev,
		min: minVal,
		max: maxVal,
	};
}

/**
 * Streaming variant — yields progress events at the configured interval
 * (default: every 500 iterations) and a final complete event with the
 * full result. Useful when you want to update a dashboard or cancel a
 * long-running simulation early.
 */
export function* runSimulationStreaming(config: SimulatorConfig): Generator<SimulationEvent> {
	if (!Number.isFinite(config.iterations) || config.iterations < 1) {
		throw new Error("runSimulationStreaming: iterations must be a positive integer");
	}
	const n = Math.floor(config.iterations);
	const interval = Math.max(1, config.progressInterval ?? 500);
	const buffer = new Float64Array(n);
	let kept = 0;
	let dropped = 0;
	let sum = 0;
	let sumSq = 0;
	let minVal = Number.POSITIVE_INFINITY;
	let maxVal = Number.NEGATIVE_INFINITY;

	for (let i = 0; i < n; i++) {
		const v = config.sample(config.rng);
		if (!Number.isFinite(v)) {
			dropped++;
		} else {
			buffer[kept++] = v;
			sum += v;
			sumSq += v * v;
			if (v < minVal) minVal = v;
			if (v > maxVal) maxVal = v;
		}

		if ((i + 1) % interval === 0 && kept > 0) {
			yield {
				type: "progress",
				completed: i + 1,
				total: n,
				partialPercentiles: computePercentiles(buffer.slice(0, kept)),
			};
		}
	}

	if (kept === 0) {
		throw new Error("runSimulationStreaming: all samples were non-finite — check sample()");
	}

	const finite = buffer.slice(0, kept);
	const mean = sum / kept;
	const variance = Math.max(0, sumSq / kept - mean * mean);
	const stddev = Math.sqrt(variance);

	yield {
		type: "complete",
		completed: n,
		total: n,
		result: {
			iterations: kept,
			dropped,
			percentiles: computePercentiles(finite),
			mean,
			stddev,
			min: minVal,
			max: maxVal,
		},
	};
}

/**
 * Compute the standard governance percentile envelope from a sample array.
 * Exported so callers can recompute percentiles on a custom subset (e.g.
 * stress-bucket of the worst 20% of outcomes).
 */
export function computePercentiles(samples: ArrayLike<number>): Percentiles {
	if (samples.length === 0) {
		return { p5: 0, p25: 0, p50: 0, p75: 0, p95: 0, p99: 0 };
	}
	const sorted = Float64Array.from(samples).sort();
	return {
		p5: percentileFromSorted(sorted, 5),
		p25: percentileFromSorted(sorted, 25),
		p50: percentileFromSorted(sorted, 50),
		p75: percentileFromSorted(sorted, 75),
		p95: percentileFromSorted(sorted, 95),
		p99: percentileFromSorted(sorted, 99),
	};
}

/**
 * Pick a single percentile (0..100) from an already-sorted array.
 * Uses the same nearest-rank convention as the source PRISM engine.
 */
export function percentileFromSorted(sorted: ArrayLike<number>, p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx] as number;
}
