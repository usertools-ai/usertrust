import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * #196 r2 — the writer lock across PID NAMESPACES, and the boot-id cache.
 * Containers on one Linux host share `boot_id`, but `kill(pid, 0)` sees only the caller's PID
 * namespace: a LIVE writer in another container must read as HELD, never reclaimed — including
 * when it carries THIS process's PID (containers often run their writer as PID 1). Modelled on any
 * host: `process.platform` reads "linux" and `/proc` is answered by a mocked `node:fs`.
 */
const proc = { bootId: "boot-A", ns: "pid:[4026531836]", bootReads: 0, failBootReads: 0 };
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const readFileSync = ((p: unknown, ...rest: unknown[]) => {
		if (p === "/proc/sys/kernel/random/boot_id") {
			proc.bootReads++;
			if (proc.failBootReads > 0) {
				proc.failBootReads--;
				throw Object.assign(new Error("EAGAIN"), { code: "EAGAIN" });
			}
			return `${proc.bootId}\n`;
		}
		return (fs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
	}) as typeof fs.readFileSync;
	const readlinkSync = ((p: unknown, ...rest: unknown[]) => {
		if (p === "/proc/self/ns/pid") return proc.ns;
		return (fs.readlinkSync as (...a: unknown[]) => unknown)(p, ...rest);
	}) as typeof fs.readlinkSync;
	return { ...fs, readFileSync, readlinkSync, default: { ...fs, readFileSync, readlinkSync } };
});

const realPlatform = process.platform;
beforeAll(() => Object.defineProperty(process, "platform", { value: "linux" }));
afterAll(() => Object.defineProperty(process, "platform", { value: realPlatform }));

const { AuditWriterLockHeldError, createAuditWriter } = await import("../../src/audit/chain.js");
const { VAULT_DIR } = await import("../../src/shared/constants.js");

const dirs: string[] = [];
const releases: Array<() => void> = [];
afterEach(() => {
	for (const r of releases.splice(0)) r();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function vault() {
	const d = mkdtempSync(join(tmpdir(), "trust-ns-"));
	dirs.push(d);
	mkdirSync(join(d, VAULT_DIR, "audit"), { recursive: true });
	return d;
}
const lockOf = (v: string) => join(v, VAULT_DIR, "audit", ".audit-writer.lock");

describe("#196 r2 P3: only a SUCCESSFUL boot-id read is cached", () => {
	it("a failed first read does not leave later locks without a boot id", () => {
		proc.failBootReads = 1;
		const v1 = vault();
		const w1 = createAuditWriter(v1, { lockAtCreate: true });
		w1.release();
		const v2 = vault();
		const w2 = createAuditWriter(v2, { lockAtCreate: true });
		releases.push(() => w2.release());
		expect(JSON.parse(readFileSync(lockOf(v2), "utf-8"))).toMatchObject({ bootId: "boot-A" });
	});
});

describe("#196 r2 P2: a lock from ANOTHER PID namespace is HELD, never reclaimed", () => {
	it("a created lock records this process's PID namespace", () => {
		const v = vault();
		const w = createAuditWriter(v, { lockAtCreate: true });
		releases.push(() => w.release());
		expect(JSON.parse(readFileSync(lockOf(v), "utf-8"))).toMatchObject({
			pidNs: "pid:[4026531836]",
		});
	});

	it("same boot, FOREIGN namespace, carrying THIS process's own PID: HELD (not the same-PID reclaim)", () => {
		const v = vault();
		writeFileSync(
			lockOf(v),
			JSON.stringify({ pid: process.pid, bootId: "boot-A", bootTime: 1, pidNs: "pid:[999]" }),
		);
		expect(() => createAuditWriter(v, { lockAtCreate: true })).toThrow(AuditWriterLockHeldError);
		expect(() => createAuditWriter(v, { lockAtCreate: true })).toThrow(/ANOTHER PID namespace/);
	});

	it("same boot, foreign namespace, a PID that is DEAD here: still HELD — the probe looks in the wrong namespace", () => {
		const v = vault();
		writeFileSync(
			lockOf(v),
			JSON.stringify({ pid: 2 ** 22 - 3, bootId: "boot-A", bootTime: 1, pidNs: "pid:[999]" }),
		);
		expect(() => createAuditWriter(v, { lockAtCreate: true })).toThrow(AuditWriterLockHeldError);
	});

	it("a PREVIOUS boot (exact id differs) in a foreign namespace: reclaimed — no process of that boot survives", () => {
		const v = vault();
		writeFileSync(
			lockOf(v),
			JSON.stringify({ pid: process.pid, bootId: "boot-OLD", bootTime: 1, pidNs: "pid:[999]" }),
		);
		const w = createAuditWriter(v, { lockAtCreate: true });
		releases.push(() => w.release());
		expect(JSON.parse(readFileSync(lockOf(v), "utf-8"))).toMatchObject({
			pid: process.pid,
			pidNs: "pid:[4026531836]",
		});
	});

	it("SAME namespace, same PID, no live in-process writer: the crashed same-PID reclaim still applies", () => {
		const v = vault();
		writeFileSync(
			lockOf(v),
			JSON.stringify({
				pid: process.pid,
				bootId: "boot-A",
				bootTime: 1,
				pidNs: "pid:[4026531836]",
			}),
		);
		const w = createAuditWriter(v, { lockAtCreate: true });
		releases.push(() => w.release());
		expect(JSON.parse(readFileSync(lockOf(v), "utf-8"))).toMatchObject({ pid: process.pid });
	});

	it("a lock with NO namespace (older writer) is judged as before: a dead PID is reclaimed", () => {
		const v = vault();
		writeFileSync(lockOf(v), JSON.stringify({ pid: 2 ** 22 - 3, bootId: "boot-A", bootTime: 1 }));
		const w = createAuditWriter(v, { lockAtCreate: true });
		releases.push(() => w.release());
	});
});
