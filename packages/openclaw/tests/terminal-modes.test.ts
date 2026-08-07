// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * terminal-modes.test.ts — exactly one terminal ledger action per authorization.
 *
 * A stream can end six ways: normal completion, close-without-a-terminal-event,
 * a terminal `error` event, a thrown provider error, a consumer `break`, and an
 * explicit `iterator.return()`. Each must produce EXACTLY ONE of
 * `governor.settle` / `governor.abort` — never zero (a leaked PENDING hold) and
 * never two (AGENTS.md, "Exactly one ledger mutation per hold").
 *
 * The clean-but-early paths (break / return / close-without-done) settle at the
 * ESTIMATE: the accumulator only learns tokens from terminal events
 * (token-extractor.ts `extractUsageFromEvent`), so there is no provider usage to
 * settle with. That asymmetry — settle the partial, do not void — is the
 * documented one in AGENTS.md, "The settle/void asymmetry is deliberate."
 *
 * Where those two axes CROSS — the consumer breaks immediately after a terminal
 * event — the terminal event the loop observed wins, not the unwind: break after
 * `done` settles at the provider's usage (it was captured before the `yield`),
 * break after `error` aborts. Otherwise a failed call gets charged, and a fully
 * served one gets charged at the estimate.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Governor } from "usertrust";
import { createGovernor } from "usertrust";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapStreamWithGovernance } from "../src/stream-governor.js";
import type { StreamEvent, StreamFn } from "../src/types.js";
import {
	asHostStream,
	doneEvent,
	errorEvent,
	makeContext,
	makeModel,
	makeUsage,
	startEvent,
	streamOf,
	textDelta,
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
	const dir = join(tmpdir(), `openclaw-terminal-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** A long stream a consumer can walk away from long before the `done` event. */
function longStreamFn(): StreamFn {
	return () =>
		asHostStream(
			(async function* () {
				yield startEvent();
				for (let i = 0; i < 50; i++) yield textDelta(`chunk-${i}`);
				yield doneEvent(makeUsage(10, 100));
			})(),
		);
}

/** A stream that throws mid-flight instead of reaching a terminal event. */
function throwingStreamFn(): StreamFn {
	return () =>
		asHostStream(
			(async function* () {
				yield startEvent();
				throw new Error("provider_exploded");
			})(),
		);
}

async function withTimeout<T>(promise: Promise<T>, ms = 500): Promise<T> {
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

describe("stream terminal modes", () => {
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

	/** Total terminal ledger actions taken for the authorization. */
	function terminalCount(): number {
		return settle.mock.calls.length + abort.mock.calls.length;
	}

	/** The `SettleParams` the sole settle call was made with. */
	function settleParams(): Record<string, unknown> {
		return settle.mock.calls[0]?.[1] as Record<string, unknown>;
	}

	it("settles at the estimate when the consumer breaks mid-stream", async () => {
		const governed = wrapStreamWithGovernance(longStreamFn(), gov);

		for await (const _event of await governed(model, makeContext())) {
			break; // caller walks away before `done`
		}

		expect(terminalCount()).toBe(1);
		expect(settle).toHaveBeenCalledOnce();
		const params = settleParams();
		expect(params.usageSource).toBe("estimated");
		expect(params).not.toHaveProperty("inputTokens");
		expect(params).not.toHaveProperty("outputTokens");
		expect(params.chunksDelivered).toBe(1);
	});

	it("settles at the estimate when the consumer calls iterator.return()", async () => {
		const governed = wrapStreamWithGovernance(longStreamFn(), gov);

		const iterator = (await governed(model, makeContext()))[Symbol.asyncIterator]();
		await iterator.next();
		await iterator.next();
		await iterator.return?.(undefined);

		expect(terminalCount()).toBe(1);
		expect(settle).toHaveBeenCalledOnce();
		expect(settleParams().usageSource).toBe("estimated");
		expect(settleParams().chunksDelivered).toBe(2);
	});

	it("aborts exactly once when the provider stream throws", async () => {
		const governed = wrapStreamWithGovernance(throwingStreamFn(), gov);
		const stream = await governed(model, makeContext());

		await expect(async () => {
			for await (const _event of stream) {
				// drain
			}
		}).rejects.toThrow("provider_exploded");

		expect(terminalCount()).toBe(1);
		expect(abort).toHaveBeenCalledOnce();
		expect(settle).not.toHaveBeenCalled();
	});

	it("aborts exactly once when the stream ends on a terminal error EVENT", async () => {
		// Per contract-notes §3 the `error` event is terminal and carries an
		// AssistantMessage, not a throw — the iteration simply ends after it.
		const events: StreamEvent[] = [startEvent(), textDelta("partial"), errorEvent(makeUsage(9, 3))];
		const governed = wrapStreamWithGovernance(streamOf(events), gov);
		const stream = await governed(model, makeContext());

		const collected: StreamEvent[] = [];
		for await (const event of stream) {
			collected.push(event);
		}

		// The event itself is forwarded unchanged; only the hold treatment differs.
		expect(collected).toHaveLength(3);
		expect(collected[2]?.type).toBe("error");

		expect(terminalCount()).toBe(1);
		expect(abort).toHaveBeenCalledOnce();
		expect(settle).not.toHaveBeenCalled();

		// A voided call has no successful final message to report.
		await expect(withTimeout(stream.result())).rejects.toThrow("boom");
	});

	it("aborts exactly once when the consumer breaks right after the error event", async () => {
		// The terminal event and the abandonment collide: the consumer sees the
		// `error` event and leaves, so the generator unwinds at the `yield` and
		// never reaches the post-loop branch. What the loop already OBSERVED still
		// decides the hold — a call the provider reported as failed is voided, not
		// charged at the estimate.
		const events: StreamEvent[] = [startEvent(), textDelta("partial"), errorEvent(makeUsage(9, 3))];
		const governed = wrapStreamWithGovernance(streamOf(events), gov);
		const stream = await governed(model, makeContext());

		for await (const event of stream) {
			if (event.type === "error") break;
		}

		expect(terminalCount()).toBe(1);
		expect(abort).toHaveBeenCalledOnce();
		expect(settle).not.toHaveBeenCalled();

		// Same rejection as the drain-to-end error path: there is no successful
		// final message either way.
		await expect(withTimeout(stream.result())).rejects.toThrow("boom");
	});

	it("settles at the provider usage when the consumer breaks right after `done`", async () => {
		// `for await (…) { if (e.type === "done") break; }` is an ordinary consumer
		// shape. The accumulator already captured the provider's tokens from that
		// event, so settling at the ESTIMATE here would systematically overcharge a
		// fully served call — holds are sized above expected actuals.
		const events: StreamEvent[] = [startEvent(), textDelta("hi"), doneEvent(makeUsage(120, 45))];
		const governed = wrapStreamWithGovernance(streamOf(events), gov);

		for await (const event of await governed(model, makeContext())) {
			if (event.type === "done") break;
		}

		expect(terminalCount()).toBe(1);
		expect(settle).toHaveBeenCalledOnce();
		expect(settleParams()).toMatchObject({
			inputTokens: 120,
			outputTokens: 45,
			usageSource: "provider",
			chunksDelivered: 3,
		});
	});

	it("settles at the estimate when the stream closes without any terminal event", async () => {
		const events: StreamEvent[] = [startEvent(), textDelta("orphaned")];
		const governed = wrapStreamWithGovernance(streamOf(events), gov);

		for await (const _event of await governed(model, makeContext())) {
			// drain to natural end — no `done`, no `error`
		}

		expect(terminalCount()).toBe(1);
		expect(settle).toHaveBeenCalledOnce();
		expect(settleParams().usageSource).toBe("estimated");
		expect(settleParams()).not.toHaveProperty("inputTokens");
	});

	it("settles exactly once at provider usage on normal completion", async () => {
		const events: StreamEvent[] = [startEvent(), textDelta("hi"), doneEvent(makeUsage(120, 45))];
		const governed = wrapStreamWithGovernance(streamOf(events), gov);

		for await (const _event of await governed(model, makeContext())) {
			// drain
		}

		expect(terminalCount()).toBe(1);
		expect(settle).toHaveBeenCalledOnce();
		expect(settle.mock.calls[0]?.[1]).toMatchObject({
			inputTokens: 120,
			outputTokens: 45,
			usageSource: "provider",
			chunksDelivered: 3,
		});
	});

	it("takes no ledger action when the pre-flight budget check denies the call", async () => {
		vi.spyOn(gov, "budgetRemaining").mockReturnValue(0);
		const governed = wrapStreamWithGovernance(longStreamFn(), gov);

		await expect(async () => {
			for await (const _event of await governed(model, makeContext())) {
				// drain
			}
		}).rejects.toThrow("budget exhausted");

		// No hold was ever created, so there is nothing to settle or abort.
		expect(terminalCount()).toBe(0);
	});

	it("takes no ledger action when authorize() rejects", async () => {
		vi.spyOn(gov, "authorize").mockRejectedValue(new Error("policy_denied"));
		const governed = wrapStreamWithGovernance(longStreamFn(), gov);

		await expect(async () => {
			for await (const _event of await governed(model, makeContext())) {
				// drain
			}
		}).rejects.toThrow("policy_denied");

		expect(terminalCount()).toBe(0);
	});

	it("still releases the hold when the abandonment settle itself fails", async () => {
		settle.mockRejectedValue(new Error("settle_unavailable"));
		const governed = wrapStreamWithGovernance(longStreamFn(), gov);

		for await (const _event of await governed(model, makeContext())) {
			break;
		}

		// Settle failed, so the hold would dangle PENDING — abort is the fallback
		// that returns the money, and it must not escape the `finally`.
		expect(settle).toHaveBeenCalledOnce();
		expect(abort).toHaveBeenCalledOnce();
	});
});
