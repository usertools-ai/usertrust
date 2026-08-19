// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `connectTimeoutMs` bounds the WHOLE handshake, not each call inside it.
 *
 * `createTBEngine` makes two sequential ledger calls (treasury, then the funded
 * holding wallet). A per-call timeout is not the bound an operator configured: a
 * treasury that answers slowly followed by a stalled wallet took nearly 2x the
 * setting, and the consequences are not cosmetic — the SERVER's generic request
 * deadline fires first and replaces the actionable `ledger_unavailable` with an
 * opaque `governor_timeout`, while direct SDK callers simply never get the bound
 * they asked for.
 *
 * `tigerbeetle-node` is mocked here rather than driven against a closed port,
 * because a dead cluster never gets PAST the first call — the second one never
 * runs, so a real-socket test cannot tell a shared budget from a restarted one.
 * The failure needs a client that succeeds slowly and THEN stalls.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SLOW_FIRST_CALL_MS = 250;
const CONNECT_TIMEOUT_MS = 400;

let createAccountsCalls = 0;

vi.mock("tigerbeetle-node", async (importOriginal) => {
	const actual = await importOriginal<typeof import("tigerbeetle-node")>();
	return {
		...actual,
		createClient: () => ({
			// Call 1 (treasury) answers slowly but successfully; call 2 (the funded
			// wallet) never answers at all.
			createAccounts: async () => {
				createAccountsCalls += 1;
				if (createAccountsCalls === 1) {
					await new Promise((resolve) => setTimeout(resolve, SLOW_FIRST_CALL_MS));
					return [{ index: 0, status: actual.CreateAccountStatus.created }];
				}
				return new Promise(() => {});
			},
			createTransfers: async () => [],
			lookupAccounts: async () => [],
			lookupTransfers: async () => [],
			getAccountTransfers: async () => [],
			getAccountBalances: async () => [],
			queryAccounts: async () => [],
			queryTransfers: async () => [],
			destroy: () => {},
		}),
	};
});

beforeEach(() => {
	createAccountsCalls = 0;
});

describe("handshake budget", () => {
	it("bounds the whole handshake, not each ledger call separately", async () => {
		const { createGovernor } = await import("../../src/headless.js");
		const { LedgerUnavailableError } = await import("../../src/shared/errors.js");

		const vaultBase = await mkdtemp(join(tmpdir(), "ut-handshake-budget-"));
		const configPath = join(vaultBase, "usertrust.config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				budget: 50_000,
				tigerbeetle: { addresses: ["127.0.0.1:3001"], connectTimeoutMs: CONNECT_TIMEOUT_MS },
			}),
			"utf-8",
		);

		const startedAt = Date.now();
		const settled = await createGovernor({ vaultBase, configPath, dryRun: false }).then(
			async (governor) => {
				await governor.destroy();
				return "resolved" as const;
			},
			(err: unknown) => err,
		);
		const elapsedMs = Date.now() - startedAt;

		expect(settled).toBeInstanceOf(LedgerUnavailableError);
		// Both calls ran, so this really did exercise the sequential path.
		expect(createAccountsCalls).toBe(2);
		// One 400ms budget: the slow first call spends 250ms of it and the stalled
		// second gets the remaining ~150ms. Restarted, the second would get a fresh
		// 400ms and the total would be ~650ms. The bound sits between the two, with
		// room for a loaded machine.
		expect(elapsedMs).toBeLessThan(550);
	}, 20_000);
});
