// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * stream-governor.ts — Governed Stream Wrapper for the OpenClaw/pi-ai seam
 *
 * Wraps a host stream function with usertrust governance:
 *   1. Before stream: attribute (which envelope pays — `attribution.ts`), then
 *      authorize (budget check, PENDING hold)
 *   2. During stream: forward events, accumulate token usage
 *   3. On the terminal event: EXACTLY ONE terminal ledger action per
 *      authorization — settle with the provider's usage on `done`, settle the
 *      PARTIAL usage on a consumer abort (`error` with `reason: "aborted"`),
 *      abort/void on a provider failure (a throw, or `error` with
 *      `reason: "error"`), and settle at the ESTIMATE when the stream ends with
 *      no terminal event at all (including a consumer who walked away).
 *
 * The full path→action matrix, including what `result()` does on each, is in
 * contract-notes §6 and pinned by `tests/terminal-modes.test.ts`.
 *
 * The wrapped function has the same signature AND the same surface as the
 * original — the pinned boundary is not a bare `AsyncIterable`, it also
 * exposes `result()`, so the wrapper is a proxy rather than a generator.
 *
 * ── TWO PINNED-HOST BEHAVIOURS THIS FILE IS SHAPED BY ──
 *
 * (a) The host awaits `result()` from INSIDE its loop body. `openclaw`
 *     `dist/proxy-BzhBz8iM.js:395-408` (`streamAssistantResponse`):
 *
 *         case "done":
 *         case "error": {
 *           const finalMessage = removeNonExecutableToolCalls(await response.result());
 *           …
 *           return finalMessage;        // ← returns from inside the for-await
 *         }
 *
 *     so the host is suspended in the loop body, holding the generator at its
 *     terminal `yield`, when it blocks on `result()`. The pinned stream class
 *     survives that because `EventStream.push()` resolves the final-result
 *     promise BEFORE delivering the terminal event to the waiting consumer
 *     (`pi-ai/dist/utils/event-stream.js:20-31`). Governance therefore has to
 *     FINISH, and `final` has to be settled, BEFORE the terminal `yield` —
 *     anything deferred past it can never run, because nothing will resume us.
 *
 * (b) `result()` upstream is PASSIVE — it returns a promise and consumes
 *     nothing (`event-stream.js:60-62`), so a caller may await it and iterate
 *     afterwards and still see every event. Ours cannot be passive: nothing
 *     else pumps governance for a `result()`-only consumer. It drains, and
 *     therefore it REPLAYS what that drain captured to any iterator that
 *     arrives later, rather than silently eating the stream.
 */

import type {
	Authorization,
	AuthorizeParams,
	EnvelopeStatus,
	Governor,
	SettleParams,
	TrustReceipt,
} from "usertrust";
import { withCostCenter } from "usertrust";
import { deriveAttribution } from "./attribution.js";
import {
	envelopeDescriptorsFrom,
	estimationMessages,
	formatScarcityBlock,
	injectScarcityBlock,
} from "./scarcity-block.js";
import type { AccumulatedUsage } from "./token-extractor.js";
import { createAccumulator } from "./token-extractor.js";
import type {
	AssistantMessage,
	AssistantMessageEventStreamLike,
	Context,
	DoneEvent,
	ErrorEvent,
	FrozenCostCenters,
	Model,
	StreamEvent,
	StreamFn,
	StreamOptions,
	Usage,
} from "./types.js";

/**
 * Per-wrapper governance options. Both wrappers take the same bag, so a
 * capability added for one is never quietly missing from the other.
 */
export interface GovernanceOptions {
	/**
	 * The operator's validated, deep-frozen cost-center config
	 * (`normalizeCostCenters`). Absent → no attribution is derived at all and
	 * both wrappers behave exactly as they did before envelopes existed.
	 *
	 * SECURITY: this is the ONLY source of cost-center strings. Nothing derived
	 * from a message, a tool name, or any other request content ever reaches
	 * `withCostCenter`.
	 */
	costCenters?: FrozenCostCenters | undefined;

	/**
	 * Fires with the `TrustReceipt` after a successful `settle()` — the wrapper
	 * used to discard it. Fire-and-forget (see `fireOnReceipt`): a synchronous
	 * throw and a returned rejection are both isolated, and the callback never
	 * delays stream termination — `result()`/the settle path have already moved
	 * on by the time it runs.
	 */
	onReceipt?: ((receipt: TrustReceipt) => void | Promise<void>) | undefined;
}

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
export function wrapStreamWithGovernance(
	streamFn: StreamFn,
	governor: Governor,
	opts?: GovernanceOptions,
): StreamFn {
	return (
		model: Model,
		context: Context,
		options?: StreamOptions,
	): AssistantMessageEventStreamLike => {
		// The governed run is a single-consumer async generator, and `result()`
		// has to resolve from that SAME run — so the inner stream's final message
		// is handed over through a deferred the generator settles.
		const final = createDeferred<AssistantMessage>();
		const events = governedStream(streamFn, governor, model, context, options, final, opts);

		// Exactly one of the two entry points may drive `events`, and WHICH one
		// claimed it decides how the other is served.
		let claimed = false;
		// Set only when `result()` claimed it — i.e. a hidden drain owns the
		// generator and a later iterator has to be served from the replay log.
		let drain: Promise<void> | undefined;
		const replayed: StreamEvent[] = [];
		let replayEnded = false;
		let replayFailure: { error: unknown } | undefined;
		// Swapped-and-resolved on every append so a replaying iterator can wait
		// for the next event without polling.
		let nextTick = createDeferred<void>();

		function announce(): void {
			const tick = nextTick;
			nextTick = createDeferred<void>();
			tick.resolve();
		}

		/**
		 * Serve an iterator that arrived after `result()` claimed the generator.
		 * Upstream `result()` consumes nothing, so this consumer is entitled to
		 * the whole stream — including a mid-stream throw, which the drain
		 * recorded rather than swallowed.
		 */
		async function* replay(): AsyncGenerator<StreamEvent> {
			let i = 0;
			for (;;) {
				const event = replayed[i];
				if (event !== undefined) {
					i++;
					yield event;
					continue;
				}
				if (replayEnded) {
					if (replayFailure !== undefined) throw replayFailure.error;
					return;
				}
				await nextTick.promise;
			}
		}

		return {
			[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
				if (!claimed) {
					claimed = true;
					return events[Symbol.asyncIterator]();
				}
				// A `result()`-driven drain owns the generator — replay into it.
				if (drain !== undefined) return replay()[Symbol.asyncIterator]();
				// A SECOND iterator on a stream already being iterated. An async
				// generator returns itself, so this picks up where the first left
				// off, exactly as it always has.
				return events[Symbol.asyncIterator]();
			},
			async result(): Promise<AssistantMessage> {
				// A `result()`-only consumer never iterates, so drain the governed
				// stream here — otherwise neither governance nor `final` ever runs.
				if (!claimed) {
					claimed = true;
					drain = (async () => {
						try {
							for await (const event of events) {
								replayed.push(event);
								announce();
							}
						} catch (err) {
							replayFailure = { error: err };
							throw err;
						} finally {
							replayEnded = true;
							announce();
						}
					})();
					// A consumer may never await the drain (it can iterate the replay
					// instead), so pre-mark the rejection leg handled.
					drain.catch(() => {});
				}
				if (drain !== undefined) {
					try {
						await drain;
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
	opts: GovernanceOptions | undefined,
): AsyncGenerator<StreamEvent> {
	// 1. Attribute, pre-flight, authorize, inject scarcity (see `authorizeGoverned`).
	// A denial — from the pre-flight or from the policy gate — is a terminal
	// path like any other: `final` must be settled here, or a consumer that
	// iterates AND awaits `result()` sees the iteration reject while `result()`
	// hangs forever. There is no hold to abort yet, so this needs its own try
	// rather than the streaming one below.
	let auth: Authorization;
	// The scarcity block (when injected) is delivered on `Context.systemPrompt`
	// — a COPY, never the caller's own object — so every downstream use of
	// `context` in this generator reads `forwardedContext`, not the parameter.
	let forwardedContext: Context;
	try {
		const authorized = await authorizeGoverned(governor, model, context, options, opts);
		auth = authorized.auth;
		forwardedContext = authorized.context;
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

	try {
		const stream = await streamFn(model, forwardedContext, options);
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

			if (event.type !== "done" && event.type !== "error") {
				yield event;
				continue;
			}

			// 3. TERMINAL EVENT. Governance runs, and `final` is settled, BEFORE
			// the yield — see (a) in the file header. The pinned host awaits
			// `result()` while it is suspended handling this very event, so a
			// settle deferred until after the yield would wait for a resumption
			// that can never come, and the agent turn would hang forever.
			//
			// Finalising here also makes "the terminal event the loop OBSERVED
			// decides the action" STRUCTURAL rather than a flag consulted from the
			// `finally`: by the time the consumer can break, it is already decided.
			const failed = await finalizeTerminal(
				governor,
				auth,
				event,
				accumulator.result(),
				providerResult,
				final,
				opts,
			);
			terminated = true;
			// The consumer still sees the event — a settle failure is ours, not a
			// reason to hide the provider's own terminal event from the caller.
			yield event;
			if (failed !== undefined) throw failed.error;
			return;
		}

		// 4. The stream closed with NO terminal event at all. Settle at the
		// ESTIMATE, then TERMINATE `result()` explicitly.
		//
		// It must not adopt `providerResult` here: the pinned `EventStream.end()`
		// resolves its final-result promise only when handed an explicit result
		// (`event-stream.js:33-43`), and a stream that reaches this branch was
		// ended without one. Adopting it would mark `final` settled while it hangs
		// forever — invisible to the `!final.settled` guard below, and a hard hang
		// at the host's post-loop `await response.result()`
		// (`proxy-BzhBz8iM.js:411`).
		const receipt = await governor.settle(auth, settleParamsFor(accumulator.result()));
		terminated = true;
		fireOnReceipt(opts, receipt);
		final.reject(new Error("usertrust: provider stream closed without a terminal event"));
	} catch (err) {
		// 5. Abort — VOID the hold (catch abort errors to preserve original).
		// Guarded by `terminated` because a settle that failed on the terminal
		// event above rethrows THROUGH here after already voiding the hold; a
		// second abort would be a second ledger action for one authorization.
		if (!terminated) {
			await governor.abort(auth, err).catch(() => {});
			terminated = true;
			final.reject(err);
		}
		throw err;
	} finally {
		// 6. Abandonment — the consumer walked away, unwinding the generator at a
		// `yield` without reaching any branch above. Reachable ONLY before a
		// terminal event was seen (one would have flipped `terminated` before its
		// own yield), so this is always the no-terminal-event case: a clean early
		// termination, not a failure, and it SETTLES the partial rather than
		// voiding (AGENTS.md, "The settle/void asymmetry is deliberate") — at the
		// ESTIMATE, because usage only ever arrives on a terminal event.
		if (!terminated) {
			await settleAbandoned(governor, auth, accumulator.result(), opts);
		}
		// `result()` must never be left pending. The abandonment path has no final
		// assistant message to hand back, so it rejects.
		if (!final.settled) {
			final.reject(new Error("usertrust: stream abandoned before completion"));
		}
	}
}

/**
 * Take the single terminal ledger action for a `done` / `error` event and
 * settle `final` with what the pinned stream class would have reported.
 *
 * NEVER THROWS — it runs before a `yield`, and its caller decides whether the
 * generator rethrows. Returns the error to rethrow (a failed settle), or
 * `undefined` when the run ends cleanly.
 *
 * Two things here are pinned host behaviour, not choices:
 *
 *  - **`reason: "aborted"` SETTLES, it does not void.** That event is the
 *    CALLER's `AbortSignal` firing, not a provider failure — every pinned
 *    provider derives it from `signal?.aborted` and attaches the usage it had
 *    accumulated so far (`pi-ai/dist/providers/anthropic.js:500-517`,
 *    `openclaw/dist/openai-transport-stream-B0WkSqXp.js:757-772`). Those tokens
 *    were really spent, so voiding them would let any consumer cancel its way
 *    out of paying for work the provider actually did. Only `reason: "error"`
 *    is a failure.
 *
 *  - **`result()` RESOLVES on an in-band error event, it does not reject.** The
 *    pinned `AssistantMessageEventStream`'s `extractResult` returns
 *    `event.error` for it (`event-stream.js:66-74`), and OpenClaw consumes that
 *    AssistantMessage as the terminal assistant turn, branching on
 *    `message.stopReason` afterwards (`proxy-BzhBz8iM.js:264`). Rejecting would
 *    convert an ordinary failed turn into a thrown agent-loop error. Rejection
 *    stays reserved for THROWN failures, where there is no message at all.
 */
async function finalizeTerminal(
	governor: Governor,
	auth: Authorization,
	event: DoneEvent | ErrorEvent,
	usage: AccumulatedUsage,
	providerResult: Promise<AssistantMessage>,
	final: Deferred<AssistantMessage>,
	opts: GovernanceOptions | undefined,
): Promise<{ error: unknown } | undefined> {
	if (event.type === "error" && event.reason === "error") {
		const err = new Error(
			`usertrust: provider stream ended with error: ${event.error.errorMessage ?? event.reason}`,
		);
		await governor.abort(auth, err).catch(() => {});
		final.resolve(event.error);
		return undefined;
	}

	try {
		const receipt = await governor.settle(auth, settleParamsFor(usage));
		fireOnReceipt(opts, receipt);
		// `done` reports the PROVIDER's own `result()` — a stream wrapper may have
		// post-processed the message, and by the pinned push-before-deliver
		// ordering it is already resolved by the time we see the event. An abort
		// has no such promise to wait on (the provider `end()`s without one), so
		// it reports the partial message the event itself carried.
		final.resolve(event.type === "done" ? providerResult : event.error);
		return undefined;
	} catch (err) {
		await governor.abort(auth, err).catch(() => {});
		final.reject(err);
		return { error: err };
	}
}

/** What {@link authorizeGoverned} hands back: the hold, and the context every
 * downstream use (the streamFn/completeFn call) must read instead of the
 * caller's original — the scarcity block, when injected, lives on its copy. */
interface GovernedAuthorization {
	auth: Authorization;
	context: Context;
}

/**
 * The single place a governed call is attributed, pre-flighted, scarcity-
 * injected and authorized. Both wrappers go through it, so the streaming and
 * completion paths can never drift into gating, attributing, or injecting the
 * same call differently.
 *
 * ALS DISCIPLINE. `withCostCenter` wraps `governor.authorize()` and NOTHING
 * else. Its scope has already exited by the time the caller's `await` resolves,
 * which is the point: `settle()`/`abort()` run later, from a `finally` or an
 * entirely different task, and they read the governor's own authorize-time
 * capture rather than an AsyncLocalStorage store that is long gone. Nothing in
 * this package ever calls `getCurrentCostCenter()`.
 */
async function authorizeGoverned(
	governor: Governor,
	model: Model,
	context: Context,
	options: StreamOptions | undefined,
	opts: GovernanceOptions | undefined,
): Promise<GovernedAuthorization> {
	const costCenters = opts?.costCenters;
	// Stateless and per-call: derived from this call's own context every time,
	// so nothing survives a previous call to go stale on a later one.
	const active =
		costCenters !== undefined ? deriveAttribution(context.messages, costCenters) : undefined;

	// Pre-flight budget check — the SESSION wallet's gate. In dry-run mode (no
	// TigerBeetle) the engine cannot enforce a balance, so we explicitly refuse
	// calls when budget_remaining ≤ 0. This matches the behaviour users expect
	// from a "budget" config: hit zero, get cut off.
	//
	// SKIPPED for an ATTRIBUTED call. The session wallet is not the wallet that
	// pays it, so denying here would make an operator's independently funded
	// envelope unreachable the moment the session ran dry — a budget the
	// operator allocated and can never spend. `authorize()` gates the envelope
	// the hold will actually debit, atomically, which is the real enforcement.
	if (active === undefined && governor.budgetRemaining() <= 0) {
		throw new Error(
			`usertrust: budget exhausted (${governor.budgetRemaining()} remaining); call denied`,
		);
	}

	// Scarcity injection (A8: reporting only — never gates, delays, or throws
	// into the money path; see `readScarcityBlock`). `costCenters === undefined`
	// means the operator never configured envelopes, so there is nothing to
	// read — same as before this feature existed, byte-identical behavior.
	const block = costCenters !== undefined ? await readScarcityBlock(governor, costCenters) : null;
	const forwardedContext = injectScarcityBlock(context, block);

	const params: AuthorizeParams = {
		model: model.id,
		// Estimation honesty (contract-notes §4): `authorize()` only ever sees
		// this array, never `Context.systemPrompt` — so the FULL effective
		// system prompt (pre-existing + the scarcity block just injected above)
		// has to be represented here, or the pre-call hold under-covers what
		// the stream call is about to actually send.
		messages: estimationMessages(forwardedContext),
		...(options?.maxTokens != null ? { maxOutputTokens: options.maxTokens } : {}),
		params: {
			...(options?.temperature != null ? { temperature: options.temperature } : {}),
		},
	};

	const auth =
		active === undefined || costCenters === undefined
			? await governor.authorize(params)
			: // `envelopes[active]` is the metadata half (D4): without it the governor
				// knows WHICH envelope to debit but not how large it is, and the policy
				// tier fields come back `undefined`. `deriveAttribution` only ever
				// returns a validated `envelopes` key, so this lookup always hits.
				await withCostCenter(
					active,
					() => governor.authorize(params),
					costCenters.envelopes[active],
				);

	return { auth, context: forwardedContext };
}

/**
 * Read + format the per-turn scarcity block. REPORTING ONLY (A8): every
 * failure leg — `scarcityContext: false` (skips the read entirely), an
 * empty/failed `budgetContext` read, or a throw from the formatter itself —
 * degrades to `null` rather than gating, delaying, or throwing into the money
 * path. The two try/catches are separate (rather than one wrapping both calls)
 * so each failure mode stays independently observable and testable: a read
 * failure and a formatter failure are different bugs in different code.
 */
async function readScarcityBlock(
	governor: Governor,
	costCenters: FrozenCostCenters,
): Promise<string | null> {
	if (!costCenters.scarcityContext) return null;

	let statuses: EnvelopeStatus[];
	try {
		statuses = await governor.budgetContext(envelopeDescriptorsFrom(costCenters));
	} catch {
		return null;
	}

	try {
		return formatScarcityBlock(statuses);
	} catch {
		return null;
	}
}

/**
 * Fire `opts.onReceipt` fire-and-forget. Neither a synchronous throw nor a
 * returned rejection may propagate into the governed stream — the settle that
 * produced `receipt` already committed — and the callback must never delay
 * stream termination, so this is never awaited.
 */
function fireOnReceipt(opts: GovernanceOptions | undefined, receipt: TrustReceipt): void {
	const cb = opts?.onReceipt;
	if (cb === undefined) return;
	try {
		void Promise.resolve(cb(receipt)).catch(() => {
			// Returned rejection — isolated, same as the synchronous throw below.
		});
	} catch {
		// Synchronous throw from the callback itself — isolated.
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
			? {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					// Cache tiers (spec D2/D4): pass through unchanged — the pinned
					// pi-ai adapters that reach openclaw are already disjoint, so no
					// second subtraction happens here. Omitted (not zeroed) when the
					// accumulator never saw them, so core's D1 fallback (absent ⇒
					// inputPer1k, never free) is what prices them, not a fabricated 0.
					...(usage.cacheReadTokens != null ? { cacheReadTokens: usage.cacheReadTokens } : {}),
					...(usage.cacheWriteTokens != null ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
				}
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
	opts: GovernanceOptions | undefined,
): Promise<void> {
	try {
		const receipt = await governor.settle(auth, settleParamsFor(usage));
		fireOnReceipt(opts, receipt);
	} catch (err) {
		// The hold would otherwise dangle PENDING until destroy/timeout.
		await governor.abort(auth, err).catch(() => {});
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
	opts?: GovernanceOptions,
): (model: Model, context: Context, options?: StreamOptions) => Promise<T> {
	return async (model: Model, context: Context, options?: StreamOptions): Promise<T> => {
		// 1. Attribute, pre-flight, authorize, inject scarcity — the SAME
		// derivation the streaming path uses, from this call's own context.
		const { auth, context: forwardedContext } = await authorizeGoverned(
			governor,
			model,
			context,
			options,
			opts,
		);

		try {
			// 2. Execute
			const result = await completeFn(model, forwardedContext, options);

			// 3. Settle with actual usage if available
			const receipt = await governor.settle(auth, {
				...(result.usage != null
					? {
							inputTokens: result.usage.input,
							outputTokens: result.usage.output,
							// Cache tiers (spec D2/D4): pass through unchanged, same as the
							// streaming settle path — the pinned pi-ai adapters deliver
							// disjoint counters, so no subtraction happens at this boundary
							// either. Guarded (not a bare property read) for the same
							// older-runtime reason as `normalizeHostUsage`: a `Usage` from a
							// pi-ai below the >=0.12.0 peer floor may lack these keys at
							// runtime despite the pinned type saying they are required, and
							// an absent tier must stay OMITTED (D1: absent ⇒ inputPer1k),
							// never coerced to a fabricated `0`.
							...(typeof result.usage.cacheRead === "number" &&
							Number.isFinite(result.usage.cacheRead)
								? { cacheReadTokens: result.usage.cacheRead }
								: {}),
							...(typeof result.usage.cacheWrite === "number" &&
							Number.isFinite(result.usage.cacheWrite)
								? { cacheWriteTokens: result.usage.cacheWrite }
								: {}),
							usageSource: "provider" as const,
						}
					: { usageSource: "estimated" as const }),
			});
			fireOnReceipt(opts, receipt);

			return result;
		} catch (err) {
			// 4. Abort (catch abort errors to preserve original)
			await governor.abort(auth, err).catch(() => {});
			throw err;
		}
	};
}
