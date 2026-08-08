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

/**
 * Guard against a promise that never settles. A hung `result()` is the whole
 * failure mode half these tests exist to catch, and it would otherwise surface
 * as an opaque suite-level timeout instead of a named assertion failure.
 */
export async function withTimeout<T>(promise: Promise<T>, ms = 500): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("promise never settled")), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

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

/**
 * The assistant turn that ISSUED `toolNames` — the message a trailing
 * tool-result run correlates back to. Ids follow `toolResult`'s `call_<name>`
 * convention, so a correlated pair is the default and every mismatch a test
 * wants has to be written out explicitly.
 */
export function assistantToolCalls(...toolNames: string[]): Message {
	return {
		...makeAssistantMessage(),
		content: toolNames.map((name) => ({
			type: "toolCall" as const,
			id: `call_${name}`,
			name,
			arguments: {},
		})),
		stopReason: "toolUse",
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

/**
 * The OTHER terminal `error` event: `reason: "aborted"`.
 *
 * This is what the pinned providers emit when the CALLER's `AbortSignal` fires —
 * not a provider failure. Evidence, verbatim from the pinned tarballs:
 *
 *   pi-ai `dist/providers/anthropic.js:515-517`
 *     output.stopReason = options?.signal?.aborted ? "aborted" : "error";
 *     output.errorMessage = …;
 *     stream.push({ type: "error", reason: output.stopReason, error: output });
 *
 *   openclaw `dist/proxy-BzhBz8iM.js:4380-4386` (`streamProxy`) and
 *   `dist/openai-transport-stream-B0WkSqXp.js:758-768` (`failTransportStream`)
 *     const reason = options.signal?.aborted ? "aborted" : "error";
 *
 * `error.usage` carries whatever the provider had accumulated before the abort
 * (pi-ai `anthropic.js:480-497` mutates `output.usage` per SSE frame), which is
 * why this path SETTLES the partial rather than voiding it.
 */
export function abortedEvent(usage: Usage = makeUsage()): StreamEvent {
	return {
		type: "error",
		reason: "aborted",
		error: {
			...makeAssistantMessage(usage),
			stopReason: "aborted",
			errorMessage: "Request was aborted",
		},
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

// ── the PINNED host's own stream class, ported ──

/**
 * A faithful port of the pinned `EventStream` / `AssistantMessageEventStream`.
 *
 * Sources, identical in both pinned tarballs:
 *   `@mariozechner/pi-ai@0.73.1` `dist/utils/event-stream.js:2-80`
 *   `openclaw@2026.7.1-2`        `dist/validation-DQFzVcBb.js:3-65`
 *
 * Three behaviours here are LOAD-BEARING and cannot be faked with a plain async
 * generator, which is why this port exists instead of another `asHostStream`:
 *
 *  1. `push()` resolves the final-result promise BEFORE handing the terminal
 *     event to the waiting consumer (`resolveFinalResult` precedes `waiter(…)`).
 *     That single ordering is what lets the host `await response.result()` from
 *     INSIDE its own loop body without deadlocking — and therefore what any
 *     governed proxy has to preserve.
 *  2. `result()` is PASSIVE. It returns the promise and consumes nothing, so a
 *     `result()`-first consumer that later iterates still sees every event.
 *  3. `end()` called with NO argument leaves the final-result promise pending
 *     FOREVER while the iteration terminates normally — the "clean close with
 *     no terminal event" case.
 */
export class PinnedEventStream implements AssistantMessageEventStreamLike {
	private readonly queue: StreamEvent[] = [];
	private readonly waiting: ((r: IteratorResult<StreamEvent>) => void)[] = [];
	private closed = false;
	private resolveFinal!: (message: AssistantMessage) => void;
	private readonly finalResultPromise: Promise<AssistantMessage>;

	constructor() {
		this.finalResultPromise = new Promise<AssistantMessage>((resolve) => {
			this.resolveFinal = resolve;
		});
	}

	push(event: StreamEvent): void {
		if (this.closed) return;
		// Terminal events resolve the result FIRST — before the consumer is
		// handed the event. See (1) above.
		if (event.type === "done") {
			this.closed = true;
			this.resolveFinal(event.message);
		} else if (event.type === "error") {
			this.closed = true;
			this.resolveFinal(event.error);
		}
		const waiter = this.waiting.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);
	}

	end(result?: AssistantMessage): void {
		this.closed = true;
		// NOTE the pinned asymmetry: no argument means the promise stays pending.
		if (result !== undefined) this.resolveFinal(result);
		while (this.waiting.length > 0) {
			this.waiting.shift()?.({ value: undefined, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
		for (;;) {
			const queued = this.queue.shift();
			if (queued !== undefined) {
				yield queued;
				continue;
			}
			if (this.closed) return;
			const next = await new Promise<IteratorResult<StreamEvent>>((resolve) =>
				this.waiting.push(resolve),
			);
			if (next.done === true) return;
			yield next.value;
		}
	}

	result(): Promise<AssistantMessage> {
		return this.finalResultPromise;
	}
}

/**
 * A host stream fn backed by {@link PinnedEventStream}, fed by a producer that
 * runs EAGERLY — exactly as every pinned provider does (an async IIFE that
 * starts pushing the moment the stream object is handed back).
 */
export function pinnedStreamOf(
	events: StreamEvent[],
	opts: { endWith?: AssistantMessage | undefined } = {},
): (model: Model, context: Context) => AssistantMessageEventStreamLike {
	return () => {
		const stream = new PinnedEventStream();
		void (async () => {
			for (const event of events) {
				await Promise.resolve();
				stream.push(event);
			}
			if (opts.endWith !== undefined) stream.end(opts.endWith);
			else stream.end();
		})();
		return stream;
	};
}

// ── the PINNED host's consumption loop, ported ──

/**
 * The pinned OpenClaw agent loop's consumption of a stream, reproduced move for
 * move — `openclaw@2026.7.1-2` `dist/proxy-BzhBz8iM.js:363-424`, region
 * `packages/agent-core/src/agent-loop.ts`, function `streamAssistantResponse`.
 *
 * The two moves that matter, and that no other test in this package made:
 *
 *   case "done":
 *   case "error": {
 *     const finalMessage = removeNonExecutableToolCalls(await response.result());
 *     …
 *     return finalMessage;              // ← returns from INSIDE the for-await
 *   }
 *   }
 *   const finalMessage = removeNonExecutableToolCalls(await response.result());
 *
 * So the host awaits `result()` **while it is suspended in the loop body
 * handling the terminal event**, and then abandons the iterator instead of
 * draining it. A proxy whose `result()` can only settle after its generator is
 * resumed deadlocks right there. The post-loop `result()` at line 411 is the
 * only path for a stream that ends with no terminal event at all.
 *
 * `observed` collects every event the host saw, so a test can assert the host
 * loop's view of the stream is intact as well as unblocked.
 */
export async function consumeLikeOpenClawLoop(
	stream: AssistantMessageEventStreamLike,
	observed: StreamEvent[] = [],
): Promise<AssistantMessage> {
	for await (const event of stream) {
		observed.push(event);
		if (event.type === "done" || event.type === "error") {
			return await stream.result();
		}
	}
	return await stream.result();
}
