// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Real TigerBeetle: at shutdown, one tenant whose ledger session the cluster pushed out while it
 * was idle must not take the other tenants' teardown down with it.
 *
 * The pool tears every tenant's governor down at once. A ledger client the cluster evicted, and
 * that learned of it from its own traffic (it fails every request "closed" from then on), aborts
 * the process if it is destroyed (tigerbeetle-node 0.17.9: SIGABRT, "attempt to unwrap error:
 * ClientInvalid"). Before the governor's teardown asked its client first, that abort landed while
 * the other tenant was still voiding its holds and writing their records: those records were
 * lost, and its audit lock was left behind.
 *
 * The governors run in a child process (`helpers/evicted-tenant.ts`), so an abort is a failed
 * row. The suite starts its OWN single-replica cluster, since eviction pushes out sessions, and
 * never touches a shared one. Self-skips unless `USERTRUST_TB_BINARY` names a `tigerbeetle`
 * binary at the version tigerbeetle-node speaks (CI's tb-integration job downloads it).
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TB_BINARY = process.env.USERTRUST_TB_BINARY;
const PRELOAD = join(import.meta.dirname, "helpers", "source-preload.mjs");
const FIXTURE = join(import.meta.dirname, "helpers", "evicted-tenant.ts");
/** helpers/evicted-tenant.ts's HOLDS: the holds tenant `b` has when the pool is torn down. */
const HOLDS = 20;

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

async function accepts(port: number): Promise<boolean> {
	return await new Promise((resolve) => {
		const socket = createConnection({ port, host: "127.0.0.1" });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

interface Run {
	code: number | null;
	signal: NodeJS.Signals | null;
	lines: Array<Record<string, unknown>>;
	stderr: string;
}

/** Each audit record a tenant's vault holds, oldest first. */
function auditRecords(
	stateDir: string,
	id: string,
): Array<{ kind: string; data: Record<string, unknown> }> {
	const path = join(stateDir, id, ".usertrust", "audit", "events.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
}

describe.skipIf(!TB_BINARY)(
	"real TigerBeetle — the pool's shutdown with one tenant's session pushed out while idle",
	() => {
		let dir = "";
		let replica: ChildProcess | undefined;
		let port = 0;

		beforeAll(async () => {
			dir = mkdtempSync(join(tmpdir(), "utsrv-evict-"));
			const data = join(dir, "0_0.tigerbeetle");
			execFileSync(
				TB_BINARY as string,
				["format", "--cluster=0", "--replica=0", "--replica-count=1", "--development", data],
				{ stdio: "ignore" },
			);
			port = await freePort();
			replica = spawn(
				TB_BINARY as string,
				["start", `--addresses=127.0.0.1:${port}`, "--development", data],
				{ stdio: "ignore" },
			);
			for (let i = 0; i < 600 && !(await accepts(port)); i++) {
				await new Promise((r) => setTimeout(r, 100));
			}
		}, 90_000);

		afterAll(() => {
			replica?.kill("SIGKILL");
			if (dir !== "") rmSync(dir, { recursive: true, force: true });
		});

		it("the evicted tenant's destroy() does not abort, and the other tenant's holds are all voided and recorded, its audit lock released", async () => {
			const stateDir = mkdtempSync(join(tmpdir(), "utsrv-evict-state-"));
			writeFileSync(
				join(stateDir, "tenant.config.json"),
				JSON.stringify({ tigerbeetle: { addresses: [String(port)], clusterId: 0 } }),
			);
			try {
				const run = await new Promise<Run>((done) => {
					const child = spawn(
						process.execPath,
						["--import", PRELOAD, FIXTURE, String(port), stateDir],
						{ stdio: ["pipe", "pipe", "pipe"] },
					);
					let stdout = "";
					let stderr = "";
					let sent = false;
					child.stdout.on("data", (chunk: Buffer) => {
						stdout += chunk.toString();
					});
					child.stderr.on("data", (chunk: Buffer) => {
						stderr += chunk.toString();
						// `a`'s client learned of its eviction: go on, with no request since.
						if (!sent && stderr.includes("session evicted")) {
							sent = true;
							child.stdin.end("go\n");
						}
					});
					const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
					child.on("exit", (code, signal) => {
						clearTimeout(timer);
						const lines = stdout
							.split("\n")
							.filter((line) => line.startsWith("{"))
							.map((line) => JSON.parse(line) as Record<string, unknown>);
						done({ code, signal, lines, stderr });
					});
				});

				// The controls: the health check was held off for both clients, ONE session was
				// evicted (`a`'s), and no request reached it, nor `b`, through a reconnect.
				expect(run.lines.find((line) => line.step === "start")).toMatchObject({ heldChecks: 2 });
				expect(run.stderr.match(/session evicted/g)?.length ?? 0).toBe(1);
				expect(run.lines.find((line) => line.step === "destroying")).toMatchObject({
					reconnects: 0,
				});
				expect(run.stderr).not.toContain("panic");
				expect({ code: run.code, signal: run.signal }).toEqual({ code: 0, signal: null });
				expect(run.lines.find((line) => line.step === "destroyed")).toMatchObject({
					reconnects: 0,
				});
				// `b`'s teardown finished: every hold voided and recorded, its lock released.
				const released = auditRecords(stateDir, "b").filter(
					(e) => e.kind === "hold_released" && e.data.reason === "governor destroyed",
				);
				expect(released).toHaveLength(HOLDS);
				expect(released.every((e) => e.data.voidError === undefined)).toBe(true);
				expect(existsSync(join(stateDir, "b", ".usertrust", "audit", ".audit-writer.lock"))).toBe(
					false,
				);
				expect(existsSync(join(stateDir, "a", ".usertrust", "audit", ".audit-writer.lock"))).toBe(
					false,
				);
				// DECLARED (LIMITATIONS §14): `a`'s evicted native client is left open, and says so.
				expect(run.stderr).toContain("could not be released");
				expect(run.lines.at(-1)).toMatchObject({ step: "still-alive" });
			} finally {
				rmSync(stateDir, { recursive: true, force: true });
			}
		}, 300_000);
	},
);
