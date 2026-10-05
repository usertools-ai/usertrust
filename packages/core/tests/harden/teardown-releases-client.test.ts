// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Teardown must ALWAYS reach the ledger client, even when voiding cannot finish.
 *
 * `destroy()` voids leftover holds and then closes the TigerBeetle client. Voiding
 * is a ledger request, and an unreachable cluster never rejects one — so an
 * unbounded void meant a dead ledger could stop teardown before it ever closed the
 * client. `AGENTS.md:118-123` is explicit that an open client is exactly what keeps
 * the event loop from draining, so this is not a leak, it is a process that will
 * not exit — the failure `destroy()` exists to prevent, reached through `destroy()`
 * itself.
 *
 * The code already carried the comment "a voidAllPending throw must not skip
 * destroy()". It was wrapped in try/catch, which covers a throw. The failure that
 * actually happens is a HANG.
 *
 * Abandoning the void is safe: TigerBeetle auto-voids pending transfers after 300s.
 * Teardown that never finishes is not.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGovernor } from "../../src/headless.js";
import type { TrustEngine } from "../../src/shared/types.js";

/** An engine whose void sweep never settles, but whose destroy() is observable. */
function stallingEngine(): { engine: TrustEngine; destroyed: () => boolean } {
	let wasDestroyed = false;
	const engine = {
		async spendPending(params: { transferId: string }) {
			return { transferId: params.transferId };
		},
		async postPendingSpend() {
			return { posted: 0 };
		},
		async voidPendingSpend() {},
		voidAllPending: () => new Promise<void>(() => {}),
		destroy: () => {
			wasDestroyed = true;
		},
	} as unknown as TrustEngine;
	return { engine, destroyed: () => wasDestroyed };
}

describe("teardown releases the ledger client", () => {
	it("destroys the engine even when the void sweep never settles", async () => {
		const vaultBase = await mkdtemp(join(tmpdir(), "ut-teardown-"));
		const { engine, destroyed } = stallingEngine();
		process.env.USERTRUST_TEST = "1";
		const governor = await createGovernor({ vaultBase, budget: 10_000, _engine: engine });

		const startedAt = Date.now();
		await governor.destroy();
		const elapsedMs = Date.now() - startedAt;

		// The whole point: teardown finished, and the client was released.
		expect(destroyed()).toBe(true);
		// Bounded by TEARDOWN_VOID_BUDGET_MS (5s), not by the stalled sweep.
		expect(elapsedMs).toBeLessThan(9_000);
	}, 30_000);
});
