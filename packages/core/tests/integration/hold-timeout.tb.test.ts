// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Real TigerBeetle: a governor hold's pending `timeout` is the one its handle publishes.
 *
 * The unit suite (`tests/headless/hold-timeout.test.ts`) pins what the engine hands
 * the client. This pins what the ledger STORED: the pending transfer, read back by
 * its principal's unit tag, carries `timeout` = `LEDGER_HOLD_TIMEOUT_MS` in seconds,
 * and `Authorization.holdTimeoutMs` equals it. usertrust-server advertises each
 * hold's remaining life from that value, so the two must never drift. Self-skips
 * (via `describe.skipIf`) whenever `USERTRUST_TB_ADDRESS` is unset.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGovernor, principalLedgerTags } from "../../src/headless.js";
import { LEDGER_HOLD_TIMEOUT_MS, VAULT_DIR } from "../../src/shared/constants.js";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
});

describe.skipIf(!TB_ADDRESS)("real TigerBeetle — a hold's pending timeout", () => {
	it("the stored pending transfer's timeout is the one the handle publishes", async () => {
		const dir = join(tmpdir(), `tb-hold-timeout-${randomUUID()}`);
		mkdirSync(join(dir, VAULT_DIR), { recursive: true });
		writeFileSync(
			join(dir, VAULT_DIR, "usertrust.config.json"),
			JSON.stringify({ budget: 1_000_000, tigerbeetle: { addresses: [TB_ADDRESS], clusterId: 0 } }),
		);
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const gov = await createGovernor({ vaultBase: dir });
		cleanup.push(() => gov.destroy());

		const unit = `timeout-${randomUUID().slice(0, 8)}`;
		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 10,
			principal: { unit },
		});

		const tbNode = await import("tigerbeetle-node");
		const raw = tbNode.createClient({ cluster_id: 0n, replica_addresses: [TB_ADDRESS as string] });
		cleanup.push(() => raw.destroy());
		const held = await raw.queryTransfers({
			user_data_128: 0n,
			user_data_64: principalLedgerTags({ unit }).userData64,
			user_data_32: 0,
			ledger: 0,
			code: 0,
			timestamp_min: 0n,
			timestamp_max: 0n,
			limit: 10,
			flags: 0,
		});
		expect(held).toHaveLength(1);
		expect((held[0]?.flags ?? 0) & tbNode.TransferFlags.pending).not.toBe(0);
		expect(held[0]?.timeout).toBe(LEDGER_HOLD_TIMEOUT_MS / 1000);
		expect(auth.holdTimeoutMs).toBe((held[0]?.timeout ?? 0) * 1000);

		await gov.abort(auth, new Error("done"));
	});
});
