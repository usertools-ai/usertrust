import { describe, expect, it, vi } from "vitest";
import type { GovernanceReceipt } from "../../src/shared/types.js";
import { type StreamUsage, createGovernedStream } from "../../src/streaming.js";

// ── Helpers ──

function makeReceipt(overrides?: Partial<GovernanceReceipt>): GovernanceReceipt {
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
	it("governance promise resolves with receipt after stream completes", async () => {
		const receipt = makeReceipt({ cost: 100 });
		const resolveGovernance = vi.fn(async (_usage: StreamUsage) => receipt);
		const rejectGovernance = vi.fn();

		const chunks = [
			{ type: "message_start", message: { usage: { input_tokens: 50 } } },
			{ type: "content_block_delta", delta: { text: "Hello" } },
			{ type: "message_delta", usage: { output_tokens: 20 } },
		];

		const governed = createGovernedStream(
			mockStream(chunks),
			"anthropic",
			resolveGovernance,
			rejectGovernance,
		);

		// Consume the stream
		await collectAll(governed);

		// governance promise should resolve
		const result = await governed.governance;
		expect(result).toEqual(receipt);
		expect(result.cost).toBe(100);
		expect(result.settled).toBe(true);
	});

	it("governance promise rejects if stream errors", async () => {
		const resolveGovernance = vi.fn(async (_usage: StreamUsage) => makeReceipt());
		const rejectGovernance = vi.fn();

		const chunks = [
			{ type: "content_block_delta", delta: { text: "partial" } },
			{ type: "content_block_delta", delta: { text: "boom" } },
		];

		const governed = createGovernedStream(
			failingStream(chunks, 1),
			"anthropic",
			resolveGovernance,
			rejectGovernance,
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
		await expect(governed.governance).rejects.toThrow("Stream exploded");
		expect(rejectGovernance).toHaveBeenCalledOnce();
		expect(resolveGovernance).not.toHaveBeenCalled();
	});

	it("yields all chunks unchanged", async () => {
		const receipt = makeReceipt();
		const resolveGovernance = vi.fn(async () => receipt);
		const rejectGovernance = vi.fn();

		const chunks = [
			{ choices: [{ delta: { content: "Part 1" } }] },
			{ choices: [{ delta: { content: "Part 2" } }] },
			{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
		];

		const governed = createGovernedStream(
			mockStream(chunks),
			"openai",
			resolveGovernance,
			rejectGovernance,
		);

		const collected = await collectAll(governed);
		expect(collected).toEqual(chunks);
	});

	it("factory wires onComplete to resolveGovernance with usage", async () => {
		const receipt = makeReceipt({ cost: 77 });
		const resolveGovernance = vi.fn(async (usage: StreamUsage) => {
			// Verify the usage was passed through
			expect(usage.inputTokens).toBe(200);
			expect(usage.outputTokens).toBe(50);
			return receipt;
		});
		const rejectGovernance = vi.fn();

		const chunks = [
			{ type: "message_start", message: { usage: { input_tokens: 200 } } },
			{ type: "content_block_delta", delta: { text: "response" } },
			{ type: "message_delta", usage: { output_tokens: 50 } },
		];

		const governed = createGovernedStream(
			mockStream(chunks),
			"anthropic",
			resolveGovernance,
			rejectGovernance,
		);

		await collectAll(governed);
		const result = await governed.governance;

		expect(resolveGovernance).toHaveBeenCalledOnce();
		expect(resolveGovernance).toHaveBeenCalledWith({ inputTokens: 200, outputTokens: 50 });
		expect(result.cost).toBe(77);
		expect(rejectGovernance).not.toHaveBeenCalled();
	});

	it("governance rejects if resolveGovernance throws", async () => {
		const resolveGovernance = vi.fn(async () => {
			throw new Error("POST failed");
		});
		const rejectGovernance = vi.fn();

		const chunks = [{ type: "content_block_delta", delta: { text: "data" } }];

		const governed = createGovernedStream(
			mockStream(chunks),
			"anthropic",
			resolveGovernance,
			rejectGovernance,
		);

		await collectAll(governed);

		await expect(governed.governance).rejects.toThrow("POST failed");
	});

	it("works with Google provider chunks", async () => {
		const receipt = makeReceipt({ provider: "google", model: "gemini-2.5-flash" });
		const resolveGovernance = vi.fn(async () => receipt);
		const rejectGovernance = vi.fn();

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
			resolveGovernance,
			rejectGovernance,
		);

		const collected = await collectAll(governed);
		expect(collected).toEqual(chunks);

		const result = await governed.governance;
		expect(result.provider).toBe("google");
		expect(resolveGovernance).toHaveBeenCalledWith({ inputTokens: 30, outputTokens: 15 });
	});

	it("handles empty stream gracefully", async () => {
		const receipt = makeReceipt({ cost: 0 });
		const resolveGovernance = vi.fn(async () => receipt);
		const rejectGovernance = vi.fn();

		const governed = createGovernedStream(
			mockStream([]),
			"openai",
			resolveGovernance,
			rejectGovernance,
		);

		const collected = await collectAll(governed);
		expect(collected).toEqual([]);

		const result = await governed.governance;
		expect(result.cost).toBe(0);
		expect(resolveGovernance).toHaveBeenCalledWith({ inputTokens: 0, outputTokens: 0 });
	});
});
