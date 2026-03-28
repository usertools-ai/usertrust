import { describe, expect, it, vi } from "vitest";
import type { LLMClientKind } from "../../src/shared/types.js";
import { type StreamUsage, wrapStream } from "../../src/streaming.js";

// ── Helpers ──

async function* mockStream<T>(chunks: T[]): AsyncGenerator<T> {
	for (const chunk of chunks) {
		yield chunk;
	}
}

async function* failingStream<T>(chunks: T[], errorAfter: number): AsyncGenerator<T> {
	let i = 0;
	for (const chunk of chunks) {
		if (i >= errorAfter) throw new Error("Stream error");
		yield chunk;
		i++;
	}
}

async function collectAll<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of stream) {
		result.push(item);
	}
	return result;
}

// ── Tests ──

describe("wrapStream", () => {
	// ─── Anthropic ───

	describe("Anthropic streams", () => {
		const kind: LLMClientKind = "anthropic";

		it("yields all chunks unchanged", async () => {
			const chunks = [
				{ type: "message_start", message: { usage: { input_tokens: 42 } } },
				{ type: "content_block_delta", delta: { text: "Hello" } },
				{ type: "content_block_delta", delta: { text: " world" } },
				{ type: "message_delta", usage: { output_tokens: 10 } },
			];

			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(mockStream(chunks), kind, onComplete, onError);

			const collected = await collectAll(wrapped);
			expect(collected).toEqual(chunks);
		});

		it("extracts input_tokens from message_start", async () => {
			const chunks = [
				{ type: "message_start", message: { usage: { input_tokens: 150 } } },
				{ type: "content_block_delta", delta: { text: "Hi" } },
				{ type: "message_delta", usage: { output_tokens: 20 } },
			];

			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(mockStream(chunks), kind, onComplete, onError);
			await collectAll(wrapped);

			expect(onComplete).toHaveBeenCalledOnce();
			const usage: StreamUsage = onComplete.mock.calls[0]?.[0] as StreamUsage;
			expect(usage.inputTokens).toBe(150);
		});

		it("extracts output_tokens from message_delta", async () => {
			const chunks = [
				{ type: "message_start", message: { usage: { input_tokens: 10 } } },
				{ type: "content_block_delta", delta: { text: "response" } },
				{ type: "message_delta", usage: { output_tokens: 75 } },
			];

			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(mockStream(chunks), kind, onComplete, onError);
			await collectAll(wrapped);

			const usage: StreamUsage = onComplete.mock.calls[0]?.[0] as StreamUsage;
			expect(usage.outputTokens).toBe(75);
		});

		it("reports combined usage on complete", async () => {
			const chunks = [
				{ type: "message_start", message: { usage: { input_tokens: 200 } } },
				{ type: "content_block_delta", delta: { text: "data" } },
				{ type: "message_delta", usage: { output_tokens: 50 } },
			];

			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(mockStream(chunks), kind, onComplete, onError);
			await collectAll(wrapped);

			expect(onComplete).toHaveBeenCalledWith({ inputTokens: 200, outputTokens: 50 });
			expect(onError).not.toHaveBeenCalled();
		});

		it("returns zero when message_start has no usage", async () => {
			const chunks = [
				{ type: "message_start", message: {} },
				{ type: "content_block_delta", delta: { text: "data" } },
			];

			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(mockStream(chunks), kind, onComplete, onError);
			await collectAll(wrapped);

			const usage: StreamUsage = onComplete.mock.calls[0]?.[0] as StreamUsage;
			expect(usage.inputTokens).toBe(0);
			expect(usage.outputTokens).toBe(0);
		});
	});

	// ─── OpenAI ───

	describe("OpenAI streams", () => {
		const kind: LLMClientKind = "openai";

		it("yields all chunks unchanged", async () => {
			const chunks = [
				{ choices: [{ delta: { content: "Hello" } }] },
				{ choices: [{ delta: { content: " there" } }] },
				{ choices: [], usage: { prompt_tokens: 30, completion_tokens: 15 } },
			];

			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(mockStream(chunks), kind, onComplete, onError);

			const collected = await collectAll(wrapped);
			expect(collected).toEqual(chunks);
		});

		it("extracts usage from final chunk", async () => {
			const chunks = [
				{ choices: [{ delta: { content: "Hi" } }] },
				{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 42 } },
			];

			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(mockStream(chunks), kind, onComplete, onError);
			await collectAll(wrapped);

			expect(onComplete).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 42 });
		});

		it("returns zero when no usage field present", async () => {
			const chunks = [
				{ choices: [{ delta: { content: "Hello" } }] },
				{ choices: [{ delta: { content: " world" } }] },
			];

			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(mockStream(chunks), kind, onComplete, onError);
			await collectAll(wrapped);

			const usage: StreamUsage = onComplete.mock.calls[0]?.[0] as StreamUsage;
			expect(usage.inputTokens).toBe(0);
			expect(usage.outputTokens).toBe(0);
		});
	});

	// ─── Google ───

	describe("Google streams", () => {
		const kind: LLMClientKind = "google";

		it("yields all chunks unchanged", async () => {
			const chunks = [
				{ candidates: [{ content: { parts: [{ text: "Hello" }] } }] },
				{
					candidates: [{ content: { parts: [{ text: " world" }] } }],
					usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 10 },
				},
			];

			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(mockStream(chunks), kind, onComplete, onError);

			const collected = await collectAll(wrapped);
			expect(collected).toEqual(chunks);
		});

		it("extracts usageMetadata from chunk", async () => {
			const chunks = [
				{ candidates: [{ content: { parts: [{ text: "Hi" }] } }] },
				{
					candidates: [],
					usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 33 },
				},
			];

			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(mockStream(chunks), kind, onComplete, onError);
			await collectAll(wrapped);

			expect(onComplete).toHaveBeenCalledWith({ inputTokens: 60, outputTokens: 33 });
		});

		it("returns zero when no usageMetadata present", async () => {
			const chunks = [{ candidates: [{ content: { parts: [{ text: "data" }] } }] }];

			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(mockStream(chunks), kind, onComplete, onError);
			await collectAll(wrapped);

			const usage: StreamUsage = onComplete.mock.calls[0]?.[0] as StreamUsage;
			expect(usage.inputTokens).toBe(0);
			expect(usage.outputTokens).toBe(0);
		});
	});

	// ─── Error handling ───

	describe("error handling", () => {
		it("calls onError on stream failure", async () => {
			const chunks = [
				{ type: "content_block_delta", delta: { text: "partial" } },
				{ type: "content_block_delta", delta: { text: " response" } },
			];

			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(failingStream(chunks, 1), "anthropic", onComplete, onError);

			const collected: unknown[] = [];
			await expect(async () => {
				for await (const chunk of wrapped) {
					collected.push(chunk);
				}
			}).rejects.toThrow("Stream error");

			expect(onError).toHaveBeenCalledOnce();
			expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
			expect(onComplete).not.toHaveBeenCalled();
		});

		it("re-throws the error to the consumer", async () => {
			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(failingStream([{ data: "x" }], 0), "openai", onComplete, onError);

			await expect(async () => {
				for await (const _ of wrapped) {
					// consume
				}
			}).rejects.toThrow("Stream error");
		});

		it("yields chunks before the error", async () => {
			const chunks = [
				{ type: "content_block_delta", delta: { text: "ok1" } },
				{ type: "content_block_delta", delta: { text: "ok2" } },
				{ type: "content_block_delta", delta: { text: "never" } },
			];

			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(failingStream(chunks, 2), "anthropic", onComplete, onError);

			const collected: unknown[] = [];
			try {
				for await (const chunk of wrapped) {
					collected.push(chunk);
				}
			} catch {
				// expected
			}

			expect(collected).toHaveLength(2);
			expect(collected[0]).toEqual(chunks[0]);
			expect(collected[1]).toEqual(chunks[1]);
		});
	});

	// ─── Edge cases ───

	describe("edge cases", () => {
		it("handles empty stream", async () => {
			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(mockStream([]), "anthropic", onComplete, onError);

			const collected = await collectAll(wrapped);
			expect(collected).toEqual([]);
			expect(onComplete).toHaveBeenCalledWith({ inputTokens: 0, outputTokens: 0 });
			expect(onError).not.toHaveBeenCalled();
		});

		it("handles chunks with null/undefined values gracefully", async () => {
			const chunks = [null, undefined, { type: "unknown" }];

			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(mockStream(chunks as unknown[]), "anthropic", onComplete, onError);

			const collected = await collectAll(wrapped);
			expect(collected).toHaveLength(3);
			expect(onComplete).toHaveBeenCalledWith({ inputTokens: 0, outputTokens: 0 });
		});

		it("uses last non-zero value when multiple usage chunks arrive", async () => {
			const chunks = [
				{ type: "message_start", message: { usage: { input_tokens: 50 } } },
				{ type: "message_delta", usage: { output_tokens: 10 } },
				// Sometimes providers send updated usage
				{ type: "message_delta", usage: { output_tokens: 25 } },
			];

			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(mockStream(chunks), "anthropic", onComplete, onError);
			await collectAll(wrapped);

			const usage: StreamUsage = onComplete.mock.calls[0]?.[0] as StreamUsage;
			expect(usage.inputTokens).toBe(50);
			// Last output_tokens value wins
			expect(usage.outputTokens).toBe(25);
		});
	});
});
