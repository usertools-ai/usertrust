// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `anchor now --scheduled`: a timer's form of `anchor now`. Nothing-to-do and
 * "another run holds the lock" exit 0; real failures exit 1 and are kept in
 * `audit/anchors/last-run.json`, which `anchor status` shows.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anchorsDir, initAnchorIdentity } from "../../../src/audit/anchor.js";
import {
	classifyEmitReason,
	isOkReason,
	LAST_RUN_REASONS,
	lastRunPath,
	readLastRun,
	writeLastRun,
} from "../../../src/audit/anchor-last-run.js";
import { run as anchorRun } from "../../../src/cli/anchor.js";
import { cleanupAll, makeAnchoredVault, tmp } from "./fixtures.js";

const origCwd = process.cwd();
const origHome = process.env.HOME;

beforeEach(() => {
	process.env.HOME = tmp("anchor-sched-home-");
	delete process.env.USERTRUST_ANCHOR_KEY;
});

afterEach(() => {
	process.chdir(origCwd);
	process.env.HOME = origHome;
	delete process.env.USERTRUST_ANCHOR_KEY;
	process.exitCode = 0;
	vi.restoreAllMocks();
	cleanupAll();
});

function capture(): string[] {
	const lines: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		lines.push(a.map(String).join(" "));
	});
	return lines;
}

async function runNow(
	extra: string[],
	json = true,
): Promise<{ out: Record<string, unknown>; exit: number }> {
	const lines = capture();
	process.exitCode = 0;
	await anchorRun(["now", ...extra], { json });
	const exit = Number(process.exitCode ?? 0);
	process.exitCode = 0;
	vi.restoreAllMocks();
	return { out: json ? JSON.parse(lines.at(-1) as string) : { lines }, exit };
}

describe("anchor now --scheduled", () => {
	it("anchors new events: exit 0, last-run ok/anchored, file mode 0600, no temp files left", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const { out, exit } = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(exit).toBe(0);
		expect(out.success).toBe(true);
		expect((out.data as { reason: string }).reason).toBe("anchored");
		const last = readLastRun(s.root);
		expect(last).toMatchObject({ ok: true, reason: "anchored" });
		expect(statSync(lastRunPath(s.root)).mode & 0o777).toBe(0o600);
		expect(readdirSync(anchorsDir(s.root)).filter((f) => f.includes(".tmp"))).toEqual([]);
	});

	it("no new events exits 0 for a timer and for a human alike", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		await runNow(["--scheduled", "--sink-file", s.storeFile]);
		const sched = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(sched.exit).toBe(0);
		expect((sched.out.data as { reason: string }).reason).toBe("no-new-events");
		expect(readLastRun(s.root)).toMatchObject({ ok: true, reason: "no-new-events" });
	});

	it("an empty vault exits 0 scheduled but 1 for a human run (positive control)", async () => {
		const s = await makeAnchoredVault(0);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const human = await runNow(["--sink-file", s.storeFile]);
		expect(human.exit).toBe(1);
		const sched = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(sched.exit).toBe(0);
		expect((sched.out.data as { reason: string }).reason).toBe("empty");
	});

	it("a live lock holder exits 0 scheduled but 1 for a human run; without it the run anchors", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const lock = join(anchorsDir(s.root), ".anchor-writer.lock");
		// The parent process is alive and is not this one: a live holder.
		writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
		const human = await runNow(["--sink-file", s.storeFile]);
		expect(human.exit).toBe(1);
		const sched = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(sched.exit).toBe(0);
		expect((sched.out.data as { reason: string }).reason).toBe("locked");
		renameSync(lock, `${lock}.aside`);
		const free = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect((free.out.data as { reason: string }).reason).toBe("anchored");
	});

	it("no private key: exit 1, reason no-key, recorded as failed", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		// No env var, and the key sits in a temp store, not at the default path under HOME.
		const { out, exit } = await runNow(["--scheduled"]);
		expect(exit).toBe(1);
		expect(out.success).toBe(false);
		expect((out.data as { reason: string }).reason).toBe("no-key");
		expect(readLastRun(s.root)).toMatchObject({ ok: false, reason: "no-key" });
	});

	it("mirror file missing: exit 1, reason mirror-missing", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const mirror = join(anchorsDir(s.root), "anchors.jsonl");
		renameSync(mirror, join(s.storeDir, "mirror.aside"));
		const { out, exit } = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(exit).toBe(1);
		expect((out.data as { reason: string }).reason).toBe("mirror-missing");
	});

	it("a sink that cannot be written: exit 1, reason sink-failed", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const blocker = join(s.storeDir, "a-file");
		writeFileSync(blocker, "x");
		const { out, exit } = await runNow([
			"--scheduled",
			"--sink-file",
			join(blocker, "anchors.jsonl"),
			"--publish-retries",
			"1",
		]);
		expect(exit).toBe(1);
		expect((out.data as { reason: string }).reason).toBe("sink-failed");
		expect(readLastRun(s.root)).toMatchObject({ ok: false, reason: "sink-failed" });
	});

	it("a failure is not hidden by the next quiet run's output, and status shows it", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		await runNow(["--scheduled"]); // no key: fails
		const lines = capture();
		await anchorRun(["status"], {});
		expect(lines.join("\n")).toContain("Last scheduled run:");
		expect(lines.join("\n")).toContain("FAILED (no-key)");
		vi.restoreAllMocks();
		const jl = capture();
		await anchorRun(["status"], { json: true });
		const st = JSON.parse(jl.at(-1) as string);
		expect(st.data.lastRun).toMatchObject({ ok: false, reason: "no-key" });
	});

	it("status says none recorded before any scheduled run", async () => {
		const s = await makeAnchoredVault(1);
		process.chdir(s.root);
		const lines = capture();
		await anchorRun(["status"], {});
		expect(lines.join("\n")).toContain("Last scheduled run: none recorded");
	});
});

describe("last-run record", () => {
	it("round-trips, and ok follows the reason", () => {
		const root = tmp("anchor-lr-");
		initAnchorIdentity(root, { keyFile: join(tmp("anchor-lr-key-"), "k.pem") });
		writeLastRun(root, "sink-failed", new Date("2026-11-03T00:00:00.000Z"));
		expect(readLastRun(root)).toEqual({
			at: "2026-11-03T00:00:00.000Z",
			ok: false,
			reason: "sink-failed",
		});
		writeLastRun(root, "locked");
		expect(readLastRun(root)?.ok).toBe(true);
	});

	it("writes nothing when there is no anchors directory", () => {
		const root = tmp("anchor-lr-none-");
		mkdirSync(join(root, ".usertrust"), { recursive: true });
		writeLastRun(root, "anchored");
		expect(existsSync(anchorsDir(root))).toBe(false);
	});

	it("reads a malformed file as absent", () => {
		const root = tmp("anchor-lr-bad-");
		initAnchorIdentity(root, { keyFile: join(tmp("anchor-lr-key-"), "k.pem") });
		for (const bad of ["not json", "{}", '{"at":"x","ok":true,"reason":"made-up"}']) {
			writeFileSync(lastRunPath(root), bad);
			expect(readLastRun(root)).toBeNull();
		}
		expect(readFileSync(lastRunPath(root), "utf-8")).toContain("made-up");
	});

	it("maps every emitter reason to a fixed code", () => {
		expect(classifyEmitReason("no-new-events")).toBe("no-new-events");
		expect(classifyEmitReason("empty")).toBe("empty");
		expect(classifyEmitReason("locked")).toBe("locked");
		expect(classifyEmitReason("mirror-missing (run `usertrust anchor resume`)")).toBe(
			"mirror-missing",
		);
		expect(classifyEmitReason("stale-signer-key: signer a is not the current epoch key b")).toBe(
			"stale-signer-key",
		);
		expect(classifyEmitReason("mirror-corrupt (repair)")).toBe("other");
		expect(classifyEmitReason(undefined)).toBe("other");
		for (const r of LAST_RUN_REASONS) expect(typeof isOkReason(r)).toBe("boolean");
		expect(LAST_RUN_REASONS.filter(isOkReason)).toEqual([
			"anchored",
			"no-new-events",
			"empty",
			"locked",
		]);
	});
});
