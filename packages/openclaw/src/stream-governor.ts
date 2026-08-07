// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * stream-governor.ts — Governed Stream Wrapper for the OpenClaw/pi-ai seam
 *
 * Wraps a host stream function with usertrust governance:
 *   1. Before stream: authorize (budget check, PENDING hold)
 *   2. During stream: forward events, accumulate token usage
 *   3. After stream: EXACTLY ONE terminal ledger action per authorization —
 *      settle with the provider's usage once a `done` event has been seen,
 *      settle at the ESTIMATE when the stream ends with no terminal event at
 *      all (including a consumer who walked away mid-stream), abort when it
 *      fails (a throw, or an in-band `error` event). The terminal event the
 *      loop OBSERVED decides the action, not where the generator happened to
 *      unwind — a consumer that breaks straight after `done`/`error` gets the
 *      same treatment as one that drains to the end.
 *
 * The full path→action matrix, including what `result()` does on each, is in
 * contract-notes §6 and pinned by `tests/terminal-modes.test.ts`.
 *
 * The wrapped function has the same signature AND the same surface as the
 * original — the pinned boundary is not a bare `AsyncIterable`, it also
 * exposes `result()`, so the wrapper is a proxy rather than a generator.
 */

import type { Authorization, Governor, SettleParams } from "usertrust";
import type { AccumulatedUsage } from "./token-extractor.js";
import { createAccumulator } from "./token-extractor.js";
import type {
	AssistantMessage,
	AssistantMessageEventStreamLike,
	Context,
	ErrorEvent,
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

	// Exactly one terminal ledger action per authorization (AGENTS.md, "Money").
	// The flag flips only once a settle or an abort has actually been issued, so
	// the `finally` guard below can tell an ABANDONED stream — the consumer
	// `break`s or calls `iterator.return()`, unwinding the generator at `yield`
	// without reaching any branch — from one that already terminated.
	let terminated = false;

	// A terminal `error` event does NOT throw — per contract-notes §3 the host
	// yields it like any other event and the iteration simply ends. Declared
	// OUTSIDE the try so the `finally` can consult it too: a consumer that breaks
	// (or calls `iterator.return()`) immediately AFTER the error event unwinds the
	// generator at the `yield` and never reaches the post-loop branch. What the
	// loop already observed still decides the hold, so a call the provider
	// reported as failed is voided rather than charged at the estimate.
	let failure: ErrorEvent | undefined;

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
			if (event.type === "error") failure = event;
			yield event;
		}

		if (failure !== undefined) {
			// 3a. The provider reported failure in-band — VOID, same as a throw.
			// The iteration itself does not rethrow — the consumer already saw the
			// event — but there is no successful message for `result()` to report.
			const err = await abortForFailureEvent(governor, auth, failure);
			terminated = true;
			final.reject(err);
			return;
		}

		// 3b. Settle — POST actual cost.
		await governor.settle(auth, settleParamsFor(accumulator.result()));
		terminated = true;

		// Governance is done and the money path succeeded — only now may
		// `result()` report the host's final message.
		final.resolve(providerResult);
	} catch (err) {
		// 4. Abort — VOID the hold (catch abort errors to preserve original).
		// Reachable only before `terminated` flips: the settle above is the last
		// thing that can throw, and a settle that rejected mutated nothing.
		await governor.abort(auth, err).catch(() => {});
		terminated = true;
		final.reject(err);
		throw err;
	} finally {
		// 5. Abandonment — the consumer walked away, unwinding the generator at a
		// `yield` without reaching any branch above. The hold is still open, and
		// what the loop OBSERVED before the unwind decides its fate.
		if (!terminated) {
			if (failure !== undefined) {
				// The provider had already reported failure in-band; the consumer just
				// left before the loop ended. VOID, exactly as the 3a branch would.
				final.reject(await abortForFailureEvent(governor, auth, failure));
			} else {
				// A clean early termination, not a failure, so it SETTLES the partial
				// rather than voiding (AGENTS.md, "The settle/void asymmetry is
				// deliberate") — at the provider's usage if a `done` event already
				// carried it, otherwise at the ESTIMATE.
				await settleAbandoned(governor, auth, accumulator.result());
			}
		}
		// `result()` must never be left pending. The abandonment path has no final
		// assistant message to hand back, so it rejects.
		if (!final.settled) {
			final.reject(new Error("usertrust: stream abandoned before completion"));
		}
	}
}

/**
 * The single place accumulated stream usage becomes `SettleParams`.
 *
 * Omitting the token fields is what selects the ESTIMATE — `settle()` reads
 * `auth.estimatedCost` when neither `inputTokens` nor `outputTokens` is given.
 * So a stream that never carried a terminal event settles at the estimate,
 * while one that did settles at the provider's own numbers — including when the
 * consumer walked away immediately after that event, where the estimate (sized
 * above expected actuals) would overcharge a fully served call.
 */
function settleParamsFor(usage: AccumulatedUsage): SettleParams {
	return {
		...(usage.usageReported
			? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
			: {}),
		chunksDelivered: usage.chunksDelivered,
		usageSource: usage.usageReported ? "provider" : "estimated",
		// Ollama-native eval_duration (when the stream carried it) flows to
		// receipt.meter.computeMs. Spread keeps the key OMITTED when absent —
		// never `computeMs: undefined` (plan A6).
		...(usage.computeMs != null ? { computeMs: usage.computeMs } : {}),
	};
}

/**
 * Settle an abandoned stream's hold, falling back to an abort if the ledger
 * refuses the settle. Nothing here may throw: it runs in the generator's
 * `finally`, where an escaping error would replace the consumer's own control
 * flow (a `break`, an outer `throw`) with a governance error.
 */
async function settleAbandoned(
	governor: Governor,
	auth: Authorization,
	usage: AccumulatedUsage,
): Promise<void> {
	try {
		await governor.settle(auth, settleParamsFor(usage));
	} catch (err) {
		// The hold would otherwise dangle PENDING until destroy/timeout.
		await governor.abort(auth, err).catch(() => {});
	}
}

/**
 * Void the hold for a stream the provider ended with an in-band `error` event,
 * and return the error `result()` should reject with. Shared by the post-loop
 * branch and the `finally`, so the two cannot drift into treating the same
 * observed failure differently. Never throws — the `finally` calls it too.
 */
async function abortForFailureEvent(
	governor: Governor,
	auth: Authorization,
	failure: ErrorEvent,
): Promise<Error> {
	const err = new Error(
		`usertrust: provider stream ended with error: ${failure.error.errorMessage ?? failure.reason}`,
	);
	await governor.abort(auth, err).catch(() => {});
	return err;
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
