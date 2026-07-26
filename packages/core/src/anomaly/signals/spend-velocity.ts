// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * spend-velocity.ts — Spend-velocity anomaly signal.
 *
 * Dual denomination (M2): cloud-scope observations accumulate usd-proxy cost
 * (dollars) against `thresholdDollarsPerMin`; local-scope observations
 * accumulate NOMINAL USERTOKENS against `localThresholdUsertokensPerMin`
 * (default 10_000). The two series are independent rolling windows; check()
 * reports which denomination (and threshold) applied via `unit`/`thresholdLabel`
 * so verdict text never fakes dollars for nominal spend.
 *
 * Explicit documented behavior: with the default local rate {0,0}, per-chunk
 * cumulative nominal cost is a constant floor of 1 usertoken, so spend_velocity
 * CANNOT trip on default local config — token_rate is the primary local signal.
 * Velocity becomes meaningful when the operator sets nonzero local rates
 * (amortized-usd showback).
 *
 * Default: $1.00/min (cloud) / 10_000 ut/min (local) over a 10s rolling window.
 *
 * Cost is computed via a `costCalculator` callback so the signal stays
 * decoupled from the SDK's pricing module.
 */

import type { EndpointClass } from "../../shared/types.js";
import type { SpendVelocityConfig } from "../types.js";

/** Default local-scope threshold, applied where consumed (resolved config keeps it optional). */
const LOCAL_THRESHOLD_USERTOKENS_PER_MIN_DEFAULT = 10_000;

/** Denomination of a velocity measurement. */
export type SpendUnit = "dollars" | "usertokens";

interface CostSample {
	tMs: number;
	/** Cumulative cost in the series' denomination (dollars or nominal usertokens). */
	cumulative: number;
}

export interface SpendVelocitySignalState {
	/** Cloud-scope samples (cumulative dollars). */
	samples: CostSample[];
	/** Local-scope samples (cumulative nominal usertokens). */
	localSamples: CostSample[];
	lastDollarsPerMin: number;
	lastUsertokensPerMin: number;
}

export interface SpendVelocityCheckResult {
	tripped: boolean;
	metric: number;
	threshold: number;
	/** Denomination of metric/threshold. */
	unit: SpendUnit;
	/** Which config threshold applied: "thresholdDollarsPerMin" | "localThresholdUsertokensPerMin". */
	thresholdLabel: string;
}

export interface SpendVelocitySignal {
	state: Readonly<SpendVelocitySignalState>;
	/**
	 * Record cumulative cost at time `nowMs`. `scope` selects the series:
	 * "local" accumulates nominal usertokens, "cloud" (default) dollars.
	 */
	observe(cumulativeCost: number, nowMs: number, scope?: EndpointClass): void;
	check(nowMs: number): SpendVelocityCheckResult;
	reset(): void;
}

export interface ResolvedSpendVelocityConfig {
	thresholdDollarsPerMin: number;
	/** Local-scope threshold; defaulted to 10_000 at consumption when absent. */
	localThresholdUsertokensPerMin?: number | undefined;
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
		// M2 field stays optional in resolved config — defaulted where consumed.
		localThresholdUsertokensPerMin: cfg?.localThresholdUsertokensPerMin,
		windowMs: cfg?.windowMs ?? SPEND_VELOCITY_DEFAULTS.windowMs,
	};
}

export function createSpendVelocitySignal(cfg: ResolvedSpendVelocityConfig): SpendVelocitySignal {
	const state: SpendVelocitySignalState = {
		samples: [],
		localSamples: [],
		lastDollarsPerMin: 0,
		lastUsertokensPerMin: 0,
	};
	const localThreshold =
		cfg.localThresholdUsertokensPerMin ?? LOCAL_THRESHOLD_USERTOKENS_PER_MIN_DEFAULT;

	function pruneOlderThan(series: CostSample[], cutoffMs: number): void {
		// Keep at least one sample older than the cutoff so we can compute deltas.
		// Find the most recent sample at or before cutoffMs and drop everything before it.
		let lastBeforeCutoff = -1;
		for (let i = 0; i < series.length; i++) {
			const sample = series[i];
			if (sample !== undefined && sample.tMs <= cutoffMs) {
				lastBeforeCutoff = i;
			} else {
				break;
			}
		}
		if (lastBeforeCutoff > 0) {
			series.splice(0, lastBeforeCutoff);
		}
	}

	function observe(cumulativeCost: number, nowMs: number, scope: EndpointClass = "cloud"): void {
		// Reject NaN/negative deltas — keep the cumulative monotonic non-decreasing.
		if (!Number.isFinite(cumulativeCost) || cumulativeCost < 0) return;
		const series = scope === "local" ? state.localSamples : state.samples;
		const last = series[series.length - 1];
		if (last !== undefined && cumulativeCost < last.cumulative) {
			// Provider regressed (shouldn't happen) — clamp to last
			series.push({ tMs: nowMs, cumulative: last.cumulative });
		} else {
			series.push({ tMs: nowMs, cumulative: cumulativeCost });
		}
		pruneOlderThan(series, nowMs - cfg.windowMs);
	}

	/** Rolling per-minute rate over a series, or null when not computable. */
	function ratePerMin(series: CostSample[], nowMs: number): number | null {
		pruneOlderThan(series, nowMs - cfg.windowMs);
		if (series.length < 2) return null;
		const first = series[0];
		const last = series[series.length - 1];
		if (first === undefined || last === undefined) return null;
		const costDelta = last.cumulative - first.cumulative;
		const minutesDelta = (last.tMs - first.tMs) / 60_000;
		if (minutesDelta <= 0) return null;
		return costDelta / minutesDelta;
	}

	function check(nowMs: number): SpendVelocityCheckResult {
		const cloudRate = ratePerMin(state.samples, nowMs);
		const localRate = ratePerMin(state.localSamples, nowMs);
		if (cloudRate !== null) state.lastDollarsPerMin = cloudRate;
		if (localRate !== null) state.lastUsertokensPerMin = localRate;

		const cloudResult = (tripped: boolean): SpendVelocityCheckResult => ({
			tripped,
			metric: cloudRate ?? 0,
			threshold: cfg.thresholdDollarsPerMin,
			unit: "dollars",
			thresholdLabel: "thresholdDollarsPerMin",
		});
		const localResult = (tripped: boolean, rate: number): SpendVelocityCheckResult => ({
			tripped,
			metric: rate,
			threshold: localThreshold,
			unit: "usertokens",
			thresholdLabel: "localThresholdUsertokensPerMin",
		});

		if (cloudRate !== null && cloudRate >= cfg.thresholdDollarsPerMin) return cloudResult(true);
		if (localRate !== null && localRate >= localThreshold) return localResult(true, localRate);

		// Neither tripped: report the denomination closer to its threshold
		// (cloud on tie / when nothing is computable — legacy behavior).
		if (
			localRate !== null &&
			(cloudRate === null || localRate / localThreshold > cloudRate / cfg.thresholdDollarsPerMin)
		) {
			return localResult(false, localRate);
		}
		return cloudResult(false);
	}

	function reset(): void {
		state.samples.length = 0;
		state.localSamples.length = 0;
		state.lastDollarsPerMin = 0;
		state.lastUsertokensPerMin = 0;
	}

	return { state, observe, check, reset };
}
