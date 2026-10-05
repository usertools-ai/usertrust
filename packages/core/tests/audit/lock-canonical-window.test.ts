import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * #182.1: the cross-process canonicalisation window. The lock key must ALWAYS be the directory's
 * realpath. If it fell back to `path.resolve` when realpath answered ENOENT, a directory created
 * by ANOTHER process between that realpath and the lock file's open would register the lock under
 * the resolve() spelling — and a spelling that differs from a live writer's realpath key misses
 * the in-process registry, meets EEXIST, and "reclaims" that writer's LIVE same-PID lock.
 *
 * The window is reproduced deterministically: realpath answers ENOENT once, for a directory that
 * does exist by the time the lock file is opened (exactly what the other process's mkdir causes).
 */
const enoentOnce = { armed: false };
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const realpathSync = ((p: string, o?: unknown) => {
		if (enoentOnce.armed) {
			enoentOnce.armed = false;
			throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${p}'`), {
				code: "ENOENT",
			});
		}
		return (fs.realpathSync as (p: string, o?: unknown) => string)(p, o);
	}) as typeof fs.realpathSync;
	realpathSync.native = fs.realpathSync.native;
	return { ...fs, realpathSync, default: { ...fs, realpathSync } };
});

const { AuditWriterLockHeldError, createAuditWriter, withAuditWriterLock } = await import(
	"../../src/audit/chain.js"
);

const cleanups: Array<() => void> = [];
afterEach(() => {
	enoentOnce.armed = false;
	for (const c of cleanups.splice(0)) c();
});

describe("#182.1: a lock is never keyed on a non-canonical spelling", () => {
	it("an ENOENT realpath in the window (another process just created the dir) never reclaims a LIVE writer's lock", async () => {
		const vault = mkdtempSync(join(tmpdir(), "trust-audit-window-"));
		const link = `${vault}-link`;
		symlinkSync(vault, link);
		const a = createAuditWriter(vault, { lockAtCreate: true });
		cleanups.push(() => {
			a.release();
			unlinkSync(link);
			rmSync(vault, { recursive: true, force: true });
		});
		const lockPath = join(vault, ".usertrust", "audit", ".audit-writer.lock");
		const before = readFileSync(lockPath, "utf-8");

		let ran = false;
		enoentOnce.armed = true;
		const err = await withAuditWriterLock(join(link, ".usertrust", "audit", "events.jsonl"), () => {
			ran = true;
		}).catch((e: unknown) => e);

		expect(ran, "the body never runs beside A's live lock").toBe(false);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(AuditWriterLockHeldError); // it fails at the key, before any open
		expect((err as { code?: string }).code).toBe("ENOENT");
		expect(readFileSync(lockPath, "utf-8"), "A's lock is untouched").toBe(before);
	});
});
