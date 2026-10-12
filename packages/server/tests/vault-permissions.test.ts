// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * usertrust-server creates every tenant vault owner-only — directories 0700, files 0600 —
 * whatever the process umask, and writes nothing outside its `stateDir` (no
 * `.usertrust/patterns/` in its working directory).
 */

import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashKey } from "../src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";

const KEY = "ut_vault_perm_key";

/** Every directory and file under `root` (root included), and the ones not owner-only. */
function walkModes(root: string): { dirs: number; files: number; loose: string[] } {
	const out = { dirs: 0, files: 0, loose: [] as string[] };
	const visit = (p: string): void => {
		const st = lstatSync(p);
		if (st.isDirectory()) out.dirs++;
		else out.files++;
		if ((st.mode & 0o077) !== 0) {
			out.loose.push(`${relative(root, p) || "."} ${(st.mode & 0o777).toString(8)}`);
		}
		if (st.isDirectory()) for (const name of readdirSync(p)) visit(join(p, name));
	};
	visit(root);
	return out;
}

let server: UsertrustServer | undefined;
let savedCwd: string;
let savedUmask: number;
const tracked: string[] = [];

beforeEach(() => {
	savedCwd = process.cwd();
	savedUmask = process.umask();
});

afterEach(async () => {
	await server?.close();
	server = undefined;
	process.chdir(savedCwd);
	process.umask(savedUmask);
	for (const d of tracked.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.each([
	["022", 0o022],
	["000", 0o000],
])("usertrust-server tenant vault under umask %s", (label, mask) => {
	it("every directory is 0700 and every file 0600, and nothing lands in the working directory", async () => {
		process.umask(mask);
		const cwd = mkdtempSync(join(tmpdir(), "utsrv-perm-cwd-"));
		const parent = mkdtempSync(join(tmpdir(), "utsrv-perm-"));
		tracked.push(cwd, parent);
		process.chdir(cwd);
		// A stateDir that does not exist yet: the server creates it, so it is the server's to close.
		const stateDir = join(parent, "state");

		server = createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir,
				enforcement: "enforce",
				pendingTtlMs: 300_000,
				dryRun: true,
				tenants: [{ id: "t1", keyHash: hashKey(KEY), budget: 50_000 }],
			},
		});
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;
		const headers = { "content-type": "application/json", authorization: `Bearer ${KEY}` };
		const authorize = async (): Promise<string> => {
			const res = await fetch(`${base}/v1/authorize`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					model: "claude-sonnet-4-6",
					estimatedInputTokens: 200,
					maxOutputTokens: 100,
				}),
			});
			expect(res.status).toBe(200);
			return ((await res.json()) as { transferId: string }).transferId;
		};
		const post = async (path: string, body: unknown): Promise<void> => {
			const res = await fetch(`${base}${path}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
			expect(res.status, path).toBe(200);
		};

		await post("/v1/settle", {
			transferId: await authorize(),
			inputTokens: 200,
			outputTokens: 40,
			usageSource: "provider",
		});
		await post("/v1/abort", { transferId: await authorize(), error: "provider failed" });
		await post("/v1/release", { transferId: await authorize(), reason: "unused" });

		// While the server runs: the tenant's audit lock is in the vault too.
		const vault = join(stateDir, "t1", ".usertrust");
		expect(statSync(join(vault, "audit", ".audit-writer.lock")).isFile()).toBe(true);
		expect.soft(walkModes(stateDir).loose).toEqual([]);

		await server.close();
		server = undefined;

		const walk = walkModes(stateDir);
		console.log(
			`server, umask ${label}: ${walk.dirs} dirs, ${walk.files} files, ${walk.loose.length} not owner-only`,
		);
		expect.soft(walk.loose).toEqual([]);
		// The writers named here ran, so the zero above is informative.
		for (const rel of [
			"audit/events.jsonl",
			"audit/events.jsonl.meta",
			"audit/index.json",
			"spend-ledger.json",
			"patterns/memory.json",
		]) {
			expect.soft(existsSync(join(vault, rel)), rel).toBe(true);
		}
		expect(readdirSync(join(vault, "audit", "llm_call")).length).toBeGreaterThan(0);

		// Nothing outside stateDir: no stray `.usertrust/patterns/memory.json` in the cwd.
		expect(readdirSync(cwd)).toEqual([]);
		expect(readdirSync(parent)).toEqual(["state"]);
	});
});
