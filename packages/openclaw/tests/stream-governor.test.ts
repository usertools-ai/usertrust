import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGovernor } from "usertrust";
import type { Governor } from "usertrust";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapCompleteWithGovernance, wrapStreamWithGovernance } from "../src/stream-governor.js";
import type { StreamContext, StreamEvent, StreamFn } from "../src/types.js";

// Mock tigerbeetle-node
vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: {
		linked: 1,
		pending: 2,
		post_pending_transfer: 4,
		void_pending_transfer: 8,
	},
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

// ── Test helpers ──

function makeTmpVault(): string {
	const dir = join(tmpdir(), `openclaw-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Create a mock pi-ai stream function that yields predefined events. */
function mockStreamFn(events: StreamEvent[]): StreamFn {
	return async function* (_model: string, _context: StreamContext) {
		for (const event of events) {
			yield event;
		}
	};
}

/** Create a mock stream that throws an error mid-stream. */
function mockFailingStreamFn(errorAfter: number): StreamFn {
	return async function* (_model: string, _context: StreamContext) {
		for (let i = 0; i < errorAfter; i++) {
			yield { type: "text_delta" as const, text: `chunk ${i}` };
		}
		throw new Error("stream_failed");
	};
}

// ── Tests ──

describe("wrapStreamWithGovernance", () => {
	let vaultBase: string;
	let gov: Governor;

	beforeEach(async () => {
		vaultBase = makeTmpVault();
		process.env.USERTRUST_TEST = "1";
		gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});
	});

	afterEach(async () => {
		delete process.env.USERTRUST_TEST; // biome-ignore lint/performance/noDelete: env cleanup requires delete
		await gov.destroy();
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup
		}
	});

	it("wraps a stream and forwards all events", async () => {
		const events: StreamEvent[] = [
			{ type: "start" },
			{ type: "text_start" },
			{ type: "text_delta", text: "Hello" },
			{ type: "text_delta", text: " world" },
			{ type: "text_end" },
			{
				type: "done",
				stopReason: "stop",
				usage: { inputTokens: 50, outputTokens: 20 },
			},
		];

		const streamFn = mockStreamFn(events);
		const governed = wrapStreamWithGovernance(streamFn, gov);

		const collected: StreamEvent[] = [];
		const context: StreamContext = {
			messages: [{ role: "user", content: "Hi" }],
			model: "claude-sonnet-4-6",
		};

		for await (const event of governed("claude-sonnet-4-6", context)) {
			collected.push(event);
		}

		expect(collected).toHaveLength(events.length);
		expect(collected[0]?.type).toBe("start");
		expect(collected[collected.length - 1]?.type).toBe("done");
	});

	it("deducts budget after successful stream", async () => {
		const events: StreamEvent[] = [
			{ type: "start" },
			{ type: "text_delta", text: "Hi" },
			{
				type: "done",
				stopReason: "stop",
				usage: { inputTokens: 100, outputTokens: 50 },
			},
		];

		const governed = wrapStreamWithGovernance(mockStreamFn(events), gov);
		const context: StreamContext = {
			messages: [{ role: "user", content: "Hello" }],
			model: "claude-sonnet-4-6",
		};

		const budgetBefore = gov.budgetRemaining();

		for await (const _event of governed("claude-sonnet-4-6", context)) {
			// consume stream
		}

		expect(gov.budgetRemaining()).toBeLessThan(budgetBefore);
	});

	it("aborts governance on stream error", async () => {
		const governed = wrapStreamWithGovernance(mockFailingStreamFn(3), gov);
		const context: StreamContext = {
			messages: [{ role: "user", content: "Hello" }],
			model: "claude-sonnet-4-6",
		};

		const budgetBefore = gov.budgetRemaining();

		const collected: StreamEvent[] = [];
		await expect(async () => {
			for await (const event of governed("claude-sonnet-4-6", context)) {
				collected.push(event);
			}
		}).rejects.toThrow("stream_failed");

		// Should have received 3 events before error
		expect(collected).toHaveLength(3);

		// Budget should be restored after abort
		expect(gov.budgetRemaining()).toBe(budgetBefore);
	});

	it("handles multiple concurrent streams", async () => {
		const events: StreamEvent[] = [
			{ type: "start" },
			{ type: "text_delta", text: "response" },
			{
				type: "done",
				stopReason: "stop",
				usage: { inputTokens: 30, outputTokens: 10 },
			},
		];

		const governed = wrapStreamWithGovernance(mockStreamFn(events), gov);
		const context: StreamContext = {
			messages: [{ role: "user", content: "Hi" }],
			model: "claude-sonnet-4-6",
		};

		// Run two streams concurrently
		const stream1 = (async () => {
			const result: StreamEvent[] = [];
			for await (const e of governed("claude-sonnet-4-6", context)) {
				result.push(e);
			}
			return result;
		})();

		const stream2 = (async () => {
			const result: StreamEvent[] = [];
			for await (const e of governed("claude-sonnet-4-6", context)) {
				result.push(e);
			}
			return result;
		})();

		const [r1, r2] = await Promise.all([stream1, stream2]);
		expect(r1).toHaveLength(3);
		expect(r2).toHaveLength(3);

		// Both calls should have been charged
		expect(gov.budgetRemaining()).toBeLessThan(100_000);
	});
});

describe("wrapCompleteWithGovernance", () => {
	let vaultBase: string;
	let gov: Governor;

	beforeEach(async () => {
		vaultBase = makeTmpVault();
		process.env.USERTRUST_TEST = "1";
		gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});
	});

	afterEach(async () => {
		delete process.env.USERTRUST_TEST; // biome-ignore lint/performance/noDelete: env cleanup requires delete
		await gov.destroy();
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup
		}
	});

	it("wraps a completion function with governance", async () => {
		const completeFn = vi.fn(async () => ({
			content: "Hello!",
			usage: { inputTokens: 50, outputTokens: 10 },
		}));

		const governed = wrapCompleteWithGovernance(completeFn, gov);
		const context: StreamContext = {
			messages: [{ role: "user", content: "Hi" }],
			model: "claude-sonnet-4-6",
		};

		const result = await governed("claude-sonnet-4-6", context);

		expect(result.content).toBe("Hello!");
		expect(completeFn).toHaveBeenCalledOnce();
		expect(gov.budgetRemaining()).toBeLessThan(100_000);
	});

	it("aborts governance on completion error", async () => {
		const completeFn = vi.fn(async () => {
			throw new Error("completion_failed");
		});

		const governed = wrapCompleteWithGovernance(completeFn, gov);
		const context: StreamContext = {
			messages: [{ role: "user", content: "Hi" }],
			model: "claude-sonnet-4-6",
		};

		const budgetBefore = gov.budgetRemaining();

		await expect(governed("claude-sonnet-4-6", context)).rejects.toThrow("completion_failed");

		// Budget restored after abort
		expect(gov.budgetRemaining()).toBe(budgetBefore);
	});
});
