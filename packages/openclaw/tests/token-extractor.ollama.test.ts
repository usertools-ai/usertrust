// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * token-extractor.ollama.test.ts — M2 Ollama-native chunk family
 *
 * Ollama's native /api/chat and /api/generate NDJSON streams carry token
 * counts (prompt_eval_count / eval_count) and generation wall time
 * (eval_duration, NANOSECONDS) only on the final `done: true` chunk.
 * Non-final chunks carry the text delta at message.content.
 *
 * Plan A8: computeMs = round(eval_duration / 1e6), clamped to [0, 86_400_000];
 * prompt_eval_duration is explicitly ignored in M2.
 */

import type { Authorization, Governor } from "usertrust";
import { describe, expect, it, vi } from "vitest";
import { wrapStreamWithGovernance } from "../src/stream-governor.js";
import {
	createAccumulator,
	extractComputeMs,
	extractTextDeltaLength,
	extractUsageFromProviderChunk,
} from "../src/token-extractor.js";
import type { StreamContext, StreamEvent, StreamFn } from "../src/types.js";

/** A realistic Ollama /api/chat final chunk (values from a llama3.3 run). */
const ollamaFinalChunk = {
	model: "llama3.3:70b",
	created_at: "2026-07-26T12:00:00.000Z",
	message: { role: "assistant", content: "" },
	done_reason: "stop",
	done: true,
	total_duration: 5_100_000_000,
	load_duration: 1_334_875,
	prompt_eval_count: 26,
	prompt_eval_duration: 342_546_000,
	eval_count: 298,
	eval_duration: 4_709_213_000,
};

/** A non-final Ollama /api/chat delta chunk. */
const ollamaDeltaChunk = {
	model: "llama3.3:70b",
	created_at: "2026-07-26T12:00:00.000Z",
	message: { role: "assistant", content: "Hello" },
	done: false,
};

describe("extractUsageFromProviderChunk — Ollama native", () => {
	it("parses the final done chunk's prompt_eval_count/eval_count", () => {
		const usage = extractUsageFromProviderChunk(ollamaFinalChunk);
		expect(usage).not.toBeNull();
		expect(usage?.inputTokens).toBe(26);
		expect(usage?.outputTokens).toBe(298);
	});

	it("defaults a missing prompt_eval_count to 0 when eval_count is present", () => {
		const usage = extractUsageFromProviderChunk({ done: true, eval_count: 42 });
		expect(usage).toEqual({ inputTokens: 0, outputTokens: 42 });
	});

	it("clamps oversized counts to the existing 2M ceiling", () => {
		const usage = extractUsageFromProviderChunk({
			done: true,
			prompt_eval_count: 999_999_999,
			eval_count: 999_999_999,
		});
		expect(usage?.inputTokens).toBe(2_000_000);
		expect(usage?.outputTokens).toBe(2_000_000);
	});

	it("clamps negative counts to 0", () => {
		const usage = extractUsageFromProviderChunk({
			done: true,
			prompt_eval_count: -26,
			eval_count: -298,
		});
		expect(usage).toEqual({ inputTokens: 0, outputTokens: 0 });
	});

	it("returns null for a done chunk without eval counts", () => {
		expect(
			extractUsageFromProviderChunk({ done: true, message: { role: "assistant", content: "" } }),
		).toBeNull();
	});

	it("returns null for non-final (done: false) chunks", () => {
		expect(extractUsageFromProviderChunk(ollamaDeltaChunk)).toBeNull();
	});

	it("requires strict done === true (string 'true' is not the family)", () => {
		expect(
			extractUsageFromProviderChunk({ done: "true", prompt_eval_count: 26, eval_count: 298 }),
		).toBeNull();
	});

	// The plan-mandated discrimination test: OpenAI chunks lack
	// prompt_eval_count/eval_count and must never hit the Ollama branch.
	it("does not misfire on OpenAI delta chunks (no prompt_eval_count)", () => {
		const openAIDelta = {
			id: "chatcmpl_01",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
		};
		expect(extractUsageFromProviderChunk(openAIDelta)).toBeNull();
	});

	it("still parses OpenAI final usage chunks via the OpenAI branch", () => {
		const openAIUsageChunk = {
			id: "chatcmpl_01",
			choices: [],
			usage: { prompt_tokens: 200, completion_tokens: 87, total_tokens: 287 },
		};
		const usage = extractUsageFromProviderChunk(openAIUsageChunk);
		expect(usage).toEqual({ inputTokens: 200, outputTokens: 87 });
	});
});

describe("extractComputeMs — A8 duration guards", () => {
	it("converts eval_duration nanoseconds to rounded milliseconds", () => {
		expect(extractComputeMs(ollamaFinalChunk)).toBe(4709); // round(4709.213)
	});

	it("rounds half-up at the ms boundary", () => {
		expect(extractComputeMs({ done: true, eval_duration: 1_500_000 })).toBe(2);
	});

	it("returns undefined when eval_duration is absent", () => {
		expect(extractComputeMs({ done: true, eval_count: 298 })).toBeUndefined();
	});

	it("returns undefined for non-finite eval_duration", () => {
		expect(
			extractComputeMs({ done: true, eval_duration: Number.POSITIVE_INFINITY }),
		).toBeUndefined();
		expect(extractComputeMs({ done: true, eval_duration: Number.NaN })).toBeUndefined();
		expect(extractComputeMs({ done: true, eval_duration: "fast" })).toBeUndefined();
	});

	it("clamps negative durations to 0", () => {
		expect(extractComputeMs({ done: true, eval_duration: -5_000_000_000 })).toBe(0);
	});

	it("clamps absurd durations to 24h (86_400_000 ms)", () => {
		expect(extractComputeMs({ done: true, eval_duration: 1e18 })).toBe(86_400_000);
	});

	it("ignores prompt_eval_duration (M2 scope — plan A8)", () => {
		expect(
			extractComputeMs({ done: true, prompt_eval_duration: 342_546_000, eval_count: 26 }),
		).toBeUndefined();
	});

	it("returns undefined for non-final chunks even with a duration", () => {
		expect(extractComputeMs({ done: false, eval_duration: 4_709_213_000 })).toBeUndefined();
	});

	it("returns undefined for null / primitive / non-Ollama chunks", () => {
		expect(extractComputeMs(null)).toBeUndefined();
		expect(extractComputeMs(undefined)).toBeUndefined();
		expect(extractComputeMs("chunk")).toBeUndefined();
		expect(extractComputeMs({ choices: [] })).toBeUndefined();
	});
});

describe("extractTextDeltaLength — Ollama native", () => {
	it("counts message.content length on non-final chunks", () => {
		expect(extractTextDeltaLength(ollamaDeltaChunk)).toBe(5);
	});

	it("returns 0 for the final done chunk (its content is not a delta)", () => {
		expect(extractTextDeltaLength({ ...ollamaFinalChunk, message: { content: "xyz" } })).toBe(0);
	});

	it("returns 0 when message.content is not a string", () => {
		expect(extractTextDeltaLength({ done: false, message: { content: 42 } })).toBe(0);
		expect(extractTextDeltaLength({ done: false, message: {} })).toBe(0);
	});

	it("keeps Anthropic message_start (content array) at 0 — regression", () => {
		const chunk = {
			type: "message_start",
			message: { content: [], usage: { input_tokens: 10, output_tokens: 1 } },
		};
		expect(extractTextDeltaLength(chunk)).toBe(0);
	});
});

describe("createAccumulator — Ollama-native capture", () => {
	it("captures usage + computeMs from a raw Ollama stream", () => {
		const acc = createAccumulator();
		acc.update(ollamaDeltaChunk as unknown as StreamEvent);
		acc.update({
			...ollamaDeltaChunk,
			message: { role: "assistant", content: " world" },
		} as unknown as StreamEvent);
		acc.update(ollamaFinalChunk as unknown as StreamEvent);

		const result = acc.result();
		expect(result.inputTokens).toBe(26);
		expect(result.outputTokens).toBe(298);
		expect(result.usageReported).toBe(true);
		expect(result.chunksDelivered).toBe(3);
		expect(result.computeMs).toBe(4709);
	});

	it("omits computeMs entirely for pi-ai event streams (A6 discipline)", () => {
		const acc = createAccumulator();
		acc.update({ type: "text_delta", text: "hi" });
		acc.update({ type: "done", stopReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } });

		const result = acc.result();
		expect(result.usageReported).toBe(true);
		expect(result).not.toHaveProperty("computeMs");
	});

	it("does not misfire on raw OpenAI usage chunks (Ollama family only)", () => {
		const acc = createAccumulator();
		acc.update({
			id: "chatcmpl_01",
			choices: [],
			usage: { prompt_tokens: 200, completion_tokens: 87 },
		} as unknown as StreamEvent);

		const result = acc.result();
		expect(result.usageReported).toBe(false);
		expect(result).not.toHaveProperty("computeMs");
	});

	it("captures a done chunk that has counts but no eval_duration (usage without computeMs)", () => {
		const acc = createAccumulator();
		acc.update({ done: true, prompt_eval_count: 12, eval_count: 34 } as unknown as StreamEvent);

		const result = acc.result();
		expect(result.inputTokens).toBe(12);
		expect(result.outputTokens).toBe(34);
		expect(result.usageReported).toBe(true);
		expect(result).not.toHaveProperty("computeMs");
	});
});

// ── stream-governor computeMs forwarding ──

function fakeGovernor(): { governor: Governor; settle: ReturnType<typeof vi.fn> } {
	const auth: Authorization = {
		transferId: "t_test",
		estimatedCost: 1,
		model: "llama3.3:70b",
		createdAt: Date.now(),
	};
	const settle = vi.fn(async () => ({}) as never);
	const governor = {
		budgetRemaining: () => 1_000,
		authorize: vi.fn(async () => auth),
		settle,
		abort: vi.fn(async () => {}),
	} as unknown as Governor;
	return { governor, settle };
}

function streamOf(chunks: unknown[]): StreamFn {
	return (_model: string, _context: StreamContext, _options?: Record<string, unknown>) =>
		(async function* () {
			for (const chunk of chunks) {
				yield chunk as StreamEvent;
			}
		})();
}

const context: StreamContext = { messages: [{ role: "user", content: "hi" }], model: "m" };

describe("stream-governor — computeMs forwarding", () => {
	it("forwards accumulated computeMs into governor.settle()", async () => {
		const { governor, settle } = fakeGovernor();
		const governed = wrapStreamWithGovernance(
			streamOf([ollamaDeltaChunk, ollamaFinalChunk]),
			governor,
		);

		const events: StreamEvent[] = [];
		for await (const event of governed("llama3.3:70b", context)) {
			events.push(event);
		}

		expect(events).toHaveLength(2); // transparent middleware — chunks forwarded unchanged
		expect(settle).toHaveBeenCalledTimes(1);
		expect(settle.mock.calls[0]?.[1]).toEqual({
			inputTokens: 26,
			outputTokens: 298,
			chunksDelivered: 2,
			usageSource: "provider",
			computeMs: 4709,
		});
	});

	it("omits computeMs from settle params when the stream never carried one", async () => {
		const { governor, settle } = fakeGovernor();
		const governed = wrapStreamWithGovernance(
			streamOf([
				{ type: "text_delta", text: "hi" },
				{ type: "done", stopReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } },
			]),
			governor,
		);

		for await (const _event of governed("claude-sonnet-4-6", context)) {
			// drain
		}

		expect(settle).toHaveBeenCalledTimes(1);
		const params = settle.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(params).not.toHaveProperty("computeMs");
		expect(params).toMatchObject({ inputTokens: 10, outputTokens: 5, usageSource: "provider" });
	});
});
