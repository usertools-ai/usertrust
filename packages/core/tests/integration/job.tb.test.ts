// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Real TigerBeetle — a job is a label on the AUDIT records, and moves no money.
 *
 * A mock engine shows the records carry the job; only a real cluster shows that the
 * label leaves the ledger alone: the labelled hold carries the same `user_data` tags a
 * principal-only hold does (the job takes no tag slot: all three belong to the
 * principal), and a hold released with no usage still names the job it was reserved for.
 * The suite self-skips (via `describe.skipIf`) whenever `USERTRUST_TB_ADDRESS` is unset.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLedgerEvents } from "../../src/audit/read.js";
import { createGovernor, principalLedgerTags } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
});

function makeVault(): string {
	const dir = join(tmpdir(), `tb-job-${randomUUID()}`);
	mkdirSync(join(dir, VAULT_DIR), { recursive: true });
	writeFileSync(
		join(dir, VAULT_DIR, "usertrust.config.json"),
		JSON.stringify({ budget: 1_000_000, tigerbeetle: { addresses: [TB_ADDRESS], clusterId: 0 } }),
	);
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

describe.skipIf(!TB_ADDRESS)("real TigerBeetle — job labels", () => {
	it("llm_call and hold_released carry the job; the hold's user_data tags are the principal's alone", async () => {
		const run = randomUUID().slice(0, 8);
		const principal = { id: `agent-${run}`, unit: `unit-${run}`, role: `role-${run}` };
		const tags = principalLedgerTags(principal);
		const job = `job-${run}`;
		const usageFrom = "2026-01-01T00:00:00.000Z";
		const usageTo = "2026-01-01T00:00:05.000Z";

		const vault = makeVault();
		const gov = await createGovernor({ vaultBase: vault });
		cleanup.push(() => gov.destroy());
		const settled = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 50,
			principal,
			job,
			usageFrom,
		});
		await gov.settle(settled, { inputTokens: 40, outputTokens: 10, usageTo });
		const released = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 50,
			principal,
			job,
			usageFrom,
		});
		await gov.release(released, "no usage");
		await gov.destroy();

		const events = readLedgerEvents(join(vault, VAULT_DIR)) as Array<{
			kind: string;
			data: Record<string, unknown>;
		}>;
		const call = events.find(
			(e) => e.kind === "llm_call" && e.data.transferId === settled.transferId,
		);
		const gave = events.find(
			(e) => e.kind === "hold_released" && e.data.transferId === released.transferId,
		);
		expect(call?.data).toMatchObject({ job, usageFrom, usageTo });
		expect(gave?.data).toMatchObject({ job, usageFrom });

		// The RAW client: the holds' tags are the principal's, with nothing the job added.
		const tbNode = await import("tigerbeetle-node");
		const raw = tbNode.createClient({ cluster_id: 0n, replica_addresses: [TB_ADDRESS as string] });
		cleanup.push(() => raw.destroy());
		const transfers = await raw.queryTransfers({
			user_data_128: tags.userData128,
			user_data_64: tags.userData64,
			user_data_32: tags.userData32,
			ledger: 0,
			code: 0,
			timestamp_min: 0n,
			timestamp_max: 0n,
			limit: 100,
			flags: 0,
		});
		// Two holds, one posted and one voided: four transfers, all under the principal's tags.
		expect(transfers).toHaveLength(4);
		for (const t of transfers) {
			expect(t.user_data_128).toBe(tags.userData128);
			expect(t.user_data_64).toBe(tags.userData64);
			expect(t.user_data_32).toBe(tags.userData32);
		}
	});
});
