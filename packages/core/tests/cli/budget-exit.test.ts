// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `usertrust budget` returns to the shell when its ledger client was evicted.
 *
 * A client the cluster evicted cannot be released (tigerbeetle-node 0.17.9 aborts the process on
 * destroying one), so it is left open, and it keeps the event loop alive. The command printed its
 * result and then never ended. Now, when it left one open, main.ts ends the process itself once
 * stdout and stderr have drained, with the exit code the command set. A healthy run still ends on
 * its own.
 *
 * Each row runs the CLI in its own process, with tigerbeetle-node replaced by
 * `fixtures/fake-tigerbeetle.mjs`: its clients hold the event loop until destroyed, and
 * destroying an evicted one aborts the process, as the real binding does. The preload reports
 * whether the process ended on its own or through process.exit().
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../..");
const MAIN = join(ROOT, "packages", "core", "src", "cli", "main.ts");
const REGISTER = join(import.meta.dirname, "fixtures", "fake-tigerbeetle-register.mjs");
const DRAIN_CHILD = join(import.meta.dirname, "fixtures", "drain-exit-child.mts");
/** tsx, resolved here: a child runs in a temporary vault, where `--import tsx` would not resolve. */
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
/** Well past a run's own time (about 1 s), well short of a hang. */
const BOUND_MS = 20_000;

interface Run {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	killed: boolean;
}

async function runChild(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Run> {
	return await new Promise((done) => {
		const child = spawn(process.execPath, args, {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let killed = false;
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => {
			killed = true;
			child.kill("SIGKILL");
		}, BOUND_MS);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			done({ code, signal, stdout, stderr, killed });
		});
	});
}

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function vault(): string {
	const dir = mkdtempSync(join(tmpdir(), "trust-budget-exit-"));
	dirs.push(dir);
	mkdirSync(join(dir, ".usertrust", "audit"), { recursive: true });
	writeFileSync(
		join(dir, ".usertrust", "usertrust.config.json"),
		JSON.stringify({
			budget: 50_000,
			tigerbeetle: { addresses: ["127.0.0.1:3001"], clusterId: 0 },
		}),
	);
	return dir;
}

async function budget(mode: string): Promise<Run> {
	return await runChild(
		[
			"--import",
			TSX,
			"--import",
			REGISTER,
			MAIN,
			"budget",
			"--cost-center",
			"research",
			"--allocated",
			"1000",
			"--json",
		],
		vault(),
		{ FAKE_TB_MODE: mode },
	);
}

/** The preload's report: did the process end on its own, and with which code. */
function ending(run: Run): { endedOnItsOwn: boolean; code: number } | undefined {
	const line = run.stderr.split("\n").find((l) => l.startsWith('{"fakeTbExit"'));
	return line === undefined
		? undefined
		: (JSON.parse(line) as { fakeTbExit: { endedOnItsOwn: boolean; code: number } }).fakeTbExit;
}

/** The command's one JSON line on stdout. */
function payload(run: Run): { success: boolean; data: Record<string, unknown> } {
	const lines = run.stdout.split("\n").filter((l) => l.startsWith("{"));
	expect(lines).toHaveLength(1);
	return JSON.parse(lines[0] as string);
}

describe("usertrust budget ends the process when its ledger client was left open", () => {
	it("a client evicted after the command's read: the full result, exit 0, and the process ends (through the exit path)", async () => {
		const run = await budget("evict-after-read");
		expect(run.killed).toBe(false);
		expect({ code: run.code, signal: run.signal }).toEqual({ code: 0, signal: null });
		expect(payload(run)).toMatchObject({ success: true, data: { balance: 750, allocated: 1000 } });
		// The control: the client was evicted and left open, which the client says.
		expect(run.stderr).toContain("could not be released");
		expect(ending(run)).toEqual({ endedOnItsOwn: false, code: 0 });
	}, 30_000);

	it("a command that FAILED on evicted clients ends with its own exit code, 1, and its full failure line", async () => {
		const run = await budget("evicted");
		expect(run.killed).toBe(false);
		expect({ code: run.code, signal: run.signal }).toEqual({ code: 1, signal: null });
		expect(payload(run)).toMatchObject({ success: false });
		expect(run.stderr).toContain("could not be released");
		expect(ending(run)).toEqual({ endedOnItsOwn: false, code: 1 });
	}, 30_000);

	it("control: a healthy run ends on its own, without the exit path", async () => {
		const run = await budget("healthy");
		expect(run.killed).toBe(false);
		expect({ code: run.code, signal: run.signal }).toEqual({ code: 0, signal: null });
		expect(payload(run)).toMatchObject({ success: true, data: { balance: 750 } });
		expect(run.stderr).not.toContain("could not be released");
		expect(ending(run)).toEqual({ endedOnItsOwn: true, code: 0 });
	}, 30_000);
});

// Where a pipe is written asynchronously (macOS), process.exit() without the drain cuts this output
// short. On Linux a pipe is written synchronously, so there this row cannot tell the two apart.
describe("exitWhenDrained(): the exit path loses no output", () => {
	it("1 MiB written to a pipe, then the exit path: every byte arrives, with the exit code the command set", async () => {
		const bytes = 1024 * 1024;
		const run = await runChild(["--import", TSX, DRAIN_CHILD, String(bytes)], ROOT, {});
		expect(run.killed).toBe(false);
		expect({ code: run.code, signal: run.signal }).toEqual({ code: 3, signal: null });
		expect(run.stdout.length).toBe(bytes);
	}, 30_000);
});
