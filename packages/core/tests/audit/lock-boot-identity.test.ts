import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Boot-aware staleness. A lock records the kernel's boot id and the writer's PID namespace where
 * they can be read. Another process's lock is reclaimed on boot grounds ONLY when both boot ids
 * are known and differ EXACTLY; an unknown boot id on either side never reads as stale (fail toward
 * live), and the PID judgement decides as before. A lock from another PID namespace is HELD: this
 * process's `kill(pid, 0)` cannot see that namespace's processes.
 *
 * `node:fs` is mocked so both identities can be chosen on any platform: the read of
 * `/proc/sys/kernel/random/boot_id` and of the `/proc/self/ns/pid` link answer what a test says
 * (a value, or a thrown error), and are counted. Everything else passes through. The module caches
 * an identity once read, so every test imports a FRESH copy of it.
 */
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const PID_NS_PATH = "/proc/self/ns/pid";
type Answer = { value: string } | { error: string };
const proc = vi.hoisted(() => ({
	bootId: { value: "" } as { value: string } | { error: string },
	pidNs: { value: "" } as { value: string } | { error: string },
	bootIdReads: 0,
	pidNsReads: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const answer = (a: Answer, path: string): string => {
		if ("error" in a) {
			throw Object.assign(new Error(`${a.error}: injected, '${path}'`), { code: a.error });
		}
		return a.value;
	};
	const readFileSync = ((p: unknown, o?: unknown) => {
		if (p === BOOT_ID_PATH) {
			proc.bootIdReads++;
			return answer(proc.bootId, BOOT_ID_PATH);
		}
		return (fs.readFileSync as (p: unknown, o?: unknown) => unknown)(p, o);
	}) as typeof fs.readFileSync;
	const readlinkSync = ((p: unknown, o?: unknown) => {
		if (p === PID_NS_PATH) {
			proc.pidNsReads++;
			return answer(proc.pidNs, PID_NS_PATH);
		}
		return (fs.readlinkSync as (p: unknown, o?: unknown) => unknown)(p, o);
	}) as typeof fs.readlinkSync;
	const wrapped = { readFileSync, readlinkSync };
	return { ...fs, ...wrapped, default: { ...fs, ...wrapped } };
});

const THIS_BOOT = "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const OTHER_BOOT = "99999999-8888-4777-8666-555555555555";
const THIS_NS = "pid:[4026531836]";
const OTHER_NS = "pid:[4026532999]";
/** A PID no process has (above every pid_max): `kill(pid, 0)` answers ESRCH. */
const DEAD_PID = 999999999;

type Chain = typeof import("../../src/audit/chain.js");
/** A fresh copy of the module: its identity caches start empty. */
async function freshChain(): Promise<Chain> {
	vi.resetModules();
	return import("../../src/audit/chain.js");
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
	proc.bootId = { value: `${THIS_BOOT}\n` };
	proc.pidNs = { value: THIS_NS };
	proc.bootIdReads = 0;
	proc.pidNsReads = 0;
});
proc.bootId = { value: `${THIS_BOOT}\n` };
proc.pidNs = { value: THIS_NS };

function vault(): string {
	const dir = mkdtempSync(join(tmpdir(), "trust-audit-boot-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, ".usertrust", "audit"), { recursive: true });
	return dir;
}
const lockOf = (v: string) => join(v, ".usertrust", "audit", ".audit-writer.lock");
const readLock = (v: string) =>
	JSON.parse(readFileSync(lockOf(v), "utf-8")) as Record<string, unknown>;
function plantLock(v: string, claim: Record<string, unknown>): string {
	const bytes = JSON.stringify({
		writerId: "planted",
		startedAt: "2020-01-01T00:00:00Z",
		...claim,
	});
	writeFileSync(lockOf(v), bytes);
	return bytes;
}

/** Take the vault's lock with a fresh module; the writer, or the error it threw. */
function acquire(chain: Chain, v: string): { taken: boolean; err?: unknown } {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const w = chain.createAuditWriter(v, { lockAtCreate: true });
		cleanups.unshift(() => w.release());
		return { taken: true };
	} catch (err) {
		return { taken: false, err };
	} finally {
		warn.mockRestore();
	}
}

function expectHeld(chain: Chain, v: string, bytes: string): void {
	const { taken, err } = acquire(chain, v);
	expect(taken, "the lock is held").toBe(false);
	expect(err).toBeInstanceOf(chain.AuditWriterLockHeldError);
	expect(readFileSync(lockOf(v), "utf-8"), "the held lock is untouched").toBe(bytes);
}

function expectReclaimed(chain: Chain, v: string): void {
	const { taken, err } = acquire(chain, v);
	expect(err).toBeUndefined();
	expect(taken).toBe(true);
	expect(readLock(v).pid).toBe(process.pid);
	expect(readLock(v).writerId).not.toBe("planted");
}

describe("the lock records this boot and this PID namespace", () => {
	it("carries the boot id and the namespace when they can be read", async () => {
		const chain = await freshChain();
		const v = vault();
		expect(acquire(chain, v).taken).toBe(true);
		expect(readLock(v)).toMatchObject({ pid: process.pid, bootId: THIS_BOOT, pidNs: THIS_NS });
	});

	it("omits each one that cannot be read (or is not of its form) — never records a guess", async () => {
		proc.bootId = { error: "ENOENT" };
		proc.pidNs = { value: "not a namespace" };
		const chain = await freshChain();
		const v = vault();
		expect(acquire(chain, v).taken).toBe(true);
		expect(readLock(v)).not.toHaveProperty("bootId");
		expect(readLock(v)).not.toHaveProperty("pidNs");
	});
});

describe("boot-aware staleness: reclaimed on boot grounds ONLY on an exact mismatch of two known boot ids", () => {
	it("P1: a lock from ANOTHER boot whose PID is now carried by a live, unrelated process is reclaimed — not held forever", async () => {
		const chain = await freshChain();
		const v = vault();
		plantLock(v, { pid: process.ppid, bootId: OTHER_BOOT, pidNs: THIS_NS });
		expectReclaimed(chain, v);
		expect(readLock(v).bootId).toBe(THIS_BOOT);
	});

	it("…even when the old lock names another PID namespace: namespaces end with their boot", async () => {
		const chain = await freshChain();
		const v = vault();
		plantLock(v, { pid: process.pid, bootId: OTHER_BOOT, pidNs: OTHER_NS });
		expectReclaimed(chain, v);
	});

	it("the SAME boot id with a live PID is held", async () => {
		const chain = await freshChain();
		const v = vault();
		const bytes = plantLock(v, { pid: process.ppid, bootId: THIS_BOOT, pidNs: THIS_NS });
		expectHeld(chain, v, bytes);
	});

	it.each([
		[
			"this process cannot read its boot id (ENOENT: not Linux, no /proc)",
			{ error: "ENOENT" },
			OTHER_BOOT,
		],
		["this process's boot id read fails (EIO)", { error: "EIO" }, OTHER_BOOT],
		["this process's boot id is not of its form", { value: "garbage\n" }, OTHER_BOOT],
		["the lock has no boot id", { value: THIS_BOOT }, undefined],
		["the lock's boot id is not of its form", { value: THIS_BOOT }, "not-a-boot-id"],
		[
			"the lock's boot id differs only in letter case",
			{ value: THIS_BOOT },
			THIS_BOOT.toUpperCase(),
		],
	] as const)(
		"UNKNOWN on one side — %s — is never stale: a live PID holds",
		async (_name, ours, theirs) => {
			proc.bootId = ours;
			const chain = await freshChain();
			const v = vault();
			const bytes = plantLock(v, {
				pid: process.ppid,
				...(theirs === undefined ? {} : { bootId: theirs }),
				pidNs: THIS_NS,
			});
			expectHeld(chain, v, bytes);
		},
	);

	it("a FAILED boot-id read is neither stale nor cached: the next acquire reads again, and then reclaims", async () => {
		proc.bootId = { error: "EIO" };
		const chain = await freshChain();
		const v = vault();
		const bytes = plantLock(v, { pid: process.ppid, bootId: OTHER_BOOT, pidNs: THIS_NS });
		expectHeld(chain, v, bytes);
		const readsWhileFailing = proc.bootIdReads;
		expect(readsWhileFailing, "control: the read was attempted").toBeGreaterThan(0);

		proc.bootId = { value: `${THIS_BOOT}\n` };
		expectReclaimed(chain, v);
		expect(proc.bootIdReads, "read again — the failure was not cached").toBeGreaterThan(
			readsWhileFailing,
		);
	});

	it("a SUCCESSFUL boot-id read is cached: a later failing read changes nothing", async () => {
		const chain = await freshChain();
		const first = vault();
		expect(acquire(chain, first).taken).toBe(true);
		const reads = proc.bootIdReads;
		expect(reads, "control: read once").toBe(1);

		proc.bootId = { error: "EIO" };
		const v = vault();
		plantLock(v, { pid: process.ppid, bootId: OTHER_BOOT, pidNs: THIS_NS });
		expectReclaimed(chain, v);
		expect(proc.bootIdReads).toBe(reads);
	});

	it.each([
		["a live PID holds", process.ppid, false],
		["a dead PID is reclaimed", DEAD_PID, true],
	] as const)(
		"an OLD-FORMAT lock (no boot id, no namespace) is judged as before: %s",
		async (_name, pid, reclaimed) => {
			const chain = await freshChain();
			const v = vault();
			const bytes = plantLock(v, { pid });
			if (reclaimed) expectReclaimed(chain, v);
			else expectHeld(chain, v, bytes);
		},
	);
});

describe("PID namespaces: a lock from another namespace is HELD — this process cannot probe it", () => {
	it("P1: THIS process's PID number in ANOTHER namespace (a sibling container's PID 1) is held — never reclaimed as a crashed same-PID writer", async () => {
		const chain = await freshChain();
		const v = vault();
		const bytes = plantLock(v, { pid: process.pid, bootId: THIS_BOOT, pidNs: OTHER_NS });
		expectHeld(chain, v, bytes);
	});

	it("P1: a PID that is dead HERE but in another namespace is held — the probe looked in the wrong namespace", async () => {
		const chain = await freshChain();
		const v = vault();
		const bytes = plantLock(v, { pid: DEAD_PID, bootId: THIS_BOOT, pidNs: OTHER_NS });
		expectHeld(chain, v, bytes);
	});

	it.each([
		["this process cannot read its own namespace", { error: "ENOENT" }, OTHER_NS],
		["the lock's namespace is not of its form", { value: THIS_NS }, "garbage"],
	] as const)(
		"a namespace that cannot be compared — %s — is held, dead PID or not (fail toward live)",
		async (_name, ours, theirs) => {
			proc.pidNs = ours;
			const chain = await freshChain();
			const v = vault();
			const bytes = plantLock(v, { pid: DEAD_PID, bootId: THIS_BOOT, pidNs: theirs });
			expectHeld(chain, v, bytes);
		},
	);

	it.each([
		["the same PID (a crashed earlier instance) is reclaimed", process.pid, true],
		["a dead PID is reclaimed", DEAD_PID, true],
		["a live PID is held", process.ppid, false],
	] as const)(
		"the SAME namespace is judged by PID as before: %s",
		async (_name, pid, reclaimed) => {
			const chain = await freshChain();
			const v = vault();
			const bytes = plantLock(v, { pid, bootId: THIS_BOOT, pidNs: THIS_NS });
			if (reclaimed) expectReclaimed(chain, v);
			else expectHeld(chain, v, bytes);
		},
	);

	it("a lock that names no namespace is judged by PID as before, wherever it is read", async () => {
		const chain = await freshChain();
		const v = vault();
		plantLock(v, { pid: process.pid, bootId: THIS_BOOT });
		expectReclaimed(chain, v);
		expect(existsSync(lockOf(v))).toBe(true);
	});
});
