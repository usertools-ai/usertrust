// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The handshake deadline must GATE the ledger call, not merely time it out.
 *
 * `withConnectDeadline` checks the clock on the way in — but while it took a
 * `Promise`, `withConnectDeadline("createFundedBudgetWallet", tbClient.create...())`
 * evaluated its argument first. The request was issued and THEN the clock was
 * consulted, so the guard could never prevent the call it guards, and the throw left
 * that live promise with no listener while the caller's `catch` destroyed the client
 * underneath it — an unhandled rejection that can terminate Node.
 *
 * The discriminating assertion here is the CALL COUNT, and that is the whole point.
 * A test that only asserts "it timed out" passes against the eager code too, because
 * the eager code issues the request and then throws: the outcome is identical and the
 * defect is invisible. Only counting the calls separates "gated" from "issued and
 * abandoned".
 *
 * `TrustTBClient` is mocked rather than `tigerbeetle-node`, because the condition is
 * time passing BETWEEN the two handshake calls. `getTreasuryId()` is the only code
 * that runs there, so it is where the stall goes; it stands in for any event-loop
 * block (GC pause, a loaded box, a first call landing near the boundary). A real
 * client cannot reproduce it — the first call's own exit check fires first and the
 * second call is never reached at all.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CONNECT_TIMEOUT_MS = 200;

let treasuryCalls = 0;
let walletCalls = 0;
let destroyCalls = 0;
let stallMs = 0;

vi.mock("../../src/ledger/client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/ledger/client.js")>();
	class StallingTBClient {
		async createTreasury(): Promise<bigint> {
			treasuryCalls += 1;
			return 1n;
		}
		getTreasuryId(): bigint {
			// Synchronous, so no timer can preempt it: the budget is provably spent by
			// the time the next handshake call is reached.
			const until = Date.now() + stallMs;
			while (Date.now() < until) {
				// Deliberate block: this is the condition under test.
			}
			return 1n;
		}
		async createFundedBudgetWallet(_seedCredits: number): Promise<bigint> {
			walletCalls += 1;
			return 2n;
		}
		destroy(): void {
			destroyCalls += 1;
		}
	}
	return { ...actual, TrustTBClient: StallingTBClient };
});

beforeEach(() => {
	treasuryCalls = 0;
	walletCalls = 0;
	destroyCalls = 0;
	stallMs = 0;
});

async function configFor(): Promise<{ vaultBase: string; configPath: string }> {
	const vaultBase = await mkdtemp(join(tmpdir(), "ut-handshake-gate-"));
	const configPath = join(vaultBase, "usertrust.config.json");
	await writeFile(
		configPath,
		JSON.stringify({
			budget: 50_000,
			tigerbeetle: { addresses: ["127.0.0.1:3001"], connectTimeoutMs: CONNECT_TIMEOUT_MS },
		}),
		"utf-8",
	);
	return { vaultBase, configPath };
}

describe("handshake gate", () => {
	it("work is never started once the budget is spent", async () => {
		const { createGovernor } = await import("../../src/headless.js");
		const { LedgerUnavailableError } = await import("../../src/shared/errors.js");
		const { vaultBase, configPath } = await configFor();

		// Spent between the two calls, not during either one.
		stallMs = CONNECT_TIMEOUT_MS * 2;

		const settled = await createGovernor({ vaultBase, configPath, dryRun: false }).then(
			async (governor) => {
				await governor.destroy();
				return "resolved" as const;
			},
			(err: unknown) => err,
		);

		expect(settled).toBeInstanceOf(LedgerUnavailableError);
		// CONTROL: the handshake really did run and really did reach the second call's
		// gate. Without this, `walletCalls === 0` would also pass for a mock that never
		// ran at all — an assertion that cannot fail proves nothing.
		expect(treasuryCalls).toBe(1);
		// THE FINDING. Eager evaluation issues this request and then throws, so a
		// timeout assertion cannot tell the two apart; the count can.
		expect(walletCalls).toBe(0);
		// And the client is still released rather than left retrying.
		expect(destroyCalls).toBeGreaterThanOrEqual(1);
	}, 20_000);

	it("still issues the second call when the budget allows it", async () => {
		// POSITIVE CONTROL for the gate itself. A `withConnectDeadline` that refused
		// everything would satisfy the test above while breaking every healthy
		// handshake; an all-refusal suite cannot detect a guard that is simply stuck
		// shut. Same path, same mock, budget intact.
		const { createGovernor } = await import("../../src/headless.js");
		const { vaultBase, configPath } = await configFor();

		stallMs = 0;

		const governor = await createGovernor({ vaultBase, configPath, dryRun: false });
		await governor.destroy();

		expect(treasuryCalls).toBe(1);
		expect(walletCalls).toBe(1);
	}, 20_000);
});
