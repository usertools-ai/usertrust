// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A governor pointed at a ledger that is not running fails within a second, with its fix, in its
 * own process: `trust()` and `createGovernor()` against a loopback port nothing listens on.
 *
 * The native TigerBeetle client retries a refused connection forever, so before the preflight such a
 * call never returned. Each row runs a child process (tsx), and the child reports how long the call
 * took, from inside, so the interpreter's start-up is not counted. That the child's stderr holds no
 * `message_bus` line (the native client's own connection log) shows no native client was built.
 *
 * The control runs the native client alone against the same port: it is still unanswered after 3 s,
 * which is the hang the preflight prevents. A test that only saw a fast failure could not tell the
 * preflight from a port that happens to answer quickly.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CHILD = join(import.meta.dirname, "fixtures", "fail-fast-child.mts");
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const ROOT = resolve(import.meta.dirname, "../../../..");
/** Well past a run's own time, well short of a hang. */
const BOUND_MS = 30_000;

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
	killed: boolean;
}

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A loopback port nothing listens on: bound, read, and closed again. */
async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no port");
	await new Promise<void>((done) => server.close(() => done()));
	return address.port;
}

async function run(mode: "trust" | "governor" | "raw", port: number): Promise<Run> {
	const dir = mkdtempSync(join(tmpdir(), "trust-fail-fast-"));
	dirs.push(dir);
	const configPath = join(dir, "usertrust.config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			budget: 50_000,
			tigerbeetle: { addresses: [`127.0.0.1:${port}`], clusterId: 0 },
		}),
	);
	return await new Promise((done) => {
		const child = spawn(
			process.execPath,
			["--import", TSX, CHILD, mode, configPath, dir, `127.0.0.1:${port}`],
			{ cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		let killed = false;
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		// timing: kills a child that has not reported in time; the longest child ran 3.2 s (the control), so the kill bound leaves wide headroom.
		const timer = setTimeout(() => {
			killed = true;
			child.kill("SIGKILL");
		}, BOUND_MS);
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ code, stdout, stderr, killed });
		});
	});
}

function report(r: Run): { outcome: string; ms: number; message: string } {
	const line = r.stdout.split("\n").find((l) => l.startsWith("{"));
	expect(line, `no report; stderr: ${r.stderr}`).toBeDefined();
	return JSON.parse(line as string);
}

describe("a governor with no ledger fails fast, with its fix", () => {
	for (const mode of ["trust", "governor"] as const) {
		it(`${mode}(): rejects in under a second naming the fix, and exits nonzero on its own`, async () => {
			const port = await unusedPort();
			const r = await run(mode, port);
			expect(r.killed).toBe(false);
			expect(r.code).toBe(1);
			const out = report(r);
			expect(out.outcome).toBe("rejected");
			// timing: 1 s bound on the call itself, measured inside the child; a refused loopback connect answers in about 1 ms, so it took 15-40 ms here (5 runs).
			expect(out.ms).toBeLessThan(1_000);
			expect(out.message).toContain(`No ledger is running at 127.0.0.1:${port}`);
			expect(out.message).toContain("npx usertrust tb start");
			// No native client was built: it would have logged its connection attempts.
			expect(r.stderr).not.toContain("message_bus");
		}, 40_000); // timing: 40 s test budget; the child ended in 0.6 s when measured (60x headroom).
	}

	it("control: the native client alone against the same port is still unanswered after 3 s", async () => {
		const port = await unusedPort();
		const r = await run("raw", port);
		expect(r.killed).toBe(false);
		expect(report(r).outcome).toBe("pending");
	}, 40_000); // timing: 40 s test budget over the 3 s the control waits; it took 3.2 s when measured (12x headroom).
});
