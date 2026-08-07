import { describe, expect, it } from "vitest";
import {
	createAccumulator,
	extractTextDeltaLength,
	extractUsageFromEvent,
	extractUsageFromProviderChunk,
} from "../src/token-extractor.js";
import type { ErrorEvent, StreamEvent } from "../src/types.js";
import {
	doneEvent,
	errorEvent,
	makeAssistantMessage,
	makeUsage,
	startEvent,
	textDelta,
} from "./host-fixtures.js";

describe("extractUsageFromEvent", () => {
	it("extracts usage from done event", () => {
		const usage = extractUsageFromEvent(doneEvent(makeUsage(100, 50)));
		expect(usage).toEqual({
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
	});

	it("extracts usage from error event", () => {
		const usage = extractUsageFromEvent(errorEvent(makeUsage(80, 30)));
		expect(usage).toEqual({
			inputTokens: 80,
			outputTokens: 30,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
	});

	it("returns null for a malformed error event carrying no assistant message", () => {
		const event = { type: "error", reason: "error" } as unknown as ErrorEvent;
		expect(extractUsageFromEvent(event)).toBeNull();
	});

	it("returns null for text delta events", () => {
		expect(extractUsageFromEvent(textDelta("hello"))).toBeNull();
	});

	it("returns null for start events", () => {
		expect(extractUsageFromEvent(startEvent())).toBeNull();
	});
});

describe("extractUsageFromEvent edge cases", () => {
	const partial = makeAssistantMessage();

	it("returns null for text_start events", () => {
		const event: StreamEvent = { type: "text_start", contentIndex: 0, partial };
		expect(extractUsageFromEvent(event)).toBeNull();
	});

	it("returns null for text_end events", () => {
		const event: StreamEvent = { type: "text_end", contentIndex: 0, content: "hi", partial };
		expect(extractUsageFromEvent(event)).toBeNull();
	});

	it("returns null for thinking_delta events", () => {
		const event: StreamEvent = {
			type: "thinking_delta",
			contentIndex: 0,
			delta: "reasoning...",
			partial,
		};
		expect(extractUsageFromEvent(event)).toBeNull();
	});

	it("returns null for toolcall_start events", () => {
		const event: StreamEvent = { type: "toolcall_start", contentIndex: 0, partial };
		expect(extractUsageFromEvent(event)).toBeNull();
	});

	it("returns null for toolcall_delta events", () => {
		const event: StreamEvent = {
			type: "toolcall_delta",
			contentIndex: 0,
			delta: '{"q":"test"}',
			partial,
		};
		expect(extractUsageFromEvent(event)).toBeNull();
	});

	it("returns null for toolcall_end events", () => {
		const event: StreamEvent = {
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: { type: "toolCall", id: "tc_1", name: "search", arguments: {} },
			partial,
		};
		expect(extractUsageFromEvent(event)).toBeNull();
	});

	it("clamps excessively large token counts", () => {
		const usage = extractUsageFromEvent(doneEvent(makeUsage(999_999_999, 999_999_999)));
		expect(usage).not.toBeNull();
		// MAX_TOKENS is 2_000_000, so these should be clamped
		expect(usage?.inputTokens).toBeLessThanOrEqual(2_000_000);
		expect(usage?.outputTokens).toBeLessThanOrEqual(2_000_000);
	});

	it("clamps negative token counts to zero", () => {
		const usage = extractUsageFromEvent(doneEvent(makeUsage(-100, -50)));
		expect(usage).not.toBeNull();
		expect(usage?.inputTokens).toBe(0);
		expect(usage?.outputTokens).toBe(0);
	});

	it("preserves cache token fields from done events", () => {
		const usage = extractUsageFromEvent(doneEvent(makeUsage(100, 50, 30, 10)));
		expect(usage).not.toBeNull();
		expect(usage?.cacheReadTokens).toBe(30);
		expect(usage?.cacheWriteTokens).toBe(10);
	});
});

describe("createAccumulator", () => {
	const partial = makeAssistantMessage();

	it("accumulates usage from a stream of events", () => {
		const acc = createAccumulator();

		acc.update(startEvent());
		acc.update({ type: "text_start", contentIndex: 0, partial });
		acc.update(textDelta("Hello"));
		acc.update(textDelta(" world"));
		acc.update({ type: "text_end", contentIndex: 0, content: "Hello world", partial });
		acc.update(doneEvent(makeUsage(120, 45)));

		const result = acc.result();
		expect(result.inputTokens).toBe(120);
		expect(result.outputTokens).toBe(45);
		expect(result.chunksDelivered).toBe(6);
		expect(result.usageReported).toBe(true);
	});

	it("reports usageReported = false when no done event", () => {
		const acc = createAccumulator();

		acc.update(startEvent());
		acc.update(textDelta("Hello"));

		const result = acc.result();
		expect(result.inputTokens).toBe(0);
		expect(result.outputTokens).toBe(0);
		expect(result.usageReported).toBe(false);
		expect(result.chunksDelivered).toBe(2);
	});

	it("handles cache token fields", () => {
		const acc = createAccumulator();

		acc.update(doneEvent(makeUsage(100, 50, 30, 10)));

		const result = acc.result();
		expect(result.inputTokens).toBe(100);
		expect(result.outputTokens).toBe(50);
		expect(result.usageReported).toBe(true);
	});

	it("returns zero usage for empty accumulator (no events)", () => {
		const acc = createAccumulator();
		const result = acc.result();

		expect(result.inputTokens).toBe(0);
		expect(result.outputTokens).toBe(0);
		expect(result.chunksDelivered).toBe(0);
		expect(result.usageReported).toBe(false);
	});

	it("handles a malformed error event with no assistant message", () => {
		const acc = createAccumulator();

		acc.update(startEvent());
		acc.update(textDelta("partial"));
		acc.update({ type: "error", reason: "error" } as unknown as ErrorEvent);

		const result = acc.result();
		expect(result.inputTokens).toBe(0);
		expect(result.outputTokens).toBe(0);
		expect(result.chunksDelivered).toBe(3);
		expect(result.usageReported).toBe(false);
	});

	it("handles error event with usage field", () => {
		const acc = createAccumulator();

		acc.update(startEvent());
		acc.update(errorEvent(makeUsage(60, 25)));

		const result = acc.result();
		expect(result.inputTokens).toBe(60);
		expect(result.outputTokens).toBe(25);
		expect(result.chunksDelivered).toBe(2);
		expect(result.usageReported).toBe(true);
	});
});

// ── Multi-provider duck-typed parsing ──

describe("extractUsageFromProviderChunk — Anthropic", () => {
	it("parses message_start with input/output tokens", () => {
		const chunk = {
			type: "message_start",
			message: {
				id: "msg_01",
				usage: { input_tokens: 120, output_tokens: 1 },
			},
		};
		const usage = extractUsageFromProviderChunk(chunk);
		expect(usage).not.toBeNull();
		expect(usage?.inputTokens).toBe(120);
		expect(usage?.outputTokens).toBe(1);
	});

	it("parses message_delta with final output tokens", () => {
		const chunk = {
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 87 },
		};
		const usage = extractUsageFromProviderChunk(chunk);
		expect(usage).not.toBeNull();
		expect(usage?.outputTokens).toBe(87);
	});

	it("preserves cache token fields on Anthropic message_start", () => {
		const chunk = {
			type: "message_start",
			message: {
				usage: {
					input_tokens: 50,
					output_tokens: 1,
					cache_read_input_tokens: 200,
					cache_creation_input_tokens: 30,
				},
			},
		};
		const usage = extractUsageFromProviderChunk(chunk);
		expect(usage?.cacheReadTokens).toBe(200);
		expect(usage?.cacheWriteTokens).toBe(30);
	});

	it("returns null for content_block_delta (no usage)", () => {
		const chunk = {
			type: "content_block_delta",
			delta: { type: "text_delta", text: "hello" },
		};
		expect(extractUsageFromProviderChunk(chunk)).toBeNull();
	});
});

describe("extractUsageFromProviderChunk — OpenAI", () => {
	it("parses final usage chunk on stream_options.include_usage", () => {
		const chunk = {
			id: "chatcmpl_01",
			choices: [],
			usage: {
				prompt_tokens: 200,
				completion_tokens: 87,
				total_tokens: 287,
			},
		};
		const usage = extractUsageFromProviderChunk(chunk);
		expect(usage).not.toBeNull();
		expect(usage?.inputTokens).toBe(200);
		expect(usage?.outputTokens).toBe(87);
	});

	it("returns null for normal delta chunks (no usage)", () => {
		const chunk = {
			id: "chatcmpl_01",
			choices: [{ index: 0, delta: { content: "hello" } }],
		};
		expect(extractUsageFromProviderChunk(chunk)).toBeNull();
	});
});

describe("extractUsageFromProviderChunk — Gemini", () => {
	it("parses usageMetadata block", () => {
		const chunk = {
			candidates: [{ content: { parts: [{ text: "hi" }] } }],
			usageMetadata: {
				promptTokenCount: 50,
				candidatesTokenCount: 12,
				totalTokenCount: 62,
			},
		};
		const usage = extractUsageFromProviderChunk(chunk);
		expect(usage).not.toBeNull();
		expect(usage?.inputTokens).toBe(50);
		expect(usage?.outputTokens).toBe(12);
	});

	it("captures cachedContentTokenCount as cache reads", () => {
		const chunk = {
			usageMetadata: {
				promptTokenCount: 100,
				candidatesTokenCount: 20,
				cachedContentTokenCount: 80,
			},
		};
		const usage = extractUsageFromProviderChunk(chunk);
		expect(usage?.cacheReadTokens).toBe(80);
	});
});

describe("extractUsageFromProviderChunk — malformed/edge", () => {
	it("returns null for null", () => {
		expect(extractUsageFromProviderChunk(null)).toBeNull();
	});

	it("returns null for undefined", () => {
		expect(extractUsageFromProviderChunk(undefined)).toBeNull();
	});

	it("returns null for primitive string", () => {
		expect(extractUsageFromProviderChunk("not a chunk")).toBeNull();
	});

	it("returns null for empty object", () => {
		expect(extractUsageFromProviderChunk({})).toBeNull();
	});

	it("returns null for unknown shape", () => {
		expect(extractUsageFromProviderChunk({ foo: "bar" })).toBeNull();
	});

	it("ignores Infinity / NaN tokens", () => {
		const chunk = {
			usageMetadata: {
				promptTokenCount: Number.POSITIVE_INFINITY,
				candidatesTokenCount: Number.NaN,
			},
		};
		// readNum filters non-finite, so usageMetadata yields no usable nums
		expect(extractUsageFromProviderChunk(chunk)).toBeNull();
	});
});

describe("extractTextDeltaLength", () => {
	it("returns 0 for null/undefined chunks", () => {
		expect(extractTextDeltaLength(null)).toBe(0);
		expect(extractTextDeltaLength(undefined)).toBe(0);
	});

	it("counts host text_delta length off `delta`", () => {
		expect(extractTextDeltaLength({ type: "text_delta", contentIndex: 0, delta: "hello" })).toBe(5);
	});

	it("counts Anthropic content_block_delta length", () => {
		const chunk = {
			type: "content_block_delta",
			delta: { type: "text_delta", text: "world!" },
		};
		expect(extractTextDeltaLength(chunk)).toBe(6);
	});

	it("counts OpenAI choices[0].delta.content length", () => {
		const chunk = {
			choices: [{ index: 0, delta: { content: "abcdef" } }],
		};
		expect(extractTextDeltaLength(chunk)).toBe(6);
	});

	it("counts Gemini candidates[0].content.parts[*].text length (sums parts)", () => {
		const chunk = {
			candidates: [
				{
					content: {
						parts: [{ text: "foo" }, { text: "bar" }],
					},
				},
			],
		};
		expect(extractTextDeltaLength(chunk)).toBe(6);
	});

	it("returns 0 for chunks with no text content", () => {
		expect(extractTextDeltaLength({ type: "start" })).toBe(0);
		expect(extractTextDeltaLength({ choices: [] })).toBe(0);
	});
});
