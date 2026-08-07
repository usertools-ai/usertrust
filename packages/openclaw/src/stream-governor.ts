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
	/** True once `resolve`/`reject` has been called — lets callers assert that
	 *  every terminal path settled, instead of silently leaving `result()` pending. */
	readonly settled: boolean;
}

function createDeferred<T>(): Deferred<T> {
	let resolveFn!: (value: T | PromiseLike<T>) => void;
	let rejectFn!: (reason: unknown) => void;
	let settled = false;
	const promise = new Promise<T>((res, rej) => {
		resolveFn = res;
		rejectFn = rej;
	});
	// A consumer that only iterates never touches `result()`; without this the
	// rejection leg would surface as an unhandled rejection.
	promise.catch(() => {});
	return {
		promise,
		resolve(value) {
			settled = true;
			resolveFn(value);
		},
		reject(reason) {
			settled = true;
			rejectFn(reason);
		},
		get settled() {
			return settled;
		},
	};
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
						// The governed run settles `final` on every terminal path, so
						// this is normally the same rejection arriving twice. Rethrow
						// rather than falling through to `final.promise`: a drain that
						// threw must never be reported as a successful message.
						final.reject(err);
						throw err;
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

	// 1b. Authorize — policy gate, PENDING hold.
	// A policy DENY is a terminal path like any other: `final` must be settled
	// here, or a consumer that iterates AND awaits `result()` sees the iteration
	// reject while `result()` hangs forever. There is no hold to abort yet, so
	// this needs its own try rather than the streaming one below.
	let auth: Authorization;
	try {
		auth = await governor.authorize({
			model: model.id,
			messages: context.messages,
			...(options?.maxTokens != null ? { maxOutputTokens: options.maxTokens } : {}),
			params: {
				...(options?.temperature != null ? { temperature: options.temperature } : {}),
			},
		});
	} catch (err) {
		final.reject(err);
		throw err;
	}

	// 2. Stream with token accumulation
	const accumulator = createAccumulator();

	try {
		const stream = await streamFn(model, context, options);
		// Hold on to the host's final-message promise, but do NOT wire it to
		// `final` yet: it settles when the PROVIDER stream ends, which is before
		// `governor.settle()` runs. Resolving here would let a `result()`-only
		// consumer see a successful assistant message for a call that governance
		// went on to abort. `final` is settled from the governed run below.
		const providerResult = stream.result();
		// Nothing awaits it until adoption, so pre-mark it handled.
		providerResult.catch(() => {});

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

		// Governance is done and the money path succeeded — only now may
		// `result()` report the host's final message.
		final.resolve(providerResult);
	} catch (err) {
		// 4. Abort — VOID the hold (catch abort errors to preserve original)
		await governor.abort(auth, err).catch(() => {});
		final.reject(err);
		throw err;
	} finally {
		// A consumer that `break`s (or otherwise calls `return()` on the iterator)
		// unwinds the generator without reaching either branch above. `result()`
		// must never be left pending, so settle it here as a last resort.
		// NOTE: this guard settles the DEFERRED only — it deliberately does not
		// touch the hold. Aborting/settling governance on abandonment is Task 3's
		// terminal-mode work.
		if (!final.settled) {
			final.reject(new Error("usertrust: stream abandoned before completion"));
		}
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
