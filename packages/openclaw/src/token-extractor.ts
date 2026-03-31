// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * token-extractor.ts — pi-ai Stream Token Extraction
 *
 * Extracts token usage from pi-ai's normalized stream events.
 * pi-ai reports usage on `done` and `error` events, unlike provider
 * SDKs which scatter it across multiple event types.
 */

import type { StreamEvent, StreamUsage } from "./types.js";

/** Accumulated usage from a pi-ai stream. */
export interface AccumulatedUsage {
	inputTokens: number;
	outputTokens: number;
	chunksDelivered: number;
	usageReported: boolean;
}

/**
 * Extract token usage from a pi-ai stream event.
 * Returns non-zero usage only for `done` and `error` events.
 */
/** Max tokens to accept from a provider (prevents Infinity/overflow in cost math). */
const MAX_TOKENS = 2_000_000;

function clampTokens(n: number): number {
	return Math.min(Math.max(0, n), MAX_TOKENS);
}

export function extractUsageFromEvent(event: StreamEvent): StreamUsage | null {
	if (event.type === "done" && event.usage != null) {
		return {
			...event.usage,
			inputTokens: clampTokens(event.usage.inputTokens),
			outputTokens: clampTokens(event.usage.outputTokens),
		};
	}
	if (event.type === "error" && event.usage != null) {
		return {
			...event.usage,
			inputTokens: clampTokens(event.usage.inputTokens),
			outputTokens: clampTokens(event.usage.outputTokens),
		};
	}
	return null;
}

/**
 * Creates a token accumulator for tracking usage across a stream.
 * Call `update()` for each event and `result()` when done.
 */
export function createAccumulator(): {
	update(event: StreamEvent): void;
	result(): AccumulatedUsage;
} {
	let inputTokens = 0;
	let outputTokens = 0;
	let chunksDelivered = 0;
	let usageReported = false;

	return {
		update(event: StreamEvent): void {
			chunksDelivered++;

			const usage = extractUsageFromEvent(event);
			if (usage != null) {
				inputTokens = usage.inputTokens;
				outputTokens = usage.outputTokens;
				usageReported = true;
			}
		},

		result(): AccumulatedUsage {
			return { inputTokens, outputTokens, chunksDelivered, usageReported };
		},
	};
}
