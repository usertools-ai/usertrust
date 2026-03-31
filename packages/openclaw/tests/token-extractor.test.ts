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
});
