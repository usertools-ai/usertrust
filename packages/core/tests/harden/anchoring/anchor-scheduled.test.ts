// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `anchor now --scheduled`: a timer's form of `anchor now`. Nothing-to-do and
 * "another run holds the lock" exit 0; real failures exit 1 and are kept in
 * `audit/anchors/last-run.json`, which `anchor status` shows.
 */

import {
	chmodSync,
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
import { canonicalize } from "../../../src/audit/canonical.js";
import { run as anchorRun } from "../../../src/cli/anchor.js";
import {
	anchorOnce,
	appendEvents,
	cleanupAll,
	makeAnchoredVault,
	nextPayload,
	signRecord,
	storeRecords,
	tmp,
} from "./fixtures.js";

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

	it("a quiet run after a failed delivery stays failed; a recovered sink clears it", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const blocker = join(s.storeDir, "a-file");
		writeFileSync(blocker, "x");
		const bad = ["--sink-file", join(blocker, "anchors.jsonl"), "--publish-retries", "1"];
		const first = await runNow(["--scheduled", ...bad]);
		expect((first.out.data as { reason: string }).reason).toBe("sink-failed");
		process.exitCode = 0;
		// Nothing new to anchor, but the earlier anchor is still undelivered.
		const quiet = await runNow(["--scheduled", ...bad]);
		expect(quiet.exit).toBe(1);
		expect((quiet.out.data as { reason: string }).reason).toBe("sink-failed");
		expect(readLastRun(s.root)).toMatchObject({ ok: false, reason: "sink-failed" });
		process.exitCode = 0;
		// The sink recovers: the backlog is delivered and the run is ok again.
		const good = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(good.exit).toBe(0);
		expect(readLastRun(s.root)).toMatchObject({ ok: true });
		expect(readFileSync(s.storeFile, "utf-8").trim().length).toBeGreaterThan(0);
		const outbox = join(anchorsDir(s.root), "outbox");
		expect(existsSync(outbox) ? readdirSync(outbox).length : 0).toBe(0);
	});

	it("never publishes an outbox record the emitter refused (invalid orphan); the entry stays and the run fails", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const first = await anchorOnce(s);
		await appendEvents(s.root, 1, 4);
		const attacker = await makeAnchoredVault(1);
		const forged = signRecord(nextPayload(s, first), attacker.keyFile);
		const entry = join(anchorsDir(s.root), "outbox", "000000000002.json");
		writeFileSync(entry, canonicalize(forged), { mode: 0o600 });
		const { out, exit } = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(exit).toBe(1);
		expect((out.data as { reason: string }).reason).toBe("other");
		expect(existsSync(entry)).toBe(true);
		expect(storeRecords(s).map((r) => r.anchorSeq)).toEqual([1]);
		expect(readLastRun(s.root)).toMatchObject({ ok: false });
	});

	it("never publishes an outbox record that differs from the mirror's; quiet run fails, entry stays", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const first = await anchorOnce(s);
		const { sig: _sig, ...unsigned } = first;
		const divergent = signRecord({ ...unsigned, merkleRoot: "ab".repeat(32) }, s.keyFile);
		const entry = join(anchorsDir(s.root), "outbox", "000000000001.json");
		writeFileSync(entry, canonicalize(divergent), { mode: 0o600 });
		const { out, exit } = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(exit).toBe(1);
		expect((out.data as { reason: string }).reason).toBe("sink-failed");
		expect(existsSync(entry)).toBe(true);
		expect(storeRecords(s)).toHaveLength(1);
		expect(storeRecords(s)[0]?.merkleRoot).toBe(first.merkleRoot);
	});

	it("a live lock holder with a backlog is still just 'locked': exit 0, nothing delivered", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const blocker = join(s.storeDir, "a-file");
		writeFileSync(blocker, "x");
		const bad = ["--sink-file", join(blocker, "anchors.jsonl"), "--publish-retries", "1"];
		await runNow(["--scheduled", ...bad]); // leaves one undelivered anchor in the outbox
		process.exitCode = 0;
		const lock = join(anchorsDir(s.root), ".anchor-writer.lock");
		writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
		const sched = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(sched.exit).toBe(0);
		expect((sched.out.data as { reason: string }).reason).toBe("locked");
		expect(existsSync(s.storeFile) ? storeRecords(s) : []).toHaveLength(0);
	});

	it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
		"a lock that cannot be created is its own failing reason, not 'locked'",
		async () => {
			const s = await makeAnchoredVault(3);
			process.chdir(s.root);
			process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
			const dir = anchorsDir(s.root);
			chmodSync(dir, 0o500);
			try {
				const { out, exit } = await runNow(["--scheduled", "--sink-file", s.storeFile]);
				expect(exit).toBe(1);
				expect((out.data as { reason: string }).reason).toBe("lock-unavailable");
			} finally {
				chmodSync(dir, 0o700);
			}
		},
	);

	it("with no sink configured a scheduled run keeps an undelivered backlog and fails", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const blocker = join(s.storeDir, "a-file");
		writeFileSync(blocker, "x");
		await runNow([
			"--scheduled",
			"--sink-file",
			join(blocker, "anchors.jsonl"),
			"--publish-retries",
			"1",
		]);
		process.exitCode = 0;
		const outbox = join(anchorsDir(s.root), "outbox");
		const before = readdirSync(outbox);
		expect(before.length).toBe(1);
		const { out, exit } = await runNow(["--scheduled"]);
		expect(exit).toBe(1);
		expect((out.data as { reason: string }).reason).toBe("sink-failed");
		expect(readdirSync(outbox)).toEqual(before);
	});

	it("an empty event log is benign only for a vault that never anchored", async () => {
		// a fresh vault, empty mirror present: benign (positive control, exit 0)
		const fresh = await makeAnchoredVault(0);
		process.chdir(fresh.root);
		process.env.USERTRUST_ANCHOR_KEY = fresh.keyFile;
		const ok = await runNow(["--scheduled", "--sink-file", fresh.storeFile]);
		expect(ok.exit).toBe(0);
		expect((ok.out.data as { reason: string }).reason).toBe("empty");
		// the mirror file is gone: a fault
		renameSync(join(anchorsDir(fresh.root), "anchors.jsonl"), join(fresh.storeDir, "mirror.aside"));
		const gone = await runNow(["--scheduled", "--sink-file", fresh.storeFile]);
		expect(gone.exit).toBe(1);
		expect((gone.out.data as { reason: string }).reason).toBe("mirror-missing");
		process.exitCode = 0;
		// an anchored vault whose event log was lost: a fault
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		await anchorOnce(s);
		const log = join(s.vaultPath, "audit", "events.jsonl");
		writeFileSync(log, "");
		const lost = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(lost.exit).toBe(1);
		expect((lost.out.data as { reason: string }).reason).toBe("other");
	});

	it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
		"a stale lock that cannot be reclaimed is lock-unavailable, not 'locked'",
		async () => {
			const s = await makeAnchoredVault(3);
			process.chdir(s.root);
			process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
			const dir = anchorsDir(s.root);
			writeFileSync(
				join(dir, ".anchor-writer.lock"),
				JSON.stringify({ pid: 999999, startedAt: "x" }),
			);
			chmodSync(dir, 0o500);
			try {
				const { out, exit } = await runNow(["--scheduled", "--sink-file", s.storeFile]);
				expect(exit).toBe(1);
				expect((out.data as { reason: string }).reason).toBe("lock-unavailable");
			} finally {
				chmodSync(dir, 0o700);
			}
		},
	);

	it("a corrupt oldest outbox entry holds back every later one", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const blocker = join(s.storeDir, "a-file");
		writeFileSync(blocker, "x");
		const bad = ["--sink-file", join(blocker, "anchors.jsonl"), "--publish-retries", "1"];
		await runNow(["--scheduled", ...bad]); // entry 1 stays in the outbox
		process.exitCode = 0;
		await appendEvents(s.root, 2, 4);
		await runNow(["--scheduled", ...bad]); // entry 2 joins it
		process.exitCode = 0;
		const outbox = join(anchorsDir(s.root), "outbox");
		const names = readdirSync(outbox).sort();
		expect(names).toEqual(["000000000001.json", "000000000002.json"]);
		// positive control: with both intact a good sink delivers both
		const first = readFileSync(join(outbox, names[0] as string), "utf-8");
		writeFileSync(join(outbox, names[0] as string), "{ not json");
		const held = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(held.exit).toBe(1);
		expect(readdirSync(outbox).sort()).toEqual(names);
		expect(existsSync(s.storeFile) ? storeRecords(s) : []).toHaveLength(0);
		writeFileSync(join(outbox, names[0] as string), first);
		const ok = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(ok.exit).toBe(0);
		expect(storeRecords(s)).toHaveLength(2);
		expect(readdirSync(outbox)).toEqual([]);
	});

	it("a lost or damaged event log is a failure even before the first anchor", async () => {
		// positive control: a vault with no events and no sidecar is still benign
		const fresh = await makeAnchoredVault(0);
		process.chdir(fresh.root);
		process.env.USERTRUST_ANCHOR_KEY = fresh.keyFile;
		const ok = await runNow(["--scheduled", "--sink-file", fresh.storeFile]);
		expect(ok.exit).toBe(0);
		// events were recorded (sidecar says 3), the log file is now empty, nothing anchored yet
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const log = join(s.vaultPath, "audit", "events.jsonl");
		writeFileSync(log, "");
		const lost = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(lost.exit).toBe(1);
		expect((lost.out.data as { reason: string }).reason).toBe("other");
		process.exitCode = 0;
		// an unreadable sidecar beside an empty log is a failure too
		writeFileSync(`${log}.meta`, "{ not json");
		const damaged = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(damaged.exit).toBe(1);
		expect((damaged.out.data as { reason: string }).reason).toBe("other");
	});

	it("status prints the recorded time without terminal escapes", async () => {
		const s = await makeAnchoredVault(1);
		process.chdir(s.root);
		writeFileSync(
			lastRunPath(s.root),
			JSON.stringify({ at: "\u001b[31mEVIL", ok: true, reason: "anchored" }),
		);
		const lines = capture();
		await anchorRun(["status"], {});
		const text = lines.join("\n");
		expect(text).toContain("Last scheduled run:");
		expect(text).not.toContain("\u001b");
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
