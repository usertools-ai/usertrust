// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A hold TigerBeetle has already expired is released cleanly, and leaves nothing behind.
 *
 * TigerBeetle ends a pending transfer itself at its timeout and returns its funds. A
 * void sent after that answers `pending_transfer_expired`. The engine used to throw it,
 * so the hold's `pendingMap` entry stayed until `destroy()`, which voided it again and
 * got the same answer: one leaked entry per expired hold. With usertrust-server sweeping
 * a hold when its advertised life ends, which is the ledger's own timeout at the
 * defaults, nearly every sweep met that answer. It now counts as done, as `exists` does.
 *
 * Driven through the REAL `createTBEngine`: only the network driver is faked, and the
 * voids it is handed are counted. Real TigerBeetle: `tests/integration/release.tb.test.ts`.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ledger = vi.hoisted(() => ({
	voids: 0,
	/** The status TigerBeetle answers a void with; `undefined` means created. */
	voidStatus: undefined as number | undefined,
}));

vi.mock("tigerbeetle-node", () => ({
	createClient: () => ({
		createAccounts: async () => [],
		createTransfers: async (xs: Array<{ flags: number }>) => {
			const isVoid = xs.some((x) => (x.flags & 4) !== 0);
			if (!isVoid) return [];
			ledger.voids += 1;
			return ledger.voidStatus === undefined ? [] : [{ index: 0, status: ledger.voidStatus }];
		},
		lookupAccounts: async () => [],
		lookupTransfers: async () => [],
		destroy: () => {},
	}),
	AccountFlags: { debits_must_not_exceed_credits: 1 << 2, history: 1 << 5 },
	TransferFlags: { pending: 1, post_pending_transfer: 2, void_pending_transfer: 4 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	CreateTransferStatus: {
		created: 4294967295,
		exists: 1,
		exceeds_credits: 22,
		pending_transfer_not_found: 25,
		pending_transfer_expired: 35,
		25: "pending_transfer_not_found",
		35: "pending_transfer_expired",
	},
	amount_max: (1n << 128n) - 1n,
}));

import { createGovernor } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

const EXPIRED = 35;
const NOT_FOUND = 25;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
	ledger.voids = 0;
	ledger.voidStatus = undefined;
});

function vault(): string {
	const dir = join(tmpdir(), `release-expired-${randomUUID()}`);
	mkdirSync(join(dir, VAULT_DIR), { recursive: true });
	writeFileSync(
		join(dir, VAULT_DIR, "usertrust.config.json"),
		JSON.stringify({ budget: 100_000, tigerbeetle: { addresses: ["3000"], clusterId: 0 } }),
	);
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

describe("a void TigerBeetle answers `pending_transfer_expired` is done", () => {
	it("the release is clean, and destroy() has nothing left to void", async () => {
		const gov = await createGovernor({ vaultBase: vault() });
		const auth = await gov.authorize({ model: "claude-sonnet-4-6", estimatedInputTokens: 10 });
		ledger.voidStatus = EXPIRED;

		expect(await gov.release(auth, "pending TTL expired")).toEqual({ released: true });
		expect(ledger.voids).toBe(1);
		await gov.destroy();
		// The entry went with the release: destroy() sends no second void.
		expect(ledger.voids).toBe(1);
	});

	it("control: any other refusal is named, and leaves the entry for destroy() to retry", async () => {
		const gov = await createGovernor({ vaultBase: vault() });
		const auth = await gov.authorize({ model: "claude-sonnet-4-6", estimatedInputTokens: 10 });
		ledger.voidStatus = NOT_FOUND;

		expect(await gov.release(auth)).toEqual({
			released: true,
			voidError: "pending_transfer_not_found",
		});
		expect(ledger.voids).toBe(1);
		await gov.destroy();
		expect(ledger.voids).toBe(2);
	});
});
