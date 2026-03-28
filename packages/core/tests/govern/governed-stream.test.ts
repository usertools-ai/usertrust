import { describe, expect, it, vi } from "vitest";
import type { TrustReceipt } from "../../src/shared/types.js";
import { type StreamUsage, createGovernedStream } from "../../src/streaming.js";

// ── Helpers ──

function makeReceipt(overrides?: Partial<TrustReceipt>): TrustReceipt {
	return {
		transferId: "tx_test_abc123",
		cost: 42,
		budgetRemaining: 49_958,
		auditHash: "deadbeef",
		chainPath: ".usertrust/audit",
		receiptUrl: null,
		settled: true,
		model: "claude-sonnet-4-6",
		provider: "anthropic",
		timestamp: "2026-03-16T00:00:00.000Z",
		...overrides,
	};
}

async function* mockStream<T>(chunks: T[]): AsyncGenerator<T> {
	for (const chunk of chunks) {
		yield chunk;
	}
}

async function* failingStream<T>(chunks: T[], errorAfter: number): AsyncGenerator<T> {
	let i = 0;
	for (const chunk of chunks) {
		if (i >= errorAfter) throw new Error("Stream exploded");
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

describe("createGovernedStream", () => {
	it("receipt promise resolves with receipt after stream completes", async () => {
		const receipt = makeReceipt({ cost: 100 });
		const resolveReceipt = vi.fn(async (_usage: StreamUsage) => receipt);
		const rejectReceipt = vi.fn();

		const chunks = [
			{ type: "message_start", message: { usage: { input_tokens: 50 } } },
			{ type: "content_block_delta", delta: { text: "Hello" } },
			{ type: "message_delta", usage: { output_tokens: 20 } },
		];

		const governed = createGovernedStream(
			mockStream(chunks),
			"anthropic",
			resolveReceipt,
			rejectReceipt,
		);

		// Consume the stream
		await collectAll(governed);

		// governance promise should resolve
		const result = await governed.receipt;
		expect(result).toEqual(receipt);
		expect(result.cost).toBe(100);
		expect(result.settled).toBe(true);
	});

	it("receipt promise rejects if stream errors", async () => {
		const resolveReceipt = vi.fn(async (_usage: StreamUsage) => makeReceipt());
		const rejectReceipt = vi.fn();

		const chunks = [
			{ type: "content_block_delta", delta: { text: "partial" } },
			{ type: "content_block_delta", delta: { text: "boom" } },
		];

		const governed = createGovernedStream(
			failingStream(chunks, 1),
			"anthropic",
			resolveReceipt,
			rejectReceipt,
		);

		// Consume — should throw
		try {
			for await (const _ of governed) {
				// consume
			}
		} catch {
			// expected
		}

		// governance promise should reject
		await expect(governed.receipt).rejects.toThrow("Stream exploded");
		expect(rejectReceipt).toHaveBeenCalledOnce();
		expect(resolveReceipt).not.toHaveBeenCalled();
	});

	it("yields all chunks unchanged", async () => {
		const receipt = makeReceipt();
		const resolveReceipt = vi.fn(async () => receipt);
		const rejectReceipt = vi.fn();

		const chunks = [
			{ choices: [{ delta: { content: "Part 1" } }] },
			{ choices: [{ delta: { content: "Part 2" } }] },
			{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
		];

		const governed = createGovernedStream(
			mockStream(chunks),
			"openai",
			resolveReceipt,
			rejectReceipt,
		);

		const collected = await collectAll(governed);
		expect(collected).toEqual(chunks);
	});

	it("factory wires onComplete to resolveReceipt callback with usage", async () => {
		const receipt = makeReceipt({ cost: 77 });
		const resolveReceipt = vi.fn(async (usage: StreamUsage) => {
			// Verify the usage was passed through
			expect(usage.inputTokens).toBe(200);
			expect(usage.outputTokens).toBe(50);
			return receipt;
		});
		const rejectReceipt = vi.fn();

		const chunks = [
			{ type: "message_start", message: { usage: { input_tokens: 200 } } },
			{ type: "content_block_delta", delta: { text: "response" } },
			{ type: "message_delta", usage: { output_tokens: 50 } },
		];

		const governed = createGovernedStream(
			mockStream(chunks),
			"anthropic",
			resolveReceipt,
			rejectReceipt,
		);

		await collectAll(governed);
		const result = await governed.receipt;

		expect(resolveReceipt).toHaveBeenCalledOnce();
		expect(resolveReceipt).toHaveBeenCalledWith({ inputTokens: 200, outputTokens: 50 });
		expect(result.cost).toBe(77);
		expect(rejectReceipt).not.toHaveBeenCalled();
	});

	it("receipt rejects if resolveReceipt throws", async () => {
		const resolveReceipt = vi.fn(async () => {
			throw new Error("POST failed");
		});
		const rejectReceipt = vi.fn();

		const chunks = [{ type: "content_block_delta", delta: { text: "data" } }];

		const governed = createGovernedStream(
			mockStream(chunks),
			"anthropic",
			resolveReceipt,
			rejectReceipt,
		);

		await collectAll(governed);

		await expect(governed.receipt).rejects.toThrow("POST failed");
	});

	it("works with Google provider chunks", async () => {
		const receipt = makeReceipt({ provider: "google", model: "gemini-2.5-flash" });
		const resolveReceipt = vi.fn(async () => receipt);
		const rejectReceipt = vi.fn();

		const chunks = [
			{ candidates: [{ content: { parts: [{ text: "Hello" }] } }] },
			{
				candidates: [],
				usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 15 },
			},
		];

		const governed = createGovernedStream(
			mockStream(chunks),
			"google",
			resolveReceipt,
			rejectReceipt,
		);

		const collected = await collectAll(governed);
		expect(collected).toEqual(chunks);

		const result = await governed.receipt;
		expect(result.provider).toBe("google");
		expect(resolveReceipt).toHaveBeenCalledWith({ inputTokens: 30, outputTokens: 15 });
	});

	it("handles empty stream gracefully", async () => {
		const receipt = makeReceipt({ cost: 0 });
		const resolveReceipt = vi.fn(async () => receipt);
		const rejectReceipt = vi.fn();

		const governed = createGovernedStream(mockStream([]), "openai", resolveReceipt, rejectReceipt);

		const collected = await collectAll(governed);
		expect(collected).toEqual([]);

		const result = await governed.receipt;
		expect(result.cost).toBe(0);
		expect(resolveReceipt).toHaveBeenCalledWith({ inputTokens: 0, outputTokens: 0 });
	});
});
