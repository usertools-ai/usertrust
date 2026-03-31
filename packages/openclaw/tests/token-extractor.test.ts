import { describe, expect, it } from "vitest";
import { createAccumulator, extractUsageFromEvent } from "../src/token-extractor.js";
import type { DoneEvent, ErrorEvent, StreamEvent, TextDeltaEvent } from "../src/types.js";

describe("extractUsageFromEvent", () => {
	it("extracts usage from done event", () => {
		const event: DoneEvent = {
			type: "done",
			stopReason: "stop",
			usage: { inputTokens: 100, outputTokens: 50 },
		};

		const usage = extractUsageFromEvent(event);
		expect(usage).toEqual({ inputTokens: 100, outputTokens: 50 });
	});

	it("extracts usage from error event with usage", () => {
		const event: ErrorEvent = {
			type: "error",
			error: new Error("test"),
			usage: { inputTokens: 80, outputTokens: 30 },
		};

		const usage = extractUsageFromEvent(event);
		expect(usage).toEqual({ inputTokens: 80, outputTokens: 30 });
	});

	it("returns null for error event without usage", () => {
		const event: ErrorEvent = {
			type: "error",
			error: new Error("test"),
		};

		expect(extractUsageFromEvent(event)).toBeNull();
	});

	it("returns null for text delta events", () => {
		const event: TextDeltaEvent = {
			type: "text_delta",
			text: "hello",
		};

		expect(extractUsageFromEvent(event)).toBeNull();
	});

	it("returns null for start events", () => {
		const event: StreamEvent = { type: "start" };
		expect(extractUsageFromEvent(event)).toBeNull();
	});
});

describe("extractUsageFromEvent edge cases", () => {
	it("returns null for text_start events", () => {
		const event: StreamEvent = { type: "text_start" };
		expect(extractUsageFromEvent(event)).toBeNull();
	});

	it("returns null for text_end events", () => {
		const event: StreamEvent = { type: "text_end" };
		expect(extractUsageFromEvent(event)).toBeNull();
	});

	it("returns null for thinking_delta events", () => {
		const event: StreamEvent = { type: "thinking_delta", text: "reasoning..." };
		expect(extractUsageFromEvent(event)).toBeNull();
	});

	it("returns null for toolcall_start events", () => {
		const event: StreamEvent = { type: "toolcall_start", name: "search", id: "tc_1" };
		expect(extractUsageFromEvent(event)).toBeNull();
	});

	it("returns null for toolcall_delta events", () => {
		const event: StreamEvent = { type: "toolcall_delta", args: '{"q":"test"}' };
		expect(extractUsageFromEvent(event)).toBeNull();
	});

	it("returns null for toolcall_end events", () => {
		const event: StreamEvent = { type: "toolcall_end" };
		expect(extractUsageFromEvent(event)).toBeNull();
	});

	it("clamps excessively large token counts", () => {
		const event: DoneEvent = {
			type: "done",
			stopReason: "stop",
			usage: { inputTokens: 999_999_999, outputTokens: 999_999_999 },
		};

		const usage = extractUsageFromEvent(event);
		expect(usage).not.toBeNull();
		// MAX_TOKENS is 2_000_000, so these should be clamped
		expect(usage?.inputTokens).toBeLessThanOrEqual(2_000_000);
		expect(usage?.outputTokens).toBeLessThanOrEqual(2_000_000);
	});

	it("clamps negative token counts to zero", () => {
		const event: DoneEvent = {
			type: "done",
			stopReason: "stop",
			usage: { inputTokens: -100, outputTokens: -50 },
		};

		const usage = extractUsageFromEvent(event);
		expect(usage).not.toBeNull();
		expect(usage?.inputTokens).toBe(0);
		expect(usage?.outputTokens).toBe(0);
	});

	it("preserves cache token fields from done events", () => {
		const event: DoneEvent = {
			type: "done",
			stopReason: "stop",
			usage: {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 30,
				cacheWriteTokens: 10,
			},
		};

		const usage = extractUsageFromEvent(event);
		expect(usage).not.toBeNull();
		expect(usage?.cacheReadTokens).toBe(30);
		expect(usage?.cacheWriteTokens).toBe(10);
	});
});

describe("createAccumulator", () => {
	it("accumulates usage from a stream of events", () => {
		const acc = createAccumulator();

		acc.update({ type: "start" });
		acc.update({ type: "text_start" });
		acc.update({ type: "text_delta", text: "Hello" });
		acc.update({ type: "text_delta", text: " world" });
		acc.update({ type: "text_end" });
		acc.update({
			type: "done",
			stopReason: "stop",
			usage: { inputTokens: 120, outputTokens: 45 },
		});

		const result = acc.result();
		expect(result.inputTokens).toBe(120);
		expect(result.outputTokens).toBe(45);
		expect(result.chunksDelivered).toBe(6);
		expect(result.usageReported).toBe(true);
	});

	it("reports usageReported = false when no done event", () => {
		const acc = createAccumulator();

		acc.update({ type: "start" });
		acc.update({ type: "text_delta", text: "Hello" });

		const result = acc.result();
		expect(result.inputTokens).toBe(0);
		expect(result.outputTokens).toBe(0);
		expect(result.usageReported).toBe(false);
		expect(result.chunksDelivered).toBe(2);
	});

	it("handles cache token fields", () => {
		const acc = createAccumulator();

		acc.update({
			type: "done",
			stopReason: "stop",
			usage: {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 30,
				cacheWriteTokens: 10,
			},
		});

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

	it("handles error event without usage field", () => {
		const acc = createAccumulator();

		acc.update({ type: "start" });
		acc.update({ type: "text_delta", text: "partial" });
		acc.update({ type: "error", error: new Error("stream broke") } as ErrorEvent);

		const result = acc.result();
		expect(result.inputTokens).toBe(0);
		expect(result.outputTokens).toBe(0);
		expect(result.chunksDelivered).toBe(3);
		expect(result.usageReported).toBe(false);
	});

	it("handles error event with usage field", () => {
		const acc = createAccumulator();

		acc.update({ type: "start" });
		acc.update({
			type: "error",
			error: new Error("partial failure"),
			usage: { inputTokens: 60, outputTokens: 25 },
		} as ErrorEvent);

		const result = acc.result();
		expect(result.inputTokens).toBe(60);
		expect(result.outputTokens).toBe(25);
		expect(result.chunksDelivered).toBe(2);
		expect(result.usageReported).toBe(true);
	});
});
