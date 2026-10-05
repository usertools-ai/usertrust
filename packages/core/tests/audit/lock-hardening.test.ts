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

describe("#194.4: a lock from a PREVIOUS boot is stale, whatever its PID now names", () => {
	it("a live PID recorded in a previous boot (boot time an hour off): reclaimed", () => {
		const boot = currentBoot();
		const v = vault();
		writeFileSync(lockOf(v), JSON.stringify({ pid: process.ppid, bootTime: boot.bootTime - 3600 }));
		const w = createAuditWriter(v, { lockAtCreate: true });
		releases.push(() => w.release());
		expect(JSON.parse(readFileSync(lockOf(v), "utf-8"))).toMatchObject({ pid: process.pid });
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
