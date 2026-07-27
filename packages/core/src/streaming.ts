// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * streaming.ts — Streaming Token Accumulator + TrustedStream Factory
 *
 * Per-provider token accumulation for streaming LLM calls. The SDK taps
 * the stream via an async generator that counts tokens without modifying
 * the yielded data.
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

import type { LLMClientKind, TrustReceipt } from "./shared/types.js";

// ── Public types ──

export interface StreamUsage {
	inputTokens: number;
	outputTokens: number;
}

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

/** Anthropic chunks carry incremental fields on distinct chunk types. */
function extractAnthropicTokens(chunk: unknown): StreamUsage {
	if (chunk == null || typeof chunk !== "object") {
		return { inputTokens: 0, outputTokens: 0 };
	}

	const c = chunk as Record<string, unknown>;

	if (c.type === "message_start" && c.message != null && typeof c.message === "object") {
		const msg = c.message as Record<string, unknown>;
		if (msg.usage != null && typeof msg.usage === "object") {
			const usage = msg.usage as Record<string, number>;
			return { inputTokens: usage.input_tokens ?? 0, outputTokens: 0 };
		}
	}
	if (c.type === "message_delta") {
		if (c.usage != null && typeof c.usage === "object") {
			const usage = c.usage as Record<string, number>;
			return { inputTokens: 0, outputTokens: usage.output_tokens ?? 0 };
		}
	}
	return { inputTokens: 0, outputTokens: 0 };
}

/** A7 sanitation: non-finite or negative provider counts are clamped to 0. */
function sanitizeCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Extract an ABSOLUTE usage snapshot from an OpenAI/Google chunk, or null when
 * the chunk carries no usage object at all. A present-but-empty usage object IS
 * a snapshot (explicit zeros count as reported usage — A11).
 */
function extractUsageSnapshot(chunk: unknown, kind: "openai" | "google"): StreamUsage | null {
	if (chunk == null || typeof chunk !== "object") return null;
	const c = chunk as Record<string, unknown>;

	if (kind === "openai") {
		// Task 3 (A6/A7): OpenAI Responses API. Usage rides ONLY on the terminal
		// `response.completed` event, nested as `event.response.usage.{input_tokens,
		// output_tokens}`. This shape is structurally disjoint from a chat.completions
		// chunk (which carries a TOP-LEVEL `usage` with prompt_tokens/completion_tokens
		// and never `type: "response.completed"`), so the two field maps stay separate
		// and never collide. A terminal event WITHOUT usage (some local runtimes omit
		// it) yields null → settles at ESTIMATE (A7), never a false zero-cost snapshot.
		if (c.type === "response.completed") {
			const resp = c.response;
			if (resp != null && typeof resp === "object") {
				const usage = (resp as Record<string, unknown>).usage;
				if (usage != null && typeof usage === "object") {
					const u = usage as Record<string, unknown>;
					return {
						inputTokens: sanitizeCount(u.input_tokens),
						outputTokens: sanitizeCount(u.output_tokens),
					};
				}
			}
			return null;
		}
		// chat.completions absolute snapshot (prompt_tokens/completion_tokens).
		if (c.usage != null && typeof c.usage === "object") {
			const usage = c.usage as Record<string, unknown>;
			return {
				inputTokens: sanitizeCount(usage.prompt_tokens),
				outputTokens: sanitizeCount(usage.completion_tokens),
			};
		}
		return null;
	}

	// google
	if (c.usageMetadata != null && typeof c.usageMetadata === "object") {
		const meta = c.usageMetadata as Record<string, unknown>;
		return {
			inputTokens: sanitizeCount(meta.promptTokenCount),
			outputTokens: sanitizeCount(meta.candidatesTokenCount),
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
	let chunksDelivered = 0;
	let usageReported = false;

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
				const snapshot = extractUsageSnapshot(chunk, kind);
				if (snapshot != null) {
					deltaInput = Math.max(0, snapshot.inputTokens - inputTokens);
					deltaOutput = Math.max(0, snapshot.outputTokens - outputTokens);
					inputTokens = snapshot.inputTokens;
					outputTokens = snapshot.outputTokens;
					usageReported = true;
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
		onError(err, { usage: { inputTokens, outputTokens }, chunksDelivered, usageReported });
		throw err;
	} finally {
		// Normal completion AND early termination (consumer break → generator
		// `.return()`) both settle here. A thrown error already ran `onError` and set
		// `errored`, so it is the only path that skips settlement (it voids instead).
		if (!errored) {
			onComplete({ usage: { inputTokens, outputTokens }, chunksDelivered, usageReported });
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
