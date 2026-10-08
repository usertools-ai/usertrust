// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Real TigerBeetle — a per-tier authorize is ONE pending transfer of the per-tier cost.
 *
 * The unit suite pins the amount the governor asks for; this pins what the ledger
 * actually holds: a single PENDING transfer whose amount is the per-tier hold, and
 * which the abort voids. The call is found by its principal's unit tag (#227), so
 * the query sees only this run's transfers on a long-lived cluster. Self-skips
 * (via `describe.skipIf`) whenever `USERTRUST_TB_ADDRESS` is unset.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGovernor, principalLedgerTags } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
});

describe.skipIf(!TB_ADDRESS)("real TigerBeetle — per-tier authorize hold", () => {
	it("holds exactly the per-tier cost as ONE pending transfer, and the abort voids it", async () => {
		const dir = join(tmpdir(), `tb-tiers-${randomUUID()}`);
		mkdirSync(join(dir, VAULT_DIR), { recursive: true });
		writeFileSync(
			join(dir, VAULT_DIR, "usertrust.config.json"),
			JSON.stringify({ budget: 1_000_000, tigerbeetle: { addresses: [TB_ADDRESS], clusterId: 0 } }),
		);
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const gov = await createGovernor({ vaultBase: dir });
		cleanup.push(() => gov.destroy());

		const unit = `tiers-${randomUUID().slice(0, 8)}`;
		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 150,
			estimatedCacheReadTokens: 82_000,
			estimatedCacheWriteTokens: 2_000,
			maxOutputTokens: 1_000,
			principal: { unit },
		});
		// Hand-computed from the published Sonnet rates (30 / 150 / 3 / 37.5 per 1k):
		// A headless authorize cannot see the cache TTLs, so fresh input and the stated write
		// are held at the 1-hour write rate (60 = 2x input): fresh 150 x 60 + read 82,000 x 3
		// + write 2,000 x 60 + out 1,000 x 150 = 9 + 246 + 120 + 150 = 525. The old all-input
		// sizing of the same window would hold 5,199.
		expect(auth.estimatedCost).toBe(525);

		const tbNode = await import("tigerbeetle-node");
		const raw = tbNode.createClient({ cluster_id: 0n, replica_addresses: [TB_ADDRESS as string] });
		cleanup.push(() => raw.destroy());
		const byUnit = () =>
			raw.queryTransfers({
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
		const { pending, void_pending_transfer } = tbNode.TransferFlags;

		const held = await byUnit();
		expect(held).toHaveLength(1);
		expect((held[0]?.flags ?? 0) & pending).not.toBe(0);
		expect(held[0]?.amount).toBe(525n);

		await gov.abort(auth, new Error("provider 500"));
		const after = await byUnit();
		expect(after).toHaveLength(2);
		const voided = after.find((t) => (t.flags & void_pending_transfer) !== 0);
		expect(voided?.pending_id).toBe(held[0]?.id);
	});
});
