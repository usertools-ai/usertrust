// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Real TigerBeetle under the health observer's REAL child: health reads `reachable` against a
 * cold server, `unreachable` once the ledger stops, and `reachable` again once it restarts.
 *
 * The suite starts its OWN single-replica cluster (a fresh `format`ed data file on a free port),
 * stops that process mid-run and restarts it on the same data file and port. It never touches a
 * shared cluster. Self-skips unless `USERTRUST_TB_BINARY` names a `tigerbeetle` binary at the
 * version tigerbeetle-node speaks (CI's tb-integration job downloads it).
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "tigerbeetle-node";
import { createGovernor } from "usertrust";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantConfig } from "../src/config.js";
import { hashKey } from "../src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";

const TB_BINARY = process.env.USERTRUST_TB_BINARY;
const KEY = "ut_health_tb_key";
const LEDGER_TIMEOUT_MS = 1_000;
const PRELOAD = join(import.meta.dirname, "helpers", "source-preload.mjs");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** One single-replica cluster this suite owns: formatted once, started, stopped and restarted on the same file and port. */
class Cluster {
	private process: ChildProcess | undefined;
	readonly dir = mkdtempSync(join(tmpdir(), "utsrv-tb-health-"));
	readonly file = join(this.dir, "0_0.tigerbeetle");
	constructor(
		readonly binary: string,
		readonly port: number,
	) {
		execFileSync(
			binary,
			["format", "--cluster=0", "--replica=0", "--replica-count=1", "--development", this.file],
			{ stdio: "ignore" },
		);
	}
	async start(): Promise<void> {
		this.process = spawn(
			this.binary,
			["start", `--addresses=127.0.0.1:${this.port}`, "--development", this.file],
			{ stdio: "ignore" },
		);
		for (let i = 0; i < 100; i++) {
			if (await accepts(this.port)) return;
			await sleep(100);
		}
		throw new Error("the cluster did not start");
	}
	async stop(): Promise<void> {
		const child = this.process;
		this.process = undefined;
		if (child === undefined || child.exitCode !== null) return;
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGKILL");
		await exited;
	}
	async destroy(): Promise<void> {
		await this.stop();
		rmSync(this.dir, { recursive: true, force: true });
	}
}

describe.skipIf(!TB_BINARY)(
	"real TigerBeetle under the health child: reachable, stopped, restarted",
	() => {
		const savedNodeOptions = process.env.NODE_OPTIONS;
		let cluster: Cluster;
		let server: UsertrustServer;
		let base: string;
		let stateDir: string;

		beforeAll(async () => {
			// The child runs from source here, as the other server suites' children do.
			process.env.NODE_OPTIONS = `${savedNodeOptions ?? ""} --import "${PRELOAD}"`.trim();
			cluster = new Cluster(TB_BINARY as string, await freePort());
			await cluster.start();
			stateDir = mkdtempSync(join(tmpdir(), "utsrv-health-tb-"));
			const configPath = join(stateDir, "tenant.config.json");
			writeFileSync(
				configPath,
				JSON.stringify({
					tigerbeetle: { addresses: [`127.0.0.1:${cluster.port}`], clusterId: 0 },
				}),
			);
			const tenant: TenantConfig = {
				id: "acme",
				keyHash: hashKey(KEY),
				budget: 10_000_000,
				configPath,
			};
			server = createUsertrustServer({
				config: {
					host: "127.0.0.1",
					port: 0,
					stateDir,
					enforcement: "enforce",
					pendingTtlMs: 300_000,
					dryRun: false,
					ledgerTimeoutMs: LEDGER_TIMEOUT_MS,
					ledgerHealth: "child",
					// Short, so a child the restart evicts is back within the row.
					healthRespawnCooldownMs: 1_000,
					tenants: [tenant],
				},
				factory: (opts) => createGovernor(opts),
				// Long, so health's session stays idle between explicit /v1/health pokes: TigerBeetle
				// evicts the least recently ACTIVE session, and a fixed number of newer registrations
				// then always evicts it (a 30 s keep-alive probe would land mid-run and keep it fresh).
				healthKeepAliveMs: 300_000,
			});
			const { port } = await server.listen();
			base = `http://127.0.0.1:${port}`;
		}, 120_000);

		afterAll(async () => {
			if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
			else process.env.NODE_OPTIONS = savedNodeOptions;
			await server?.close();
			await cluster?.destroy();
			rmSync(stateDir, { recursive: true, force: true });
		}, 120_000);

		const health = async () => {
			const res = await fetch(`${base}/v1/health`);
			return { status: res.status, body: (await res.json()) as Record<string, unknown> };
		};
		const budget = async () => {
			const res = await fetch(`${base}/v1/budget`, { headers: { authorization: `Bearer ${KEY}` } });
			return { status: res.status, body: (await res.json()) as Record<string, unknown> };
		};
		/** Polls health until its `ledger` is `want`, for at most `ms`; the last answer either way. */
		const healthUntil = async (want: string, ms: number) => {
			const deadline = Date.now() + ms;
			let answer = await health();
			while (answer.body.ledger !== want && Date.now() < deadline) {
				await sleep(100);
				answer = await health();
			}
			return answer;
		};

		it("a cold server reads reachable, on health and on the tenant's budget", async () => {
			const h = await healthUntil("reachable", 15_000);
			expect(h.status).toBe(200);
			expect(h.body).toMatchObject({ ok: true, ledger: "reachable" });
			const b = await budget();
			expect(b.status).toBe(200);
			expect(b.body).toMatchObject({
				ledger: "reachable",
				ledgerObserver: { failures: 0, lastFailure: null },
			});
		}, 60_000);

		it("the ledger stopped: unreachable, ok false, within the deadline and the slack of one poke", async () => {
			await cluster.stop();
			const stoppedAt = performance.now();
			const h = await healthUntil("unreachable", 3 * LEDGER_TIMEOUT_MS + 2_000);
			expect(h.status).toBe(200);
			expect(h.body).toMatchObject({ ok: false, ledger: "unreachable" });
			expect(performance.now() - stoppedAt).toBeLessThan(3 * LEDGER_TIMEOUT_MS + 2_000);
		}, 60_000);

		it("the ledger restarted: reachable again, ok true", async () => {
			await cluster.start();
			const h = await healthUntil("reachable", 30_000);
			expect(h.body).toMatchObject({ ok: true, ledger: "reachable" });
		}, 60_000);

		// A replica resets connections past a small concurrent-connection limit (measured on 0.17.9: the
		// ~9th open connection never registers), so sessions cannot be held open by the dozen. As
		// core's evicted-client.mts fixture does, the newer sessions register ONE AT A TIME instead.
		// TigerBeetle evicts the least recently ACTIVE session: health's keep-alive is set long above,
		// so its session is idle while the 64 newer ones register, and its next probe is the explicit
		// /v1/health poke after them.
		it("at the session boundary (3 held governors and an idle health child, then 64 newer sessions registered one at a time): nothing crashes, health is evicted and recovers, and every held governor's next call succeeds", async () => {
			const governorOn = async (name: string) => {
				const dir = mkdtempSync(join(stateDir, `${name}-`));
				const configPath = join(dir, "usertrust.config.json");
				writeFileSync(
					configPath,
					JSON.stringify({
						budget: 1_000_000,
						tigerbeetle: { addresses: [`127.0.0.1:${cluster.port}`], clusterId: 0 },
					}),
				);
				return await createGovernor({ vaultBase: dir, configPath, budget: 1_000_000 });
			};
			// Measured on TigerBeetle 0.17.9 `--development`, single replica: the 9th concurrently open
			// connection never registered.
			const MEASURED_OPEN_CONNECTION_STALL = 9;
			const HELD_GOVERNORS = 3;
			// Also open in this process or beside it: the health child, and the server's own governor for
			// the tenant (created by the earlier rows' budget calls).
			expect(
				HELD_GOVERNORS + 2,
				"held-open connections must stay below the replica's connection stall",
			).toBeLessThan(MEASURED_OPEN_CONNECTION_STALL);
			const governors = [];
			for (let i = 0; i < HELD_GOVERNORS; i++) governors.push(await governorOn(`g${i}`));
			// Past the 64 sessions the cluster keeps: 64 newer registrations evict every older one. Each
			// is created, makes one request and is destroyed before the next is created.
			for (let i = 0; i < 64; i++) {
				const other = createClient({
					cluster_id: 0n,
					replica_addresses: [`127.0.0.1:${cluster.port}`],
				});
				await other.lookupAccounts([]);
				other.destroy();
			}
			const observer = async () =>
				(await budget()).body.ledgerObserver as { failures: number; lastFailure: string | null };
			// The explicit next probe: the child learns of its eviction from its own traffic.
			await health();
			// /v1/budget does not poke: it only reads what the probe found.
			const deadline = Date.now() + 30_000;
			while ((await observer()).failures === 0 && Date.now() < deadline) await sleep(250);
			expect(
				(await observer()).failures,
				"health was not evicted after 64 registrations with keep-alive off",
			).toBeGreaterThan(0);
			expect((await observer()).lastFailure).toBe("evicted");
			expect((await healthUntil("reachable", 30_000)).body.ledger).toBe("reachable");
			for (const governor of governors) {
				const auth = await governor.authorize({
					model: "claude-sonnet-4-6",
					estimatedInputTokens: 100,
					maxOutputTokens: 10,
				});
				await governor.release(auth, "boundary row");
				await governor.destroy();
			}
		}, 300_000);
	},
);
