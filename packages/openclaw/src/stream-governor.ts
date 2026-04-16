// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * stream-governor.ts — Governed Stream Wrapper for pi-ai
 *
 * Wraps a pi-ai stream function with usertrust governance:
 *   1. Before stream: authorize (budget check, PENDING hold)
 *   2. During stream: forward events, accumulate token usage
 *   3. After stream: settle with actual cost
 *   4. On error: abort (VOID the hold)
 *
 * The wrapped function has the same signature as the original —
 * it's a transparent middleware layer.
 */

import type { Authorization, Governor } from "usertrust";
import { createAccumulator } from "./token-extractor.js";
import type { StreamContext, StreamEvent, StreamFn } from "./types.js";

/**
 * Wrap a pi-ai stream function with usertrust governance.
 *
 * Returns a new stream function with the same signature. Every call:
 *   - Checks budget and creates a PENDING hold
 *   - Forwards all stream events unchanged
 *   - Settles with actual token usage on completion
 *   - Voids the hold on error
 *
 * The governance receipt is emitted as a custom `usertrust:receipt`
 * property on the `done` event for consumers that want it.
 */
export function wrapStreamWithGovernance(streamFn: StreamFn, governor: Governor): StreamFn {
	return (
		model: string,
		context: StreamContext,
		options?: Record<string, unknown>,
	): AsyncIterable<StreamEvent> => {
		return governedStream(streamFn, governor, model, context, options);
	};
}

async function* governedStream(
	streamFn: StreamFn,
	governor: Governor,
	model: string,
	context: StreamContext,
	options?: Record<string, unknown>,
): AsyncGenerator<StreamEvent> {
	// 1a. Pre-flight budget check.
	// In dry-run mode (no TigerBeetle) the engine cannot enforce balance,
	// so we explicitly refuse calls when budget_remaining ≤ 0. This matches
	// the behaviour users expect from a "budget" config: hit zero, get cut off.
	if (governor.budgetRemaining() <= 0) {
		throw new Error(
			`usertrust: budget exhausted (${governor.budgetRemaining()} remaining); call denied`,
		);
	}

	// 1b. Authorize — policy gate, PENDING hold
	const auth: Authorization = await governor.authorize({
		model,
		messages: context.messages,
		...(context.maxTokens != null ? { maxOutputTokens: context.maxTokens } : {}),
		params: {
			...(context.temperature != null ? { temperature: context.temperature } : {}),
		},
	});

	// 2. Stream with token accumulation
	const accumulator = createAccumulator();

	try {
		const stream = streamFn(model, context, options);

		for await (const event of stream) {
			accumulator.update(event);
			yield event;
		}

		// 3. Settle — POST actual cost
		const usage = accumulator.result();

		await governor.settle(auth, {
			...(usage.usageReported
				? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
				: {}),
			chunksDelivered: usage.chunksDelivered,
			usageSource: usage.usageReported ? "provider" : "estimated",
		});
	} catch (err) {
		// 4. Abort — VOID the hold (catch abort errors to preserve original)
		await governor.abort(auth, err).catch(() => {});
		throw err;
	}
}

/**
 * Wrap a non-streaming completion function with governance.
 *
 * For pi-ai's `completeSimple()` / `complete()` functions that
 * return a Promise instead of an async iterable.
 */
export function wrapCompleteWithGovernance<
	T extends { usage?: { inputTokens: number; outputTokens: number } },
>(
	completeFn: (
		model: string,
		context: StreamContext,
		options?: Record<string, unknown>,
	) => Promise<T>,
	governor: Governor,
): (model: string, context: StreamContext, options?: Record<string, unknown>) => Promise<T> {
	return async (
		model: string,
		context: StreamContext,
		options?: Record<string, unknown>,
	): Promise<T> => {
		// 1a. Pre-flight budget check (see governedStream for rationale).
		if (governor.budgetRemaining() <= 0) {
			throw new Error(
				`usertrust: budget exhausted (${governor.budgetRemaining()} remaining); call denied`,
			);
		}

		// 1b. Authorize
		const auth = await governor.authorize({
			model,
			messages: context.messages,
			...(context.maxTokens != null ? { maxOutputTokens: context.maxTokens } : {}),
			params: {
				...(context.temperature != null ? { temperature: context.temperature } : {}),
			},
		});

		try {
			// 2. Execute
			const result = await completeFn(model, context, options);

			// 3. Settle with actual usage if available
			await governor.settle(auth, {
				...(result.usage != null
					? {
							inputTokens: result.usage.inputTokens,
							outputTokens: result.usage.outputTokens,
							usageSource: "provider" as const,
						}
					: { usageSource: "estimated" as const }),
			});

			return result;
		} catch (err) {
			// 4. Abort (catch abort errors to preserve original)
			await governor.abort(auth, err).catch(() => {});
			throw err;
		}
	};
}
