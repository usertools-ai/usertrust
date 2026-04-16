// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * spend-velocity.ts — Spend-velocity anomaly signal.
 *
 * Tracks $/min over a rolling window. Each observation records the
 * cumulative cost (in dollars). The signal trips when the rolling
 * dollars-per-minute exceeds the configured ceiling.
 *
 * Default: $1.00/min over a 10s rolling window.
 *
 * Cost is computed via a `costCalculator` callback so the signal stays
 * decoupled from the SDK's pricing module.
 */

import type { SpendVelocityConfig } from "../types.js";

interface CostSample {
	tMs: number;
	cumulativeDollars: number;
}

export interface SpendVelocitySignalState {
	samples: CostSample[];
	lastDollarsPerMin: number;
}

export interface SpendVelocitySignal {
	state: Readonly<SpendVelocitySignalState>;
	/** Record cumulative dollars at time `nowMs`. */
	observe(cumulativeDollars: number, nowMs: number): void;
	check(nowMs: number): {
		tripped: boolean;
		metric: number;
		threshold: number;
	};
	reset(): void;
}

export interface ResolvedSpendVelocityConfig {
	thresholdDollarsPerMin: number;
	windowMs: number;
}

export const SPEND_VELOCITY_DEFAULTS: ResolvedSpendVelocityConfig = {
	thresholdDollarsPerMin: 1.0,
	windowMs: 10_000,
};

export function resolveSpendVelocityConfig(cfg?: SpendVelocityConfig): ResolvedSpendVelocityConfig {
	return {
		thresholdDollarsPerMin:
			cfg?.thresholdDollarsPerMin ?? SPEND_VELOCITY_DEFAULTS.thresholdDollarsPerMin,
		windowMs: cfg?.windowMs ?? SPEND_VELOCITY_DEFAULTS.windowMs,
	};
}

export function createSpendVelocitySignal(cfg: ResolvedSpendVelocityConfig): SpendVelocitySignal {
	const state: SpendVelocitySignalState = {
		samples: [],
		lastDollarsPerMin: 0,
	};

	function pruneOlderThan(cutoffMs: number): void {
		// Keep at least one sample older than the cutoff so we can compute deltas.
		// Find the most recent sample at or before cutoffMs and drop everything before it.
		let lastBeforeCutoff = -1;
		for (let i = 0; i < state.samples.length; i++) {
			const sample = state.samples[i];
			if (sample !== undefined && sample.tMs <= cutoffMs) {
				lastBeforeCutoff = i;
			} else {
				break;
			}
		}
		if (lastBeforeCutoff > 0) {
			state.samples.splice(0, lastBeforeCutoff);
		}
	}

	function observe(cumulativeDollars: number, nowMs: number): void {
		// Reject NaN/negative deltas — keep the cumulative monotonic non-decreasing.
		if (!Number.isFinite(cumulativeDollars) || cumulativeDollars < 0) return;
		const last = state.samples[state.samples.length - 1];
		if (last !== undefined && cumulativeDollars < last.cumulativeDollars) {
			// Provider regressed (shouldn't happen) — clamp to last
			state.samples.push({ tMs: nowMs, cumulativeDollars: last.cumulativeDollars });
		} else {
			state.samples.push({ tMs: nowMs, cumulativeDollars });
		}
		pruneOlderThan(nowMs - cfg.windowMs);
	}

	function check(nowMs: number): {
		tripped: boolean;
		metric: number;
		threshold: number;
	} {
		pruneOlderThan(nowMs - cfg.windowMs);
		if (state.samples.length < 2) {
			return {
				tripped: false,
				metric: 0,
				threshold: cfg.thresholdDollarsPerMin,
			};
		}
		const first = state.samples[0];
		const last = state.samples[state.samples.length - 1];
		if (first === undefined || last === undefined) {
			return {
				tripped: false,
				metric: 0,
				threshold: cfg.thresholdDollarsPerMin,
			};
		}
		const dollarsDelta = last.cumulativeDollars - first.cumulativeDollars;
		const minutesDelta = (last.tMs - first.tMs) / 60_000;
		if (minutesDelta <= 0) {
			return {
				tripped: false,
				metric: 0,
				threshold: cfg.thresholdDollarsPerMin,
			};
		}
		const dollarsPerMin = dollarsDelta / minutesDelta;
		state.lastDollarsPerMin = dollarsPerMin;
		return {
			tripped: dollarsPerMin >= cfg.thresholdDollarsPerMin,
			metric: dollarsPerMin,
			threshold: cfg.thresholdDollarsPerMin,
		};
	}

	function reset(): void {
		state.samples.length = 0;
		state.lastDollarsPerMin = 0;
	}

	return { state, observe, check, reset };
}
