// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Every governor hold carries a NAMED ledger timeout, and the headless handle
 * publishes it.
 *
 * TigerBeetle expires a pending transfer on its own at its `timeout`. The engine
 * used to leave that to the client's default, so nothing above the ledger could
 * state a hold's life. Now `createTBEngine` passes `LEDGER_HOLD_TIMEOUT_MS`
 * explicitly, and a headless `Authorization` carries the same value as
 * `holdTimeoutMs`, a duration usertrust-server turns into each hold's remaining life.
 *
 * Driven through the REAL `createTBEngine` (no `_engine`): only the network driver is
 * faked, and the pending transfer it is handed is what is asserted. Real TigerBeetle:
 * `tests/integration/hold-timeout.tb.test.ts`.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({
	transfers: [] as Array<{ flags: number; timeout: number; amount: bigint }>,
}));

vi.mock("tigerbeetle-node", () => ({
	createClient: () => ({
		createAccounts: async () => [],
		createTransfers: async (xs: Array<{ flags: number; timeout: number; amount: bigint }>) => {
			sent.transfers.push(...xs);
			return [];
		},
		lookupAccounts: async () => [],
		lookupTransfers: async () => [],
		destroy: () => {},
	}),
	AccountFlags: { debits_must_not_exceed_credits: 1 << 2, history: 1 << 5 },
	TransferFlags: { pending: 1, post_pending_transfer: 2, void_pending_transfer: 4 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	CreateTransferStatus: { created: 4294967295, exists: 1, exceeds_credits: 22 },
	amount_max: (1n << 128n) - 1n,
}));

// The constant at a value the client would never default to (300 s): the timeout the
// ledger is handed, and the one the handle publishes, must both come from it.
vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
	...(await importOriginal()),
	LEDGER_HOLD_TIMEOUT_MS: 120_000,
}));

import { createGovernor } from "../../src/headless.js";
import { LEDGER_HOLD_TIMEOUT_MS, VAULT_DIR } from "../../src/shared/constants.js";

const PENDING = 1;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
	sent.transfers.length = 0;
});

function vault(config: Record<string, unknown>): string {
	const dir = join(tmpdir(), `hold-timeout-${randomUUID()}`);
	mkdirSync(join(dir, VAULT_DIR), { recursive: true });
	writeFileSync(join(dir, VAULT_DIR, "usertrust.config.json"), JSON.stringify(config));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

describe("a governor hold's ledger timeout is named, and published on the handle", () => {
	it("the pending transfer carries LEDGER_HOLD_TIMEOUT_MS, and so does the handle", async () => {
		const gov = await createGovernor({
			vaultBase: vault({ budget: 100_000, tigerbeetle: { addresses: ["3000"], clusterId: 0 } }),
		});
		cleanup.push(() => gov.destroy());
		const auth = await gov.authorize({ model: "claude-sonnet-4-6", estimatedInputTokens: 10 });

		const holds = sent.transfers.filter((t) => (t.flags & PENDING) !== 0);
		expect(holds).toHaveLength(1);
		expect(LEDGER_HOLD_TIMEOUT_MS).toBe(120_000);
		expect(holds[0]?.timeout).toBe(120);
		// The value published is the value the ledger was handed.
		expect(auth.holdTimeoutMs).toBe((holds[0]?.timeout ?? 0) * 1000);
		await gov.abort(auth, new Error("done"));
	});

	it("the published constant is TigerBeetle's five minutes", async () => {
		const actual = await vi.importActual<typeof import("../../src/shared/constants.js")>(
			"../../src/shared/constants.js",
		);
		expect(actual.LEDGER_HOLD_TIMEOUT_MS).toBe(300_000);
	});

	it("dry run: no ledger hold, so no timeout on the handle", async () => {
		const gov = await createGovernor({ vaultBase: vault({ budget: 100_000 }), dryRun: true });
		cleanup.push(() => gov.destroy());
		const auth = await gov.authorize({ model: "claude-sonnet-4-6", estimatedInputTokens: 10 });
		expect(sent.transfers).toEqual([]);
		expect(Object.hasOwn(auth, "holdTimeoutMs")).toBe(false);
	});

	it("the handle stays JSON-serializable, timeout included", async () => {
		const gov = await createGovernor({
			vaultBase: vault({ budget: 100_000, tigerbeetle: { addresses: ["3000"], clusterId: 0 } }),
		});
		cleanup.push(() => gov.destroy());
		const auth = await gov.authorize({ model: "claude-sonnet-4-6", estimatedInputTokens: 10 });
		expect(JSON.parse(JSON.stringify(auth)).holdTimeoutMs).toBe(LEDGER_HOLD_TIMEOUT_MS);
		await gov.abort(auth, new Error("done"));
	});
});
