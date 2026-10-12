// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * usertrust-server creates every tenant vault owner-only — directories 0700, files 0600 —
 * whatever the process umask, and writes nothing outside its `stateDir` (no
 * `.usertrust/patterns/` in its working directory).
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashKey } from "../src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";

const KEY = "ut_vault_perm_key";

/** On Windows usertrust neither sets nor checks modes (see LIMITATIONS.md): these rows are POSIX. */
const onWindows = process.platform === "win32";

// The CLI runs from its TypeScript sources, as cli.test.ts runs it: the preload compiles them
// and resolves `usertrust` to the core's sources, so no package needs building first.
const CLI = join(import.meta.dirname, "..", "src", "cli", "main.ts");
const PRELOAD = join(import.meta.dirname, "helpers", "source-preload.mjs");
/** Covers compiling the sources on a cold CI runner. */
const START_MS = 30_000;

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

/** A localhost port nothing listens on: bound by the OS, then released (the config needs >= 1). */
async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const address = probe.address();
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	if (address === null || typeof address === "string") throw new Error("no port");
	return address.port;
}

let server: UsertrustServer | undefined;
let child: ChildProcess | undefined;
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
	child?.kill("SIGKILL");
	child = undefined;
	process.chdir(savedCwd);
	process.umask(savedUmask);
	for (const d of tracked.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(onWindows).each([
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

/**
 * The real start-up: `usertrust-server --config <file>` as its own process, started in an empty
 * working directory with the umask under test (a child inherits it). The tenant vault, its audit
 * log and its spend ledger are created by the server, from nothing, through the wire.
 */
describe.skipIf(onWindows).each([
	["022", 0o022],
	["000", 0o000],
])("usertrust-server CLI, a vault it creates, under umask %s", (label, mask) => {
	it(
		"every directory is 0700 and every file 0600, and nothing lands in the process's cwd",
		async () => {
			const cwd = mkdtempSync(join(tmpdir(), "utsrv-cli-perm-cwd-"));
			const parent = mkdtempSync(join(tmpdir(), "utsrv-cli-perm-"));
			tracked.push(cwd, parent);
			const stateDir = join(parent, "state");
			const configPath = join(parent, "usertrust-server.config.json");
			writeFileSync(
				configPath,
				JSON.stringify({
					host: "127.0.0.1",
					port: await freePort(),
					stateDir,
					dryRun: true,
					tenants: [{ id: "acme", keyHash: hashKey(KEY), budget: 50_000 }],
				}),
			);

			process.umask(mask);
			let stderr = "";
			const proc = spawn(process.execPath, [CLI, "--config", configPath], {
				cwd,
				env: {
					...process.env,
					NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import "${PRELOAD}"`.trim(),
				},
				stdio: ["ignore", "ignore", "pipe"],
			});
			child = proc;
			process.umask(savedUmask);
			const exited = new Promise<number | null>((resolve) => proc.once("exit", resolve));
			proc.stderr?.setEncoding("utf-8");
			const port = await new Promise<number>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no listen: ${stderr}`)), START_MS);
				proc.stderr?.on("data", (chunk: string) => {
					stderr += chunk;
					const m = /listening on [^\n]*:(\d+)\n/.exec(stderr);
					if (m?.[1] !== undefined) {
						clearTimeout(timer);
						resolve(Number(m[1]));
					}
				});
				void exited.then((code) => reject(new Error(`exited ${code}: ${stderr}`)));
			});

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
			const settle = await fetch(`${base}/v1/settle`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					transferId: await authorize(),
					inputTokens: 200,
					outputTokens: 40,
					usageSource: "provider",
				}),
			});
			expect(settle.status).toBe(200);

			// While it runs, then after a clean shutdown.
			expect.soft(walkModes(stateDir).loose).toEqual([]);
			proc.kill("SIGTERM");
			expect(await exited).toBe(0);
			child = undefined;

			const walk = walkModes(stateDir);
			console.log(
				`server CLI, umask ${label}: ${walk.dirs} dirs, ${walk.files} files, ${walk.loose.length} not owner-only`,
			);
			expect.soft(walk.loose).toEqual([]);
			const vault = join(stateDir, "acme", ".usertrust");
			for (const rel of ["audit/events.jsonl", "audit/events.jsonl.meta", "spend-ledger.json"]) {
				expect.soft(existsSync(join(vault, rel)), rel).toBe(true);
			}
			// Nothing in the server process's working directory.
			expect(readdirSync(cwd)).toEqual([]);
		},
		START_MS * 2,
	);
});
