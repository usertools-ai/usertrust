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
 * Self-skips (via `describe.skipIf`) whenever `USERTRUST_TB_ADDRESS` is unset, and FAILS when
 * it is set without `USERTRUST_TB_BINARY`: that would skip the suite in the one job that runs it.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;
const TB_BINARY = process.env.USERTRUST_TB_BINARY;

const ROOT = resolve(import.meta.dirname, "../../../..");
const FIXTURE = join(import.meta.dirname, "fixtures", "evicted-client.mts");

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

/** The fixture in its own process, to its natural end (no process.exit), or killed at `ms`. */
async function runFixture(address: string, mode: string, ms: number): Promise<Run> {
	return await new Promise((done) => {
		const child = spawn(
			process.execPath,
			["--expose-gc", "--import", "tsx", FIXTURE, address, mode],
			{
				cwd: ROOT,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
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
