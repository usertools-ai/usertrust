// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	createAccumulator,
	extractTextDeltaLength,
	extractUsageFromEvent,
	extractUsageFromProviderChunk,
} from "../src/token-extractor.js";
import { doneEvent, errorEvent, makeUsage, textDelta } from "./host-fixtures.js";

describe("extractUsageFromProviderChunk — clamping and cache tokens", () => {
	it("clamps non-finite, negative, and over-max token counts", () => {
		expect(
			extractUsageFromProviderChunk({
				type: "message_start",
				message: { usage: { input_tokens: Number.POSITIVE_INFINITY, output_tokens: 10 } },
			}),
		).toEqual({ inputTokens: 0, outputTokens: 10 });

		expect(
			extractUsageFromProviderChunk({
				type: "message_start",
				message: { usage: { input_tokens: -100, output_tokens: 5 } },
			}),
		).toEqual({ inputTokens: 0, outputTokens: 5 });

		const overMax = extractUsageFromProviderChunk({
			type: "message_start",
			message: { usage: { input_tokens: 5_000_000, output_tokens: 1 } },
		});
		expect(overMax?.inputTokens).toBe(2_000_000);
	});

	it("carries Anthropic cache read/write tokens when present", () => {
		expect(
			extractUsageFromProviderChunk({
				type: "message_start",
				message: {
					usage: {
						input_tokens: 100,
						output_tokens: 0,
						cache_read_input_tokens: 40,
						cache_creation_input_tokens: 20,
					},
				},
			}),
		).toEqual({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 40, cacheWriteTokens: 20 });
	});

	it("returns null for a message_start whose usage has no numeric token fields", () => {
		expect(
			extractUsageFromProviderChunk({ type: "message_start", message: { usage: {} } }),
		).toBeNull();
	});
});

describe("extractUsageFromProviderChunk — message_delta / OpenAI / Gemini", () => {
	it("reads Anthropic message_delta output+input usage", () => {
		expect(
			extractUsageFromProviderChunk({
				type: "message_delta",
				usage: { output_tokens: 42, input_tokens: 7 },
			}),
		).toEqual({ inputTokens: 7, outputTokens: 42 });
	});

	it("reads OpenAI usage with only prompt_tokens present", () => {
		expect(extractUsageFromProviderChunk({ choices: [], usage: { prompt_tokens: 30 } })).toEqual({
			inputTokens: 30,
			outputTokens: 0,
		});
	});

	it("reads Gemini usageMetadata with cached content tokens", () => {
		expect(
			extractUsageFromProviderChunk({
				usageMetadata: {
					promptTokenCount: 12,
					candidatesTokenCount: 8,
					cachedContentTokenCount: 3,
				},
			}),
		).toEqual({ inputTokens: 12, outputTokens: 8, cacheReadTokens: 3 });
	});

	it("returns null for unrecognized shapes", () => {
		expect(extractUsageFromProviderChunk(null)).toBeNull();
		expect(extractUsageFromProviderChunk(42)).toBeNull();
		expect(extractUsageFromProviderChunk({ foo: "bar" })).toBeNull();
	});
});

describe("extractTextDeltaLength — provider shapes", () => {
	it("host text_delta carries the text on `delta`", () => {
		expect(extractTextDeltaLength({ type: "text_delta", contentIndex: 0, delta: "hello" })).toBe(5);
	});

	it("Anthropic content_block_delta", () => {
		expect(extractTextDeltaLength({ type: "content_block_delta", delta: { text: "abcd" } })).toBe(
			4,
		);
	});

	it("OpenAI choices[].delta.content", () => {
		expect(extractTextDeltaLength({ choices: [{ delta: { content: "xyz" } }] })).toBe(3);
	});

	it("Gemini parts sums text and skips non-text parts", () => {
		expect(
			extractTextDeltaLength({
				candidates: [{ content: { parts: [{ text: "ab" }, { inlineData: {} }, { text: "cde" }] } }],
			}),
		).toBe(5);
	});

	it("returns 0 for unrecognized or empty shapes", () => {
		expect(extractTextDeltaLength(null)).toBe(0);
		expect(extractTextDeltaLength({ type: "text_start" })).toBe(0);
		expect(extractTextDeltaLength({ choices: [] })).toBe(0);
	});
});

describe("extractUsageFromEvent + createAccumulator", () => {
	it("extracts usage from an error event", () => {
		expect(extractUsageFromEvent(errorEvent(makeUsage(3, 4)))).toMatchObject({
			inputTokens: 3,
			outputTokens: 4,
		});
	});

	it("returns null for a non-terminal event", () => {
		expect(extractUsageFromEvent(textDelta("hi"))).toBeNull();
	});

	it("accumulator records usage only from terminal events and counts chunks", () => {
		const acc = createAccumulator();
		acc.update(textDelta("hi"));
		acc.update(doneEvent(makeUsage(11, 22)));
		expect(acc.result()).toEqual({
			inputTokens: 11,
			outputTokens: 22,
			chunksDelivered: 2,
			usageReported: true,
		});
	});
});
