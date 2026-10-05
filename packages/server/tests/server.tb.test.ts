// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The DEFAULT server configuration against a REAL TigerBeetle cluster.
 *
 * The other half of usertools-ai/usertrust#131. `tests/integration.test.ts` proves
 * the default config FAILS LOUD when the ledger is unreachable; this proves it
 * SUCCEEDS when the ledger is there. Both are needed, and the second is the one a
 * deadline can quietly break: a guard that refuses everything passes every
 * failure-mode test ever written. Without this, "the shipped default has never
 * been run by a test" would still be true — only the error path would be covered.
 *
 * Every other server test either injects `createFakeGovernor` or runs in dryRun,
 * so this is the ONLY place the server drives a real governor over a real ledger.
 *
 * Self-skips (`describe.skipIf`) when `USERTRUST_TB_ADDRESS` is absent, which is
 * what keeps the ordinary `test` job green without a cluster. The `tb-integration`
 * CI job exports it and names this file explicitly.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashKey } from "../src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;
const KEY = "ut_tb_default_key";

let server: UsertrustServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

describe.skipIf(!TB_ADDRESS)("real TigerBeetle — the DEFAULT (non-dryRun) server config", () => {
	it("authorize -> settle over a real ledger, with dryRun left at its default", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-tb-"));
		const configPath = join(stateDir, "usertrust.config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				budget: 50_000,
				tigerbeetle: { addresses: [TB_ADDRESS], clusterId: 0 },
			}),
			"utf-8",
		);

		server = createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir,
				enforcement: "enforce",
				pendingTtlMs: 300_000,
				requestTimeoutMs: 10_000,
				// The whole point: the shipped default, over a real ledger. The
				// connectTimeoutMs left at its 5s default must NOT fire against a
				// healthy cluster — if it ever does, this test is where that surfaces.
				dryRun: false,
				tenants: [{ id: "real", keyHash: hashKey(KEY), budget: 50_000, configPath }],
			},
		});
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;
		const headers = { "content-type": "application/json", authorization: `Bearer ${KEY}` };

		const authRes = await fetch(`${base}/v1/authorize`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "claude-sonnet-4-6",
				estimatedInputTokens: 200,
				maxOutputTokens: 100,
				actor: "tb-default-test",
			}),
		});
		expect(authRes.status).toBe(200);
		const auth = (await authRes.json()) as { transferId: string; estimatedCost: number };
		expect(auth.estimatedCost).toBeGreaterThan(0);

		const settleRes = await fetch(`${base}/v1/settle`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				transferId: auth.transferId,
				inputTokens: 200,
				outputTokens: 40,
				usageSource: "provider",
			}),
		});
		expect(settleRes.status).toBe(200);
		const receipt = (await settleRes.json()) as {
			settled: boolean;
			cost: number;
			auditHash: string;
			budgetRemaining: number;
		};
		expect(receipt.settled).toBe(true);
		expect(receipt.auditHash).toMatch(/^[0-9a-f]{16,}$/);
		// The hold was real: the ledger debited it, so the budget actually moved.
		expect(receipt.budgetRemaining).toBeLessThan(50_000);

		const budgetRes = await fetch(`${base}/v1/budget`, { headers });
		expect(budgetRes.status).toBe(200);
		expect((await budgetRes.json()) as { remaining: number }).toEqual({
			remaining: receipt.budgetRemaining,
		});
	}, 30_000);
});
