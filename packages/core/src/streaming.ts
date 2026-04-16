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
 *   - Anthropic: message_start (input_tokens), message_delta (output_tokens)
 *   - OpenAI: usage field on final chunk (prompt_tokens, completion_tokens)
 *   - Google: usageMetadata field (promptTokenCount, candidatesTokenCount)
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

function extractTokensFromChunk(chunk: unknown, kind: LLMClientKind): StreamUsage {
	if (chunk == null || typeof chunk !== "object") {
		return { inputTokens: 0, outputTokens: 0 };
	}

	const c = chunk as Record<string, unknown>;

	if (kind === "anthropic") {
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

	if (kind === "openai") {
		if (c.usage != null && typeof c.usage === "object") {
			const usage = c.usage as Record<string, number>;
			return {
				inputTokens: usage.prompt_tokens ?? 0,
				outputTokens: usage.completion_tokens ?? 0,
			};
		}
		return { inputTokens: 0, outputTokens: 0 };
	}

	// google
	if (c.usageMetadata != null && typeof c.usageMetadata === "object") {
		const meta = c.usageMetadata as Record<string, number>;
		return {
			inputTokens: meta.promptTokenCount ?? 0,
			outputTokens: meta.candidatesTokenCount ?? 0,
		};
	}

	return { inputTokens: 0, outputTokens: 0 };
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

	try {
		for await (const chunk of stream) {
			const tokens = extractTokensFromChunk(chunk, kind);
			let deltaInput = 0;
			let deltaOutput = 0;
			// Use latest non-zero value (providers report cumulative or final)
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
		onComplete({ usage: { inputTokens, outputTokens }, chunksDelivered, usageReported });
	} catch (err) {
		onError(err, { usage: { inputTokens, outputTokens }, chunksDelivered, usageReported });
		throw err;
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
