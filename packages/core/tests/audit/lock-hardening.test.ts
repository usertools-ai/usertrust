import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditWriterLockHeldError, createAuditWriter } from "../../src/audit/chain.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

const dirs: string[] = [];
const releases: Array<() => void> = [];
afterEach(() => {
	for (const r of releases.splice(0)) r();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function vault() {
	const d = mkdtempSync(join(tmpdir(), "trust-lock-hard-"));
	dirs.push(d);
	mkdirSync(join(d, VAULT_DIR, "audit"), { recursive: true });
	return d;
}
const lockOf = (v: string) => join(v, VAULT_DIR, "audit", ".audit-writer.lock");
/** This boot's identity, as a writer records it. */
function currentBoot(): { bootId?: string; bootTime: number } {
	const v = vault();
	const w = createAuditWriter(v, { lockAtCreate: true });
	const lock = JSON.parse(readFileSync(lockOf(v), "utf-8")) as {
		bootId?: string;
		bootTime: number;
	};
	w.release();
	// ONLY the boot fields: the lock's own pid must not leak into a fixture.
	return lock.bootId === undefined
		? { bootTime: lock.bootTime }
		: { bootId: lock.bootId, bootTime: lock.bootTime };
}

describe("#194.3: a lock is created whole, and an incomplete one reads as HELD", () => {
	it("a created lock carries the pid, writer id and this boot's identity, and no temp file is left behind", () => {
		const v = vault();
		const w = createAuditWriter(v, { lockAtCreate: true });
		releases.push(() => w.release());
		const lock = JSON.parse(readFileSync(lockOf(v), "utf-8")) as Record<string, unknown>;
		expect(lock).toMatchObject({ pid: process.pid });
		expect(typeof lock.bootTime).toBe("number");
		expect(readdirSync(join(v, VAULT_DIR, "audit")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	for (const [name, content] of [
		["an EMPTY lock (a writer between create and write)", ""],
		["a lock cut short mid-JSON", '{"pid":12'],
	] as const) {
		it(`${name}, freshly written: HELD — never deleted as corrupt`, () => {
			const v = vault();
			writeFileSync(lockOf(v), content);
			expect(() => createAuditWriter(v, { lockAtCreate: true })).toThrow(AuditWriterLockHeldError);
			expect(readFileSync(lockOf(v), "utf-8")).toBe(content);
		});
	}

	it("an incomplete lock older than any write takes is abandoned: reclaimed", () => {
		const v = vault();
		writeFileSync(lockOf(v), "");
		const old = new Date(Date.now() - 120_000);
		utimesSync(lockOf(v), old, old);
		const w = createAuditWriter(v, { lockAtCreate: true });
		releases.push(() => w.release());
		expect(JSON.parse(readFileSync(lockOf(v), "utf-8"))).toMatchObject({ pid: process.pid });
	});
});

describe("#194.4 / #196 r1: a lock from a PREVIOUS boot (by EXACT boot id) is stale; a time estimate never reclaims", () => {
	it("#196 r1 P1: a live PID whose recorded boot TIME is an hour off (a clock step), same or no boot id: HELD — never reclaimed on a time estimate", () => {
		const boot = currentBoot();
		const v = vault();
		// The boot-time estimate moves with every wall-clock step; reclaiming on it deleted a LIVE
		// lock and forked the chain. Only an exact boot id may reclaim.
		writeFileSync(
			lockOf(v),
			JSON.stringify({
				pid: process.ppid,
				...(boot.bootId === undefined ? {} : { bootId: boot.bootId }),
				bootTime: boot.bootTime - 3600,
			}),
		);
		expect(() => createAuditWriter(v, { lockAtCreate: true })).toThrow(AuditWriterLockHeldError);
	});

	it("a live PID recorded under a DIFFERENT exact boot id: reclaimed (where this host has an exact id)", () => {
		const boot = currentBoot();
		const v = vault();
		writeFileSync(
			lockOf(v),
			JSON.stringify({
				pid: process.ppid,
				bootId: "00000000-0000-0000-0000-000000000000",
				bootTime: boot.bootTime,
			}),
		);
		if (boot.bootId === undefined) {
			// No exact id on this host: the probe decides, and a live PID holds.
			expect(() => createAuditWriter(v, { lockAtCreate: true })).toThrow(AuditWriterLockHeldError);
		} else {
			const w = createAuditWriter(v, { lockAtCreate: true });
			releases.push(() => w.release());
			expect(JSON.parse(readFileSync(lockOf(v), "utf-8"))).toMatchObject({ pid: process.pid });
		}
	});

	it("this host records an EXACT boot id on linux and darwin", () => {
		if (process.platform === "linux" || process.platform === "darwin") {
			expect(typeof currentBoot().bootId).toBe("string");
		}
	});

	it("the same live PID recorded in THIS boot: held", () => {
		const boot = currentBoot();
		const v = vault();
		writeFileSync(lockOf(v), JSON.stringify({ pid: process.ppid, ...boot }));
		expect(() => createAuditWriter(v, { lockAtCreate: true })).toThrow(AuditWriterLockHeldError);
	});

	it("a lock with NO boot identity (written before #194) is judged by its PID alone, as before: live → held", () => {
		const v = vault();
		writeFileSync(
			lockOf(v),
			JSON.stringify({ pid: process.ppid, startedAt: "2020-01-01T00:00:00Z" }),
		);
		expect(() => createAuditWriter(v, { lockAtCreate: true })).toThrow(AuditWriterLockHeldError);
	});
});
