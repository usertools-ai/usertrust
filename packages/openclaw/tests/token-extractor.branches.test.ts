// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	extractTextDeltaLength,
	extractUsageFromEvent,
	extractUsageFromProviderChunk,
} from "../src/token-extractor.js";
import type { DoneEvent } from "../src/types.js";

describe("token-extractor — remaining branch edges", () => {
	it("clampTokens zeroes non-finite usage that bypasses readNum (event path)", () => {
		const done: DoneEvent = {
			type: "done",
			stopReason: "stop",
			usage: { inputTokens: Number.POSITIVE_INFINITY, outputTokens: Number.NaN },
		};
		expect(extractUsageFromEvent(done)).toMatchObject({ inputTokens: 0, outputTokens: 0 });
	});

	it("message_start with no usage object falls through to null", () => {
		expect(extractUsageFromProviderChunk({ type: "message_start", message: {} })).toBeNull();
	});

	it("message_start with only input_tokens defaults output to 0", () => {
		expect(
			extractUsageFromProviderChunk({
				type: "message_start",
				message: { usage: { input_tokens: 100 } },
			}),
		).toEqual({ inputTokens: 100, outputTokens: 0 });
	});

	it("message_delta with no numeric fields falls through to null", () => {
		expect(extractUsageFromProviderChunk({ type: "message_delta", usage: {} })).toBeNull();
	});

	it("message_delta with only input_tokens defaults output to 0", () => {
		expect(
			extractUsageFromProviderChunk({ type: "message_delta", usage: { input_tokens: 7 } }),
		).toEqual({ inputTokens: 7, outputTokens: 0 });
	});

	it("OpenAI usage with no numeric fields falls through to null", () => {
		expect(extractUsageFromProviderChunk({ choices: [], usage: {} })).toBeNull();
	});

	it("OpenAI usage with only completion_tokens defaults input to 0", () => {
		expect(extractUsageFromProviderChunk({ choices: [], usage: { completion_tokens: 9 } })).toEqual(
			{
				inputTokens: 0,
				outputTokens: 9,
			},
		);
	});

	it("Gemini usageMetadata with only candidatesTokenCount defaults input to 0", () => {
		expect(extractUsageFromProviderChunk({ usageMetadata: { candidatesTokenCount: 8 } })).toEqual({
			inputTokens: 0,
			outputTokens: 8,
		});
	});

	it("Gemini usageMetadata with only promptTokenCount defaults output to 0", () => {
		expect(extractUsageFromProviderChunk({ usageMetadata: { promptTokenCount: 12 } })).toEqual({
			inputTokens: 12,
			outputTokens: 0,
		});
	});

	it("extractTextDeltaLength: content_block_delta without a text field yields 0", () => {
		expect(extractTextDeltaLength({ type: "content_block_delta", delta: { foo: 1 } })).toBe(0);
	});

	it("extractTextDeltaLength: OpenAI choice delta without content yields 0", () => {
		expect(extractTextDeltaLength({ choices: [{ delta: { role: "assistant" } }] })).toBe(0);
	});

	it("extractTextDeltaLength: Gemini candidate without a parts array yields 0", () => {
		expect(extractTextDeltaLength({ candidates: [{ content: {} }] })).toBe(0);
	});
});
