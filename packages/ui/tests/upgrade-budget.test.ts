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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function serverConfig(budget = VAULT_5_0_0_BUDGET): ServerConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		stateDir,
		enforcement: "enforce",
		pendingTtlMs: 300_000,
		dryRun: true,
		tenants: [{ id: TENANT, keyHash: hashKey(KEY), budget }],
	};
}

async function summary(port: number): Promise<SummaryPayload> {
	const res = await fetch(`http://127.0.0.1:${port}/api/summary`);
	expect(res.status).toBe(200);
	return (await res.json()) as SummaryPayload;
}

async function status(port: number): Promise<number> {
	const res = await fetch(`http://127.0.0.1:${port}/v1/budget`, {
		headers: { authorization: `Bearer ${KEY}` },
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { remaining: number }).remaining;
}

function post(port: number, path: string, body: unknown): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
		body: JSON.stringify(body),
	});
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
		// At rest after a clean shutdown, 5.0.0 leaves no writer lock: its destroy() released it.
		expect(VAULT_5_0_0.map((f) => f.path)).not.toContain("audit/.audit-writer.lock");
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

	it("a record an earlier process published stands, with its age, when the server restarts with a changed budget; the first append replaces it", {
		timeout: 20_000,
	}, async () => {
		// An earlier run's governor published its budget at its start (no lock) and exited before any call.
		const OLD = "2026-10-01T00:00:00.000Z";
		const earlier = JSON.stringify({
			budget: VAULT_5_0_0_BUDGET,
			writtenAt: OLD,
			pid: 1,
			processStartedAt: OLD,
		});
		writeFileSync(join(vaultPath, "effective-budget.json"), earlier, { mode: 0o600 });
		const changed = VAULT_5_0_0_BUDGET + 10_000;
		ui = await createUiServer(join(stateDir, TENANT), { port: 0 });
		api = createUsertrustServer({ config: serverConfig(changed), log: () => {} });
		const { port } = await api.listen();
		expect(await status(port)).toBe(changed - VAULT_5_0_0_SPENT);
		// No append yet: the earlier record stands, shown "as of" its time, never the new budget. This is how a lock
		// holder's record already persists across a restart; only the lock holder replaces a record. On disk first: the
		// start neither replaced nor removed it.
		expect(readFileSync(join(vaultPath, "effective-budget.json"), "utf-8")).toBe(earlier);
		const stale = {
			budget: VAULT_5_0_0_BUDGET,
			budgetSource: "governor",
			budgetWrittenAt: OLD,
			budgetProvenance: `the enforced budget, as of ${OLD}`,
		};
		expect(loadState(vaultPath).summary).toMatchObject(stale);
		// The dashboard polls the record every second: after more than two polls it still shows the earlier one.
		await new Promise((r) => setTimeout(r, 2_500));
		expect(await summary(ui.port)).toMatchObject(stale);
		// The first governed call appends, so this process holds the lock and publishes the budget it enforces.
		const auth = await post(port, "/v1/authorize", {
			model: "claude-haiku-4-5",
			estimatedInputTokens: 100,
			maxOutputTokens: 50,
		});
		expect(auth.status).toBe(200);
		const { transferId } = (await auth.json()) as { transferId: string };
		const settled = await post(port, "/v1/settle", {
			transferId,
			inputTokens: 100,
			outputTokens: 40,
		});
		expect(settled.status).toBe(200);
		const remaining = await status(port);
		let shown: SummaryPayload | undefined;
		await vi.waitFor(
			async () => {
				shown = await summary((ui as UiServer).port);
				expect(shown.budget).toBe(changed);
				expect(shown.remainingUt).toBe(remaining);
			},
			{ timeout: 10_000, interval: 100 },
		);
		expect(shown?.budgetWrittenAt).not.toBe(OLD);
	});

	it("red-first (a confident wrong figure): while a 5.0.0 process holds the vault (its lock is there), the new server's budget is not published; the budget stays unknown", {
		timeout: 20_000,
	}, async () => {
		// The lock a 5.0.0 writer holds: its own format (pid, writer id, start), with no lease. A rolling upgrade: that
		// process still runs, enforcing a budget of its own, and never publishes a record.
		const lock = join(vaultPath, "audit", ".audit-writer.lock");
		const content = JSON.stringify({
			pid: 1,
			writerId: "00000000-0000-4000-8000-000000000000",
			startedAt: "2026-10-01T00:00:00.000Z",
		});
		writeFileSync(lock, content, { mode: 0o600 });
		ui = await createUiServer(join(stateDir, TENANT), { port: 0 });
		api = createUsertrustServer({
			config: serverConfig(VAULT_5_0_0_BUDGET + 10_000),
			log: () => {},
		});
		const { port } = await api.listen();
		// The new server's governor is running (its status answers), and it published nothing.
		expect(await status(port)).toBe(VAULT_5_0_0_BUDGET + 10_000 - VAULT_5_0_0_SPENT);
		expect(existsSync(join(vaultPath, "effective-budget.json"))).toBe(false);
		expect(loadState(vaultPath).summary).toMatchObject({
			budget: null,
			budgetSource: "unpublished",
			remainingUt: null,
		});
		// After more than two of the dashboard's polls: still unknown, never the new server's figure.
		await new Promise((r) => setTimeout(r, 2_500));
		expect(await summary(ui.port)).toMatchObject({
			budget: null,
			budgetSource: "unpublished",
			remainingUt: null,
		});
		expect(readFileSync(lock, "utf-8")).toBe(content);
	});
});
