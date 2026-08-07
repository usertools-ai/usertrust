// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * host-fixtures.ts — builders for the PINNED host shapes.
 *
 * Every openclaw test that fakes a stream builds its events here, so a
 * contract correction lands in one place instead of eight test files. The
 * shapes are pinned by `contract.test-d.ts`; these builders just fill them in.
 */

import type {
	AssistantMessage,
	AssistantMessageEventStreamLike,
	Context,
	Message,
	Model,
	StreamEvent,
	ToolResultMessage,
	Usage,
} from "../src/types.js";

export const TEST_MODEL_ID = "claude-sonnet-4-6";

export function makeModel(id: string = TEST_MODEL_ID): Model {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

export function makeUsage(input = 0, output = 0, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function makeAssistantMessage(usage: Usage = makeUsage()): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: TEST_MODEL_ID,
		usage,
		stopReason: "stop",
		timestamp: 0,
	};
}

export function makeContext(messages: Message[] = [userMessage("hi")]): Context {
	return { messages };
}

export function userMessage(text: string): Message {
	return { role: "user", content: text, timestamp: 0 };
}

export function toolResult(
	toolName: string,
	overrides: Partial<ToolResultMessage> = {},
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call_${toolName}`,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 0,
		...overrides,
	};
}

// ── events ──

export function startEvent(): StreamEvent {
	return { type: "start", partial: makeAssistantMessage() };
}

export function textDelta(delta: string, contentIndex = 0): StreamEvent {
	return { type: "text_delta", contentIndex, delta };
}

export function doneEvent(usage: Usage = makeUsage()): StreamEvent {
	return { type: "done", reason: "stop", message: makeAssistantMessage(usage) };
}

export function errorEvent(usage: Usage = makeUsage()): StreamEvent {
	return {
		type: "error",
		reason: "error",
		error: { ...makeAssistantMessage(usage), stopReason: "error", errorMessage: "boom" },
	};
}

// ── streams ──

/**
 * Wrap an async iterable of events in the pinned stream surface. `result()`
 * resolves with the terminal event's assistant message once the stream ends.
 */
export function asHostStream(
	events: AsyncIterable<StreamEvent>,
	final: AssistantMessage = makeAssistantMessage(),
): AssistantMessageEventStreamLike {
	return {
		[Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
		result: async () => final,
	};
}

/** A host stream fn that replays a fixed event list. */
export function streamOf(
	events: StreamEvent[],
): (model: Model, context: Context) => AssistantMessageEventStreamLike {
	return () =>
		asHostStream(
			(async function* () {
				for (const event of events) yield event;
			})(),
		);
}
