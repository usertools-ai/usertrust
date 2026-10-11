// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Real TigerBeetle: a released hold's funds come back, whether the release voids a
 * live hold or meets one the ledger has already expired.
 *
 * The budget is sized so that ONE hold fits and two do not. A second hold the size of
 * the first therefore succeeds only if the first one's funds really left the session's
 * holding wallet: the ledger enforces that wallet's balance, whatever the governor's
 * own accounting says. The ledger's pending timeout is shortened to one second here
 * (`LEDGER_HOLD_TIMEOUT_MS`), so a hold can expire inside the test.
 *
 * The unit suite (`tests/headless/release-expired-hold.test.ts`) pins the engine's
 * handling of `pending_transfer_expired` against a faked driver. Self-skips (via
 * `describe.skipIf`) whenever `USERTRUST_TB_ADDRESS` is unset.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
	...(await importOriginal()),
	LEDGER_HOLD_TIMEOUT_MS: 1_000,
}));

import { createGovernor, type Governor } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";
import { InsufficientBalanceError, PolicyDeniedError } from "../../src/shared/errors.js";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;
const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 2_000, maxOutputTokens: 500 };

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
});

async function governor(budget: number): Promise<Governor> {
	const dir = join(tmpdir(), `tb-release-${randomUUID()}`);
	mkdirSync(join(dir, VAULT_DIR), { recursive: true });
	writeFileSync(
		join(dir, VAULT_DIR, "usertrust.config.json"),
		JSON.stringify({ budget, tigerbeetle: { addresses: [TB_ADDRESS], clusterId: 0 } }),
	);
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const gov = await createGovernor({ vaultBase: dir });
	cleanup.push(() => gov.destroy());
	return gov;
}

/** A budget that holds one hold of this size and not two. */
async function oneHoldBudget(): Promise<number> {
	const probe = await governor(10_000_000);
	const auth = await probe.authorize(AUTHORIZE);
	await probe.release(auth);
	return Math.floor(auth.estimatedCost * 1.5);
}

describe.skipIf(!TB_ADDRESS)("real TigerBeetle — a released hold's funds come back", () => {
	it("control: while the first hold is pending, a second does not fit", async () => {
		const gov = await governor(await oneHoldBudget());
		await gov.authorize(AUTHORIZE);
		// The governor's own budget gate refuses it first; the ledger would too.
		await expect(gov.authorize(AUTHORIZE)).rejects.toSatisfy(
			(err) => err instanceof PolicyDeniedError || err instanceof InsufficientBalanceError,
		);
	});

	it("a live hold: released, then a second hold of the same size fits", async () => {
		const gov = await governor(await oneHoldBudget());
		const first = await gov.authorize(AUTHORIZE);
		expect(await gov.release(first, "given back")).toEqual({ released: true });
		// The governor's gate passes once its accounting is released; the reserve then
		// succeeds only if the ledger has the funds back (else exceeds_credits, a 402).
		await expect(gov.authorize(AUTHORIZE)).resolves.toBeDefined();
	});

	it("a hold the ledger already expired: released cleanly, and a second hold fits", async () => {
		const gov = await governor(await oneHoldBudget());
		const first = await gov.authorize(AUTHORIZE);
		expect(first.holdTimeoutMs).toBe(1_000);
		await new Promise((r) => setTimeout(r, 3_000));
		// TigerBeetle answers this void `pending_transfer_expired`: done, not a voidError.
		expect(await gov.release(first, "pending TTL expired")).toEqual({ released: true });
		await expect(gov.authorize(AUTHORIZE)).resolves.toBeDefined();
	}, 15_000);
});
