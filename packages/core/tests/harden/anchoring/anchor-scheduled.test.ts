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
import { anchorsDir, createAnchorEmitter, initAnchorIdentity } from "../../../src/audit/anchor.js";
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

	it("--scheduled is a switch of `now` only: another action still refuses it as an unknown option", async () => {
		const lines = capture();
		process.exitCode = 0;
		await anchorRun(["status", "--scheduled"], { json: true });
		const exit = Number(process.exitCode ?? 0);
		process.exitCode = 0;
		vi.restoreAllMocks();
		expect(exit).toBe(2);
		expect(lines.at(-1)).toContain('has no option \\"--scheduled\\"');
	});

	it("an empty vault with ANOTHER vault's key is stale-signer-key, exit 1, recorded (not a benign 'empty')", async () => {
		const s = await makeAnchoredVault(0);
		const other = await makeAnchoredVault(0);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = other.keyFile;
		const r = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(r.exit).toBe(1);
		expect((r.out.data as { reason: string }).reason).toBe("stale-signer-key");
		expect(readLastRun(s.root)).toMatchObject({ ok: false, reason: "stale-signer-key" });
		// positive control: the vault's own key is still the benign empty
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const own = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(own.exit).toBe(0);
		expect((own.out.data as { reason: string }).reason).toBe("empty");
	});

	it("a scheduled run refused by the option check is recorded as failed, so status cannot keep an old ok", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const good = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(good.exit).toBe(0);
		expect(readLastRun(s.root)).toMatchObject({ ok: true, reason: "anchored" });
		const bad = await runNow(["--scheduled", "--bogus"]);
		expect(bad.exit).toBe(2);
		expect(readLastRun(s.root)).toMatchObject({ ok: false, reason: "other" });
		// a human run refused the same way writes nothing: last-run is the timer's record only
		await runNow(["--sink-file", s.storeFile]);
		const before = readFileSync(lastRunPath(s.root), "utf-8");
		const human = await runNow(["--bogus"]);
		expect(human.exit).toBe(2);
		expect(readFileSync(lastRunPath(s.root), "utf-8")).toBe(before);
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

	it("a damaged legacy log (no sidecar) is a failure before the first anchor; a zero-length one is not", async () => {
		// positive control: zero-length log, no sidecar, nothing anchored: a fresh vault
		const fresh = await makeAnchoredVault(0);
		process.chdir(fresh.root);
		process.env.USERTRUST_ANCHOR_KEY = fresh.keyFile;
		mkdirSync(join(fresh.vaultPath, "audit"), { recursive: true });
		writeFileSync(join(fresh.vaultPath, "audit", "events.jsonl"), "");
		const ok = await runNow(["--scheduled", "--sink-file", fresh.storeFile]);
		expect(ok.exit).toBe(0);
		expect((ok.out.data as { reason: string }).reason).toBe("empty");
		// malformed lines only, legacy log without a sidecar
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const log = join(s.vaultPath, "audit", "events.jsonl");
		renameSync(`${log}.meta`, join(s.storeDir, "meta.aside"));
		writeFileSync(log, "not json\n{ also not\n");
		const bad = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(bad.exit).toBe(1);
		expect((bad.out.data as { reason: string; detail?: string }).reason).toBe("other");
		expect((bad.out.data as { detail?: string }).detail).toContain(
			"has content but yields no events",
		);
	});

	it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
		"an unreadable legacy log (no sidecar) is a failure before the first anchor",
		async () => {
			const s = await makeAnchoredVault(3);
			process.chdir(s.root);
			process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
			const log = join(s.vaultPath, "audit", "events.jsonl");
			renameSync(`${log}.meta`, join(s.storeDir, "meta.aside"));
			chmodSync(log, 0o000);
			try {
				const { out, exit } = await runNow(["--scheduled", "--sink-file", s.storeFile]);
				expect(exit).toBe(1);
				expect((out.data as { reason: string }).reason).toBe("other");
			} finally {
				chmodSync(log, 0o600);
			}
		},
	);

	it("a last-run record that cannot be written fails the run and says so on stderr", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		// positive control: the same run with a writable record exits 0
		const good = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(good.exit).toBe(0);
		// a directory where the record file belongs makes the atomic replace fail
		renameSync(lastRunPath(s.root), join(s.storeDir, "last-run.aside"));
		mkdirSync(lastRunPath(s.root), { recursive: true });
		let err = "";
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			err += String(chunk);
			return true;
		});
		const { out, exit } = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(exit).toBe(1);
		expect(out.success).toBe(false);
		expect(err).toContain("could not record this run");
		expect(err).not.toContain("\u001b");
	});

	it("table: an empty outcome is benign only with positive evidence of a never-used vault", async () => {
		type Row = {
			name: string;
			setup: (s: Awaited<ReturnType<typeof makeAnchoredVault>>) => void;
			exit: 0 | 1;
			reason: string;
		};
		const log = (s: { vaultPath: string }) => join(s.vaultPath, "audit", "events.jsonl");
		const rows: Row[] = [
			{ name: "fresh vault, no log", setup: () => {}, exit: 0, reason: "empty" },
			{
				name: "zero-length log, no sidecar",
				setup: (s) => {
					mkdirSync(join(s.vaultPath, "audit"), { recursive: true });
					writeFileSync(log(s), "");
				},
				exit: 0,
				reason: "empty",
			},
			{
				name: "zero-length log, sidecar at 0",
				setup: (s) => {
					mkdirSync(join(s.vaultPath, "audit"), { recursive: true });
					writeFileSync(log(s), "");
					writeFileSync(`${log(s)}.meta`, JSON.stringify({ lastHash: "", sequence: 0 }));
				},
				exit: 0,
				reason: "empty",
			},
			{
				name: "mirror missing",
				setup: (s) =>
					renameSync(join(anchorsDir(s.root), "anchors.jsonl"), join(s.storeDir, "m.aside")),
				exit: 1,
				reason: "mirror-missing",
			},
			{
				name: "mirror holds a record",
				setup: (s) => writeFileSync(join(anchorsDir(s.root), "anchors.jsonl"), '{"anchorSeq":1}\n'),
				exit: 1,
				reason: "other",
			},
			{
				name: "log with malformed bytes only",
				setup: (s) => {
					mkdirSync(join(s.vaultPath, "audit"), { recursive: true });
					writeFileSync(log(s), "garbage\n");
				},
				exit: 1,
				reason: "other",
			},
			{
				name: "rotated segment with bytes",
				setup: (s) => {
					mkdirSync(join(s.vaultPath, "audit"), { recursive: true });
					writeFileSync(join(s.vaultPath, "audit", "events-2026.jsonl"), "garbage\n");
				},
				exit: 1,
				reason: "other",
			},
			{
				name: "emptied log, sidecar records events",
				setup: (s) => {
					mkdirSync(join(s.vaultPath, "audit"), { recursive: true });
					writeFileSync(log(s), "");
					writeFileSync(`${log(s)}.meta`, JSON.stringify({ lastHash: "ab", sequence: 4 }));
				},
				exit: 1,
				reason: "other",
			},
			{
				name: "unreadable sidecar",
				setup: (s) => {
					mkdirSync(join(s.vaultPath, "audit"), { recursive: true });
					writeFileSync(log(s), "");
					writeFileSync(`${log(s)}.meta`, "{ not json");
				},
				exit: 1,
				reason: "other",
			},
		];
		for (const row of rows) {
			const s = await makeAnchoredVault(0);
			process.chdir(s.root);
			process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
			row.setup(s);
			const r = await runNow(["--scheduled", "--sink-file", s.storeFile]);
			expect([row.name, r.exit, (r.out.data as { reason: string }).reason]).toEqual([
				row.name,
				row.exit,
				row.reason,
			]);
			process.exitCode = 0;
		}
	});

	it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
		"an outbox that cannot be listed is a failure, not an empty backlog",
		async () => {
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
			]); // one undelivered anchor
			process.exitCode = 0;
			const outbox = join(anchorsDir(s.root), "outbox");
			expect(readdirSync(outbox)).toHaveLength(1);
			chmodSync(outbox, 0o000);
			try {
				const r = await runNow(["--scheduled", "--sink-file", s.storeFile]);
				expect(r.exit).toBe(1);
				expect((r.out.data as { reason: string }).reason).toBe("sink-failed");
				expect(readLastRun(s.root)).toMatchObject({ ok: false, reason: "sink-failed" });
				// status does not report "0 pending" either
				process.exitCode = 0;
				const lines = capture();
				await anchorRun(["status"], { json: true });
				const st = JSON.parse(lines.at(-1) as string);
				expect(st.data.outboxUnreadable).toBe(true);
				process.exitCode = 0;
			} finally {
				chmodSync(outbox, 0o700);
			}
			// positive control: readable again, the same run delivers the backlog
			vi.restoreAllMocks();
			const ok = await runNow(["--scheduled", "--sink-file", s.storeFile]);
			expect(ok.exit).toBe(0);
			expect(storeRecords(s)).toHaveLength(1);
		},
	);

	it("a new anchor is never delivered past an unreadable earlier outbox entry", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const blocker = join(s.storeDir, "a-file");
		writeFileSync(blocker, "x");
		const bad = ["--sink-file", join(blocker, "anchors.jsonl"), "--publish-retries", "1"];
		await runNow(["--scheduled", ...bad]); // entry 1 stays
		process.exitCode = 0;
		const outbox = join(anchorsDir(s.root), "outbox");
		const first = readFileSync(join(outbox, "000000000001.json"), "utf-8");
		writeFileSync(join(outbox, "000000000001.json"), "{ not json");
		await appendEvents(s.root, 2, 4);
		const r = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(r.exit).toBe(1);
		expect(existsSync(s.storeFile) ? storeRecords(s) : []).toHaveLength(0);
		// positive control: with entry 1 intact the same run delivers everything
		writeFileSync(join(outbox, "000000000001.json"), first);
		const ok = await runNow(["--scheduled", "--sink-file", s.storeFile]);
		expect(ok.exit).toBe(0);
		expect(storeRecords(s).length).toBeGreaterThanOrEqual(2);
	});

	it("an in-process emitter blocked by an unreadable outbox entry reports degraded", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		const blocker = join(s.storeDir, "a-file");
		writeFileSync(blocker, "x");
		const config = (sinkPath: string) => ({
			signer: { type: "pem" as const, file: s.keyFile },
			sinks: [{ type: "file" as const, path: sinkPath }],
			publishRetries: 1,
		});
		const first = createAnchorEmitter(s.root, config(join(blocker, "anchors.jsonl")));
		await first.anchorNow(); // entry 1 stays in the outbox
		await first.stop();
		// positive control: a healthy emitter over a sound outbox is not degraded
		const sound = createAnchorEmitter(s.root, config(s.storeFile));
		expect(sound.status().degraded).toBe(false);
		await sound.stop();
		const outbox = join(anchorsDir(s.root), "outbox");
		writeFileSync(join(outbox, "000000000001.json"), "{ not json");
		await appendEvents(s.root, 2, 4);
		const em = createAnchorEmitter(s.root, config(s.storeFile));
		const r = await em.anchorNow();
		await em.stop();
		expect(r.emitted).toBe(true);
		const st = em.status();
		expect(st.degraded).toBe(true);
		expect(st.publishFailures).toBeGreaterThan(0);
		expect(st.lastEmitError).toContain("unreadable entry");
		expect(existsSync(s.storeFile) ? storeRecords(s) : []).toHaveLength(0);
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
