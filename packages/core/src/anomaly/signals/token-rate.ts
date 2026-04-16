// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * token-rate.ts — Token-rate anomaly signal.
 *
 * Buckets observed chunks into fixed-width windows (default 2 s) and counts
 * tokens-per-second within each window. Trips when N consecutive windows
 * exceed the configured threshold (default 500 tok/s, 3 windows).
 *
 * Brief spikes (1-2 hot windows) are ignored — only sustained runaway
 * behavior trips the circuit.
 */

import type { TokenRateConfig } from "../types.js";

export interface TokenRateSignalState {
	/** Per-window tokens accumulated in the current bucket. */
	currentWindowTokens: number;
	/** Start time of the current window. */
	currentWindowStartMs: number;
	/** Number of consecutive completed windows that exceeded threshold. */
	consecutiveHotWindows: number;
	/** Last computed peak rate (for the most recently closed window). */
	lastWindowRateTokPerSec: number;
}

export interface TokenRateSignal {
	state: Readonly<TokenRateSignalState>;
	/** Observe a chunk's delta tokens at time `nowMs`. */
	observe(deltaTokens: number, nowMs: number): void;
	/**
	 * Check if the threshold has been crossed.
	 * Returns the metric (peak window rate) when tripped, else null.
	 */
	check(nowMs: number): {
		tripped: boolean;
		metric: number;
		threshold: number;
		hotWindows: number;
	};
	reset(): void;
}

export interface ResolvedTokenRateConfig {
	thresholdTokPerSec: number;
	windowMs: number;
	consecutiveWindows: number;
}

export const TOKEN_RATE_DEFAULTS: ResolvedTokenRateConfig = {
	thresholdTokPerSec: 500,
	windowMs: 2_000,
	consecutiveWindows: 3,
};

export function resolveTokenRateConfig(cfg?: TokenRateConfig): ResolvedTokenRateConfig {
	return {
		thresholdTokPerSec: cfg?.thresholdTokPerSec ?? TOKEN_RATE_DEFAULTS.thresholdTokPerSec,
		windowMs: cfg?.windowMs ?? TOKEN_RATE_DEFAULTS.windowMs,
		consecutiveWindows: cfg?.consecutiveWindows ?? TOKEN_RATE_DEFAULTS.consecutiveWindows,
	};
}

export function createTokenRateSignal(cfg: ResolvedTokenRateConfig): TokenRateSignal {
	const state: TokenRateSignalState = {
		currentWindowTokens: 0,
		currentWindowStartMs: 0,
		consecutiveHotWindows: 0,
		lastWindowRateTokPerSec: 0,
	};
	let initialized = false;

	function rollWindowsTo(nowMs: number): void {
		// Roll forward: close completed windows, evaluate threshold, advance.
		while (nowMs - state.currentWindowStartMs >= cfg.windowMs) {
			const windowEndMs = state.currentWindowStartMs + cfg.windowMs;
			const seconds = cfg.windowMs / 1_000;
			const rate = state.currentWindowTokens / seconds;
			state.lastWindowRateTokPerSec = rate;
			if (rate >= cfg.thresholdTokPerSec) {
				state.consecutiveHotWindows += 1;
			} else {
				state.consecutiveHotWindows = 0;
			}
			state.currentWindowStartMs = windowEndMs;
			state.currentWindowTokens = 0;
		}
	}

	function observe(deltaTokens: number, nowMs: number): void {
		if (!initialized) {
			state.currentWindowStartMs = nowMs;
			initialized = true;
		}
		rollWindowsTo(nowMs);
		state.currentWindowTokens += Math.max(0, deltaTokens);
	}

	function check(nowMs: number): {
		tripped: boolean;
		metric: number;
		threshold: number;
		hotWindows: number;
	} {
		if (!initialized) {
			return {
				tripped: false,
				metric: 0,
				threshold: cfg.thresholdTokPerSec,
				hotWindows: 0,
			};
		}
		rollWindowsTo(nowMs);
		// Also evaluate the current (incomplete) window if it has surpassed threshold
		// by enough margin to count: only if it would already be a "hot" window.
		const elapsedMs = nowMs - state.currentWindowStartMs;
		let inFlightHot = false;
		let inFlightRate = 0;
		if (elapsedMs > 0) {
			inFlightRate = state.currentWindowTokens / (elapsedMs / 1_000);
			// Only consider in-flight as "hot" once the window has accumulated meaningful
			// data (>=50% elapsed) to avoid false positives from one large early chunk.
			if (elapsedMs >= cfg.windowMs / 2 && inFlightRate >= cfg.thresholdTokPerSec) {
				inFlightHot = true;
			}
		}
		const effectiveHot = state.consecutiveHotWindows + (inFlightHot ? 1 : 0);
		const tripped = effectiveHot >= cfg.consecutiveWindows;
		const metric = Math.max(state.lastWindowRateTokPerSec, inFlightRate);
		return {
			tripped,
			metric,
			threshold: cfg.thresholdTokPerSec,
			hotWindows: effectiveHot,
		};
	}

	function reset(): void {
		state.currentWindowTokens = 0;
		state.currentWindowStartMs = 0;
		state.consecutiveHotWindows = 0;
		state.lastWindowRateTokPerSec = 0;
		initialized = false;
	}

	return { state, observe, check, reset };
}
