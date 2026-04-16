// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * injection-cascade.ts — Injection-cascade anomaly signal.
 *
 * Detects when N injection signals fire within an M-second rolling window.
 * Useful for catching agents under sustained adversarial pressure.
 *
 * Default: 3 events in 60s.
 */

import type { InjectionCascadeConfig } from "../types.js";

export interface InjectionCascadeSignalState {
	/** Timestamps (ms since epoch) of injection events within the active window. */
	eventTimes: number[];
}

export interface InjectionCascadeSignal {
	state: Readonly<InjectionCascadeSignalState>;
	observe(nowMs: number): void;
	check(nowMs: number): {
		tripped: boolean;
		metric: number;
		threshold: number;
	};
	reset(): void;
}

export interface ResolvedInjectionCascadeConfig {
	eventCount: number;
	windowMs: number;
}

export const INJECTION_CASCADE_DEFAULTS: ResolvedInjectionCascadeConfig = {
	eventCount: 3,
	windowMs: 60_000,
};

export function resolveInjectionCascadeConfig(
	cfg?: InjectionCascadeConfig,
): ResolvedInjectionCascadeConfig {
	return {
		eventCount: cfg?.eventCount ?? INJECTION_CASCADE_DEFAULTS.eventCount,
		windowMs: cfg?.windowMs ?? INJECTION_CASCADE_DEFAULTS.windowMs,
	};
}

export function createInjectionCascadeSignal(
	cfg: ResolvedInjectionCascadeConfig,
): InjectionCascadeSignal {
	const state: InjectionCascadeSignalState = {
		eventTimes: [],
	};

	function pruneOlderThan(cutoffMs: number): void {
		while (state.eventTimes.length > 0) {
			const head = state.eventTimes[0];
			if (head !== undefined && head < cutoffMs) {
				state.eventTimes.shift();
			} else {
				break;
			}
		}
	}

	function observe(nowMs: number): void {
		pruneOlderThan(nowMs - cfg.windowMs);
		state.eventTimes.push(nowMs);
	}

	function check(nowMs: number): {
		tripped: boolean;
		metric: number;
		threshold: number;
	} {
		pruneOlderThan(nowMs - cfg.windowMs);
		const count = state.eventTimes.length;
		return {
			tripped: count >= cfg.eventCount,
			metric: count,
			threshold: cfg.eventCount,
		};
	}

	function reset(): void {
		state.eventTimes.length = 0;
	}

	return { state, observe, check, reset };
}
