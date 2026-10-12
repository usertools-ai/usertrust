// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * streaming.ts — Streaming Token Accumulator + TrustedStream Factory
 *
 * Per-provider token accumulation for streaming LLM calls. The SDK taps
 * the stream via an async generator that counts tokens without modifying
 * the yielded data.
 *
 * Spec D2/D4: the accumulator carries FOUR disjoint tiers (fresh input, output,
 * cache read, cache write), not two. Which fields to read and whether the
 * prompt count is inclusive of the cache tiers is decided in exactly one place
 * — `ledger/usage.ts` — so this file never re-derives the extraction math and
 * the terminal Responses path here shares its extractor with the non-stream
 * Responses path in govern.ts.
 *
 * Provider-specific extraction:
 *   - Anthropic: message_start (input_tokens), message_delta (output_tokens) —
 *     incremental fields on distinct chunk types, accumulated as before.
 *   - OpenAI chat.completions: usage field (prompt_tokens, completion_tokens) —
 *     REPLACE-WITH-LATEST: every usage-bearing chunk is an absolute snapshot.
 *     vLLM's continuous_usage_stats stamps RUNNING totals on every chunk, so
 *     summing would multiply-count (M2 design decision 5.2 / plan Task 2).
 *   - OpenAI Responses (Task 3, A6/A7): usage arrives ONLY on the terminal
 *     `response.completed` event, nested at `event.response.usage.{input_tokens,
 *     output_tokens}` — a SEPARATE field map from chat.completions, keyed on the
 *     structurally disjoint Responses event shape (no top-level `usage`, no
 *     `include_usage` opt-in). A terminal event lacking usage settles at ESTIMATE.
 *   - Google: usageMetadata field (promptTokenCount, candidatesTokenCount) —
 *     same replace-with-latest snapshot semantics.
 *
 * Usage:
 * ```ts
 * const governed = createGovernedStream(stream, "anthropic", resolveReceipt, rejectReceipt);
 * for await (const chunk of governed) { process(chunk); }
 * const receipt = await governed.receipt;
 * ```
 */

import {
	fromAnthropicUsage,
	fromGeminiUsage,
	fromOpenAICompletionsUsage,
	fromOpenAIResponsesUsage,
	MAX_PLAUSIBLE_TOKENS_PER_TIER,
	type UsageTier,
} from "./ledger/usage.js";
import { AuditDegradedError } from "./shared/errors.js";
import type { LLMClientKind, TrustReceipt } from "./shared/types.js";

// ── Public types ──

/**
 * Accumulated stream usage — the four DISJOINT tiers of spec D2.
 *
 * `inputTokens` is FRESH prompt tokens only. For providers whose prompt count
 * is inclusive of the cache tiers (OpenAI, Gemini) the cached tokens have
 * already been subtracted back out by the extractors in `ledger/usage.ts`; for
 * Anthropic, whose SDK counters are disjoint at the source, nothing is
 * subtracted. Either way, summing the four fields gives the billable total and
 * nothing is counted twice.
 */
export interface StreamUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** The 1-hour SUBSET of `cacheWriteTokens` (Anthropic only). Absent means 0. */
	cacheWrite1hTokens?: number | undefined;
}

/** The zero snapshot — a stream that reported nothing. */
const NO_USAGE: StreamUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
};

export interface StreamCompletion {
	usage: StreamUsage;
	chunksDelivered: number;
	usageReported: boolean;
	/**
	 * Tiers whose reported count exceeded the plausibility ceiling in ANY chunk (the larger figure per tier). Sticky: an
	 * absurd count in a later chunk is not undone by a plausible earlier one, so the settle charges the estimate and
	 * records the anomaly rather than billing zeroed counts under a provider label.
	 */
	implausible?: Partial<Record<UsageTier, number>> | undefined;
}

export interface GovernedStream<T> extends AsyncIterable<T> {
	/**
	 * Resolves with the settled trust receipt when the stream completes, or when the
	 * consumer stops early (the consumed usage settles). Rejects, with the same error the
	 * iteration threw, when the stream fails mid-way and its iteration THROWS: the hold is
	 * then voided, not charged. A provider event the SDK yields as a chunk instead of
	 * throwing (an OpenAI Responses `error` event) ends the stream like any other, and it
	 * settles and is charged. Also rejects when settlement itself is refused after it ran
	 * (`AuditDegradedError`, under `audit.failClosed`): the charge posted, or its POST
	 * failed and may still post, so the work may be billed. The governor then throws that
	 * error from the iteration too (`surfaceAuditRefusal`), on a normal end or a `break`;
	 * when the caller's own loop body throws, for-await keeps that throw and drops the
	 * refusal. Any OTHER settlement error rejects only `.receipt`. Never an unhandled
	 * rejection.
	 */
	receipt: Promise<TrustReceipt>;
}

// ── Token extraction ──

/**
 * Anthropic chunks carry incremental fields on distinct chunk types.
 *
 * The cache tiers ride on whichever chunk carries a usage object (message_start
 * in practice, but message_delta repeats the cumulative counters on newer SDKs),
 * so they are read from BOTH and accumulated by the same keep-the-larger rule as
 * input/output. `fromAnthropicUsage` supplies them — including the nested
 * `cache_creation.{ephemeral_5m,1h}_input_tokens` breakdown — so the D2 row is
 * implemented in exactly one place.
 */
/**
 * A raw count above the plausibility ceiling is not usage: it is reported (sticky, to the settle) and contributes ZERO to
 * the running counters and their deltas, so the anomaly detector never observes a figure the settle refuses to price.
 */
function boundedCount(
	raw: unknown,
	tier: UsageTier,
	found: Partial<Record<UsageTier, number>>,
): number {
	const n = sanitizeCount(raw);
	if (n > MAX_PLAUSIBLE_TOKENS_PER_TIER) {
		found[tier] = n;
		return 0;
	}
	return n;
}

function extractAnthropicTokens(chunk: unknown): StreamUsage & {
	implausible?: Partial<Record<UsageTier, number>> | undefined;
} {
	if (chunk == null || typeof chunk !== "object") return NO_USAGE;

	const c = chunk as Record<string, unknown>;

	if (c.type === "message_start" && c.message != null && typeof c.message === "object") {
		const msg = c.message as Record<string, unknown>;
		if (msg.usage != null && typeof msg.usage === "object") {
			const usage = msg.usage as Record<string, unknown>;
			const normalized = fromAnthropicUsage(usage);
			const found: Partial<Record<UsageTier, number>> = { ...normalized.implausible };
			const inputTokens = boundedCount(usage.input_tokens, "inputTokens", found);
			return {
				inputTokens,
				outputTokens: 0,
				cacheReadTokens: normalized.cacheReadTokens,
				cacheWriteTokens: normalized.cacheWriteTokens,
				cacheWrite1hTokens: normalized.cacheWrite1hTokens ?? 0,
				implausible: Object.keys(found).length > 0 ? found : undefined,
			};
		}
	}
	if (c.type === "message_delta") {
		if (c.usage != null && typeof c.usage === "object") {
			const usage = c.usage as Record<string, unknown>;
			const normalized = fromAnthropicUsage(usage);
			const found: Partial<Record<UsageTier, number>> = { ...normalized.implausible };
			const outputTokens = boundedCount(usage.output_tokens, "outputTokens", found);
			return {
				inputTokens: 0,
				outputTokens,
				cacheReadTokens: normalized.cacheReadTokens,
				cacheWriteTokens: normalized.cacheWriteTokens,
				cacheWrite1hTokens: normalized.cacheWrite1hTokens ?? 0,
				implausible: Object.keys(found).length > 0 ? found : undefined,
			};
		}
	}
	return NO_USAGE;
}

/** A7 sanitation: non-finite or negative provider counts are clamped to 0. */
function sanitizeCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * A snapshot plus its D5 provenance: `reported` is true only when the payload
 * carried a USABLE input AND output count. An explicit `0` is usable (A11 —
 * a provider that produced nothing reports zero, and that is data); an absent,
 * NaN, Infinity or negative counter is not, so the clamped zero it becomes is
 * FABRICATED and must not be published as provider-sourced.
 */
interface SnapshotWithProvenance extends StreamUsage {
	reported: boolean;
	implausible?: Partial<Record<UsageTier, number>> | undefined;
}

/**
 * Extract an ABSOLUTE usage snapshot from an OpenAI/Google chunk, or null when
 * the chunk carries no usage object at all.
 *
 * A present-but-unusable usage object still yields a snapshot (the counts clamp
 * to 0 — A7 sanitation) but with `reported: false`, so the settle falls back to
 * the estimate instead of billing a garbage terminal at the 1-usertoken floor
 * under a "provider" label.
 */
function extractUsageSnapshot(
	chunk: unknown,
	kind: "openai" | "google",
): SnapshotWithProvenance | null {
	if (chunk == null || typeof chunk !== "object") return null;
	const c = chunk as Record<string, unknown>;

	if (kind === "openai") {
		// Task 3 (A6/A7): OpenAI Responses API. Usage rides on the TERMINAL event,
		// nested as `event.response.usage.{input_tokens,output_tokens}`. All three
		// terminal types carry it: `response.completed`, and — equally terminal —
		// `response.incomplete` (max_output_tokens / content filter) and
		// `response.failed`. This shape is structurally disjoint from a chat.completions
		// chunk (which carries a TOP-LEVEL `usage` with prompt_tokens/completion_tokens
		// and never a `response.*` type), so the two field maps stay separate and never
		// collide. A terminal event WITHOUT usage (an early failure, or a local runtime
		// that omits it) yields null → settles at ESTIMATE (A7), never a false zero-cost
		// snapshot.
		if (
			c.type === "response.completed" ||
			c.type === "response.incomplete" ||
			c.type === "response.failed"
		) {
			const resp = c.response;
			if (resp != null && typeof resp === "object") {
				const usage = (resp as Record<string, unknown>).usage;
				if (usage != null && typeof usage === "object") {
					// D2: `input_tokens` is INCLUSIVE of the tiers nested under
					// `input_tokens_details`; one extractor serves this terminal path and
					// the non-stream Responses path so the two can never drift.
					const n = fromOpenAIResponsesUsage(usage);
					return {
						inputTokens: n.inputTokens,
						outputTokens: n.outputTokens,
						cacheReadTokens: n.cacheReadTokens,
						cacheWriteTokens: n.cacheWriteTokens,
						reported: n.source === "provider",
						implausible: n.implausible,
					};
				}
			}
			return null;
		}
		// chat.completions absolute snapshot (prompt_tokens/completion_tokens).
		// D2: `prompt_tokens` is INCLUSIVE of `prompt_tokens_details.cached_tokens`.
		if (c.usage != null && typeof c.usage === "object") {
			const n = fromOpenAICompletionsUsage(c.usage);
			return {
				inputTokens: n.inputTokens,
				outputTokens: n.outputTokens,
				cacheReadTokens: n.cacheReadTokens,
				cacheWriteTokens: n.cacheWriteTokens,
				reported: n.source === "provider",
				implausible: n.implausible,
			};
		}
		return null;
	}

	// google — D2: `promptTokenCount` is INCLUSIVE of `cachedContentTokenCount`,
	// and `thoughtsTokenCount` bills as output without being inside
	// `candidatesTokenCount`.
	if (c.usageMetadata != null && typeof c.usageMetadata === "object") {
		const n = fromGeminiUsage(c.usageMetadata);
		return {
			inputTokens: n.inputTokens,
			outputTokens: n.outputTokens,
			cacheReadTokens: n.cacheReadTokens,
			cacheWriteTokens: n.cacheWriteTokens,
			reported: n.source === "provider",
			implausible: n.implausible,
		};
	}
	return null;
}

// ── Stream wrapper ──

/**
 * Per-chunk hook called after token extraction but before yielding the chunk
 * to the consumer. Throwing from this hook aborts the stream — onError will
 * fire with the thrown value (this is how the anomaly detector trips a
 * circuit breaker mid-stream).
 *
 * `delta` reflects the change in tokens compared to the previous chunk
 * (cumulative reporting is normalised to a delta here).
 *
 * Spec D7: `deltaTokens` and the cumulative counters carry all FOUR tiers —
 * once `inputTokens` means fresh-only, a cache-heavy chunk with near-zero
 * fresh input/output must still register as real traffic, not idle.
 */
export interface ChunkObservation {
	chunk: unknown;
	deltaTokens: number;
	cumulativeInputTokens: number;
	cumulativeOutputTokens: number;
	cumulativeCacheReadTokens: number;
	cumulativeCacheWriteTokens: number;
	/** The 1-hour subset of the write total; present only once some was reported. */
	cumulativeCacheWrite1hTokens?: number | undefined;
}

export type ChunkHook = (obs: ChunkObservation) => void;

/**
 * Wraps a provider stream with token counting.
 * Yields all chunks unchanged. Calls onComplete with accumulated usage
 * when the stream ends, or onError on failure. An optional `onChunk` hook
 * fires per chunk and can throw to abort the stream (used by the anomaly
 * detector to trip a circuit breaker mid-stream).
 *
 * When `onComplete` returns a promise, the iteration's last step (the final `next()`,
 * or the `return()` an early `break` drives) waits for it, and a rejection is thrown
 * from that step. When it returns nothing, the last step is not delayed.
 */
export function wrapStream<T>(
	stream: AsyncIterable<T>,
	kind: LLMClientKind,
	onComplete: (completion: StreamCompletion) => void | Promise<void>,
	onError: (error: unknown, partial: StreamCompletion) => void,
	onChunk?: ChunkHook,
): AsyncIterable<T> {
	return endsBeforeStart(
		wrapStreamImpl(stream, kind, onComplete, onError, onChunk),
		stream,
		onComplete,
		onError,
	);
}

/** What a stream that delivered nothing reports to its terminal (a fresh object each time). */
function nothingConsumed(): StreamCompletion {
	return { usage: { ...NO_USAGE }, chunksDelivered: 0, usageReported: false };
}

/**
 * Give a generator that is closed BEFORE its first `next()` the terminal it would have
 * had once started.
 *
 * An async generator in its start state never runs its body when `.return()` or
 * `.throw()` is called on it: it completes on the spot, so wrapStreamImpl's `finally`
 * (settle) and `catch` (void) never run, the hold is never ended, `.receipt` never
 * settles and the governor's in-flight stream count never drops. This patches the two
 * methods ON THE GENERATOR ITSELF (it stays a real async generator, and
 * `Symbol.asyncDispose`, which calls `this.return()`, goes through the patch) and, until
 * the first `next()`, runs the same terminal a started generator would:
 *   - `.return(v)` is the early `break` with nothing consumed: the provider stream is
 *     closed, then `onComplete` runs with zero usage, `usageReported: false` (so the hold
 *     settles at the ESTIMATE, the rule for any stream that reports no usage), and a
 *     settlement that `onComplete` returns is awaited, as wrapStreamImpl's `finally` does.
 *   - `.throw(e)` is what `.throw(e)` does to a started stream: the provider stream is
 *     closed, then `onError(e)` runs (the hold is VOIDED) and `e` is rethrown.
 * Once `next()` has been called the patched methods defer to the generator's own.
 */
function endsBeforeStart<T>(
	gen: AsyncGenerator<T>,
	source: AsyncIterable<T>,
	onComplete: (completion: StreamCompletion) => void | Promise<void>,
	onError: (error: unknown, partial: StreamCompletion) => void,
): AsyncGenerator<T> {
	let started = false;
	const ownNext = gen.next.bind(gen);
	const ownReturn = gen.return.bind(gen);
	const ownThrow = gen.throw.bind(gen);
	// Best effort, like the iterator close a `for await` break performs on the source.
	const closeSource = async (): Promise<void> => {
		try {
			await source[Symbol.asyncIterator]().return?.();
		} catch {
			// nothing to release, or the source refused: the terminal still runs
		}
	};
	gen.next = (...args: [] | [unknown]) => {
		started = true;
		return ownNext(...args);
	};
	gen.return = async (value: unknown) => {
		if (started) return ownReturn(value as never);
		started = true;
		await ownReturn(value as never); // complete the generator; its body never runs
		await closeSource();
		const settling = onComplete(nothingConsumed());
		if (settling !== undefined) await settling;
		return { done: true, value: value as never };
	};
	gen.throw = async (error: unknown) => {
		if (started) return ownThrow(error);
		started = true;
		await ownReturn(undefined as never);
		await closeSource();
		onError(error, nothingConsumed());
		throw error;
	};
	return gen;
}

async function* wrapStreamImpl<T>(
	stream: AsyncIterable<T>,
	kind: LLMClientKind,
	onComplete: (completion: StreamCompletion) => void | Promise<void>,
	onError: (error: unknown, partial: StreamCompletion) => void,
	onChunk?: ChunkHook,
): AsyncGenerator<T> {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let cacheWrite1hTokens = 0;
	let chunksDelivered = 0;
	let usageReported = false;
	let implausible: Partial<Record<UsageTier, number>> | undefined;
	const noteImplausible = (found: Partial<Record<UsageTier, number>> | undefined): void => {
		if (found === undefined) return;
		implausible = { ...implausible };
		for (const [tier, value] of Object.entries(found) as Array<[UsageTier, number]>) {
			implausible[tier] = Math.max(implausible[tier] ?? 0, value);
		}
	};
	const snapshot = (): StreamUsage => ({
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		// Absent when 0, so a stream with no 1-hour writes snapshots as it always did.
		...(cacheWrite1hTokens > 0 ? { cacheWrite1hTokens } : {}),
	});

	// P4-STREAM-LEAK: settlement runs in `finally` so that a consumer who breaks
	// out of the `for await` early (which drives generator `.return()`) settles the
	// consumed cost EXACTLY like a normal end-of-stream — the hold is released, the
	// audit event is written, and `.receipt` resolves. Only a thrown error voids.
	let errored = false;
	try {
		for await (const chunk of stream) {
			let deltaInput = 0;
			let deltaOutput = 0;
			let deltaCacheRead = 0;
			let deltaCacheWrite = 0;
			if (kind === "openai" || kind === "google") {
				// M2 REPLACE-WITH-LATEST (design decision 5.2 / plan Task 2): each
				// usage-bearing chunk is an absolute snapshot, assigned wholesale.
				// Fixes double-counting under vLLM continuous_usage_stats (running
				// totals on every chunk); a decreasing final total takes the last
				// chunk's values (A7); explicit zeros count as reported usage (A11).
				const latest = extractUsageSnapshot(chunk, kind);
				if (latest != null) {
					noteImplausible(latest.implausible);
					deltaInput = Math.max(0, latest.inputTokens - inputTokens);
					deltaOutput = Math.max(0, latest.outputTokens - outputTokens);
					inputTokens = latest.inputTokens;
					outputTokens = latest.outputTokens;
					// The cache tiers are part of the same absolute snapshot: replace,
					// never sum, or vLLM-style running totals multiply-count them too.
					// D7: still measure the DELTA (not just replace) so the anomaly
					// signal sees the cache traffic that arrived on this chunk.
					deltaCacheRead = Math.max(0, latest.cacheReadTokens - cacheReadTokens);
					deltaCacheWrite = Math.max(0, latest.cacheWriteTokens - cacheWriteTokens);
					cacheReadTokens = latest.cacheReadTokens;
					cacheWriteTokens = latest.cacheWriteTokens;
					// D5: only a payload that actually reported a usable input AND output
					// makes this call provider-sourced. Monotonic — a later garbage
					// snapshot never un-reports a good one.
					if (latest.reported) usageReported = true;
				}
			} else {
				// Anthropic: message_start carries input, message_delta carries output —
				// genuinely incremental chunk types; keep the latest non-zero value.
				const tokens = extractAnthropicTokens(chunk);
				noteImplausible(tokens.implausible);
				if (tokens.inputTokens > 0) {
					deltaInput = Math.max(0, tokens.inputTokens - inputTokens);
					inputTokens = tokens.inputTokens;
					usageReported = true;
				}
				if (tokens.outputTokens > 0) {
					deltaOutput = Math.max(0, tokens.outputTokens - outputTokens);
					outputTokens = tokens.outputTokens;
					usageReported = true;
				}
				// Cache tokens alone do NOT make usage "reported" (D5: provenance needs
				// input AND output) — but they are real billed tokens, so they still
				// accumulate for the partial/void audit, for the cost when the headline
				// counters do arrive, and (D7) for the anomaly signal's delta.
				if (tokens.cacheReadTokens > cacheReadTokens) {
					deltaCacheRead = tokens.cacheReadTokens - cacheReadTokens;
					cacheReadTokens = tokens.cacheReadTokens;
				}
				if (tokens.cacheWriteTokens > cacheWriteTokens) {
					deltaCacheWrite = tokens.cacheWriteTokens - cacheWriteTokens;
					cacheWriteTokens = tokens.cacheWriteTokens;
				}
				// The 1-hour share is a subset of the write total, so it only ever rises
				// with it (same keep-the-latest-larger rule as every other cache counter).
				if ((tokens.cacheWrite1hTokens ?? 0) > cacheWrite1hTokens) {
					cacheWrite1hTokens = tokens.cacheWrite1hTokens ?? 0;
				}
			}

			// Run hook BEFORE yielding so a throw aborts before the consumer sees it.
			if (onChunk != null) {
				onChunk({
					chunk,
					deltaTokens: deltaInput + deltaOutput + deltaCacheRead + deltaCacheWrite,
					cumulativeInputTokens: inputTokens,
					cumulativeOutputTokens: outputTokens,
					cumulativeCacheReadTokens: cacheReadTokens,
					cumulativeCacheWriteTokens: cacheWriteTokens,
					...(cacheWrite1hTokens > 0 ? { cumulativeCacheWrite1hTokens: cacheWrite1hTokens } : {}),
				});
			}

			yield chunk;
			chunksDelivered++;
		}
	} catch (err) {
		errored = true;
		onError(err, { usage: snapshot(), chunksDelivered, usageReported, implausible });
		throw err;
	} finally {
		// Normal completion AND early termination (consumer break → generator
		// `.return()`) both settle here. A thrown error already ran `onError` and set
		// `errored`, so it is the only path that skips settlement (it voids instead).
		//
		// A settlement that returns a promise is awaited, and a rejection of THAT promise is
		// thrown from here, so it ends the caller's iteration (createGovernedStream decides
		// which settlement errors reach it). `errored` stays false: nothing voids, because
		// a settlement that got this far may already have posted the charge.
		if (!errored) {
			const settling = onComplete({
				usage: snapshot(),
				chunksDelivered,
				usageReported,
				implausible,
			});
			if (settling !== undefined) await settling;
		}
	}
}

// ── GovernedStream factory ──

/**
 * Creates a GovernedStream: an AsyncIterable that also exposes a `.receipt`
 * promise resolving to the TrustReceipt after the stream completes.
 *
 * - `resolveReceipt` is called with final usage when the stream ends.
 *   It should POST the actual cost and return the receipt.
 * - `rejectReceipt` is called on stream error. It should VOID the hold.
 */
export interface GovernedStreamOptions {
	/**
	 * The audit refusal (`AuditDegradedError`) also ends the caller's ITERATION, not only
	 * `.receipt`. The last step (the final `next()`, or the `return()` an early `break`
	 * drives) waits for settlement; if settlement rejects with `AuditDegradedError`, that
	 * step throws it, the same error `.receipt` rejects with. ANY OTHER settlement error
	 * rejects `.receipt` only: the iteration still ends cleanly. When the caller's own
	 * loop body throws, for-await awaits `return()` but keeps the caller's throw and drops
	 * the refusal, which then reaches `.receipt` only. The governor sets this
	 * from `audit.failClosed`: there settlement can run (post the charge, or fail its
	 * POST ambiguously) and THEN refuse, and a caller who catches the iteration without
	 * awaiting `.receipt` must still hear of it. Off (the default), the last step is not
	 * delayed and settlement runs in the background.
	 */
	surfaceAuditRefusal?: boolean;
}

export function createGovernedStream<T>(
	stream: AsyncIterable<T>,
	kind: LLMClientKind,
	resolveReceipt: (completion: StreamCompletion) => Promise<TrustReceipt>,
	rejectReceipt: (error: unknown, partial: StreamCompletion) => void,
	onChunk?: ChunkHook,
	options: GovernedStreamOptions = {},
): GovernedStream<T> {
	let receiptResolve!: (receipt: TrustReceipt) => void;
	let receiptReject!: (error: unknown) => void;

	const receiptPromise = new Promise<TrustReceipt>((resolve, reject) => {
		receiptResolve = resolve;
		receiptReject = reject;
	});
	// A stream that fails mid-way (a cut connection, a provider error event) rejects
	// `.receipt` with the error its iteration throws. A caller that catches the iteration
	// need not await `.receipt` as well, so Node must never see this rejection unhandled:
	// that would end the caller's process (exit 1). This handler is a SEPARATE branch.
	// Promises are multicast, so a caller who awaits `.receipt` still gets the rejection,
	// as the same error object the iteration threw. The ledger outcome does not depend on
	// it: the hold is voided by the error terminal below either way.
	receiptPromise.catch(() => {});

	const wrapped = wrapStream(
		stream,
		kind,
		(completion) => {
			if (options.surfaceAuditRefusal === true) {
				// Returned, so wrapStream awaits it. Only the audit refusal is rethrown, and so
				// thrown from the iteration; any other settlement error rejects `.receipt`
				// (whose pre-attached catch keeps it handled) and the iteration ends cleanly.
				return resolveReceipt(completion).then(receiptResolve, (err: unknown) => {
					receiptReject(err);
					if (err instanceof AuditDegradedError) throw err;
				});
			}
			resolveReceipt(completion)
				.then((receipt) => {
					receiptResolve(receipt);
				})
				.catch((err: unknown) => {
					receiptReject(err);
				});
			return undefined;
		},
		(error, partial) => {
			rejectReceipt(error, partial);
			receiptReject(error);
		},
		onChunk,
	);

	return Object.assign(wrapped, {
		receipt: receiptPromise,
	}) as GovernedStream<T>;
}
