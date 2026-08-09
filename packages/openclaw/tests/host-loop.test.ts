// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * host-loop.test.ts — the governed proxy as the PINNED OpenClaw loop consumes it.
 *
 * Every other suite in this package drives the wrapper the way a *test* finds
 * convenient: `for await (…) { }` to exhaustion, then `await stream.result()`.
 * The pinned host does neither. `openclaw@2026.7.1-2`
 * `dist/proxy-BzhBz8iM.js:363-424` (`streamAssistantResponse`) awaits
 * `response.result()` from INSIDE the loop body while handling the terminal
 * event, and then returns without draining the iterator:
 *
 *     case "done":
 *     case "error": {
 *       const finalMessage = removeNonExecutableToolCalls(await response.result());
 *       …
 *       return finalMessage;
 *     }
 *
 * That is legal against the pinned stream class only because
 * `EventStream.push()` resolves the final-result promise BEFORE delivering the
 * terminal event to the waiting consumer (`pi-ai/dist/utils/event-stream.js:20-31`,
 * `openclaw/dist/validation-DQFzVcBb.js:16-28`). A proxy that settles its
 * deferred only after its generator is RESUMED past the terminal `yield` cannot
 * be resumed — the host is blocked on the very promise the resumption would
 * settle — and the whole agent turn hangs.
 *
 * The absence of this consumption shape from the test suite is what let the
 * Codex PR-82 findings through, so it is the shape every case here uses:
 * `consumeLikeOpenClawLoop` + `PinnedEventStream` (both in `host-fixtures.ts`,
 * both ported line-for-line from the pinned tarballs).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Governor } from "usertrust";
import { createGovernor } from "usertrust";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapStreamWithGovernance } from "../src/stream-governor.js";
import type { AssistantMessageEventStreamLike, StreamEvent, StreamFn } from "../src/types.js";
import {
	abortedEvent,
	consumeLikeOpenClawLoop,
	doneEvent,
	errorEvent,
	makeContext,
	makeModel,
	makeUsage,
	PinnedEventStream,
	pinnedStreamOf,
	startEvent,
	textDelta,
	withTimeout,
} from "./host-fixtures.js";

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

const model = makeModel();

function makeTmpVault(): string {
	const dir = join(tmpdir(), `openclaw-host-loop-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("pinned OpenClaw host loop", () => {
	let vaultBase: string;
	let gov: Governor;
	let settle: ReturnType<typeof vi.spyOn>;
	let abort: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		vaultBase = makeTmpVault();
		process.env.USERTRUST_TEST = "1";
		gov = await createGovernor({ dryRun: true, budget: 100_000, vaultBase });
		settle = vi.spyOn(gov, "settle");
		abort = vi.spyOn(gov, "abort");
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

	function terminalCount(): number {
		return settle.mock.calls.length + abort.mock.calls.length;
	}

	function settleParams(): Record<string, unknown> {
		return settle.mock.calls[0]?.[1] as Record<string, unknown>;
	}

	// ── [P1-1] the deadlock: result() awaited from inside the loop body ──

	it("resolves result() awaited from inside the loop body on a `done` event", async () => {
		const events = [startEvent(), textDelta("hi"), doneEvent(makeUsage(10, 5))];
		const governed = wrapStreamWithGovernance(pinnedStreamOf(events), gov);
		const stream = await governed(model, makeContext());

		const observed: StreamEvent[] = [];
		const finalMessage = await withTimeout(consumeLikeOpenClawLoop(stream, observed));

		// The host saw the whole stream and got its final message back.
		expect(observed.map((e) => e.type)).toEqual(["start", "text_delta", "done"]);
		expect(finalMessage.usage.input).toBe(10);
		expect(finalMessage.usage.output).toBe(5);

		// And governance had ALREADY finished by the time it did: the host never
		// resumes the generator, so anything deferred past the terminal `yield`
		// would simply never run.
		expect(terminalCount()).toBe(1);
		expect(settle).toHaveBeenCalledOnce();
		expect(settleParams()).toMatchObject({
			inputTokens: 10,
			outputTokens: 5,
			usageSource: "provider",
		});
	});

	it("settles the hold BEFORE the terminal event reaches the host", async () => {
		// Ordering, not just eventual consistency: the host treats `result()`
		// resolving as the turn being over, so a settle still in flight at that
		// point is a hold the host believes is already closed.
		const order: string[] = [];
		settle.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			order.push("settle");
		});

		const events = [startEvent(), doneEvent(makeUsage(10, 5))];
		const governed = wrapStreamWithGovernance(pinnedStreamOf(events), gov);
		const stream = await governed(model, makeContext());

		for await (const event of stream) {
			if (event.type === "done") {
				order.push("host-sees-done");
				break;
			}
		}

		expect(order).toEqual(["settle", "host-sees-done"]);
	});

	it("resolves result() awaited from inside the loop body on an `error` event", async () => {
		// [P2-4] The pinned `AssistantMessageEventStream` RESOLVES its result with
		// `event.error` for an in-band error event — `extractResult` returns
		// `event.error`, it never rejects (`event-stream.js:66-74`). OpenClaw then
		// uses that AssistantMessage as the terminal assistant turn and branches on
		// `message.stopReason` (`proxy-BzhBz8iM.js:264`). Rejecting here would turn
		// a normal failed turn into a thrown agent-loop error.
		const events = [startEvent(), textDelta("partial"), errorEvent(makeUsage(9, 3))];
		const governed = wrapStreamWithGovernance(pinnedStreamOf(events), gov);
		const stream = await governed(model, makeContext());

		const observed: StreamEvent[] = [];
		const finalMessage = await withTimeout(consumeLikeOpenClawLoop(stream, observed));

		expect(observed.map((e) => e.type)).toEqual(["start", "text_delta", "error"]);
		expect(finalMessage.stopReason).toBe("error");
		expect(finalMessage.errorMessage).toBe("boom");

		// A provider-reported failure still VOIDS the hold — resolving `result()`
		// changes what the host is told, never what the ledger does.
		expect(terminalCount()).toBe(1);
		expect(abort).toHaveBeenCalledOnce();
		expect(settle).not.toHaveBeenCalled();
	});

	// ── [P1-2] consumer abort is not a provider failure ──

	it("settles the partial usage when the consumer aborts (reason: `aborted`)", async () => {
		const events = [startEvent(), textDelta("partial"), abortedEvent(makeUsage(9, 3))];
		const governed = wrapStreamWithGovernance(pinnedStreamOf(events), gov);
		const stream = await governed(model, makeContext());

		const finalMessage = await withTimeout(consumeLikeOpenClawLoop(stream));

		expect(finalMessage.stopReason).toBe("aborted");

		// The caller cancelled a call the provider was serving honestly, and the
		// partial usage is real spend. Settle it — do NOT void, and do not book it
		// as a provider failure.
		expect(terminalCount()).toBe(1);
		expect(settle).toHaveBeenCalledOnce();
		expect(abort).not.toHaveBeenCalled();
		expect(settleParams()).toMatchObject({
			inputTokens: 9,
			outputTokens: 3,
			usageSource: "provider",
		});
	});

	it("settles the partial when a real AbortSignal cancels the stream mid-flight", async () => {
		// The end-to-end shape: the caller's signal fires, the provider catches it
		// and pushes `{ type: "error", reason: "aborted", error: <partial> }` —
		// `pi-ai/dist/providers/anthropic.js:500-517`.
		const controller = new AbortController();
		const streamFn: StreamFn = (_model, _context, options): AssistantMessageEventStreamLike => {
			const stream = new PinnedEventStream();
			void (async () => {
				stream.push(startEvent());
				await Promise.resolve();
				stream.push(textDelta("half a sen"));
				await new Promise((resolve) => setTimeout(resolve, 5));
				if (options?.signal?.aborted === true) {
					stream.push(abortedEvent(makeUsage(42, 7)));
					stream.end();
					return;
				}
				stream.push(doneEvent(makeUsage(42, 400)));
				stream.end();
			})();
			return stream;
		};

		const governed = wrapStreamWithGovernance(streamFn, gov);
		const stream = await governed(model, makeContext(), { signal: controller.signal });
		controller.abort();

		const finalMessage = await withTimeout(consumeLikeOpenClawLoop(stream));

		expect(finalMessage.stopReason).toBe("aborted");
		expect(terminalCount()).toBe(1);
		expect(settle).toHaveBeenCalledOnce();
		expect(abort).not.toHaveBeenCalled();
		expect(settleParams()).toMatchObject({ inputTokens: 42, outputTokens: 7 });
	});

	// ── [P2-5] clean close with no terminal event ──

	it("terminates result() explicitly when the stream closes with no terminal event", async () => {
		// `EventStream.end()` with no argument marks the iteration finished but
		// leaves `finalResultPromise` pending FOREVER (`event-stream.js:33-43`).
		// This is the host's post-loop `await response.result()` at
		// `proxy-BzhBz8iM.js:411`, and adopting the provider's promise there marks
		// our deferred settled while it hangs — the one state the wrapper's own
		// "result() must never be left pending" guard cannot see.
		const governed = wrapStreamWithGovernance(pinnedStreamOf([startEvent(), textDelta("x")]), gov);
		const stream = await governed(model, makeContext());

		await expect(withTimeout(consumeLikeOpenClawLoop(stream))).rejects.toThrow(
			/closed without a terminal event/,
		);

		// The hold is still released, at the estimate, exactly as before.
		expect(terminalCount()).toBe(1);
		expect(settle).toHaveBeenCalledOnce();
		expect(settleParams().usageSource).toBe("estimated");
	});

	// ── [P2-3] result() is passive upstream; our drain must not eat the stream ──

	it("replays every event to an iterator that arrives after a result()-only drain", async () => {
		// The pinned `result()` consumes NOTHING (`event-stream.js:60-62`), so a
		// consumer that calls it first and iterates afterwards still sees the whole
		// stream. Our `result()` has to drain — nothing else pumps governance — so
		// it must replay what that drain swallowed instead of silently eating it.
		const events = [startEvent(), textDelta("a"), textDelta("b"), doneEvent(makeUsage(10, 5))];
		const governed = wrapStreamWithGovernance(pinnedStreamOf(events), gov);
		const stream = await governed(model, makeContext());

		const finalMessage = await withTimeout(stream.result());
		expect(finalMessage.usage.input).toBe(10);

		const seen: StreamEvent[] = [];
		for await (const event of stream) seen.push(event);

		expect(seen.map((e) => e.type)).toEqual(["start", "text_delta", "text_delta", "done"]);
		expect(terminalCount()).toBe(1);
	});

	it("does not split the stream when result() and iteration race", async () => {
		const events = [startEvent(), textDelta("a"), textDelta("b"), doneEvent(makeUsage(10, 5))];
		const governed = wrapStreamWithGovernance(pinnedStreamOf(events), gov);
		const stream = await governed(model, makeContext());

		// `result()` first, deliberately NOT awaited — its hidden drain is still
		// running when the iterator arrives.
		const resultPromise = stream.result();
		const seen: StreamEvent[] = [];
		for await (const event of stream) seen.push(event);

		await withTimeout(resultPromise);
		expect(seen.map((e) => e.type)).toEqual(["start", "text_delta", "text_delta", "done"]);
		expect(terminalCount()).toBe(1);
	});

	it("replays a mid-stream provider throw to a late iterator", async () => {
		const streamFn: StreamFn = () => ({
			[Symbol.asyncIterator]: async function* () {
				yield startEvent();
				throw new Error("provider_exploded");
			},
			result: () => new Promise<never>(() => {}),
		});
		const governed = wrapStreamWithGovernance(streamFn, gov);
		const stream = await governed(model, makeContext());

		await expect(withTimeout(stream.result())).rejects.toThrow("provider_exploded");

		const seen: StreamEvent[] = [];
		await expect(async () => {
			for await (const event of stream) seen.push(event);
		}).rejects.toThrow("provider_exploded");
		expect(seen.map((e) => e.type)).toEqual(["start"]);

		expect(terminalCount()).toBe(1);
		expect(abort).toHaveBeenCalledOnce();
	});
});
