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
} from "./ledger/usage.js";
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
}

export interface GovernedStream<T> extends AsyncIterable<T> {
	/** Resolves with the trust receipt when the stream completes */
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
function extractAnthropicTokens(chunk: unknown): StreamUsage {
	if (chunk == null || typeof chunk !== "object") return NO_USAGE;

	const c = chunk as Record<string, unknown>;

	if (c.type === "message_start" && c.message != null && typeof c.message === "object") {
		const msg = c.message as Record<string, unknown>;
		if (msg.usage != null && typeof msg.usage === "object") {
			const usage = msg.usage as Record<string, unknown>;
			const normalized = fromAnthropicUsage(usage);
			return {
				inputTokens: sanitizeCount(usage.input_tokens),
				outputTokens: 0,
				cacheReadTokens: normalized.cacheReadTokens,
				cacheWriteTokens: normalized.cacheWriteTokens,
			};
		}
	}
	if (c.type === "message_delta") {
		if (c.usage != null && typeof c.usage === "object") {
			const usage = c.usage as Record<string, unknown>;
			const normalized = fromAnthropicUsage(usage);
			return {
				inputTokens: 0,
				outputTokens: sanitizeCount(usage.output_tokens),
				cacheReadTokens: normalized.cacheReadTokens,
				cacheWriteTokens: normalized.cacheWriteTokens,
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
 */
export interface ChunkObservation {
	chunk: unknown;
	deltaTokens: number;
	cumulativeInputTokens: number;
	cumulativeOutputTokens: number;
}

export type ChunkHook = (obs: ChunkObservation) => void;

/**
 * Wraps a provider stream with token counting.
 * Yields all chunks unchanged. Calls onComplete with accumulated usage
 * when the stream ends, or onError on failure. An optional `onChunk` hook
 * fires per chunk and can throw to abort the stream (used by the anomaly
 * detector to trip a circuit breaker mid-stream).
 */
export function wrapStream<T>(
	stream: AsyncIterable<T>,
	kind: LLMClientKind,
	onComplete: (completion: StreamCompletion) => void,
	onError: (error: unknown, partial: StreamCompletion) => void,
	onChunk?: ChunkHook,
): AsyncIterable<T> {
	return wrapStreamImpl(stream, kind, onComplete, onError, onChunk);
}

async function* wrapStreamImpl<T>(
	stream: AsyncIterable<T>,
	kind: LLMClientKind,
	onComplete: (completion: StreamCompletion) => void,
	onError: (error: unknown, partial: StreamCompletion) => void,
	onChunk?: ChunkHook,
): AsyncGenerator<T> {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let chunksDelivered = 0;
	let usageReported = false;
	const snapshot = (): StreamUsage => ({
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
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
			if (kind === "openai" || kind === "google") {
				// M2 REPLACE-WITH-LATEST (design decision 5.2 / plan Task 2): each
				// usage-bearing chunk is an absolute snapshot, assigned wholesale.
				// Fixes double-counting under vLLM continuous_usage_stats (running
				// totals on every chunk); a decreasing final total takes the last
				// chunk's values (A7); explicit zeros count as reported usage (A11).
				const latest = extractUsageSnapshot(chunk, kind);
				if (latest != null) {
					deltaInput = Math.max(0, latest.inputTokens - inputTokens);
					deltaOutput = Math.max(0, latest.outputTokens - outputTokens);
					inputTokens = latest.inputTokens;
					outputTokens = latest.outputTokens;
					// The cache tiers are part of the same absolute snapshot: replace,
					// never sum, or vLLM-style running totals multiply-count them too.
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
				// accumulate for the partial/void audit and for the cost when the
				// headline counters do arrive.
				if (tokens.cacheReadTokens > cacheReadTokens) cacheReadTokens = tokens.cacheReadTokens;
				if (tokens.cacheWriteTokens > cacheWriteTokens) cacheWriteTokens = tokens.cacheWriteTokens;
			}

			// Run hook BEFORE yielding so a throw aborts before the consumer sees it.
			if (onChunk != null) {
				onChunk({
					chunk,
					deltaTokens: deltaInput + deltaOutput,
					cumulativeInputTokens: inputTokens,
					cumulativeOutputTokens: outputTokens,
				});
			}

			yield chunk;
			chunksDelivered++;
		}
	} catch (err) {
		errored = true;
		onError(err, { usage: snapshot(), chunksDelivered, usageReported });
		throw err;
	} finally {
		// Normal completion AND early termination (consumer break → generator
		// `.return()`) both settle here. A thrown error already ran `onError` and set
		// `errored`, so it is the only path that skips settlement (it voids instead).
		if (!errored) {
			onComplete({ usage: snapshot(), chunksDelivered, usageReported });
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
export function createGovernedStream<T>(
	stream: AsyncIterable<T>,
	kind: LLMClientKind,
	resolveReceipt: (completion: StreamCompletion) => Promise<TrustReceipt>,
	rejectReceipt: (error: unknown, partial: StreamCompletion) => void,
	onChunk?: ChunkHook,
): GovernedStream<T> {
	let receiptResolve!: (receipt: TrustReceipt) => void;
	let receiptReject!: (error: unknown) => void;

	const receiptPromise = new Promise<TrustReceipt>((resolve, reject) => {
		receiptResolve = resolve;
		receiptReject = reject;
	});

	const wrapped = wrapStream(
		stream,
		kind,
		(completion) => {
			resolveReceipt(completion)
				.then((receipt) => {
					receiptResolve(receipt);
				})
				.catch((err: unknown) => {
					receiptReject(err);
				});
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
