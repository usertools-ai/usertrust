// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * detector.ts — AnomalyDetector
 *
 * Mental model:
 *   - One detector instance per intercepted streaming call (or shared across
 *     a "conversation" when injection-cascade tracking is needed).
 *   - The streaming pipeline calls observe(event) for each chunk; the detector
 *     updates per-signal state and check() returns a verdict.
 *   - On tripped verdict: caller throws AnomalyError, which propagates through
 *     the existing wrapStream onError → VOID flow → upstream caller. An audit
 *     event `anomaly_detected` is appended via the existing hash-chain.
 *   - After cooldownMs the detector auto-resets; reset() can be called manually.
 *
 * Defaults are tuned conservatively (500 tok/s sustained, $1/min, 3 injections in 60s).
 * Detection is opt-in (anomaly.enabled=true) — when off, observe/check are no-ops.
 */

import { estimateCost } from "../ledger/pricing.js";
import {
	type InjectionCascadeSignal,
	createInjectionCascadeSignal,
	resolveInjectionCascadeConfig,
} from "./signals/injection-cascade.js";
import {
	type SpendVelocitySignal,
	createSpendVelocitySignal,
	resolveSpendVelocityConfig,
} from "./signals/spend-velocity.js";
import {
	type TokenRateSignal,
	createTokenRateSignal,
	resolveTokenRateConfig,
} from "./signals/token-rate.js";
import type {
	AnomalyChunkEvent,
	AnomalyConfig,
	AnomalyDetectorOptions,
	AnomalyDetectorState,
	AnomalyEvent,
	AnomalyInjectionEvent,
	AnomalyKind,
	AnomalyVerdict,
	ResolvedAnomalyConfig,
} from "./types.js";

const DEFAULT_COOLDOWN_MS = 30_000;

/** Resolve a partial AnomalyConfig with defaults. */
export function resolveAnomalyConfig(cfg?: AnomalyConfig): ResolvedAnomalyConfig {
	return {
		enabled: cfg?.enabled ?? false,
		tokenRate: resolveTokenRateConfig(cfg?.tokenRate),
		spendVelocity: resolveSpendVelocityConfig(cfg?.spendVelocity),
		injectionCascade: resolveInjectionCascadeConfig(cfg?.injectionCascade),
		cooldownMs: cfg?.cooldownMs ?? DEFAULT_COOLDOWN_MS,
	};
}

/** USD value of one usertoken. 1 usertoken = $0.0001 (one basis point of a cent). */
const USERTOKENS_PER_DOLLAR = 10_000;

function defaultCostCalculator(model: string, inputTokens: number, outputTokens: number): number {
	// estimateCost returns usertokens; convert to dollars.
	const usertokens = estimateCost(model, inputTokens, outputTokens);
	return usertokens / USERTOKENS_PER_DOLLAR;
}

export interface AnomalyDetector {
	readonly config: ResolvedAnomalyConfig;
	readonly state: Readonly<AnomalyDetectorState>;
	/** Observe a chunk or injection event. */
	observe(event: AnomalyEvent): void;
	/** Check current state. Returns the most-severe tripped verdict, or {tripped:false}. */
	check(): AnomalyVerdict;
	/** Manually reset the detector to a clean state. */
	reset(): void;
	/** True if currently tripped (and not yet auto-recovered via cooldown). */
	isTripped(): boolean;
}

export function createAnomalyDetector(
	cfg?: AnomalyConfig,
	options?: AnomalyDetectorOptions,
): AnomalyDetector {
	const config = resolveAnomalyConfig(cfg);
	const now = options?.now ?? (() => Date.now());
	const model = options?.model ?? "unknown";
	const costCalculator = options?.costCalculator ?? defaultCostCalculator;

	const tokenRate: TokenRateSignal = createTokenRateSignal(config.tokenRate);
	const spendVelocity: SpendVelocitySignal = createSpendVelocitySignal(config.spendVelocity);
	const injectionCascade: InjectionCascadeSignal = createInjectionCascadeSignal(
		config.injectionCascade,
	);

	const state: AnomalyDetectorState = {
		tripped: false,
		trippedAt: null,
		trippedKind: null,
	};

	function maybeAutoRecover(): void {
		if (!state.tripped || state.trippedAt == null) return;
		if (now() - state.trippedAt >= config.cooldownMs) {
			doReset();
		}
	}

	function observeChunk(ev: AnomalyChunkEvent): void {
		const t = ev.at ?? now();
		tokenRate.observe(ev.deltaTokens, t);
		const dollars = costCalculator(model, ev.cumulativeInputTokens, ev.cumulativeOutputTokens);
		spendVelocity.observe(dollars, t);
	}

	function observeInjection(ev: AnomalyInjectionEvent): void {
		injectionCascade.observe(ev.at ?? now());
	}

	function observe(event: AnomalyEvent): void {
		if (!config.enabled) return;
		maybeAutoRecover();
		if (event.kind === "chunk") {
			observeChunk(event);
		} else {
			observeInjection(event);
		}
	}

	function check(): AnomalyVerdict {
		if (!config.enabled) return { tripped: false };
		maybeAutoRecover();
		// If already tripped (still in cooldown), keep returning the trip verdict
		// so the caller's check is idempotent during the same call.
		if (state.tripped && state.trippedKind != null) {
			return buildKnownTrip(state.trippedKind);
		}

		const t = now();

		// Check signals in priority order: token-rate first (cheapest), spend-velocity, then injection.
		const tr = tokenRate.check(t);
		if (tr.tripped) {
			return markTripped(
				"token_rate",
				`tokens/s ${tr.metric.toFixed(1)} >= ${tr.threshold}`,
				tr.metric,
				tr.threshold,
			);
		}

		const sv = spendVelocity.check(t);
		if (sv.tripped) {
			return markTripped(
				"spend_velocity",
				`$/min ${sv.metric.toFixed(4)} >= ${sv.threshold}`,
				sv.metric,
				sv.threshold,
			);
		}

		const ic = injectionCascade.check(t);
		if (ic.tripped) {
			return markTripped(
				"injection_cascade",
				`injection events ${ic.metric} >= ${ic.threshold} within window`,
				ic.metric,
				ic.threshold,
			);
		}

		return { tripped: false };
	}

	function buildKnownTrip(kind: AnomalyKind): AnomalyVerdict {
		// Re-check the tripped signal so metric reflects the most recent value.
		const t = now();
		switch (kind) {
			case "token_rate": {
				const r = tokenRate.check(t);
				return {
					tripped: true,
					kind,
					message: `tokens/s ${r.metric.toFixed(1)} >= ${r.threshold}`,
					metric: r.metric,
					threshold: r.threshold,
				};
			}
			case "spend_velocity": {
				const r = spendVelocity.check(t);
				return {
					tripped: true,
					kind,
					message: `$/min ${r.metric.toFixed(4)} >= ${r.threshold}`,
					metric: r.metric,
					threshold: r.threshold,
				};
			}
			case "injection_cascade": {
				const r = injectionCascade.check(t);
				return {
					tripped: true,
					kind,
					message: `injection events ${r.metric} >= ${r.threshold} within window`,
					metric: r.metric,
					threshold: r.threshold,
				};
			}
		}
	}

	function markTripped(
		kind: AnomalyKind,
		message: string,
		metric: number,
		threshold: number,
	): AnomalyVerdict {
		state.tripped = true;
		state.trippedAt = now();
		state.trippedKind = kind;
		return { tripped: true, kind, message, metric, threshold };
	}

	function doReset(): void {
		state.tripped = false;
		state.trippedAt = null;
		state.trippedKind = null;
		tokenRate.reset();
		spendVelocity.reset();
		injectionCascade.reset();
	}

	function isTripped(): boolean {
		// Run a check first so that signals which have crossed thresholds since
		// the last observe() are reflected. Then handle auto-recovery.
		if (!state.tripped && config.enabled) {
			check();
		}
		maybeAutoRecover();
		return state.tripped;
	}

	return {
		config,
		state,
		observe,
		check,
		reset: doReset,
		isTripped,
	};
}
