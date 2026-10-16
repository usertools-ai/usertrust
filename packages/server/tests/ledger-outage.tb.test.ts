// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Real TigerBeetle, stopped and restarted mid-run: an authorize while the ledger is down answers
 * 503 `ledger_unavailable` within the deadline, and the hold the ledger creates when it returns
 * is given back at once by an explicit void, never left to the ledger's pending timeout.
 *
 * The suite starts its OWN single-replica cluster (a fresh `format`ed data file on a free port),
 * stops that process mid-run and restarts it on the same data file and port. It never touches a
 * shared cluster. Self-skips unless `USERTRUST_TB_BINARY` names a `tigerbeetle` binary at the
 * version tigerbeetle-node speaks (CI's tb-integration job downloads it).
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Governor } from "usertrust";
import { createGovernor, readLedgerEvents } from "usertrust";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantConfig } from "../src/config.js";
import { hashKey } from "../src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";
import { createFakeGovernor } from "./helpers/fake-governor.js";

const TB_BINARY = process.env.USERTRUST_TB_BINARY;
const KEY = "ut_outage_key";
const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 1_000, maxOutputTokens: 200 };
const LEDGER_TIMEOUT_MS = 1_000;
const SLACK_MS = 1_500;
const LATE_REASON = "ledger reply after the authorize was refused";

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
	readonly dir = mkdtempSync(join(tmpdir(), "utsrv-tb-"));
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
	"real TigerBeetle stopped and restarted: authorize is bounded, and a late hold is given back at once",
	() => {
		let cluster: Cluster;
		let server: UsertrustServer;
		let base: string;
		let stateDir: string;
		/** Set by a test: runs before the governor's release starts (the void it submits). */
		let beforeRelease: (() => Promise<void>) | undefined;
		const releasesStarted: string[] = [];

		beforeAll(async () => {
			cluster = new Cluster(TB_BINARY as string, await freePort());
			await cluster.start();
			stateDir = mkdtempSync(join(tmpdir(), "utsrv-outage-"));
			const configPath = join(stateDir, "tenant.config.json");
			writeFileSync(
				configPath,
				JSON.stringify({ tigerbeetle: { addresses: [String(cluster.port)], clusterId: 0 } }),
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
					tenants: [tenant],
				},
				// The real governor, its release observed (and, where a test asks, held) before it starts.
				factory: async (opts) => {
					const real: Governor = await createGovernor(opts);
					return Object.assign(Object.create(real) as Governor, {
						release: async (...args: Parameters<Governor["release"]>) => {
							releasesStarted.push(args[0].transferId);
							await beforeRelease?.();
							return real.release(...args);
						},
					});
				},
			});
			const { port } = await server.listen();
			base = `http://127.0.0.1:${port}`;
			// The tenant's governor is created (its accounts written to the fresh cluster) before any
			// timed request: a cold creation on a just-started cluster can outlast the 1 s deadline,
			// which the deadline covers by design and which is not what these rows measure.
			await server.pool.get(tenant);
		}, 120_000);

		afterAll(async () => {
			await server?.close();
			await cluster?.destroy();
			rmSync(stateDir, { recursive: true, force: true });
		}, 120_000);

		const authorize = async () => {
			const started = performance.now();
			const res = await fetch(`${base}/v1/authorize`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
				body: JSON.stringify(AUTHORIZE),
			});
			return {
				status: res.status,
				json: (await res.json()) as Record<string, unknown>,
				ms: performance.now() - started,
			};
		};
		const budget = async () => {
			const res = await fetch(`${base}/v1/budget`, { headers: { authorization: `Bearer ${KEY}` } });
			return (await res.json()) as { remaining: number; voidsOwed: number };
		};
		const lateReleases = () =>
			readLedgerEvents(join(stateDir, "acme", ".usertrust")).filter(
				(e) => e.kind === "hold_released" && (e.data as { reason?: string }).reason === LATE_REASON,
			) as unknown as Array<{ data: { transferId: string; voidError?: string } }>;
		const until = async (check: () => Promise<boolean> | boolean, ms: number): Promise<number> => {
			const started = performance.now();
			while (performance.now() - started < ms) {
				if (await check()) return performance.now() - started;
				await sleep(50);
			}
			throw new Error("timed out waiting");
		};

		it("with the ledger stopped, authorize answers 503 ledger_unavailable within the deadline; restarted, the late hold is voided at once and nothing is stranded", async () => {
			// Warm: the tenant's governor exists and its accounts are on the ledger.
			const warm = await authorize();
			expect(warm.status).toBe(200);
			const given = await fetch(`${base}/v1/release`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
				body: JSON.stringify({ transferId: warm.json.transferId }),
			});
			expect(given.status).toBe(200);
			const before = await budget();
			expect(before.voidsOwed).toBe(0);

			await cluster.stop();
			const refused = await authorize();
			expect(refused.status).toBe(503);
			expect(refused.json).toMatchObject({
				error: "ledger_unavailable",
				retryAfterMs: LEDGER_TIMEOUT_MS,
			});
			expect(refused.ms).toBeLessThan(LEDGER_TIMEOUT_MS + SLACK_MS);
			expect(refused.ms).toBeGreaterThanOrEqual(LEDGER_TIMEOUT_MS - 50);
			// The refused authorize is still queued on the client: the next one fails fast.
			const fast = await authorize();
			expect(fast.status).toBe(503);
			expect(fast.ms).toBeLessThan(LEDGER_TIMEOUT_MS / 2);
			process.stderr.write(
				`ledger-outage: real 503 after ${Math.round(refused.ms)} ms, fast-fail ${Math.round(fast.ms)} ms\n`,
			);

			const restartedAt = performance.now();
			await cluster.start();
			// The late reply lands and its hold is voided explicitly: well before the 300 s timeout.
			const landed = await until(async () => lateReleases().length === 1, 60_000);
			const [record] = lateReleases();
			expect(record?.data.voidError).toBeUndefined();
			await until(async () => (await budget()).voidsOwed === 0, 30_000);
			const after = await budget();
			expect(after.remaining).toBe(before.remaining);
			expect(server.pendingCount()).toBe(0);
			expect(performance.now() - restartedAt).toBeLessThan(60_000);
			process.stderr.write(
				`ledger-outage: late hold voided ${Math.round(landed)} ms after the restart\n`,
			);
			// Reachable again: authorize answers.
			const again = await authorize();
			expect(again.status).toBe(200);
			const back = await fetch(`${base}/v1/release`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
				body: JSON.stringify({ transferId: again.json.transferId }),
			});
			expect(back.status).toBe(200);
		}, 180_000);

		it("a late success whose void meets a second outage: voidsOwed is 1 at once, and the void lands when the ledger returns", async () => {
			const before = await budget();
			let releaseHeld: () => void = () => {};
			const held = new Promise<void>((r) => {
				releaseHeld = r;
			});
			const startedAt = releasesStarted.length;
			// The late hold's release waits until the ledger is down again, then submits its void.
			beforeRelease = async () => {
				releaseHeld();
				await cluster.stop();
			};
			await cluster.stop();
			const refused = await authorize();
			expect(refused.status).toBe(503);
			await cluster.start();
			// The reserve lands; its release starts and stops the cluster before its void is answered.
			await held;
			beforeRelease = undefined;
			expect(releasesStarted.length).toBe(startedAt + 1);
			await sleep(200);
			expect((await budget()).voidsOwed).toBe(1);
			const lateBefore = lateReleases().length;
			await cluster.start();
			await until(async () => (await budget()).voidsOwed === 0, 60_000);
			// An explicit void: the record says so, with no voidError, and the budget is back.
			await until(async () => lateReleases().length === lateBefore + 1, 30_000);
			expect(lateReleases().at(-1)?.data.voidError).toBeUndefined();
			expect((await budget()).remaining).toBe(before.remaining);
			expect(server.pendingCount()).toBe(0);
		}, 180_000);
	},
);

describe.skipIf(!TB_BINARY)("the stub ledger reaches the same failure mode", () => {
	it("an authorize that never settles answers the same 503 within the deadline", async () => {
		const fake = createFakeGovernor();
		let stuck: () => void = () => {};
		const gate = new Promise<void>((r) => {
			stuck = r;
		});
		const governor: Governor = {
			...fake.governor,
			authorize: async (params) => {
				await gate;
				return fake.governor.authorize(params);
			},
		};
		const stateDir = mkdtempSync(join(tmpdir(), `utsrv-stub-${randomUUID()}`));
		const stub = createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir,
				enforcement: "enforce",
				pendingTtlMs: 300_000,
				dryRun: false,
				ledgerTimeoutMs: LEDGER_TIMEOUT_MS,
				tenants: [{ id: "acme", keyHash: hashKey(KEY), budget: 10_000_000 }],
			},
			factory: async () => governor,
		});
		const { port } = await stub.listen();
		const started = performance.now();
		const res = await fetch(`http://127.0.0.1:${port}/v1/authorize`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
			body: JSON.stringify(AUTHORIZE),
		});
		const ms = performance.now() - started;
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({
			error: "ledger_unavailable",
			retryAfterMs: LEDGER_TIMEOUT_MS,
		});
		expect(ms).toBeLessThan(LEDGER_TIMEOUT_MS + SLACK_MS);
		process.stderr.write(`ledger-outage: stub 503 after ${Math.round(ms)} ms\n`);
		stuck();
		await stub.close();
		rmSync(stateDir, { recursive: true, force: true });
	});
});
