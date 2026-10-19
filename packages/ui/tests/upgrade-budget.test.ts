// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Upgrading from a release that never wrote the enforced-budget record. A vault written only by usertrust 5.0.0 has no
 * `effective-budget.json`, and its budget reached the governor in memory only, so the vault carries it nowhere. A
 * governor of a later release published the record only at its first append (when it takes the vault's writer lock),
 * so after the upgrade the dashboard read "budget unknown" while the server's status already answered, until the first
 * governed call arrived. A governor now publishes at its start wherever no record stands.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyVault } from "../../core/src/audit/verify.js";
import { hashKey, type ServerConfig } from "../../server/src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../../server/src/server.js";
import { createUiServer, type UiServer } from "../src/server/server.js";
import { loadState } from "../src/server/state.js";
import type { SummaryPayload } from "../src/shared/api.js";
import { VAULT_5_0_0, VAULT_5_0_0_BUDGET, VAULT_5_0_0_SPENT } from "./fixtures/vault-5.0.0.js";

const KEY = "ut_upgrade_key";
const TENANT = "acme";

let stateDir: string;
let vaultPath: string;
let api: UsertrustServer | undefined;
let ui: UiServer | undefined;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "ut-upgrade-"));
	vaultPath = join(stateDir, TENANT, ".usertrust");
	for (const file of VAULT_5_0_0) {
		const path = join(vaultPath, file.path);
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, file.text, { mode: 0o600 });
	}
});

afterEach(async () => {
	await ui?.close();
	ui = undefined;
	await api?.close();
	api = undefined;
	rmSync(stateDir, { recursive: true, force: true });
});

function serverConfig(): ServerConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		stateDir,
		enforcement: "enforce",
		pendingTtlMs: 300_000,
		dryRun: true,
		tenants: [{ id: TENANT, keyHash: hashKey(KEY), budget: VAULT_5_0_0_BUDGET }],
	};
}

async function summary(port: number): Promise<SummaryPayload> {
	const res = await fetch(`http://127.0.0.1:${port}/api/summary`);
	expect(res.status).toBe(200);
	return (await res.json()) as SummaryPayload;
}

function eventLog(): string {
	return readFileSync(join(vaultPath, "audit", "events.jsonl"), "utf-8");
}

describe("a vault only usertrust 5.0.0 wrote", () => {
	it("is what that release wrote: every file's bytes, a chain of two events that verifies, and no budget in it", () => {
		for (const file of VAULT_5_0_0) {
			const bytes = readFileSync(join(vaultPath, file.path));
			expect(createHash("sha256").update(bytes).digest("hex"), file.path).toBe(file.sha256);
		}
		expect(verifyVault(vaultPath)).toMatchObject({
			valid: true,
			errors: [],
			chainLength: 2,
			validHashes: 2,
		});
		// The control: with no governor running, nothing in the vault gives a budget, and the dashboard says so.
		expect(loadState(vaultPath).summary).toMatchObject({
			spentUt: VAULT_5_0_0_SPENT,
			budget: null,
			budgetSource: "unpublished",
			remainingUt: null,
		});
	});

	it("red-first (budget unknown until a call): once the server's governor starts, the dashboard and the server's status read the enforced budget, with no new event", {
		timeout: 20_000,
	}, async () => {
		const before = eventLog();
		ui = await createUiServer(join(stateDir, TENANT), { port: 0 });
		// No governor yet: unknown, truthfully.
		expect((await summary(ui.port)).budgetSource).toBe("unpublished");

		api = createUsertrustServer({ config: serverConfig(), log: () => {} });
		const { port } = await api.listen();
		// The server's status: its first request starts the tenant's governor, which appends nothing.
		const res = await fetch(`http://127.0.0.1:${port}/v1/budget`, {
			headers: { authorization: `Bearer ${KEY}` },
		});
		expect(res.status).toBe(200);
		const status = (await res.json()) as { remaining: number };
		expect(status.remaining).toBe(VAULT_5_0_0_BUDGET - VAULT_5_0_0_SPENT);

		// The dashboard, polling the vault as it does, reads the enforced budget: the status's figure, not unknown.
		let shown: SummaryPayload | undefined;
		await vi.waitFor(
			async () => {
				shown = await summary((ui as UiServer).port);
				expect(shown.budgetSource).toBe("governor");
			},
			{ timeout: 10_000, interval: 100 },
		);
		expect(shown).toMatchObject({
			budget: VAULT_5_0_0_BUDGET,
			budgetSource: "governor",
			budgetProvenance: expect.stringMatching(/^the enforced budget, as of \d{4}-/),
			spentUt: VAULT_5_0_0_SPENT,
			remainingUt: status.remaining,
		});
		// So do the vault's other readers (inspect, health, report read the same source).
		expect(loadState(vaultPath).summary).toMatchObject({
			budget: VAULT_5_0_0_BUDGET,
			budgetSource: "governor",
			remainingUt: status.remaining,
		});
		// No governed event arrived: the chain is the one 5.0.0 wrote, byte for byte.
		expect(eventLog()).toBe(before);
		expect(shown?.chain.events).toBe(2);
	});
});
