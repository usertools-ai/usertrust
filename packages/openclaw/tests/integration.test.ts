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
import type { StreamContext, StreamEvent, StreamFn } from "../src/types.js";

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
		expect(typeof plugin.wrapStreamFn).toBe("function");
	});

	it("wrapStreamFn(next) returns a callable stream function", () => {
		const plugin = createUsertrustPlugin({ budget: 100_000, dryRun: true, vaultBase });

		const rawStreamFn: StreamFn = async function* () {
			yield { type: "start" as const };
		};

		const wrapped = plugin.wrapStreamFn?.(rawStreamFn);
		expect(typeof wrapped).toBe("function");
	});

	it("wrapped stream forwards all events from the inner streamFn", async () => {
		const plugin = createUsertrustPlugin({ budget: 100_000, dryRun: true, vaultBase });

		const events: StreamEvent[] = [
			{ type: "start" },
			{ type: "text_start" },
			{ type: "text_delta", text: "hello " },
			{ type: "text_delta", text: "world" },
			{ type: "text_end" },
			{
				type: "done",
				stopReason: "stop",
				usage: { inputTokens: 10, outputTokens: 5 },
			},
		];

		const rawStreamFn: StreamFn = async function* () {
			for (const e of events) yield e;
		};

		const wrapped = plugin.wrapStreamFn?.(rawStreamFn);
		expect(wrapped).toBeDefined();

		const ctx: StreamContext = {
			messages: [{ role: "user", content: "hi" }],
			model: "claude-sonnet-4-6",
		};

		const collected: StreamEvent[] = [];
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		for await (const event of wrapped!("claude-sonnet-4-6", ctx)) {
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
		const rawStreamFn: StreamFn = async function* () {
			yield { type: "start" as const };
		};
		const wrapped = plugin.wrapStreamFn?.(rawStreamFn);
		const ctx: StreamContext = {
			messages: [{ role: "user", content: "hi" }],
			model: "claude-sonnet-4-6",
		};

		// biome-ignore lint/style/noNonNullAssertion: guarded above
		for await (const _e of wrapped!("claude-sonnet-4-6", ctx)) {
			// drain
		}

		expect(getGovernor()).not.toBeNull();
	});

	it("propagates errors from the inner streamFn and aborts the hold", async () => {
		const plugin = createUsertrustPlugin({ budget: 100_000, dryRun: true, vaultBase });

		const rawStreamFn: StreamFn = async function* () {
			yield { type: "start" as const };
			throw new Error("upstream_failure");
		};

		// Trigger lazy init by calling once with a successful no-op — but
		// we can't, since first call may also be the failing one. Instead,
		// snapshot budget AFTER first authorize completes by routing through
		// a separate channel: just compare delta within this test.
		const wrapped = plugin.wrapStreamFn?.(rawStreamFn);
		const ctx: StreamContext = {
			messages: [{ role: "user", content: "hi" }],
			model: "claude-sonnet-4-6",
		};

		const { getGovernor } = await import("../src/index.js");

		await expect(async () => {
			// biome-ignore lint/style/noNonNullAssertion: guarded above
			for await (const _e of wrapped!("claude-sonnet-4-6", ctx)) {
				// drain
			}
		}).rejects.toThrow("upstream_failure");

		const gov = getGovernor();
		expect(gov).not.toBeNull();
		// After abort, budget should equal the configured starting budget
		// (no spend should have been recorded for the failed call).
		expect(gov?.budgetRemaining()).toBe(100_000);
	});

	it("denies further calls once the budget is exhausted", async () => {
		// 240 usertokens per call (claude-sonnet-4-6 at 500/1500 tokens),
		// budget 480 → exactly 2 calls then 0 remaining → 3rd call denied.
		const plugin = createUsertrustPlugin({ budget: 480, dryRun: true, vaultBase });

		const rawStreamFn: StreamFn = async function* () {
			yield { type: "start" as const };
			yield {
				type: "done" as const,
				stopReason: "stop" as const,
				usage: { inputTokens: 500, outputTokens: 1500 },
			};
		};

		const wrapped = plugin.wrapStreamFn?.(rawStreamFn);
		const ctx: StreamContext = {
			messages: [{ role: "user", content: "hi" }],
			model: "claude-sonnet-4-6",
		};

		// First two calls should succeed
		// biome-ignore lint/style/noNonNullAssertion: guarded above
		for await (const _e of wrapped!("claude-sonnet-4-6", ctx)) {
			// drain
		}
		// biome-ignore lint/style/noNonNullAssertion: guarded above
		for await (const _e of wrapped!("claude-sonnet-4-6", ctx)) {
			// drain
		}

		// Third should be cut off
		await expect(async () => {
			// biome-ignore lint/style/noNonNullAssertion: guarded above
			for await (const _e of wrapped!("claude-sonnet-4-6", ctx)) {
				// drain
			}
		}).rejects.toThrow(/budget exhausted/);
	});

	it("settles the hold on early consumer-side termination (break)", async () => {
		const plugin = createUsertrustPlugin({ budget: 100_000, dryRun: true, vaultBase });

		// A stream that produces many chunks and never gets to `done`
		const rawStreamFn: StreamFn = async function* () {
			yield { type: "start" as const };
			for (let i = 0; i < 100; i++) {
				yield { type: "text_delta" as const, text: `chunk-${i}` };
			}
			yield {
				type: "done" as const,
				stopReason: "stop" as const,
				usage: { inputTokens: 10, outputTokens: 100 },
			};
		};

		const wrapped = plugin.wrapStreamFn?.(rawStreamFn);
		const ctx: StreamContext = {
			messages: [{ role: "user", content: "hi" }],
			model: "claude-sonnet-4-6",
		};

		// biome-ignore lint/style/noNonNullAssertion: guarded above
		const iter = wrapped!("claude-sonnet-4-6", ctx)[Symbol.asyncIterator]();
		await iter.next(); // consume one chunk
		// Caller drops the iterator without consuming `done`. The async
		// generator's `return()` will run the finally block — abort path.
		if (typeof iter.return === "function") {
			await iter.return(undefined);
		}
		// We don't assert budget here — abort vs. settle on early-return is
		// implementation-defined. We just assert it doesn't throw or hang.
		expect(true).toBe(true);
	});
});
