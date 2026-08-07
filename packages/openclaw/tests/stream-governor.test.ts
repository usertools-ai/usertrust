import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Governor } from "usertrust";
import { createGovernor } from "usertrust";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapCompleteWithGovernance, wrapStreamWithGovernance } from "../src/stream-governor.js";
import type { Context, StreamEvent, StreamFn, StreamOptions } from "../src/types.js";
import {
	asHostStream,
	doneEvent,
	makeAssistantMessage,
	makeContext,
	makeModel,
	makeUsage,
	startEvent,
	streamOf,
	textDelta,
} from "./host-fixtures.js";

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

/** Create a mock host stream function that yields predefined events. */
const mockStreamFn = streamOf;

/** Create a mock stream that throws an error mid-stream. */
function mockFailingStreamFn(errorAfter: number): StreamFn {
	return () =>
		asHostStream(
			(async function* () {
				for (let i = 0; i < errorAfter; i++) {
					yield textDelta(`chunk ${i}`);
				}
				throw new Error("stream_failed");
			})(),
		);
}

const model = makeModel();

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
		process.env.USERTRUST_TEST = "";
		await gov.destroy();
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup
		}
	});

	it("wraps a stream and forwards all events", async () => {
		const partial = makeAssistantMessage();
		const events: StreamEvent[] = [
			startEvent(),
			{ type: "text_start", contentIndex: 0, partial },
			textDelta("Hello"),
			textDelta(" world"),
			{ type: "text_end", contentIndex: 0, content: "Hello world", partial },
			doneEvent(makeUsage(50, 20)),
		];

		const streamFn = mockStreamFn(events);
		const governed = wrapStreamWithGovernance(streamFn, gov);

		const collected: StreamEvent[] = [];
		const context: Context = makeContext();

		for await (const event of await governed(model, context)) {
			collected.push(event);
		}

		expect(collected).toHaveLength(events.length);
		expect(collected[0]?.type).toBe("start");
		expect(collected[collected.length - 1]?.type).toBe("done");
	});

	it("deducts budget after successful stream", async () => {
		const events: StreamEvent[] = [startEvent(), textDelta("Hi"), doneEvent(makeUsage(100, 50))];

		const governed = wrapStreamWithGovernance(mockStreamFn(events), gov);
		const context: Context = makeContext();

		const budgetBefore = gov.budgetRemaining();

		for await (const _event of await governed(model, context)) {
			// consume stream
		}

		expect(gov.budgetRemaining()).toBeLessThan(budgetBefore);
	});

	it("aborts governance on stream error", async () => {
		const governed = wrapStreamWithGovernance(mockFailingStreamFn(3), gov);
		const context: Context = makeContext();

		const budgetBefore = gov.budgetRemaining();

		const collected: StreamEvent[] = [];
		await expect(async () => {
			for await (const event of await governed(model, context)) {
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
			startEvent(),
			textDelta("response"),
			doneEvent(makeUsage(30, 10)),
		];

		const governed = wrapStreamWithGovernance(mockStreamFn(events), gov);
		const context: Context = makeContext();

		// Run two streams concurrently
		const stream1 = (async () => {
			const result: StreamEvent[] = [];
			for await (const e of await governed(model, context)) {
				result.push(e);
			}
			return result;
		})();

		const stream2 = (async () => {
			const result: StreamEvent[] = [];
			for await (const e of await governed(model, context)) {
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
		process.env.USERTRUST_TEST = "";
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
			usage: makeUsage(50, 10),
		}));

		const governed = wrapCompleteWithGovernance(completeFn, gov);
		const context: Context = makeContext();

		const result = await governed(model, context);

		expect(result.content).toBe("Hello!");
		expect(completeFn).toHaveBeenCalledOnce();
		expect(gov.budgetRemaining()).toBeLessThan(100_000);
	});

	it("aborts governance on completion error", async () => {
		const completeFn = vi.fn(async () => {
			throw new Error("completion_failed");
		});

		const governed = wrapCompleteWithGovernance(completeFn, gov);
		const context: Context = makeContext();

		const budgetBefore = gov.budgetRemaining();

		await expect(governed(model, context)).rejects.toThrow("completion_failed");

		// Budget restored after abort
		expect(gov.budgetRemaining()).toBe(budgetBefore);
	});

	it("wraps a completion without usage (falls back to estimated)", async () => {
		const completeFn = vi.fn(async () => ({
			content: "Hello!",
		}));

		const governed = wrapCompleteWithGovernance(completeFn, gov);
		const context: Context = makeContext();
		const options: StreamOptions = { maxTokens: 2000, temperature: 0.7 };

		const result = await governed(model, context, options);

		expect(result.content).toBe("Hello!");
		expect(gov.budgetRemaining()).toBeLessThan(100_000);
	});
});

describe("wrapStreamWithGovernance with maxTokens/temperature", () => {
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
		process.env.USERTRUST_TEST = "";
		await gov.destroy();
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup
		}
	});

	it("reads maxTokens/temperature from options, not the context, and authorizes model.id", async () => {
		const events: StreamEvent[] = [startEvent(), doneEvent(makeUsage(10, 5))];

		const governed = wrapStreamWithGovernance(mockStreamFn(events), gov);
		const context: Context = makeContext();
		const options: StreamOptions = { maxTokens: 1000, temperature: 0.5 };
		const authorize = vi.spyOn(gov, "authorize");

		const collected: StreamEvent[] = [];
		for await (const event of await governed(model, context, options)) {
			collected.push(event);
		}

		expect(collected).toHaveLength(2);
		expect(authorize).toHaveBeenCalledOnce();
		expect(authorize.mock.calls[0]?.[0]).toMatchObject({
			model: model.id,
			maxOutputTokens: 1000,
			params: { temperature: 0.5 },
		});
		expect(gov.budgetRemaining()).toBeLessThan(100_000);
	});

	it("handles stream without usage reporting (falls back to estimated)", async () => {
		const partial = makeAssistantMessage();
		const events: StreamEvent[] = [
			startEvent(),
			textDelta("hello"),
			{ type: "text_end", contentIndex: 0, content: "hello", partial },
		];

		// Stream ends without a done event that has usage
		const noUsageStreamFn: StreamFn = streamOf(events);

		const governed = wrapStreamWithGovernance(noUsageStreamFn, gov);
		const context: Context = makeContext();

		for await (const _event of await governed(model, context)) {
			// consume
		}

		expect(gov.budgetRemaining()).toBeLessThan(100_000);
	});
});
