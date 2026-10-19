import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The lease: the one proof that a lock's holder is gone which works ACROSS PID namespaces.
 *
 * A writer that records its PID namespace declares a lease in its lock (`leaseRenewMs`) and renews
 * the lock file's mtime on a timer. Another namespace's lock is reclaimed only when its lease is
 * expired on the wall clock AND this process has itself seen it unrenewed across the confirmation
 * window of its own monotonic clock. Without a lease (a lock an earlier version wrote) another
 * namespace's lock is held, as before, and the refusal says how to recover by hand.
 *
 * `node:fs` is mocked so the boot id and the PID namespace can be chosen on any platform, as in
 * lock-boot-identity.test.ts. Two FRESH copies of the module, each having read a different namespace,
 * stand for two processes in two namespaces: each has its own registry of live writers, its own
 * renewal timer and its own observations, and they share only the files.
 *
 * The monotonic clock is `performance.now()`, faked here so the confirmation window can pass without
 * waiting. The wall-clock age is the lock file's mtime, set with `utimesSync`; `Date` stays real.
 */
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const PID_NS_PATH = "/proc/self/ns/pid";
type Answer = { value: string } | { error: string };
const proc = vi.hoisted(() => ({
	bootId: { value: "" } as { value: string } | { error: string },
	pidNs: { value: "" } as { value: string } | { error: string },
	/** When set, every `futimesSync` fails with this code: a filesystem that cannot set an mtime. */
	futimesError: undefined as string | undefined,
	futimesCalls: 0,
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
		if (p === BOOT_ID_PATH) return answer(proc.bootId, BOOT_ID_PATH);
		return (fs.readFileSync as (p: unknown, o?: unknown) => unknown)(p, o);
	}) as typeof fs.readFileSync;
	const readlinkSync = ((p: unknown, o?: unknown) => {
		if (p === PID_NS_PATH) return answer(proc.pidNs, PID_NS_PATH);
		return (fs.readlinkSync as (p: unknown, o?: unknown) => unknown)(p, o);
	}) as typeof fs.readlinkSync;
	const futimesSync = ((...args: Parameters<typeof fs.futimesSync>) => {
		proc.futimesCalls++;
		if (proc.futimesError !== undefined) {
			throw Object.assign(new Error(`${proc.futimesError}: injected futimes`), {
				code: proc.futimesError,
			});
		}
		return fs.futimesSync(...args);
	}) as typeof fs.futimesSync;
	const wrapped = { readFileSync, readlinkSync, futimesSync };
	return { ...fs, ...wrapped, default: { ...fs, ...wrapped } };
});

const THIS_BOOT = "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const OTHER_BOOT = "99999999-8888-4777-8666-555555555555";
const THIS_NS = "pid:[4026531836]";
const OTHER_NS = "pid:[4026532999]";
/** A PID no process has (above every pid_max): `kill(pid, 0)` answers ESRCH. */
const DEAD_PID = 999999999;
/** The shipped lease constants, as a reader applies them to a lock declaring a 10 s renewal. */
const RENEW_MS = 10_000;
const STALE_MS = 60_000;
const CONFIRM_MS = 30_000;
const TEN_MINUTES_AGO = () => new Date(Date.now() - 10 * 60_000);

type Chain = typeof import("../../src/audit/chain.js");
/** A fresh copy of the module, in namespace `ns`: it reads (and caches) its identity at first use. */
async function processIn(ns: string): Promise<Chain> {
	proc.pidNs = { value: ns };
	vi.resetModules();
	const chain = await import("../../src/audit/chain.js");
	return chain;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) {
		try {
			c();
		} catch {
			/* a lock this test took away from its writer: nothing to release */
		}
	}
	vi.useRealTimers();
	vi.restoreAllMocks();
	proc.bootId = { value: `${THIS_BOOT}\n` };
	proc.pidNs = { value: THIS_NS };
	proc.futimesError = undefined;
	proc.futimesCalls = 0;
});
proc.bootId = { value: `${THIS_BOOT}\n` };
proc.pidNs = { value: THIS_NS };

function vault(): string {
	const dir = mkdtempSync(join(tmpdir(), "trust-audit-lease-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, ".usertrust", "audit"), { recursive: true });
	return dir;
}
const lockOf = (v: string) => join(v, ".usertrust", "audit", ".audit-writer.lock");
const logOf = (v: string) => join(v, ".usertrust", "audit", "events.jsonl");
const readLock = (v: string) =>
	JSON.parse(readFileSync(lockOf(v), "utf-8")) as Record<string, unknown>;
const mtimeNsOf = (v: string) => statSync(lockOf(v), { bigint: true }).mtimeNs;
const linesOf = (v: string) =>
	existsSync(logOf(v)) ? readFileSync(logOf(v), "utf-8").trim().split("\n").length : 0;

/** Plant another process's lock, its mtime set to `mtime` (its last lease renewal). */
function plantLock(v: string, claim: Record<string, unknown>, mtime: Date): string {
	const bytes = JSON.stringify({
		writerId: "planted",
		startedAt: "2020-01-01T00:00:00Z",
		...claim,
	});
	writeFileSync(lockOf(v), bytes);
	utimesSync(lockOf(v), mtime, mtime);
	return bytes;
}

/** Take the vault's lock now; the writer, or the error the acquire threw. */
function acquire(
	chain: Chain,
	v: string,
): { writer?: ReturnType<Chain["createAuditWriter"]>; err?: unknown } {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const writer = chain.createAuditWriter(v, { lockAtCreate: true });
		cleanups.unshift(() => writer.release());
		return { writer };
	} catch (err) {
		return { err };
	} finally {
		warn.mockRestore();
	}
}

function expectHeld(chain: Chain, v: string, bytes: string): string {
	const { writer, err } = acquire(chain, v);
	expect(writer, "the lock is held").toBeUndefined();
	expect(err).toBeInstanceOf(chain.AuditWriterLockHeldError);
	expect(readFileSync(lockOf(v), "utf-8"), "the held lock is untouched").toBe(bytes);
	return (err as Error).message;
}

function expectReclaimed(chain: Chain, v: string): void {
	const { writer, err } = acquire(chain, v);
	expect(err).toBeUndefined();
	expect(writer).toBeDefined();
	expect(readLock(v).writerId).not.toBe("planted");
	expect(readLock(v).pidNs).toBe(THIS_NS);
}

/** Pass `ms` of the monotonic clock, with positive control that it moved. */
function passMonotonic(ms: number): void {
	const before = performance.now();
	vi.advanceTimersByTime(ms);
	expect(performance.now() - before, "control: the monotonic clock moved").toBeGreaterThanOrEqual(
		ms,
	);
}

describe("a writer that records its namespace declares a lease", () => {
	it("records leaseRenewMs beside its namespace, its mtime is now, and its timer runs only while it holds the lock", async () => {
		vi.useFakeTimers({ toFake: ["performance", "setInterval", "clearInterval"] });
		const chain = await processIn(THIS_NS);
		const v = vault();
		const { writer } = acquire(chain, v);
		expect(writer).toBeDefined();
		expect(readLock(v)).toMatchObject({ pidNs: THIS_NS, leaseRenewMs: RENEW_MS });
		expect(Math.abs(Date.now() - Number(mtimeNsOf(v) / 1_000_000n))).toBeLessThan(5_000);
		expect(vi.getTimerCount(), "the renewal timer").toBe(1);
		writer?.release();
		expect(vi.getTimerCount(), "stopped once no leased lock is held").toBe(0);
	});

	it("declares none where its namespace cannot be read — no reader could consult it, and no timer runs", async () => {
		vi.useFakeTimers({ toFake: ["performance", "setInterval", "clearInterval"] });
		proc.pidNs = { error: "ENOENT" };
		vi.resetModules();
		const chain = await import("../../src/audit/chain.js");
		const v = vault();
		expect(acquire(chain, v).writer).toBeDefined();
		expect(readLock(v)).not.toHaveProperty("leaseRenewMs");
		expect(readLock(v)).not.toHaveProperty("pidNs");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("declares NO lease where the lock's own mtime cannot be set (fail toward live): no timer, and judged as an earlier version's lock", async () => {
		vi.useFakeTimers({ toFake: ["performance", "setInterval", "clearInterval"] });
		proc.futimesError = "EPERM";
		const chain = await processIn(THIS_NS);
		const v = vault();
		expect(acquire(chain, v).writer).toBeDefined();
		expect(proc.futimesCalls, "control: the probe ran").toBeGreaterThan(0);
		expect(readLock(v)).toMatchObject({ pidNs: THIS_NS });
		expect(readLock(v)).not.toHaveProperty("leaseRenewMs");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("renews only its OWN lock file: a file another writer put at that path keeps its mtime", async () => {
		vi.useFakeTimers({ toFake: ["performance", "setInterval", "clearInterval"] });
		const chain = await processIn(THIS_NS);
		const v = vault();
		expect(acquire(chain, v).writer).toBeDefined();
		utimesSync(lockOf(v), TEN_MINUTES_AGO(), TEN_MINUTES_AGO());
		const own = mtimeNsOf(v);
		vi.advanceTimersByTime(RENEW_MS);
		expect(mtimeNsOf(v), "control: its own lock IS renewed").not.toBe(own);

		rmSync(lockOf(v));
		const old = TEN_MINUTES_AGO();
		plantLock(v, { pid: DEAD_PID, pidNs: OTHER_NS, leaseRenewMs: RENEW_MS }, old);
		const planted = mtimeNsOf(v);
		vi.advanceTimersByTime(3 * RENEW_MS);
		expect(mtimeNsOf(v), "another writer's file is never renewed").toBe(planted);
	});
});

describe("another namespace's lock with a lease: reclaimed only once the lease is proven expired", () => {
	it("P1: foreign namespace, different boot id, EXPIRED lease — refused while this process confirms it, then reclaimed", async () => {
		vi.useFakeTimers({ toFake: ["performance"] });
		const chain = await processIn(THIS_NS);
		const v = vault();
		const bytes = plantLock(
			v,
			{ pid: DEAD_PID, bootId: OTHER_BOOT, pidNs: OTHER_NS, leaseRenewMs: RENEW_MS },
			TEN_MINUTES_AGO(),
		);
		const first = expectHeld(chain, v, bytes);
		expect(first).toContain("reclaimed automatically at the first append");
		passMonotonic(CONFIRM_MS - 1);
		expectHeld(chain, v, bytes);
		passMonotonic(1);
		expectReclaimed(chain, v);
		expect(readLock(v).bootId).toBe(THIS_BOOT);
	});

	it("P1: a FRESH lease from another namespace (the systemd-nspawn case: private boot id, LIVE writer) is held — and stays held across the confirmation window", async () => {
		vi.useFakeTimers({ toFake: ["performance"] });
		const chain = await processIn(THIS_NS);
		const v = vault();
		const bytes = plantLock(
			v,
			{ pid: process.pid, bootId: OTHER_BOOT, pidNs: OTHER_NS, leaseRenewMs: RENEW_MS },
			new Date(),
		);
		const message = expectHeld(chain, v, bytes);
		expect(message).toContain("in another PID namespace");
		expect(message).toContain("renewed its lease");
		passMonotonic(CONFIRM_MS + 1);
		expectHeld(chain, v, bytes);
		passMonotonic(10 * CONFIRM_MS);
		expectHeld(chain, v, bytes);
	});

	it("a lease whose mtime is AHEAD of this clock is fresh (fail toward live)", async () => {
		vi.useFakeTimers({ toFake: ["performance"] });
		const chain = await processIn(THIS_NS);
		const v = vault();
		const ahead = new Date(Date.now() + 10 * 60_000);
		const bytes = plantLock(v, { pid: DEAD_PID, pidNs: OTHER_NS, leaseRenewMs: RENEW_MS }, ahead);
		expectHeld(chain, v, bytes);
		passMonotonic(CONFIRM_MS + 1);
		expectHeld(chain, v, bytes);
	});

	it("a lock declaring a slower renewal is judged by ITS thresholds (6× and 3× its interval), never shorter ones", async () => {
		vi.useFakeTimers({ toFake: ["performance"] });
		const chain = await processIn(THIS_NS);
		const v = vault();
		// 20 s renewals: stale after 120 s. 100 s old is past the default 60 s, and still fresh.
		const bytes = plantLock(
			v,
			{ pid: DEAD_PID, pidNs: OTHER_NS, leaseRenewMs: 20_000 },
			new Date(Date.now() - 100_000),
		);
		expectHeld(chain, v, bytes);
		passMonotonic(2 * CONFIRM_MS + 1);
		expectHeld(chain, v, bytes);
	});

	it.each([
		["a string", "10000"],
		["zero", 0],
		["a fraction", 1.5],
		["more than an hour", 3_600_001],
	] as const)(
		"a lease declared as %s is no lease: held, as an earlier version's lock",
		async (_name, leaseRenewMs) => {
			vi.useFakeTimers({ toFake: ["performance"] });
			const chain = await processIn(THIS_NS);
			const v = vault();
			const bytes = plantLock(
				v,
				{ pid: DEAD_PID, bootId: OTHER_BOOT, pidNs: OTHER_NS, leaseRenewMs },
				TEN_MINUTES_AGO(),
			);
			expect(expectHeld(chain, v, bytes)).toContain("carries no lease");
			passMonotonic(CONFIRM_MS + 1);
			expectHeld(chain, v, bytes);
		},
	);

	it("a namespace that cannot be compared is held whatever its lease says (unchanged), and prints the recovery steps", async () => {
		vi.useFakeTimers({ toFake: ["performance"] });
		proc.pidNs = { error: "ENOENT" };
		vi.resetModules();
		const chain = await import("../../src/audit/chain.js");
		const v = vault();
		const bytes = plantLock(
			v,
			{ pid: DEAD_PID, pidNs: OTHER_NS, leaseRenewMs: RENEW_MS },
			TEN_MINUTES_AGO(),
		);
		expect(expectHeld(chain, v, bytes)).toContain("cannot compare with its own");
		passMonotonic(CONFIRM_MS + 1);
		const message = expectHeld(chain, v, bytes);
		expect(message).toContain("Remove exactly this file");
	});
});

describe("two writers in two namespaces: the lease decides, and a holder that lost it stops appending", () => {
	it("P1: a LIVE holder whose lease reads expired at once (a host suspend, a clock step forward) renews within the window, and keeps its lock", async () => {
		vi.useFakeTimers({ toFake: ["performance", "setInterval", "clearInterval"] });
		const holder = await processIn(OTHER_NS);
		const v = vault();
		expect(acquire(holder, v).writer).toBeDefined();
		expect(readLock(v).leaseRenewMs).toBe(RENEW_MS);
		// Every lease reads ten minutes old the moment the clock steps.
		utimesSync(lockOf(v), TEN_MINUTES_AGO(), TEN_MINUTES_AGO());
		const stepped = mtimeNsOf(v);
		const bytes = readFileSync(lockOf(v), "utf-8");

		const observer = await processIn(THIS_NS);
		expect(expectHeld(observer, v, bytes)).toContain("reclaimed automatically at the first append");
		// The holder's timer runs on the same monotonic clock as the observer's window.
		passMonotonic(CONFIRM_MS + 1);
		expect(mtimeNsOf(v), "control: the holder renewed").not.toBe(stepped);
		expect(expectHeld(observer, v, bytes)).toContain("renewed its lease");
		expect(readLock(v).pidNs, "still the holder's lock").toBe(OTHER_NS);
	});

	it("P1: a holder that stopped renewing loses the lock to another namespace, and its next append is REFUSED — the chain does not fork", async () => {
		// Only the monotonic clock is faked: the holder's real 10 s renewal timer never fires during
		// this test — a holder frozen (SIGSTOP, a paused container) or blocked past the threshold.
		vi.useFakeTimers({ toFake: ["performance"] });
		const holder = await processIn(OTHER_NS);
		const v = vault();
		const held = acquire(holder, v).writer;
		expect(held).toBeDefined();
		await held?.appendEvent({ kind: "test", actor: "holder", data: { n: 1 } });
		expect(linesOf(v)).toBe(1);
		utimesSync(lockOf(v), TEN_MINUTES_AGO(), TEN_MINUTES_AGO());
		const holderBytes = readFileSync(lockOf(v), "utf-8");

		const taker = await processIn(THIS_NS);
		expectHeld(taker, v, holderBytes);
		passMonotonic(CONFIRM_MS);
		const { writer: took } = acquire(taker, v);
		expect(took, "the taker reclaimed the expired lease").toBeDefined();
		expect(readLock(v).pidNs).toBe(THIS_NS);
		await took?.appendEvent({ kind: "test", actor: "taker", data: { n: 2 } });
		expect(linesOf(v)).toBe(2);

		// The old holder wakes and appends: it checks that it still owns the lock first.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const late = held?.appendEvent({ kind: "test", actor: "holder", data: { n: 3 } });
		await expect(late).rejects.toBeInstanceOf(holder.AuditWriterLockHeldError);
		warn.mockRestore();
		expect(linesOf(v), "nothing appended by the holder that lost the lock").toBe(2);
		expect(readLock(v).pidNs, "the taker's lock is untouched").toBe(THIS_NS);
		// The chain the taker extended is one chain: its event follows the holder's first.
		const [first, second] = readFileSync(logOf(v), "utf-8").trim().split("\n");
		expect(JSON.parse(second as string).previousHash).toBe(JSON.parse(first as string).hash);
	});
});

describe("unchanged: a lock without a lease, and a lock from this namespace", () => {
	it("P1: an OLD-FORMAT lock from another namespace, from before a reboot, is held however old it is — and the refusal prints the safe recovery steps", async () => {
		vi.useFakeTimers({ toFake: ["performance"] });
		const chain = await processIn(THIS_NS);
		const v = vault();
		const bytes = plantLock(
			v,
			{ pid: 1234, bootId: OTHER_BOOT, pidNs: OTHER_NS },
			new Date(Date.now() - 7 * 24 * 3600_000),
		);
		expectHeld(chain, v, bytes);
		passMonotonic(10 * CONFIRM_MS);
		const message = expectHeld(chain, v, bytes);
		expect(message).toContain("PID 1234 in another PID namespace");
		expect(message).toContain("carries no lease");
		expect(message).toContain("ps -eo pid,args");
		expect(message).toContain("wsl --list --running");
		expect(message).toContain("tasklist");
		// The lock is named by its physical path (the directory's realpath), and so is the vault root.
		const root = realpathSync(v);
		expect(message).toContain(`Remove exactly this file and nothing else: ${lockOf(root)}`);
		expect(message).toContain(`\`usertrust verify ${root}\``);
	});

	it.each([
		["a live PID is held, however old its lease", process.ppid, false],
		["a dead PID is reclaimed at once, with no confirmation window", DEAD_PID, true],
	] as const)(
		"a leased lock from THIS namespace is judged by PID, as before: %s",
		async (_name, pid, reclaimed) => {
			vi.useFakeTimers({ toFake: ["performance"] });
			const chain = await processIn(THIS_NS);
			const v = vault();
			const bytes = plantLock(
				v,
				{ pid, bootId: THIS_BOOT, pidNs: THIS_NS, leaseRenewMs: RENEW_MS },
				TEN_MINUTES_AGO(),
			);
			if (reclaimed) expectReclaimed(chain, v);
			else expectHeld(chain, v, bytes);
		},
	);
});

// The thresholds are internal constants; this pins the values the comments and the documentation
// state, so a change to one is a change to all.
describe("the documented thresholds", () => {
	it("an expired lease is reclaimed only after BOTH 60 s of wall age and 30 s of this process's own observation", async () => {
		vi.useFakeTimers({ toFake: ["performance"] });
		const chain = await processIn(THIS_NS);
		const v = vault();
		// Just inside the wall threshold: seen unrenewed for any time, still fresh.
		const bytes = plantLock(
			v,
			{ pid: DEAD_PID, pidNs: OTHER_NS, leaseRenewMs: RENEW_MS },
			new Date(Date.now() - (STALE_MS - 5_000)),
		);
		expectHeld(chain, v, bytes);
		passMonotonic(CONFIRM_MS + 1);
		expectHeld(chain, v, bytes);
	});
});
