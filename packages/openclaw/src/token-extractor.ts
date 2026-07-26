// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * token-extractor.ts — Stream Token Extraction
 *
 * Extracts token usage from pi-ai's normalized stream events AND from
 * raw provider chunk shapes (Anthropic, OpenAI, Gemini) via duck-typing.
 *
 * pi-ai reports usage on `done` / `error` events. Raw provider chunks
 * scatter usage across multiple shapes — we duck-type each one.
 */

import type { StreamEvent, StreamUsage } from "./types.js";

/** Accumulated usage from a pi-ai stream. */
export interface AccumulatedUsage {
	inputTokens: number;
	outputTokens: number;
	chunksDelivered: number;
	usageReported: boolean;
	/**
	 * Generation wall time in ms, from an Ollama-native final chunk's
	 * eval_duration. Omitted (never `undefined`-valued) when the stream
	 * carried no native duration.
	 */
	computeMs?: number | undefined;
}

/** Max tokens to accept from a provider (prevents Infinity/overflow in cost math). */
const MAX_TOKENS = 2_000_000;

/** Max computeMs to accept — 24h; guards absurd/hostile eval_duration values (plan A8). */
const MAX_COMPUTE_MS = 86_400_000;

function clampTokens(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.min(Math.max(0, Math.trunc(n)), MAX_TOKENS);
}

/**
 * Duck-type chunks from raw provider streams. We support:
 *
 *   Anthropic:
 *     { type: "message_start", message: { usage: { input_tokens, output_tokens } } }
 *     { type: "message_delta", usage: { output_tokens } }
 *     { type: "content_block_delta", delta: { text } }
 *
 *   OpenAI:
 *     { choices: [{ delta: { content } }], usage: { prompt_tokens, completion_tokens } }
 *
 *   Gemini:
 *     { candidates: [{ content: { parts: [...] } }], usageMetadata: { promptTokenCount, candidatesTokenCount } }
 *
 *   Ollama native (/api/chat, /api/generate final chunk):
 *     { done: true, prompt_eval_count, eval_count, eval_duration }
 *
 * Returns null if the chunk is not a recognized usage-bearing shape.
 */
export function extractUsageFromProviderChunk(chunk: unknown): StreamUsage | null {
	if (chunk == null || typeof chunk !== "object") return null;
	const c = chunk as Record<string, unknown>;

	// ── Anthropic message_start ──
	if (c.type === "message_start" && typeof c.message === "object" && c.message != null) {
		const msg = c.message as Record<string, unknown>;
		const usage = msg.usage as Record<string, unknown> | undefined;
		if (usage != null) {
			const input = readNum(usage.input_tokens);
			const output = readNum(usage.output_tokens);
			if (input != null || output != null) {
				return {
					inputTokens: clampTokens(input ?? 0),
					outputTokens: clampTokens(output ?? 0),
					...(typeof usage.cache_read_input_tokens === "number"
						? { cacheReadTokens: clampTokens(usage.cache_read_input_tokens) }
						: {}),
					...(typeof usage.cache_creation_input_tokens === "number"
						? { cacheWriteTokens: clampTokens(usage.cache_creation_input_tokens) }
						: {}),
				};
			}
		}
	}

	// ── Anthropic message_delta (final usage) ──
	if (c.type === "message_delta" && typeof c.usage === "object" && c.usage != null) {
		const usage = c.usage as Record<string, unknown>;
		const output = readNum(usage.output_tokens);
		const input = readNum(usage.input_tokens);
		if (output != null || input != null) {
			return {
				inputTokens: clampTokens(input ?? 0),
				outputTokens: clampTokens(output ?? 0),
			};
		}
	}

	// ── OpenAI usage (final chunk on stream_options.include_usage=true) ──
	if (typeof c.usage === "object" && c.usage != null && Array.isArray(c.choices)) {
		const usage = c.usage as Record<string, unknown>;
		const prompt = readNum(usage.prompt_tokens);
		const completion = readNum(usage.completion_tokens);
		if (prompt != null || completion != null) {
			return {
				inputTokens: clampTokens(prompt ?? 0),
				outputTokens: clampTokens(completion ?? 0),
			};
		}
	}

	// ── Gemini usageMetadata ──
	if (typeof c.usageMetadata === "object" && c.usageMetadata != null) {
		const meta = c.usageMetadata as Record<string, unknown>;
		const prompt = readNum(meta.promptTokenCount);
		const candidates = readNum(meta.candidatesTokenCount);
		if (prompt != null || candidates != null) {
			return {
				inputTokens: clampTokens(prompt ?? 0),
				outputTokens: clampTokens(candidates ?? 0),
				...(typeof meta.cachedContentTokenCount === "number"
					? { cacheReadTokens: clampTokens(meta.cachedContentTokenCount) }
					: {}),
			};
		}
	}

	// ── Ollama native final chunk (done: true + eval counts) ──
	const ollama = extractOllamaUsage(c);
	if (ollama != null) return ollama;

	return null;
}

/**
 * Ollama-native final chunk (/api/chat, /api/generate): `done === true` with
 * numeric prompt_eval_count / eval_count token counts. OpenAI chunks carry
 * neither field (they report prompt_tokens/completion_tokens under `usage`),
 * so OpenAI-compat streams cannot misfire into this family.
 */
function extractOllamaUsage(chunk: unknown): StreamUsage | null {
	if (chunk == null || typeof chunk !== "object") return null;
	const c = chunk as Record<string, unknown>;
	if (c.done !== true) return null;
	const input = readNum(c.prompt_eval_count);
	const output = readNum(c.eval_count);
	if (input == null && output == null) return null;
	return {
		inputTokens: clampTokens(input ?? 0),
		outputTokens: clampTokens(output ?? 0),
	};
}

/**
 * Extract generation compute time (ms) from an Ollama-native final chunk.
 *
 * Ollama reports `eval_duration` in NANOSECONDS on the `done: true` chunk.
 * Converted to whole milliseconds and clamped to [0, 86_400_000] (24h) to
 * guard absurd or hostile values (plan A8).
 *
 * `prompt_eval_duration` is explicitly IGNORED in M2 (plan A8): computeMs
 * meters generation (eval) wall time only; prompt-processing time is a
 * future enrichment once its KV-cache interaction semantics are pinned.
 *
 * Returns undefined for non-final chunks, non-Ollama shapes, or
 * missing/non-finite durations.
 */
export function extractComputeMs(chunk: unknown): number | undefined {
	if (chunk == null || typeof chunk !== "object") return undefined;
	const c = chunk as Record<string, unknown>;
	if (c.done !== true) return undefined;
	const ns = Number(c.eval_duration);
	if (!Number.isFinite(ns)) return undefined;
	const ms = Math.round(ns / 1e6);
	return Math.min(Math.max(0, ms), MAX_COMPUTE_MS);
}

/**
 * Estimate output tokens from a streaming chunk's text delta.
 * Used as a fallback when usage isn't reported. ~4 chars per token.
 *
 * Duck-types each provider's text delta shape:
 *   Anthropic: chunk.delta.text                    (content_block_delta)
 *   OpenAI:    chunk.choices[0].delta.content
 *   Gemini:    chunk.candidates[0].content.parts[0].text
 *   Ollama:    chunk.message.content  (native /api/chat, non-final only)
 *   pi-ai:     chunk.text  (text_delta event)
 */
export function extractTextDeltaLength(chunk: unknown): number {
	if (chunk == null || typeof chunk !== "object") return 0;
	const c = chunk as Record<string, unknown>;

	// pi-ai text_delta
	if (c.type === "text_delta" && typeof c.text === "string") {
		return c.text.length;
	}

	// Anthropic content_block_delta
	if (c.type === "content_block_delta" && typeof c.delta === "object" && c.delta != null) {
		const delta = c.delta as Record<string, unknown>;
		if (typeof delta.text === "string") return delta.text.length;
	}

	// OpenAI choices[].delta.content
	if (Array.isArray(c.choices) && c.choices.length > 0) {
		const first = c.choices[0] as Record<string, unknown> | undefined;
		const delta = first?.delta as Record<string, unknown> | undefined;
		if (typeof delta?.content === "string") return delta.content.length;
	}

	// Gemini candidates[].content.parts[].text
	if (Array.isArray(c.candidates) && c.candidates.length > 0) {
		const first = c.candidates[0] as Record<string, unknown> | undefined;
		const content = first?.content as Record<string, unknown> | undefined;
		const parts = content?.parts;
		if (Array.isArray(parts)) {
			let len = 0;
			for (const part of parts) {
				const p = part as Record<string, unknown> | undefined;
				if (typeof p?.text === "string") len += p.text.length;
			}
			return len;
		}
	}

	// Ollama native /api/chat delta: { message: { content }, done: false }.
	// Only NON-final chunks are deltas — the done chunk repeats an empty
	// content alongside the usage totals, so it must not count as text.
	// (Anthropic message_start also carries `message`, but its content is an
	// array, so the string check keeps it at 0 as before.)
	if (c.done !== true && typeof c.message === "object" && c.message != null) {
		const msg = c.message as Record<string, unknown>;
		if (typeof msg.content === "string") return msg.content.length;
	}

	return 0;
}

function readNum(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Extract token usage from a pi-ai stream event.
 * Returns non-zero usage only for `done` and `error` events.
 */
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
	let computeMs: number | undefined;

	return {
		update(event: StreamEvent): void {
			chunksDelivered++;

			// pi-ai events are the primary shape. Ollama-native chunks are the one
			// raw-provider family the accumulator also understands (OpenClaw can hand
			// /api/chat NDJSON through un-normalized); other raw provider shapes stay
			// with extractUsageFromProviderChunk consumers, so e.g. raw Anthropic
			// message_start/message_delta pairs can't half-replace each other here.
			const usage = extractUsageFromEvent(event) ?? extractOllamaUsage(event);
			if (usage != null) {
				inputTokens = usage.inputTokens;
				outputTokens = usage.outputTokens;
				usageReported = true;
			}

			const ms = extractComputeMs(event);
			if (ms != null) {
				computeMs = ms;
			}
		},

		result(): AccumulatedUsage {
			return {
				inputTokens,
				outputTokens,
				chunksDelivered,
				usageReported,
				// Omitted entirely when absent — never `computeMs: undefined` (plan A6).
				...(computeMs != null ? { computeMs } : {}),
			};
		},
	};
}
