// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Real TigerBeetle: a client the cluster EVICTS is dropped, never destroyed.
 *
 * tigerbeetle-node 0.17.9 aborts the whole process (SIGABRT, "attempt to unwrap error:
 * ClientInvalid") when destroy() is called on an evicted client, and no try/catch can stop
 * it. The reconnect path used to do exactly that on the next request after an eviction, so
 * any process whose session was evicted (a shared cluster past its session limit, or churn)
 * crashed on its next ledger call.
 *
 * Eviction pushes out EVERY older session, so this suite never touches the shared cluster at
 * `USERTRUST_TB_ADDRESS`: it formats and starts its own single-replica cluster on a free port
 * from the binary at `USERTRUST_TB_BINARY`, and removes it after. The client runs in a child
 * process (`fixtures/evicted-client.mts`), so an abort is a failed row, not a crashed worker.
 * The rows for a session pushed out while its client is IDLE (`fixtures/idle-evicted.mts`) each
 * start a cluster of their own, so the cluster's session table holds only what the row put there.
 * Self-skips (via `describe.skipIf`) whenever `USERTRUST_TB_ADDRESS` is unset, and FAILS when
 * it is set without `USERTRUST_TB_BINARY`: that would skip the suite in the one job that runs it.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;
const TB_BINARY = process.env.USERTRUST_TB_BINARY;

const ROOT = resolve(import.meta.dirname, "../../../..");
const FIXTURE = join(import.meta.dirname, "fixtures", "evicted-client.mts");
const IDLE_FIXTURE = join(import.meta.dirname, "fixtures", "idle-evicted.mts");

/** A free local TCP port, from the kernel. */
async function freePort(): Promise<number> {
	return await new Promise((done, fail) => {
		const server = createServer();
		server.once("error", fail);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			server.close(() => done(port));
		});
	});
}

/** Resolves once something accepts connections on `port`, or rejects after `ms`. */
async function listening(port: number, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const ok = await new Promise<boolean>((done) => {
			const socket = new Socket();
			socket.once("connect", () => {
				socket.destroy();
				done(true);
			});
			socket.once("error", () => done(false));
			socket.connect(port, "127.0.0.1");
		});
		if (ok) return;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`no TigerBeetle on port ${port} after ${ms} ms`);
}

interface Run {
	code: number | null;
	signal: NodeJS.Signals | null;
	lines: Array<Record<string, unknown>>;
	stderr: string;
}

/**
 * The fixture in its own process, to its natural end (no process.exit), or killed at `ms`.
 * `goWhen`: once the child's stderr says so, it is sent its go line on stdin.
 */
async function runFixture(
	address: string,
	mode: string,
	ms: number,
	fixture = FIXTURE,
	goWhen?: (stderr: string) => boolean,
): Promise<Run> {
	return await new Promise((done) => {
		const child = spawn(
			process.execPath,
			["--expose-gc", "--import", "tsx", fixture, address, mode],
			{
				cwd: ROOT,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		// A child that never reads it, or has already ended, must not fail the row through its pipe.
		child.stdin.on("error", () => {});
		if (!goWhen) child.stdin.end();
		let stdout = "";
		let stderr = "";
		let sent = false;
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (goWhen && !sent && goWhen(stderr)) {
				sent = true;
				child.stdin.end("go\n");
			}
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), ms);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			const lines = stdout
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			done({ code, signal, lines, stderr });
		});
	});
}

interface Cluster {
	address: string;
	replica: ChildProcess;
	stop(): void;
}

/** A fresh single-replica cluster on a free port, from `USERTRUST_TB_BINARY`. */
async function startCluster(): Promise<Cluster> {
	if (!TB_BINARY) {
		throw new Error(
			"USERTRUST_TB_BINARY is unset: this suite needs a private cluster (eviction pushes out every session)",
		);
	}
	const dir = mkdtempSync(join(tmpdir(), "usertrust-evict-"));
	const data = join(dir, "0_0.tigerbeetle");
	const format = spawnSync(
		TB_BINARY,
		["format", "--cluster=0", "--replica=0", "--replica-count=1", "--development", data],
		{ encoding: "utf8" },
	);
	if (format.status !== 0) throw new Error(`tigerbeetle format failed: ${format.stderr}`);
	const port = await freePort();
	const address = `127.0.0.1:${port}`;
	const replica = spawn(TB_BINARY, ["start", `--addresses=${address}`, "--development", data], {
		stdio: "ignore",
	});
	await listening(port, 60_000);
	return {
		address,
		replica,
		stop() {
			replica.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** The client logged that the cluster evicted it. */
const evictedLogged = (stderr: string): boolean => stderr.includes("session evicted");

/** Where in the child's stderr a step line was written, or -1. */
const stepAt = (stderr: string, step: string): number => stderr.indexOf(`"step":"${step}"`);

describe.skipIf(!TB_ADDRESS)(
	"real TigerBeetle — an evicted client is dropped, never destroyed",
	() => {
		let dir = "";
		let replica: ChildProcess | undefined;
		let address = "";

		beforeAll(async () => {
			if (!TB_BINARY) {
				throw new Error(
					"USERTRUST_TB_BINARY is unset: this suite needs a private cluster (eviction pushes out every session)",
				);
			}
			dir = mkdtempSync(join(tmpdir(), "usertrust-evict-"));
			const data = join(dir, "0_0.tigerbeetle");
			const format = spawnSync(
				TB_BINARY,
				["format", "--cluster=0", "--replica=0", "--replica-count=1", "--development", data],
				{ encoding: "utf8" },
			);
			if (format.status !== 0) throw new Error(`tigerbeetle format failed: ${format.stderr}`);
			const port = await freePort();
			address = `127.0.0.1:${port}`;
			replica = spawn(TB_BINARY, ["start", `--addresses=${address}`, "--development", data], {
				stdio: "ignore",
			});
			await listening(port, 60_000);
		}, 90_000);

		afterAll(() => {
			replica?.kill("SIGKILL");
			if (dir !== "") rmSync(dir, { recursive: true, force: true });
		});

		it("evicted twice (the second time on the fresh client its reconnect built): the process survives, and each next request is answered", async () => {
			const run = await runFixture(address, "2", 240_000);
			// The positive control: the cluster did evict the session.
			expect(run.stderr.match(/session evicted/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
			expect(run.stderr).not.toContain("panic");
			expect({ code: run.code, signal: run.signal }).toEqual({ code: 0, signal: null });
			const cycles = run.lines.filter((line) => line.step === "cycle");
			expect(cycles).toHaveLength(2);
			// The request was answered THROUGH a reconnect: the eviction reached the client.
			for (const cycle of cycles) {
				expect(cycle).toMatchObject({ answered: true });
				expect(Number(cycle.reconnected)).toBeGreaterThanOrEqual(1);
			}
			// destroy() says what it could not release.
			expect(run.stderr).toContain("could not be released");
			// DECLARED (LIMITATIONS): the evicted native client is left open, since destroying it
			// aborts, and keeps the process from ending on its own after destroy(): the fixture's
			// unref'd timer still fires, where the control (the same stdio pipes) ends first.
			// Once tigerbeetle-node can release an evicted client, this flips: drop the declaration.
			expect(run.lines.at(-1)).toMatchObject({ step: "still-alive" });
		}, 300_000);

		it("control: a reconnect of a HEALTHY client (destroy(), then a new client) is unchanged", async () => {
			const run = await runFixture(address, "control", 60_000);
			expect(run.stderr).not.toContain("panic");
			expect({ code: run.code, signal: run.signal }).toEqual({ code: 0, signal: null });
			expect(run.lines.find((line) => line.step === "control")).toMatchObject({
				answered: true,
				reconnects: 1,
			});
			// It ends on its own: the destroyed clients hold nothing.
			expect(run.lines.at(-1)).toMatchObject({ step: "end" });
			expect(run.stderr).not.toContain("could not be released");
		}, 90_000);
	},
);

describe.skipIf(!TB_ADDRESS)(
	"real TigerBeetle — a session pushed out while its client is idle (it fails CLOSED, never EVICTED)",
	() => {
		let cluster: Cluster | undefined;
		afterEach(() => {
			cluster?.replica.kill("SIGCONT");
			cluster?.stop();
			cluster = undefined;
		});

		it("one ordinary request after the client learned of it is answered through a reconnect; the process survives", async () => {
			cluster = await startCluster();
			const run = await runFixture(
				cluster.address,
				"request",
				240_000,
				IDLE_FIXTURE,
				evictedLogged,
			);
			// The positive control: the client learned of its eviction on its own, before the request.
			expect(run.stderr.match(/session evicted/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
			expect(run.stderr.indexOf("session evicted")).toBeLessThan(stepAt(run.stderr, "request"));
			expect(run.stderr).not.toContain("panic");
			expect({ code: run.code, signal: run.signal }).toEqual({ code: 0, signal: null });
			const request = run.lines.find((line) => line.step === "request");
			expect(request).toMatchObject({ answered: true });
			expect(Number(request?.reconnects)).toBeGreaterThanOrEqual(1);
			expect(run.stderr).toContain("could not be released");
			// DECLARED, as above: the evicted native client is left open.
			expect(run.lines.at(-1)).toMatchObject({ step: "still-alive" });
		}, 300_000);

		it("a governor's destroy() after its client learned of it, with no request since, does not abort", async () => {
			cluster = await startCluster();
			const run = await runFixture(
				cluster.address,
				"governor",
				240_000,
				IDLE_FIXTURE,
				evictedLogged,
			);
			// The controls: the health check was held off (it is the request this row must not have),
			// and the client learned of its eviction on its own before destroy().
			expect(run.lines.find((line) => line.step === "start")).toMatchObject({ heldChecks: 1 });
			expect(run.stderr.match(/session evicted/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
			expect(run.stderr.indexOf("session evicted")).toBeLessThan(stepAt(run.stderr, "destroying"));
			expect(run.stderr).not.toContain("panic");
			expect({ code: run.code, signal: run.signal }).toEqual({ code: 0, signal: null });
			// No request reached it before destroy(): close()'s probe is what found it.
			expect(run.lines.find((line) => line.step === "destroyed")).toMatchObject({ reconnects: 0 });
			expect(run.stderr).toContain("could not be released");
			expect(run.lines.at(-1)).toMatchObject({ step: "still-alive" });
			const vault = run.lines.find((line) => line.step === "start")?.vault;
			if (typeof vault === "string") rmSync(vault, { recursive: true, force: true });
		}, 300_000);

		it("close() on a cluster that never answers its probe destroys the client after the bound, and the process ends on its own", async () => {
			const own = await startCluster();
			cluster = own;
			const run = await runFixture(own.address, "timeout", 60_000, IDLE_FIXTURE, (stderr) => {
				if (stepAt(stderr, "start") < 0) return false;
				own.replica.kill("SIGSTOP");
				return true;
			});
			expect(run.stderr).not.toContain("panic");
			expect({ code: run.code, signal: run.signal }).toEqual({ code: 0, signal: null });
			const destroyed = run.lines.find((line) => line.step === "destroyed");
			// The probe's bound (2 s) ran out, and destroy() followed.
			expect(Number(destroyed?.ms)).toBeGreaterThanOrEqual(1_900);
			expect(Number(destroyed?.ms)).toBeLessThan(10_000);
			expect(run.stderr).not.toContain("could not be released");
			// It ends on its own: the destroyed client holds nothing.
			expect(run.lines.at(-1)).toMatchObject({ step: "end" });
		}, 90_000);
	},
);
