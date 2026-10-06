// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Real TigerBeetle — a principal's `user_data` tags on the ledger.
 *
 * The roll-up claim rests on two TigerBeetle behaviours that a mock cannot show:
 *  - a post or void that leaves `user_data_*` at zero INHERITS the pending
 *    transfer's values, so tags written on the hold reach the settlement with no
 *    change to the post path;
 *  - `query_transfers` filters on `user_data_*` (intersection), so work can be
 *    rolled up by agent, unit and role straight from the ledger.
 *
 * Each run uses its own unit and role, so the query below sees only this run's
 * transfers on a long-lived cluster. The suite self-skips (via `describe.skipIf`)
 * whenever `USERTRUST_TB_ADDRESS` is unset.
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

function makeVault(): string {
	const dir = join(tmpdir(), `tb-principal-${randomUUID()}`);
	mkdirSync(join(dir, VAULT_DIR), { recursive: true });
	writeFileSync(
		join(dir, VAULT_DIR, "usertrust.config.json"),
		JSON.stringify({ budget: 1_000_000, tigerbeetle: { addresses: [TB_ADDRESS], clusterId: 0 } }),
	);
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

describe.skipIf(!TB_ADDRESS)("real TigerBeetle — principal ledger tags", () => {
	it("the hold carries the tags, the post and the void INHERIT them, and query_transfers rolls them up", async () => {
		const run = randomUUID().slice(0, 8);
		const principal = {
			id: `agent-${run}`,
			type: "Explore",
			unit: `unit-${run}`,
			role: `role-${run}`,
		};
		const tags = principalLedgerTags(principal);

		const gov = await createGovernor({ vaultBase: makeVault() });
		cleanup.push(() => gov.destroy());
		const settled = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 50,
			principal,
		});
		await gov.settle(settled, { inputTokens: 40, outputTokens: 10 });
		const aborted = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 50,
			principal,
		});
		await gov.abort(aborted, new Error("provider 500"));

		// The RAW client: the server's own answer, with nothing of ours in between.
		const tbNode = await import("tigerbeetle-node");
		const raw = tbNode.createClient({ cluster_id: 0n, replica_addresses: [TB_ADDRESS as string] });
		cleanup.push(() => raw.destroy());
		const query = (filter: {
			user_data_128?: bigint;
			user_data_64?: bigint;
			user_data_32?: number;
		}) =>
			raw.queryTransfers({
				user_data_128: filter.user_data_128 ?? 0n,
				user_data_64: filter.user_data_64 ?? 0n,
				user_data_32: filter.user_data_32 ?? 0,
				ledger: 0,
				code: 0,
				timestamp_min: 0n,
				timestamp_max: 0n,
				limit: 100,
				flags: 0,
			});

		const byUnit = await query({ user_data_64: tags.userData64 });
		const { pending, post_pending_transfer, void_pending_transfer } = tbNode.TransferFlags;
		const kinds = byUnit.map((t) =>
			(t.flags & post_pending_transfer) !== 0
				? "post"
				: (t.flags & void_pending_transfer) !== 0
					? "void"
					: (t.flags & pending) !== 0
						? "pending"
						: "other",
		);
		// Two holds, one posted and one voided — the resolutions were written with ZERO
		// user_data and carry the tags only because TigerBeetle inherited them.
		expect(kinds.sort()).toEqual(["pending", "pending", "post", "void"]);
		for (const t of byUnit) {
			expect(t.user_data_128).toBe(tags.userData128);
			expect(t.user_data_64).toBe(tags.userData64);
			expect(t.user_data_32).toBe(tags.userData32);
		}

		// Intersection: agent ∩ unit ∩ role answers the same four transfers…
		const all = await query({
			user_data_128: tags.userData128,
			user_data_64: tags.userData64,
			user_data_32: tags.userData32,
		});
		expect(all.map((t) => t.id).sort()).toEqual(byUnit.map((t) => t.id).sort());
		// …and a different role in the same unit answers none (the filter is real).
		const otherRole = principalLedgerTags({ role: `other-${run}` }).userData32;
		expect(await query({ user_data_64: tags.userData64, user_data_32: otherRole })).toHaveLength(0);
	});
});
