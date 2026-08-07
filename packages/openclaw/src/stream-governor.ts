// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * stream-governor.ts — Governed Stream Wrapper for the OpenClaw/pi-ai seam
 *
 * Wraps a host stream function with usertrust governance:
 *   1. Before stream: authorize (budget check, PENDING hold)
 *   2. During stream: forward events, accumulate token usage
 *   3. After stream: settle with actual cost
 *   4. On error: abort (VOID the hold)
 *
 * The wrapped function has the same signature AND the same surface as the
 * original — the pinned boundary is not a bare `AsyncIterable`, it also
 * exposes `result()`, so the wrapper is a proxy rather than a generator.
 */

import type { Authorization, Governor } from "usertrust";
import { createAccumulator } from "./token-extractor.js";
import type {
	AssistantMessage,
	AssistantMessageEventStreamLike,
	Context,
	Model,
	StreamEvent,
	StreamFn,
	StreamOptions,
	Usage,
} from "./types.js";

/** A promise plus its settlers, pre-marked as handled to avoid stray rejections. */
interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	// A consumer that only iterates never touches `result()`; without this the
	// rejection leg would surface as an unhandled rejection.
	promise.catch(() => {});
	return { promise, resolve, reject };
}

/**
 * Wrap a host stream function with usertrust governance.
 *
 * Returns a new stream function with the same signature. Every call:
 *   - Checks budget and creates a PENDING hold
 *   - Forwards all stream events unchanged
 *   - Settles with actual token usage on completion
 *   - Voids the hold on error
 */
export function wrapStreamWithGovernance(streamFn: StreamFn, governor: Governor): StreamFn {
	return (
		model: Model,
		context: Context,
		options?: StreamOptions,
	): AssistantMessageEventStreamLike => {
		// The governed run is a single-consumer async generator, and `result()`
		// has to resolve from that SAME run — so the inner stream's final message
		// is handed over through a deferred the generator settles.
		const final = createDeferred<AssistantMessage>();
		const events = governedStream(streamFn, governor, model, context, options, final);
		let consumed = false;

		return {
			[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
				consumed = true;
				return events[Symbol.asyncIterator]();
			},
			async result(): Promise<AssistantMessage> {
				// A `result()`-only consumer never iterates, so drain the governed
				// stream here — otherwise neither governance nor `final` ever runs.
				if (!consumed) {
					consumed = true;
					try {
						for await (const _event of events) {
							// drain
						}
					} catch (err) {
						final.reject(err);
					}
				}
				return final.promise;
			},
		};
	};
}

async function* governedStream(
	streamFn: StreamFn,
	governor: Governor,
	model: Model,
	context: Context,
	options: StreamOptions | undefined,
	final: Deferred<AssistantMessage>,
): AsyncGenerator<StreamEvent> {
	// 1a. Pre-flight budget check.
	// In dry-run mode (no TigerBeetle) the engine cannot enforce balance,
	// so we explicitly refuse calls when budget_remaining ≤ 0. This matches
	// the behaviour users expect from a "budget" config: hit zero, get cut off.
	if (governor.budgetRemaining() <= 0) {
		const denial = new Error(
			`usertrust: budget exhausted (${governor.budgetRemaining()} remaining); call denied`,
		);
		final.reject(denial);
		throw denial;
	}

	// 1b. Authorize — policy gate, PENDING hold
	const auth: Authorization = await governor.authorize({
		model: model.id,
		messages: context.messages,
		...(options?.maxTokens != null ? { maxOutputTokens: options.maxTokens } : {}),
		params: {
			...(options?.temperature != null ? { temperature: options.temperature } : {}),
		},
	});

	// 2. Stream with token accumulation
	const accumulator = createAccumulator();

	try {
		const stream = await streamFn(model, context, options);
		// Forward the host's own final-message promise onto our surface.
		stream.result().then(final.resolve, final.reject);

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
			// Ollama-native eval_duration (when the stream carried it) flows to
			// receipt.meter.computeMs. Spread keeps the key OMITTED when absent —
			// never `computeMs: undefined` (plan A6).
			...(usage.computeMs != null ? { computeMs: usage.computeMs } : {}),
		});
	} catch (err) {
		// 4. Abort — VOID the hold (catch abort errors to preserve original)
		await governor.abort(auth, err).catch(() => {});
		final.reject(err);
		throw err;
	}
}

/**
 * Wrap a non-streaming completion function with governance.
 *
 * For the host's `completeSimple()` / `complete()` functions that return a
 * Promise instead of a stream. Usage lands on the returned assistant message
 * as the host's `Usage` shape (`input`/`output`), not `inputTokens`.
 */
export function wrapCompleteWithGovernance<T extends { usage?: Usage }>(
	completeFn: (model: Model, context: Context, options?: StreamOptions) => Promise<T>,
	governor: Governor,
): (model: Model, context: Context, options?: StreamOptions) => Promise<T> {
	return async (model: Model, context: Context, options?: StreamOptions): Promise<T> => {
		// 1a. Pre-flight budget check (see governedStream for rationale).
		if (governor.budgetRemaining() <= 0) {
			throw new Error(
				`usertrust: budget exhausted (${governor.budgetRemaining()} remaining); call denied`,
			);
		}

		// 1b. Authorize
		const auth = await governor.authorize({
			model: model.id,
			messages: context.messages,
			...(options?.maxTokens != null ? { maxOutputTokens: options.maxTokens } : {}),
			params: {
				...(options?.temperature != null ? { temperature: options.temperature } : {}),
			},
		});

		try {
			// 2. Execute
			const result = await completeFn(model, context, options);

			// 3. Settle with actual usage if available
			await governor.settle(auth, {
				...(result.usage != null
					? {
							inputTokens: result.usage.input,
							outputTokens: result.usage.output,
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
