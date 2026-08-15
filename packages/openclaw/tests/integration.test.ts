// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * integration.test.ts — End-to-end shape + behaviour for createUsertrustPlugin.
 *
 * Verifies the public factory returns an OpenClaw-compatible ProviderPlugin,
 * lazily initializes the governor on first call, and correctly wraps a mock
 * streamFn through the budget → forward → settle lifecycle.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock tigerbeetle-node so the test never touches a real ledger
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

import { createUsertrustPlugin } from "../src/index.js";
import type { Context, StreamEvent, StreamFn } from "../src/types.js";
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

/** The hook context openclaw hands `wrapStreamFn`, with the inner fn on it. */
function wrapCtx(streamFn: StreamFn) {
	return { provider: "anthropic", modelId: "claude-sonnet-4-6", streamFn };
}

const MODEL = makeModel();

function makeTmpVault(): string {
	const dir = join(tmpdir(), `openclaw-integration-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("createUsertrustPlugin (factory)", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = makeTmpVault();
		process.env.USERTRUST_TEST = "1";
	});

	afterEach(async () => {
		process.env.USERTRUST_TEST = "";
		// Reset module-level governor between tests
		const mod = await import("../src/index.js");
		await mod.shutdown();
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup
		}
	});

	it("returns a valid OpenClaw ProviderPlugin shape", () => {
		const plugin = createUsertrustPlugin({ budget: 100_000, dryRun: true, vaultBase });

		expect(plugin.id).toBe("usertrust");
		expect(plugin.label).toBe("usertrust Governance");
		expect(plugin.aliases).toEqual(["anthropic", "openai", "google"]);
		expect(typeof plugin.wrapStreamFn).toBe("function");
	});

	it("wrapStreamFn(ctx) returns a callable stream function", () => {
		const plugin = createUsertrustPlugin({ budget: 100_000, dryRun: true, vaultBase });

		const wrapped = plugin.wrapStreamFn?.(wrapCtx(streamOf([startEvent()])));
		expect(typeof wrapped).toBe("function");
	});

	it("wrapped stream forwards all events from the inner streamFn", async () => {
		const plugin = createUsertrustPlugin({ budget: 100_000, dryRun: true, vaultBase });

		const partial = makeAssistantMessage();
		const events: StreamEvent[] = [
			startEvent(),
			{ type: "text_start", contentIndex: 0, partial },
			textDelta("hello "),
			textDelta("world"),
			{ type: "text_end", contentIndex: 0, content: "hello world", partial },
			doneEvent(makeUsage(10, 5)),
		];

		const wrapped = plugin.wrapStreamFn?.(wrapCtx(streamOf(events)));
		expect(wrapped).toBeDefined();

		const ctx: Context = makeContext();

		const collected: StreamEvent[] = [];
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		for await (const event of await wrapped!(MODEL, ctx)) {
			collected.push(event);
		}

		expect(collected).toHaveLength(events.length);
		expect(collected[0]?.type).toBe("start");
		expect(collected[collected.length - 1]?.type).toBe("done");
	});

	it("lazy-init: governor is null until first call", async () => {
		const { getGovernor } = await import("../src/index.js");

		// Create plugin — should NOT initialize governor
		const plugin = createUsertrustPlugin({ budget: 100_000, dryRun: true, vaultBase });
		expect(getGovernor()).toBeNull();

		// First call should trigger init
		const wrapped = plugin.wrapStreamFn?.(wrapCtx(streamOf([startEvent()])));
		const ctx: Context = makeContext();

		// biome-ignore lint/style/noNonNullAssertion: guarded above
		for await (const _e of await wrapped!(MODEL, ctx)) {
			// drain
		}

		expect(getGovernor()).not.toBeNull();
	});

	it("propagates errors from the inner streamFn and aborts the hold", async () => {
		const plugin = createUsertrustPlugin({ budget: 100_000, dryRun: true, vaultBase });

		const rawStreamFn: StreamFn = () =>
			asHostStream(
				(async function* () {
					yield startEvent();
					throw new Error("upstream_failure");
				})(),
			);

		// Trigger lazy init by calling once with a successful no-op — but
		// we can't, since first call may also be the failing one. Instead,
		// snapshot budget AFTER first authorize completes by routing through
		// a separate channel: just compare delta within this test.
		const wrapped = plugin.wrapStreamFn?.(wrapCtx(rawStreamFn));
		const ctx: Context = makeContext();

		const { getGovernor } = await import("../src/index.js");

		await expect(async () => {
			// biome-ignore lint/style/noNonNullAssertion: guarded above
			for await (const _e of await wrapped!(MODEL, ctx)) {
				// drain
			}
		}).rejects.toThrow("upstream_failure");

		const gov = getGovernor();
		expect(gov).not.toBeNull();
		// After abort, budget should equal the configured starting budget
		// (no spend should have been recorded for the failed call).
		expect(gov?.budgetRemaining()).toBe(100_000);
	});

	it("denies calls once the shared budget cannot cover another call (pre-spend, no overshoot)", async () => {
		// Each call SETTLES 240 usertokens (sonnet at 500/1500), but pre-spend
		// enforcement decides on the ESTIMATE — and openclaw sends no maxTokens, so
		// the estimate assumes the full 4096-token output (~614/call). A call is
		// denied once its estimate exceeds the remaining budget, so a call can never
		// overshoot. The exact number that fit is estimate-dependent, so assert the
		// invariant (some succeed, then denied, never overshoot) — not a fixed count.
		const BUDGET = 3000;
		const SETTLED_PER_CALL = 240;
		const plugin = createUsertrustPlugin({ budget: BUDGET, dryRun: true, vaultBase });

		const wrapped = plugin.wrapStreamFn?.(
			wrapCtx(streamOf([startEvent(), doneEvent(makeUsage(500, 1500))])),
		);
		const ctx: Context = makeContext();

		const drain = async () => {
			// biome-ignore lint/style/noNonNullAssertion: guarded by the test setup
			for await (const _e of await wrapped!(MODEL, ctx)) {
				// drain
			}
		};

		let succeeded = 0;
		let denied: unknown;
		for (let i = 0; i < 40; i++) {
			try {
				await drain();
				succeeded++;
			} catch (e) {
				denied = e;
				break;
			}
		}

		// At least one call went through, then a later call was denied pre-spend
		// with a budget error — and the total settled spend never overshot the
		// budget (the real guarantee: never spend past the cap).
		expect(succeeded).toBeGreaterThanOrEqual(1);
		expect(denied).toBeInstanceOf(Error);
		expect((denied as Error).message).toMatch(/budget/i);
		expect(succeeded * SETTLED_PER_CALL).toBeLessThanOrEqual(BUDGET);
	});

	it("settles the hold at the estimate on early consumer-side termination (break)", async () => {
		const plugin = createUsertrustPlugin({ budget: 100_000, dryRun: true, vaultBase });
		const { getGovernor } = await import("../src/index.js");

		// A stream that produces many chunks and never gets to `done`
		const rawStreamFn: StreamFn = () =>
			asHostStream(
				(async function* () {
					yield startEvent();
					for (let i = 0; i < 100; i++) {
						yield textDelta(`chunk-${i}`);
					}
					yield doneEvent(makeUsage(10, 100));
				})(),
			);

		const wrapped = plugin.wrapStreamFn?.(wrapCtx(rawStreamFn));
		const ctx: Context = makeContext();

		// Run one call to completion first: init is lazy, so this is what creates
		// the governor the terminal-action spies below attach to.
		// biome-ignore lint/style/noNonNullAssertion: guarded by the test setup
		for await (const _e of await wrapped!(MODEL, ctx)) {
			// drain
		}
		const gov = getGovernor();
		expect(gov).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: guarded by the expect above
		const settle = vi.spyOn(gov!, "settle");
		// biome-ignore lint/style/noNonNullAssertion: guarded by the expect above
		const abort = vi.spyOn(gov!, "abort");

		// biome-ignore lint/style/noNonNullAssertion: guarded by the test setup
		const iter = (await wrapped!(MODEL, ctx))[Symbol.asyncIterator]();
		await iter.next(); // consume one chunk
		// Caller drops the iterator without consuming `done`, unwinding the
		// governed generator through its `finally`.
		await iter.return?.(undefined);

		// The hold must not leak. Early termination is clean, so it SETTLES the
		// partial — at the estimate, since usage only arrives on a terminal event —
		// and never voids. Exactly one terminal action, through the plugin seam.
		expect(settle).toHaveBeenCalledOnce();
		expect(abort).not.toHaveBeenCalled();
		expect(settle.mock.calls[0]?.[1]).toMatchObject({
			usageSource: "estimated",
			chunksDelivered: 1,
		});
		vi.restoreAllMocks();
	});
});
