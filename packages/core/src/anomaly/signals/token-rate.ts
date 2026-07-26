// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * token-rate.ts — Token-rate anomaly signal.
 *
 * Buckets observed chunks into fixed-width windows (default 2 s) and counts
 * tokens-per-second within each window. Trips when N consecutive windows
 * exceed the effective threshold (default 500 tok/s, 3 windows).
 *
 * Brief spikes (1-2 hot windows) are ignored — only sustained runaway
 * behavior trips the circuit.
 *
 * M2 scoped thresholds: each observation may carry the event's model and
 * endpointClass. Local-scope events select `perModel` (trailing-* glob,
 * matched via matchModelPattern) first, then `localThresholdTokPerSec`
 * (default 5000 — fast local GPU inference legitimately exceeds the cloud
 * 500). Cloud/unscoped events keep the legacy `thresholdTokPerSec`. The
 * check() result names which threshold applied via `thresholdLabel`.
 *
 * Cross-scope isolation: cloud and local keep SEPARATE rolling windows, each
 * judged against its own threshold. A shared detector observes interleaved
 * cloud+local streams, so a single mutable threshold/window would let one
 * scope's chunks contaminate the other's verdict — a cloud runaway inheriting
 * the 10x local threshold (evasion), or a local burst false-tripping the cloud
 * 500. Mirrors the dual-series pattern in spend-velocity.ts.
 */

import { matchModelPattern } from "../../ledger/pricing.js";
import type { EndpointClass } from "../../shared/types.js";
import type { TokenRateConfig } from "../types.js";

/** Default local-scope threshold, applied where consumed (resolved config keeps it optional). */
const LOCAL_THRESHOLD_TOK_PER_SEC_DEFAULT = 5_000;

/** Threshold-source labels: "thresholdTokPerSec", "localThresholdTokPerSec", or `perModel["<pattern>"]`. */
export type TokenRateThresholdLabel = string;

/** Per-observation scope context (an AnomalyChunkEvent satisfies this shape). */
export interface TokenRateObserveContext {
	model?: string | undefined;
	endpointClass?: EndpointClass | undefined;
}

/** Rolling-window state for a single endpoint scope (cloud or local). */
export interface ScopeWindowState {
	/** Per-window tokens accumulated in the current bucket. */
	currentWindowTokens: number;
	/** Start time of the current window. */
	currentWindowStartMs: number;
	/** Number of consecutive completed windows that exceeded threshold. */
	consecutiveHotWindows: number;
	/** Last computed peak rate (for the most recently closed window). */
	lastWindowRateTokPerSec: number;
	/** Whether any observation has been routed to this scope yet. */
	initialized: boolean;
	/** Effective threshold for this scope's windows (resolved per observation). */
	threshold: number;
	/** Source label of the effective threshold. */
	thresholdLabel: TokenRateThresholdLabel;
}

export interface TokenRateSignalState {
	/** Cloud/unscoped window state (legacy `thresholdTokPerSec`). */
	cloud: Readonly<ScopeWindowState>;
	/** Local window state (`perModel` glob / `localThresholdTokPerSec`). */
	local: Readonly<ScopeWindowState>;
}

export interface TokenRateSignal {
	state: Readonly<TokenRateSignalState>;
	/**
	 * Observe a chunk's delta tokens at time `nowMs`. `context` (the chunk
	 * event) selects the effective threshold for subsequent window evaluation;
	 * omitted/unscoped context means the legacy cloud threshold.
	 */
	observe(deltaTokens: number, nowMs: number, context?: TokenRateObserveContext): void;
	/**
	 * Check if the threshold has been crossed.
	 * Returns the metric (peak window rate) when tripped, else null.
	 */
	check(nowMs: number): {
		tripped: boolean;
		metric: number;
		threshold: number;
		hotWindows: number;
		thresholdLabel: TokenRateThresholdLabel;
	};
	reset(): void;
}

export interface ResolvedTokenRateConfig {
	thresholdTokPerSec: number;
	/** Local-scope threshold; defaulted to 5000 at consumption when absent. */
	localThresholdTokPerSec?: number | undefined;
	/** Per-model overrides for local-scope events (trailing-* glob keys). */
	perModel?: Record<string, number> | undefined;
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
		// M2 fields stay optional in resolved config — defaulted where consumed.
		localThresholdTokPerSec: cfg?.localThresholdTokPerSec,
		perModel: cfg?.perModel,
		windowMs: cfg?.windowMs ?? TOKEN_RATE_DEFAULTS.windowMs,
		consecutiveWindows: cfg?.consecutiveWindows ?? TOKEN_RATE_DEFAULTS.consecutiveWindows,
	};
}

interface TokenRateCheckResult {
	tripped: boolean;
	metric: number;
	threshold: number;
	hotWindows: number;
	thresholdLabel: TokenRateThresholdLabel;
}

export function createTokenRateSignal(cfg: ResolvedTokenRateConfig): TokenRateSignal {
	const localDefaultThreshold = cfg.localThresholdTokPerSec ?? LOCAL_THRESHOLD_TOK_PER_SEC_DEFAULT;

	function makeWindow(threshold: number, label: TokenRateThresholdLabel): ScopeWindowState {
		return {
			currentWindowTokens: 0,
			currentWindowStartMs: 0,
			consecutiveHotWindows: 0,
			lastWindowRateTokPerSec: 0,
			initialized: false,
			threshold,
			thresholdLabel: label,
		};
	}

	// Independent per-scope windows: cloud/unscoped events accumulate against the
	// legacy threshold, local events against the local/perModel threshold. Neither
	// can move the other's threshold or window (evasion + false-trip fix).
	const cloud = makeWindow(cfg.thresholdTokPerSec, "thresholdTokPerSec");
	const local = makeWindow(localDefaultThreshold, "localThresholdTokPerSec");
	const state: TokenRateSignalState = { cloud, local };

	/** Resolve the local-scope threshold/label for an event's model (perModel glob first). */
	function applyLocalThreshold(model: string | undefined): void {
		if (model !== undefined && cfg.perModel !== undefined) {
			const match = matchModelPattern(model, cfg.perModel);
			if (match !== undefined) {
				local.threshold = match.value;
				local.thresholdLabel = `perModel["${match.pattern}"]`;
				return;
			}
		}
		local.threshold = localDefaultThreshold;
		local.thresholdLabel = "localThresholdTokPerSec";
	}

	function rollWindowsTo(w: ScopeWindowState, nowMs: number): void {
		// Roll forward: close completed windows, evaluate threshold, advance.
		while (nowMs - w.currentWindowStartMs >= cfg.windowMs) {
			const windowEndMs = w.currentWindowStartMs + cfg.windowMs;
			const seconds = cfg.windowMs / 1_000;
			const rate = w.currentWindowTokens / seconds;
			w.lastWindowRateTokPerSec = rate;
			if (rate >= w.threshold) {
				w.consecutiveHotWindows += 1;
			} else {
				w.consecutiveHotWindows = 0;
			}
			w.currentWindowStartMs = windowEndMs;
			w.currentWindowTokens = 0;
		}
	}

	function observe(deltaTokens: number, nowMs: number, context?: TokenRateObserveContext): void {
		const w = context?.endpointClass === "local" ? local : cloud;
		if (w === local) {
			applyLocalThreshold(context?.model);
		}
		if (!w.initialized) {
			w.currentWindowStartMs = nowMs;
			w.initialized = true;
		}
		rollWindowsTo(w, nowMs);
		w.currentWindowTokens += Math.max(0, deltaTokens);
	}

	/** Evaluate one scope's window against its own threshold. */
	function evaluate(w: ScopeWindowState, nowMs: number): TokenRateCheckResult {
		if (!w.initialized) {
			return {
				tripped: false,
				metric: 0,
				threshold: w.threshold,
				hotWindows: 0,
				thresholdLabel: w.thresholdLabel,
			};
		}
		rollWindowsTo(w, nowMs);
		// Also evaluate the current (incomplete) window if it has surpassed threshold
		// by enough margin to count: only if it would already be a "hot" window.
		const elapsedMs = nowMs - w.currentWindowStartMs;
		let inFlightHot = false;
		let inFlightRate = 0;
		if (elapsedMs > 0) {
			inFlightRate = w.currentWindowTokens / (elapsedMs / 1_000);
			// Only consider in-flight as "hot" once the window has accumulated meaningful
			// data (>=50% elapsed) to avoid false positives from one large early chunk.
			if (elapsedMs >= cfg.windowMs / 2 && inFlightRate >= w.threshold) {
				inFlightHot = true;
			}
		}
		const effectiveHot = w.consecutiveHotWindows + (inFlightHot ? 1 : 0);
		const tripped = effectiveHot >= cfg.consecutiveWindows;
		const metric = Math.max(w.lastWindowRateTokPerSec, inFlightRate);
		return {
			tripped,
			metric,
			threshold: w.threshold,
			hotWindows: effectiveHot,
			thresholdLabel: w.thresholdLabel,
		};
	}

	function check(nowMs: number): TokenRateCheckResult {
		// Cloud is evaluated first so a cloud runaway is reported with the cloud
		// threshold even while a slower local stream interleaves.
		const cloudResult = evaluate(cloud, nowMs);
		if (cloudResult.tripped) return cloudResult;
		const localResult = evaluate(local, nowMs);
		if (localResult.tripped) return localResult;
		// Neither tripped: report the initialized scope closer to its threshold
		// (higher metric/threshold ratio); default to cloud (legacy) otherwise.
		if (!local.initialized) return cloudResult;
		if (!cloud.initialized) return localResult;
		const cloudRatio = cloudResult.threshold > 0 ? cloudResult.metric / cloudResult.threshold : 0;
		const localRatio = localResult.threshold > 0 ? localResult.metric / localResult.threshold : 0;
		return localRatio > cloudRatio ? localResult : cloudResult;
	}

	function reset(): void {
		for (const w of [cloud, local]) {
			w.currentWindowTokens = 0;
			w.currentWindowStartMs = 0;
			w.consecutiveHotWindows = 0;
			w.lastWindowRateTokPerSec = 0;
			w.initialized = false;
		}
		cloud.threshold = cfg.thresholdTokPerSec;
		cloud.thresholdLabel = "thresholdTokPerSec";
		local.threshold = localDefaultThreshold;
		local.thresholdLabel = "localThresholdTokPerSec";
	}

	return { state, observe, check, reset };
}
