// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * anomaly/types.ts — Shared types for the streaming anomaly detector.
 *
 * The detector is a per-operation observer attached to a streaming LLM call.
 * It receives `observe(event)` calls for each chunk, accumulates per-signal
 * state, and `check()` returns a verdict. On a "trip" verdict, the caller
 * should VOID the PENDING hold, throw `AnomalyError`, and emit a hash-chained
 * `anomaly_detected` audit event.
 */

import type { LLMClientKind } from "../shared/types.js";

// ── Anomaly kinds ──

/** The three signal types the detector watches. */
export type AnomalyKind = "token_rate" | "spend_velocity" | "injection_cascade";

// ── Config ──

/** Token-rate signal config. */
export interface TokenRateConfig {
	/** Threshold tokens-per-second above which a window is "hot". Default 500. */
	thresholdTokPerSec?: number;
	/** Window size in milliseconds. Default 2000. */
	windowMs?: number;
	/** Number of consecutive hot windows required to trip. Default 3. */
	consecutiveWindows?: number;
}

/** Spend-velocity signal config. */
export interface SpendVelocityConfig {
	/** Maximum dollars per minute (rolling). Default 1.00. */
	thresholdDollarsPerMin?: number;
	/** Rolling window in milliseconds. Default 10000. */
	windowMs?: number;
}

/** Injection-cascade signal config. */
export interface InjectionCascadeConfig {
	/** Number of injection events to trip. Default 3. */
	eventCount?: number;
	/** Window in milliseconds. Default 60000. */
	windowMs?: number;
}

/** Top-level anomaly governance config (extends TrustConfig). */
export interface AnomalyConfig {
	/** Enable streaming anomaly detection. Default: false (opt-in). */
	enabled?: boolean;
	tokenRate?: TokenRateConfig;
	spendVelocity?: SpendVelocityConfig;
	injectionCascade?: InjectionCascadeConfig;
	/** Cooldown after a trip before auto-reset. Default 30000 ms. */
	cooldownMs?: number;
}

/** Resolved (defaulted) config used internally. */
export interface ResolvedAnomalyConfig {
	enabled: boolean;
	tokenRate: Required<TokenRateConfig>;
	spendVelocity: Required<SpendVelocityConfig>;
	injectionCascade: Required<InjectionCascadeConfig>;
	cooldownMs: number;
}

// ── Observation events ──

/** Per-chunk observation passed to the detector. */
export interface AnomalyChunkEvent {
	kind: "chunk";
	/** Tokens contained in this chunk (delta, not cumulative). */
	deltaTokens: number;
	/** Cumulative input tokens reported by provider so far (or last estimate). */
	cumulativeInputTokens: number;
	/** Cumulative output tokens reported by provider so far (or last estimate). */
	cumulativeOutputTokens: number;
	/** Wall-clock timestamp. Defaults to Date.now() if omitted. */
	at?: number;
}

/** Out-of-band injection event (fired when detect.injection finds something). */
export interface AnomalyInjectionEvent {
	kind: "injection";
	at?: number;
	patterns?: string[];
}

export type AnomalyEvent = AnomalyChunkEvent | AnomalyInjectionEvent;

// ── Verdicts ──

/** Detector verdict after each observation or on demand. */
export type AnomalyVerdict =
	| { tripped: false }
	| {
			tripped: true;
			kind: AnomalyKind;
			message: string;
			/** Numeric metric that crossed the threshold (e.g., 612.4 for tok/s). */
			metric: number;
			/** The configured threshold the metric crossed. */
			threshold: number;
	  };

// ── Detector public surface ──

export interface AnomalyDetectorOptions {
	/** The provider kind being observed (used for audit/log context). */
	provider?: LLMClientKind;
	/** Model name being observed (used for cost calculation in spend-velocity). */
	model?: string;
	/** Override the cost calculator (for testing). Returns dollars for given tokens. */
	costCalculator?: (model: string, inputTokens: number, outputTokens: number) => number;
	/** Time source override (for deterministic tests). */
	now?: () => number;
}

export interface AnomalyDetectorState {
	/** Whether the detector is currently in a tripped state (post-trip, pre-cooldown). */
	tripped: boolean;
	/** When the trip occurred (ms since epoch), if tripped. */
	trippedAt: number | null;
	/** The kind that tripped, if tripped. */
	trippedKind: AnomalyKind | null;
}
