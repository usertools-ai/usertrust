// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A tenant vault written by an earlier usertrust-server, opened by this one.
 *
 * The audit writer refuses a chain of several events that has no `.meta` anchor (`ANCHOR_MISSING`).
 * A vault a server user already has must not hit that on upgrade. Every released writer writes
 * `{ lastHash, sequence }` to `events.jsonl.meta` after each append, and these fixtures are vaults
 * written through the 5.0.0 and 5.0.1 server path: a dryRun tenant, 14 authorize/settle and 2
 * authorize/abort calls over HTTP, 16 events. Each is taken as it is: it verifies with its tail at its
 * anchor, and this server goes on appending to the same chain.
 *
 * The chain files (`audit/events.jsonl` and its `.meta`) are byte for byte what that release wrote. The
 * JSON side files (the receipt index and receipts, the spend ledger, the budget record) are the same
 * values reformatted by the repo's formatter.
 */

import {
	chmodSync,
	cpSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyVault } from "usertrust";
import {
	verifyVault as standaloneVerifyVault,
	verifyVaultReading as standaloneVerifyVaultReading,
} from "usertrust-verify";
import { afterEach, describe, expect, it } from "vitest";
import { hashKey } from "../src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";

const KEY = "ut_compat_fixture_key";
const TENANT = "tenant-a";
const FIXTURES = join(import.meta.dirname, "fixtures");

let server: UsertrustServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
	await server?.close();
	server = undefined;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Owner-only, as the server wrote it (a checkout's modes are not the vault's). */
function ownerOnly(path: string): void {
	chmodSync(path, statSync(path).isDirectory() ? 0o700 : 0o600);
	if (statSync(path).isDirectory()) for (const e of readdirSync(path)) ownerOnly(join(path, e));
}

/** A server state directory holding the fixture as its tenant's vault. */
function stateDirWith(release: string): { stateDir: string; vault: string } {
	const stateDir = mkdtempSync(join(tmpdir(), "utsrv-compat-"));
	dirs.push(stateDir);
	const vault = join(stateDir, TENANT, ".usertrust");
	cpSync(join(FIXTURES, `vault-${release}-dryrun`), vault, { recursive: true });
	ownerOnly(join(stateDir, TENANT));
	return { stateDir, vault };
}

for (const release of ["5.0.0", "5.0.1"]) {
	describe(`a dryRun tenant vault written by usertrust-server ${release}`, () => {
		it("verifies in both verifiers, its tail at its anchor", () => {
			const { vault } = stateDirWith(release);
			const result = verifyVault(vault);
			expect(result).toMatchObject({ valid: true, chainLength: 16, errors: [] });
			expect(result.tailState?.state).toBe("MATCH");
			expect(standaloneVerifyVault(vault)).toMatchObject({ valid: true, chainLength: 16 });
		});

		it("this server opens it and appends to the same chain: authorize and settle, then verified", async () => {
			const { stateDir, vault } = stateDirWith(release);
			const before = readFileSync(join(vault, "audit", "events.jsonl"));
			server = createUsertrustServer({
				config: {
					host: "127.0.0.1",
					port: 0,
					stateDir,
					enforcement: "enforce",
					pendingTtlMs: 300_000,
					dryRun: true,
					tenants: [{ id: TENANT, keyHash: hashKey(KEY), budget: 1_000_000 }],
				},
			});
			const { port } = await server.listen();
			const base = `http://127.0.0.1:${port}`;
			const headers = { "content-type": "application/json", authorization: `Bearer ${KEY}` };
			const authorized = await fetch(`${base}/v1/authorize`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					model: "claude-sonnet-4-6",
					estimatedInputTokens: 200,
					maxOutputTokens: 100,
					actor: "compat-fixture",
				}),
			});
			expect(authorized.status).toBe(200);
			const { transferId } = (await authorized.json()) as { transferId: string };
			const settled = await fetch(`${base}/v1/settle`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					transferId,
					inputTokens: 200,
					outputTokens: 40,
					usageSource: "provider",
				}),
			});
			expect(settled.status).toBe(200);
			expect(((await settled.json()) as { settled: boolean }).settled).toBe(true);
			await server.close();
			server = undefined;

			// The earlier release's events are untouched, and the new one chains from them.
			const after = readFileSync(join(vault, "audit", "events.jsonl"));
			expect(after.subarray(0, before.length).equals(before)).toBe(true);
			const result = verifyVault(vault);
			expect(result).toMatchObject({ valid: true, errors: [] });
			expect(result.chainLength).toBeGreaterThan(16);
			expect(result.tailState?.state).toBe("MATCH");
			const reading = standaloneVerifyVaultReading(vault);
			expect(reading.result).toMatchObject({ valid: true, chainLength: result.chainLength });
			expect(
				reading.events.some((e) => (e.data as { transferId?: unknown }).transferId === transferId),
			).toBe(true);
		});
	});
}
