import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
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
/** #195 r2: count which realpath answers, and make `.native` fail on EVERY call (musl, no /proc). */
const realpathCalls = { native: 0, js: 0, nativeAlwaysFails: false };
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	// Both forms are armed: the lock key uses `.native` (#195 r1), and a mock that left it
	// unarmed would stop exercising the window at all.
	const arm =
		<F extends (p: string, o?: unknown) => string>(real: F) =>
		(p: string, o?: unknown) => {
			if (enoentOnce.armed) {
				enoentOnce.armed = false;
				throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${p}'`), {
					code: "ENOENT",
				});
			}
			return real(p, o);
		};
	const realJs = arm(fs.realpathSync as (p: string, o?: unknown) => string);
	const realNative = arm(fs.realpathSync.native as (p: string, o?: unknown) => string);
	const realpathSync = ((p: string, o?: unknown) => {
		realpathCalls.js++;
		return realJs(p, o);
	}) as typeof fs.realpathSync;
	realpathSync.native = ((p: string, o?: unknown) => {
		realpathCalls.native++;
		if (realpathCalls.nativeAlwaysFails) {
			throw Object.assign(new Error(`ENOENT: realpath(3) without /proc, '${p}'`), {
				code: "ENOENT",
			});
		}
		return realNative(p, o);
	}) as typeof fs.realpathSync.native;
	return { ...fs, realpathSync, default: { ...fs, realpathSync } };
});

const { AuditWriterLockHeldError, createAuditWriter, withAuditWriterLock } = await import(
	"../../src/audit/chain.js"
);

const cleanups: Array<() => void> = [];
afterEach(() => {
	enoentOnce.armed = false;
	realpathCalls.native = 0;
	realpathCalls.js = 0;
	realpathCalls.nativeAlwaysFails = false;
	for (const c of cleanups.splice(0)) c();
});

/** Is the filesystem under `dir` case-insensitive (APFS's default)? */
function caseInsensitive(dir: string): boolean {
	const probe = join(dir, "CaseProbe");
	mkdirSync(probe);
	const yes = existsSync(join(dir, "caseprobe"));
	rmSync(probe, { recursive: true, force: true });
	return yes;
}
const scratch = mkdtempSync(join(tmpdir(), "trust-audit-case-"));
const CASE_INSENSITIVE = caseInsensitive(scratch);
rmSync(scratch, { recursive: true, force: true });

describe("#195 r1: one key per directory on a case-insensitive volume", () => {
	it.skipIf(!CASE_INSENSITIVE)(
		"a CASE-variant spelling of a live writer's vault is refused (AuditWriterLockHeldError) — and the live lock is untouched",
		() => {
			const parent = mkdtempSync(join(tmpdir(), "trust-audit-case-"));
			const vault = join(parent, "VaultDir");
			mkdirSync(vault);
			const a = createAuditWriter(vault, { lockAtCreate: true });
			cleanups.push(() => {
				a.release();
				rmSync(parent, { recursive: true, force: true });
			});
			const lockPath = join(vault, ".usertrust", "audit", ".audit-writer.lock");
			const before = readFileSync(lockPath, "utf-8");
			expect(() => createAuditWriter(join(parent, "vaultdir"), { lockAtCreate: true })).toThrow(
				AuditWriterLockHeldError,
			);
			expect(readFileSync(lockPath, "utf-8")).toBe(before);
		},
	);
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
		// #195 r2: the directory exists, so the key is re-read NATIVELY — the canonical key, which
		// finds A's live registration: refused as held, never a reclaim.
		expect(err).toBeInstanceOf(AuditWriterLockHeldError);
		expect(readFileSync(lockPath, "utf-8"), "A's lock is untouched").toBe(before);
	});
});

describe("#195 r2: the native realpath is THE key; the JS realpath only where native cannot answer", () => {
	it("on a normal platform the key comes from realpathSync.native — never the JS realpath (pins #195 r1 on case-sensitive CI too)", () => {
		const vault = mkdtempSync(join(tmpdir(), "trust-audit-native-"));
		const w = createAuditWriter(vault, { lockAtCreate: true });
		cleanups.push(() => {
			w.release();
			rmSync(vault, { recursive: true, force: true });
		});
		expect(realpathCalls.native).toBeGreaterThan(0);
		expect(realpathCalls.js, "the JS realpath keeps the caller's case: never the key here").toBe(0);
	});

	it.skipIf(!CASE_INSENSITIVE)(
		"the window on a CASE-variant spelling (native ENOENT once, the dir exists): the key is re-read NATIVELY — never the caller's case — so A's live lock is refused, never reclaimed",
		async () => {
			const parent = mkdtempSync(join(tmpdir(), "trust-audit-case-window-"));
			const vault = join(parent, "VaultDir");
			mkdirSync(vault);
			const a = createAuditWriter(vault, { lockAtCreate: true });
			cleanups.push(() => {
				a.release();
				rmSync(parent, { recursive: true, force: true });
			});
			const lockPath = join(vault, ".usertrust", "audit", ".audit-writer.lock");
			const before = readFileSync(lockPath, "utf-8");
			let ran = false;
			enoentOnce.armed = true;
			const err = await withAuditWriterLock(
				join(parent, "vaultdir", ".usertrust", "audit", "events.jsonl"),
				() => {
					ran = true;
				},
			).catch((e: unknown) => e);
			expect(ran, "never beside A's live lock").toBe(false);
			expect(err).toBeInstanceOf(AuditWriterLockHeldError);
			expect(readFileSync(lockPath, "utf-8")).toBe(before);
		},
	);

	it("musl without /proc (native fails EVERY call) on an existing dir: the JS realpath keys the lock — the writer starts, and a second writer is still refused", () => {
		realpathCalls.nativeAlwaysFails = true;
		const vault = mkdtempSync(join(tmpdir(), "trust-audit-musl-"));
		const w = createAuditWriter(vault, { lockAtCreate: true });
		cleanups.push(() => {
			w.release();
			rmSync(vault, { recursive: true, force: true });
		});
		expect(realpathCalls.js).toBeGreaterThan(0);
		expect(() => createAuditWriter(vault, { lockAtCreate: true })).toThrow(
			AuditWriterLockHeldError,
		);
	});

	it("native failing for a directory that does NOT exist still throws (no fallback can invent a key)", async () => {
		realpathCalls.nativeAlwaysFails = true;
		const err = await withAuditWriterLock(
			join(tmpdir(), "trust-audit-nope", "events.jsonl"),
			() => {},
		).catch((e: unknown) => e);
		expect((err as { code?: string }).code).toBe("ENOENT");
		expect(realpathCalls.js, "no JS fallback for an absent directory").toBe(0);
	});
});
