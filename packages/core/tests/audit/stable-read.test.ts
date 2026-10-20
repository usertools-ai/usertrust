// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `verify` on a live vault: ONE consistent snapshot, read without the lock, and never a
 * live write reported as broken. A torn tail under a writer that holds the lock is read again; one
 * that completes is verified as found; one that stays byte-identical through every attempt is reported
 * as torn-or-in-progress (`writerLive`), never clean and never busy; with no writer, a torn tail is
 * final, and torn. And `usertrust health` names a refused tail, and an interrupted recovery, critical.
 */

/** Seams on the reader's file calls: each row arms only what it uses. */
const seam = vi.hoisted(() => ({
	auditDir: "",
	/** From this audit-directory listing on, each EVEN listing (an attempt's second) adds a name: every
	 * attempt from then is inconsistent, though its first reading is the same as the one before. */
	flipListingsFrom: undefined as number | undefined,
	listings: 0,
	/** A name every audit-directory listing carries that no open finds: a name the OS hands back changed. */
	phantomName: undefined as string | undefined,
	/** Runs once, at this numbered lstat of the quarantine path: an attempt's very last read. */
	atQuarantineLstat: undefined as { n: number; run: () => void } | undefined,
	quarantineLstats: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const readdirSync = ((p: unknown, ...rest: unknown[]) => {
		const names = (fs.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
		if (seam.phantomName !== undefined && String(p) === seam.auditDir && Array.isArray(names)) {
			return [...names, seam.phantomName];
		}
		if (
			seam.flipListingsFrom !== undefined &&
			String(p) === seam.auditDir &&
			Array.isArray(names)
		) {
			seam.listings++;
			if (seam.listings >= seam.flipListingsFrom && seam.listings % 2 === 0) {
				return [...names, `changing-${seam.listings}`];
			}
		}
		return names;
	}) as typeof fs.readdirSync;
	const lstatSync = ((p: unknown, ...rest: unknown[]) => {
		const hook = seam.atQuarantineLstat;
		if (hook !== undefined && String(p) === `${seam.auditDir}/quarantine`) {
			seam.quarantineLstats++;
			if (seam.quarantineLstats === hook.n) {
				seam.atQuarantineLstat = undefined;
				hook.run();
			}
		}
		return (fs.lstatSync as (...a: unknown[]) => unknown)(p, ...rest);
	}) as typeof fs.lstatSync;
	return { ...fs, readdirSync, lstatSync, default: { ...fs, readdirSync, lstatSync } };
});

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyVaultReading as standaloneVerifyVaultReading } from "../../../verify/src/index.js";
import { canonicalize } from "../../src/audit/canonical.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import { readVaultSnapshot, writerMayHoldLock } from "../../src/audit/stable-read.js";
import { verifyVaultBounded, verifyVaultReading } from "../../src/audit/verify.js";
import { run as healthRun } from "../../src/cli/health.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

let root: string;
let out: string[];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "stable-read-"));
	out = [];
	seam.auditDir = join(root, VAULT_DIR, "audit");
	seam.flipListingsFrom = undefined;
	seam.listings = 0;
	seam.phantomName = undefined;
	seam.atQuarantineLstat = undefined;
	seam.quarantineLstats = 0;
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

const vaultDir = () => join(root, VAULT_DIR);
const auditDir = () => join(vaultDir(), "audit");
const logPath = () => join(auditDir(), "events.jsonl");
const lockPath = () => join(auditDir(), ".audit-writer.lock");

async function vaultOf(n: number): Promise<void> {
	const w = createAuditWriter(root);
	try {
		for (let i = 1; i <= n; i++) {
			await w.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: `tx_${i}` } });
		}
	} finally {
		w.release();
	}
}

/** A lock file naming THIS process: a live writer, as a reader judges one (it cannot prove none). */
const liveLock = () =>
	writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, writerId: "w" }));

/** The next event of the chain, and the anchor that records it. */
function nextEvent(): { line: string; anchor: string } {
	const lines = readFileSync(logPath(), "utf-8").trim().split("\n");
	const head = JSON.parse(lines.at(-1) as string) as { hash: string; sequence: number };
	const body = {
		id: "next",
		timestamp: "2026-10-12T00:00:00.000Z",
		previousHash: head.hash,
		kind: "llm_call",
		actor: "local",
		data: { transferId: "tx_next" },
		sequence: head.sequence + 1,
	};
	const hash = createHash("sha256").update(canonicalize(body)).digest("hex");
	return {
		line: canonicalize({ ...body, hash }),
		anchor: JSON.stringify({ lastHash: hash, sequence: head.sequence + 1 }),
	};
}

describe("verify on a live vault", () => {
	it("a torn tail under a live writer that then completes its append: read again, then valid", async () => {
		await vaultOf(2);
		liveLock();
		const { line, anchor } = nextEvent();
		const half = Math.floor(line.length / 2);
		writeFileSync(logPath(), `${readFileSync(logPath(), "utf-8")}${line.slice(0, half)}`);
		// Another process finishes the write while this one reads: the rest of the line, then its anchor.
		const child = spawn(
			process.execPath,
			[
				"-e",
				`const fs=require("node:fs");setTimeout(()=>{fs.appendFileSync(process.argv[1],process.argv[2]);fs.writeFileSync(process.argv[1]+".meta",process.argv[3]);},150);`,
				logPath(),
				`${line.slice(half)}\n`,
				anchor,
			],
			{ stdio: "ignore" },
		);
		const done = new Promise((r) => child.on("exit", r));
		// A wide window (it ends as soon as a consistent, untorn snapshot is read): a slow child start on a
		// loaded machine must not turn this row into the steady-torn one below.
		const { result } = verifyVaultReading(vaultDir(), { attempts: 200, delayMs: 25 });
		await done;
		expect(result).toMatchObject({ valid: true, chainLength: 3 });
		// The other process appends the rest of the line, THEN writes the anchor: a snapshot that lands between the
		// two holds a complete event one past its anchor, which is a valid verdict too (an interrupted write's).
		expect(["MATCH", "ONE_PAST_ANCHOR"]).toContain(result.tailState?.state);
		expect(result.busy).toBeUndefined();
		expect(result.writerLive).toBeUndefined();
	});

	it("a torn tail that stays byte-identical under a live writer: torn, or a write in progress, never clean and never busy", async () => {
		await vaultOf(2);
		liveLock();
		writeFileSync(logPath(), `${readFileSync(logPath(), "utf-8")}{"kind":"llm`);
		expect(writerMayHoldLock(auditDir())).toBe(true);
		const { result } = verifyVaultReading(vaultDir(), { attempts: 4, delayMs: 1 });
		expect(result.valid).toBe(false);
		expect(result.writerLive).toBe(true);
		expect(result.busy).toBeUndefined();
		expect(result.errors.join(" ")).toMatch(/stop the writer to classify it/);
	});

	it("a torn tail that keeps CHANGING under a live writer: busy, no verdict, never reported as broken", async () => {
		await vaultOf(2);
		liveLock();
		writeFileSync(logPath(), `${readFileSync(logPath(), "utf-8")}{"kind":"llm`);
		// Another process keeps writing to the tail, a byte every few milliseconds, for longer than the read.
		const child = spawn(
			process.execPath,
			[
				"-e",
				`const fs=require("node:fs");const end=Date.now()+1500;const t=setInterval(()=>{fs.appendFileSync(process.argv[1],"x");if(Date.now()>end)clearInterval(t);},3);`,
				logPath(),
			],
			{ stdio: "ignore" },
		);
		const done = new Promise((r) => child.on("exit", r));
		// Let it start writing before the read begins.
		await new Promise((r) => setTimeout(r, 300));
		const { result } = verifyVaultReading(vaultDir(), { attempts: 5, delayMs: 30 });
		await done;
		expect(result).toMatchObject({ valid: false, busy: true, tailState: null });
		expect(result.writerLive).toBeUndefined();
		expect(result.errors.join(" ")).toMatch(/being written/);
	});

	it("the same torn tail with NO writer: final, and torn", async () => {
		await vaultOf(2);
		writeFileSync(logPath(), `${readFileSync(logPath(), "utf-8")}{"kind":"llm`);
		expect(writerMayHoldLock(auditDir())).toBe(false);
		const read = readVaultSnapshot(auditDir(), { attempts: 4, delayMs: 1 });
		expect(read.kind).toBe("final");
		expect(read.attempts).toBe(1);
		const { result } = verifyVaultReading(vaultDir(), { attempts: 4, delayMs: 1 });
		expect(result.writerLive).toBeUndefined();
		expect(result.errors).toContain(
			"torn tail: 12 byte(s) after the last newline of events.jsonl (fragment)",
		);
	});

	it("a torn tail read once, under a live writer, then a vault that keeps changing: busy, never the stale torn snapshot", async () => {
		await vaultOf(2);
		liveLock();
		writeFileSync(logPath(), `${readFileSync(logPath(), "utf-8")}{"kind":"llm`);
		// The first attempt (its two listings) reads the torn tail consistently. Every attempt after it is
		// inconsistent, while its first reading is the torn snapshot again: only the inconsistency says
		// the vault is changing.
		seam.flipListingsFrom = 4;
		const read = readVaultSnapshot(auditDir(), { attempts: 5, delayMs: 1 });
		expect(read.kind).toBe("busy");
	});

	it("a segment the directory lists but no open finds is evidence nobody read: a failure in both verifiers, never an empty valid chain", () => {
		mkdirSync(auditDir(), { recursive: true });
		seam.phantomName = "events.0001.jsonl";
		for (const read of [verifyVaultReading, standaloneVerifyVaultReading]) {
			const { result } = read(vaultDir(), { attempts: 2, delayMs: 1 });
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("Audit segment could not be read: events.0001.jsonl");
		}
		// CONTROL: without the phantom name, the same empty directory is an empty, valid chain.
		seam.phantomName = undefined;
		expect(verifyVaultReading(vaultDir()).result).toMatchObject({ valid: true, chainLength: 0 });
	});

	it("verifyVaultBounded reads with its caller's bound: a vault that keeps changing is busy after exactly that many attempts", async () => {
		await vaultOf(2);
		// Every attempt is inconsistent, its second listing never its first: two listings an attempt, then busy.
		seam.flipListingsFrom = 1;
		const result = verifyVaultBounded(vaultDir(), { attempts: 3, delayMs: 1 });
		expect(result).toMatchObject({ valid: false, busy: true });
		expect(seam.listings).toBe(6);
	});

	it("a writer that finishes its line and lets go DURING an attempt: read again, then valid, never 'torn'", async () => {
		await vaultOf(2);
		liveLock();
		const { line, anchor } = nextEvent();
		const half = Math.floor(line.length / 2);
		writeFileSync(logPath(), `${readFileSync(logPath(), "utf-8")}${line.slice(0, half)}`);
		// At the first attempt's last read, after the torn bytes were read: the rest of the line, its
		// anchor, and the lock let go. The lock was held when the bytes were read.
		seam.atQuarantineLstat = {
			n: 2,
			run: () => {
				writeFileSync(logPath(), `${readFileSync(logPath(), "utf-8")}${line.slice(half)}\n`);
				writeFileSync(`${logPath()}.meta`, anchor);
				rmSync(lockPath());
			},
		};
		const { result } = verifyVaultReading(vaultDir(), { attempts: 5, delayMs: 1 });
		expect(seam.atQuarantineLstat).toBeUndefined();
		expect(result).toMatchObject({ valid: true, chainLength: 3, tailState: { state: "MATCH" } });
	});

	it("a lock whose PID is gone, or written before this boot, is no writer; one that cannot be read is", async () => {
		await vaultOf(1);
		// A PID that exists nowhere (the kernel limit is far below it).
		writeFileSync(lockPath(), JSON.stringify({ pid: 2 ** 30, writerId: "w" }));
		expect(writerMayHoldLock(auditDir())).toBe(false);
		writeFileSync(lockPath(), "not json");
		expect(writerMayHoldLock(auditDir())).toBe(true);
		writeFileSync(
			lockPath(),
			JSON.stringify({ pid: process.pid, pidNs: "pid:[1]", writerId: "w" }),
		);
		// Another (or an unknown) PID namespace cannot be probed from here: a writer may hold it.
		expect(writerMayHoldLock(auditDir())).toBe(true);
	});
});

describe("health: a refused tail, and an interrupted recovery, are CRITICAL and named", () => {
	async function health(opts?: { json: true }): Promise<string> {
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			out.push(args.map(String).join(" "));
		});
		const cwd = process.cwd();
		process.chdir(root);
		try {
			await healthRun(undefined, opts);
		} finally {
			process.chdir(cwd);
		}
		const ESC = String.fromCharCode(27);
		return out.join("\n").replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
	}

	it("events missing after the anchored head: FEWER_THAN_ANCHOR, critical", async () => {
		await vaultOf(4);
		const lines = readFileSync(logPath(), "utf-8").trim().split("\n");
		writeFileSync(logPath(), `${lines.slice(0, 2).join("\n")}\n`);
		expect(await health()).toMatch(
			/Chain integrity:\s+FAILED: FEWER_THAN_ANCHOR \(.*\) \[critical\]/,
		);
	});

	it("an interrupted recovery: RECOVERY_PENDING, critical", async () => {
		await vaultOf(2);
		mkdirSync(join(auditDir(), "quarantine"));
		writeFileSync(join(auditDir(), "quarantine", "PENDING"), "{}");
		expect(await health()).toMatch(
			/Chain integrity:\s+FAILED: RECOVERY_PENDING \(.*\) \[critical\]/,
		);
	});

	it("a torn tail is named first, with the repair that applies, in the line and in --json", async () => {
		await vaultOf(2);
		writeFileSync(logPath(), `${readFileSync(logPath(), "utf-8")}{"kind":"llm`);
		expect(await health()).toMatch(
			/Chain integrity:\s+FAILED: TORN_TAIL \(12 byte\(s\) after the last newline, a fragment; `usertrust audit quarantine-tail` moves it aside\) \[critical\]/,
		);
		out.length = 0;
		vi.restoreAllMocks();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const json = await health({ json: true });
		expect(JSON.parse(json).data.signals).toMatchObject({
			chainState: "MATCH",
			chainTorn: { kind: "fragment", length: 12 },
		});
	});

	it("torn bytes after an event one past its anchor: never 'the next append rolls it forward' (it refuses them)", async () => {
		await vaultOf(2);
		const { line } = nextEvent();
		writeFileSync(logPath(), `${readFileSync(logPath(), "utf-8")}${line}\n{"kind":"llm`);
		const text = await health();
		expect(text).toMatch(
			/Chain integrity:\s+FAILED: TORN_TAIL .*one event past its anchor before them/,
		);
		expect(text).not.toMatch(/rolls it forward/);
	});

	it("a torn fragment after a chain with another error: no quarantine-tail hint (it would refuse)", async () => {
		await vaultOf(3);
		const lines = readFileSync(logPath(), "utf-8").trim().split("\n");
		const first = JSON.parse(lines[0] as string) as { data: Record<string, unknown> };
		first.data = { ...first.data, edited: true };
		lines[0] = JSON.stringify(first);
		writeFileSync(logPath(), `${lines.join("\n")}\n{"kind":"llm`);
		const text = await health();
		expect(text).toMatch(
			/Chain integrity:\s+FAILED: TORN_TAIL \(12 byte\(s\) after the last newline, a fragment\)/,
		);
		expect(text).not.toMatch(/quarantine-tail/);
	});

	it("CONTROL: an interrupted WRITE verifies, with its note, and is not critical", async () => {
		await vaultOf(2);
		const { line } = nextEvent();
		writeFileSync(logPath(), `${readFileSync(logPath(), "utf-8")}${line}\n`);
		expect(await health()).toMatch(
			/Chain integrity:\s+verified, one event past its anchor .*\[ok\]/,
		);
	});
});
