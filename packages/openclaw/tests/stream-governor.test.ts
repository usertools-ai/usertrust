import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Governor } from "usertrust";
import { createGovernor } from "usertrust";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapCompleteWithGovernance, wrapStreamWithGovernance } from "../src/stream-governor.js";
import type { Context, StreamEvent, StreamFn, StreamOptions, Usage } from "../src/types.js";
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
	withTimeout,
} from "./host-fixtures.js";

/**
 * A pre-cache (two-field) host `Usage` shape — `cacheRead`/`cacheWrite` are
 * ABSENT keys, not `0`-valued ones. `makeUsage()` always supplies explicit
 * zeros (a provider reporting confirmed no cache use), so this fixture is what
 * the older-runtime degradation path (spec D2 "Version contract") actually
 * needs: a pi-ai below the >=0.12.0 peer floor whose `Usage` never had cache
 * fields at all.
 */
function legacyUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	} as unknown as Usage;
}

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

/** Iterate a governed stream to exhaustion, discarding the events. */
function drain(stream: AsyncIterable<StreamEvent>): Promise<void> {
	return (async () => {
		for await (const _event of stream) {
			// consume
		}
	})();
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

	it("forwards cache read/write tokens to governor.settle (spec D4 row 2, stream path)", async () => {
		const settle = vi.spyOn(gov, "settle");
		const events: StreamEvent[] = [startEvent(), doneEvent(makeUsage(100, 50, 30, 10))];

		const governed = wrapStreamWithGovernance(mockStreamFn(events), gov);
		for await (const _event of await governed(model, makeContext())) {
			// consume
		}

		expect(settle).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 30,
				cacheWriteTokens: 10,
			}),
		);
	});

	it("omits cache tokens from the settle params for a pre-cache (two-field) host Usage", async () => {
		const settle = vi.spyOn(gov, "settle");
		const events: StreamEvent[] = [startEvent(), doneEvent(legacyUsage(100, 50))];

		const governed = wrapStreamWithGovernance(mockStreamFn(events), gov);
		for await (const _event of await governed(model, makeContext())) {
			// consume
		}

		const params = settle.mock.calls[0]?.[1];
		expect(params).not.toHaveProperty("cacheReadTokens");
		expect(params).not.toHaveProperty("cacheWriteTokens");
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

	it("forwards cache read/write tokens to governor.settle (spec D4 row 2, completion path)", async () => {
		const settle = vi.spyOn(gov, "settle");
		const completeFn = vi.fn(async () => ({
			content: "Hello!",
			usage: makeUsage(100, 50, 30, 10),
		}));

		const governed = wrapCompleteWithGovernance(completeFn, gov);
		await governed(model, makeContext());

		expect(settle).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 30,
				cacheWriteTokens: 10,
			}),
		);
	});

	it("omits cache tokens from settle params for a pre-cache (two-field) completion Usage", async () => {
		const settle = vi.spyOn(gov, "settle");
		const completeFn = vi.fn(async () => ({
			content: "Hello!",
			usage: legacyUsage(100, 50),
		}));

		const governed = wrapCompleteWithGovernance(completeFn, gov);
		await governed(model, makeContext());

		const params = settle.mock.calls[0]?.[1];
		expect(params).not.toHaveProperty("cacheReadTokens");
		expect(params).not.toHaveProperty("cacheWriteTokens");
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

/**
 * `result()` is backed by a deferred. It MUST settle on every terminal path of
 * the governed run — otherwise the host's normal pattern (iterate for UI events,
 * await `result()` for the final message) hangs forever, or worse, reports a
 * successful assistant message for a call governance actually voided.
 */
describe("wrapStreamWithGovernance result() settlement", () => {
	let vaultBase: string;
	let gov: Governor;

	beforeEach(async () => {
		vaultBase = makeTmpVault();
		process.env.USERTRUST_TEST = "1";
		gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });
	});

	afterEach(async () => {
		process.env.USERTRUST_TEST = "";
		vi.restoreAllMocks();
		await gov.destroy();
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup
		}
	});

	const okEvents: StreamEvent[] = [startEvent(), textDelta("hi"), doneEvent(makeUsage(10, 5))];

	it("rejects result() on a policy DENY when the consumer also iterates", async () => {
		vi.spyOn(gov, "authorize").mockRejectedValue(new Error("policy_denied"));

		const governed = wrapStreamWithGovernance(mockStreamFn(okEvents), gov);
		const stream = await governed(model, makeContext());

		// Iterating first marks the stream consumed, so `result()` cannot fall
		// back to its own drain — the governed run has to settle the deferred.
		await expect(drain(stream)).rejects.toThrow("policy_denied");
		await expect(withTimeout(stream.result())).rejects.toThrow("policy_denied");
	});

	it("rejects result() on a policy DENY for a result()-only consumer", async () => {
		vi.spyOn(gov, "authorize").mockRejectedValue(new Error("policy_denied"));

		const governed = wrapStreamWithGovernance(mockStreamFn(okEvents), gov);
		const stream = await governed(model, makeContext());

		await expect(withTimeout(stream.result())).rejects.toThrow("policy_denied");
	});

	it("rejects result() when the budget is exhausted and the consumer also iterates", async () => {
		vi.spyOn(gov, "budgetRemaining").mockReturnValue(0);

		const governed = wrapStreamWithGovernance(mockStreamFn(okEvents), gov);
		const stream = await governed(model, makeContext());

		await expect(drain(stream)).rejects.toThrow("budget exhausted");
		await expect(withTimeout(stream.result())).rejects.toThrow("budget exhausted");
	});

	it("rejects result() when settle fails after the provider stream succeeded", async () => {
		vi.spyOn(gov, "settle").mockRejectedValue(new Error("settle_failed"));

		const governed = wrapStreamWithGovernance(mockStreamFn(okEvents), gov);
		const stream = await governed(model, makeContext());

		// The provider's own `result()` resolves as soon as its stream ends —
		// well before settle runs. `result()` must not report that success.
		await expect(drain(stream)).rejects.toThrow("settle_failed");
		await expect(withTimeout(stream.result())).rejects.toThrow("settle_failed");
	});

	it("surfaces a settle failure to a result()-only consumer instead of swallowing it", async () => {
		vi.spyOn(gov, "settle").mockRejectedValue(new Error("settle_failed"));

		const governed = wrapStreamWithGovernance(mockStreamFn(okEvents), gov);
		const stream = await governed(model, makeContext());

		await expect(withTimeout(stream.result())).rejects.toThrow("settle_failed");
	});

	it("rejects result() when the provider stream itself fails mid-flight", async () => {
		const governed = wrapStreamWithGovernance(mockFailingStreamFn(2), gov);
		const stream = await governed(model, makeContext());

		await expect(drain(stream)).rejects.toThrow("stream_failed");
		await expect(withTimeout(stream.result())).rejects.toThrow("stream_failed");
	});

	it("rejects result() when the consumer abandons the stream early", async () => {
		const governed = wrapStreamWithGovernance(mockStreamFn(okEvents), gov);
		const stream = await governed(model, makeContext());

		for await (const _event of stream) {
			break; // caller walks away before `done`
		}

		await expect(withTimeout(stream.result())).rejects.toThrow("abandoned before completion");
	});

	it("resolves result() with the host's final message, and only after settle", async () => {
		const order: string[] = [];
		vi.spyOn(gov, "settle").mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			order.push("settle");
		});

		const finalMessage = makeAssistantMessage(makeUsage(10, 5));
		const streamFn: StreamFn = () =>
			asHostStream(
				(async function* () {
					for (const event of okEvents) yield event;
				})(),
				finalMessage,
			);

		const governed = wrapStreamWithGovernance(streamFn, gov);
		const stream = await governed(model, makeContext());

		const iteration = drain(stream);
		const got = await withTimeout(stream.result());
		order.push("result");
		await iteration;

		expect(got).toBe(finalMessage);
		expect(order).toEqual(["settle", "result"]);
	});
});
