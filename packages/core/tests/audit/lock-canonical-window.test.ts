import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The audit writer's in-process lock registry is keyed by the audit directory's IDENTITY,
 * `(st_dev, st_ino)` from `statSync(dir, { bigint: true })` — never by a path spelling (#195 r3).
 *
 * `node:fs` is mocked at module level, wrapping three calls and passing everything else through:
 *  - `realpathSync` and `realpathSync.native` only COUNT their calls, so a test can pin that lock
 *    keying takes no realpath at all (the spelling ladder #195 r1/r2 used is gone);
 *  - `statSync` can be ARMED to answer ENOENT once (#182.1's window: the directory does not exist
 *    yet at the identity lookup, and another process creates it before the lock file's open), and
 *    can REPORT A CHOSEN `(dev, ino)` for a given path. Real inode reuse cannot be produced on
 *    demand, so it is modelled: two different directories are made to report one identity.
 *
 * Why the mock and not a seam in chain.ts: the identity lookup is a single `statSync` call, so
 * wrapping it here models reuse exactly as the kernel would present it, while adding nothing to
 * the production module's surface (an injectable identity function would be a test-only export).
 * The real stat still runs first, so an absent directory still throws its real ENOENT.
 */
const statWindow = { enoentOnce: false };
const identityOverride = new Map<string, { dev: bigint; ino: bigint; hits: number }>();
const realpathCalls = { native: 0, js: 0 };
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const realpathSync = ((p: string, o?: unknown) => {
		realpathCalls.js++;
		return (fs.realpathSync as (p: string, o?: unknown) => string)(p, o);
	}) as typeof fs.realpathSync;
	realpathSync.native = ((p: string, o?: unknown) => {
		realpathCalls.native++;
		return (fs.realpathSync.native as (p: string, o?: unknown) => string)(p, o);
	}) as typeof fs.realpathSync.native;
	const statSync = ((p: string, o?: unknown) => {
		if (statWindow.enoentOnce) {
			statWindow.enoentOnce = false;
			throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), {
				code: "ENOENT",
			});
		}
		const real = (fs.statSync as (p: string, o?: unknown) => object)(p, o);
		const forced = identityOverride.get(p);
		if (forced === undefined) return real;
		forced.hits++;
		return { ...real, dev: forced.dev, ino: forced.ino };
	}) as typeof fs.statSync;
	return {
		...fs,
		realpathSync,
		statSync,
		default: { ...fs, realpathSync, statSync },
	};
});

const { AuditWriterLockHeldError, createAuditWriter, withAuditWriterLock } = await import(
	"../../src/audit/chain.js"
);

const cleanups: Array<() => void> = [];
afterEach(() => {
	statWindow.enoentOnce = false;
	identityOverride.clear();
	realpathCalls.native = 0;
	realpathCalls.js = 0;
	for (const c of cleanups.splice(0)) c();
});

const auditDirOf = (vault: string) => join(vault, ".usertrust", "audit");
const lockOf = (vault: string) => join(auditDirOf(vault), ".audit-writer.lock");
const logOf = (vault: string) => join(auditDirOf(vault), "events.jsonl");
const inodeOf = (path: string) => lstatSync(path, { bigint: true }).ino;

/** A fresh scratch directory, removed after the test. Never a fixed shared path. */
function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Model inode reuse: every given audit directory reports the SAME `(dev, ino)`. */
let fakeIno = 1n << 62n;
function shareOneIdentity(...auditDirs: string[]): void {
	fakeIno += 1n;
	for (const d of auditDirs) identityOverride.set(d, { dev: 424242n, ino: fakeIno, hits: 0 });
}

type Writer = ReturnType<typeof createAuditWriter>;
function track(w: Writer): Writer {
	cleanups.unshift(() => w.release());
	return w;
}

/** Is the filesystem under `dir` case-insensitive (APFS's default)? */
function caseInsensitive(dir: string): boolean {
	const probe = join(dir, "CaseProbe");
	mkdirSync(probe);
	const yes = existsSync(join(dir, "caseprobe"));
	rmSync(probe, { recursive: true, force: true });
	return yes;
}
const probeDir = mkdtempSync(join(tmpdir(), "trust-audit-case-"));
const CASE_INSENSITIVE = caseInsensitive(probeDir);
rmSync(probeDir, { recursive: true, force: true });

describe("#195 r3: one registry key per directory — its identity, never a spelling", () => {
	it("a SYMLINK spelling of a live writer's vault is refused (AuditWriterLockHeldError) — never a reclaim; the live lock is untouched", () => {
		const parent = scratch("trust-audit-link-");
		const vault = join(parent, "vault");
		mkdirSync(vault);
		const link = join(parent, "vault-link");
		symlinkSync(vault, link);
		track(createAuditWriter(vault, { lockAtCreate: true }));
		const before = readFileSync(lockOf(vault), "utf-8");
		const ino = inodeOf(lockOf(vault));

		expect(() => createAuditWriter(link, { lockAtCreate: true })).toThrow(AuditWriterLockHeldError);
		expect(readFileSync(lockOf(vault), "utf-8")).toBe(before);
		expect(inodeOf(lockOf(vault)), "the lock file was never unlinked and re-created").toBe(ino);
	});

	it.skipIf(!CASE_INSENSITIVE)(
		"a CASE-variant spelling of a live writer's vault is refused (AuditWriterLockHeldError) — never a reclaim; the live lock is untouched",
		() => {
			const parent = scratch("trust-audit-case-");
			const vault = join(parent, "VaultDir");
			mkdirSync(vault);
			track(createAuditWriter(vault, { lockAtCreate: true }));
			const before = readFileSync(lockOf(vault), "utf-8");
			const ino = inodeOf(lockOf(vault));

			expect(() => createAuditWriter(join(parent, "vaultdir"), { lockAtCreate: true })).toThrow(
				AuditWriterLockHeldError,
			);
			expect(readFileSync(lockOf(vault), "utf-8")).toBe(before);
			expect(inodeOf(lockOf(vault))).toBe(ino);
		},
	);

	it("lock keying calls NO realpath — neither realpathSync nor realpathSync.native — on any acquire path", async () => {
		// Positive control: the counters do see a realpath call made through this module.
		const control = scratch("trust-audit-norealpath-control-");
		realpathSync(control);
		realpathSync.native(control);
		expect(realpathCalls).toEqual({ native: 1, js: 1 });
		realpathCalls.native = 0;
		realpathCalls.js = 0;

		const parent = scratch("trust-audit-norealpath-");
		const vault = join(parent, "vault");
		mkdirSync(vault);
		const link = join(parent, "vault-link");
		symlinkSync(vault, link);
		const w = track(createAuditWriter(vault, { lockAtCreate: true })); // fresh create
		await w.appendEvent({ kind: "k", actor: "a", data: {} }); // verified re-hit
		expect(() => createAuditWriter(link, { lockAtCreate: true })).toThrow(AuditWriterLockHeldError); // refused sibling
		w.release();
		await withAuditWriterLock(logOf(link), () => {}); // the scoped lock, through a symlink
		await expect(
			withAuditWriterLock(join(parent, "absent", "events.jsonl"), () => {}),
		).rejects.toMatchObject({ code: "ENOENT" }); // the absent directory

		expect(realpathCalls).toEqual({ native: 0, js: 0 });
	});
});

describe("#182.1: no lock without the directory, and the window never reclaims a live lock", () => {
	it("an ABSENT directory throws ENOENT and creates nothing", async () => {
		const parent = scratch("trust-audit-absent-");
		let ran = false;
		const err = await withAuditWriterLock(
			join(parent, "absent", ".usertrust", "audit", "events.jsonl"),
			() => {
				ran = true;
			},
		).catch((e: unknown) => e);
		expect((err as { code?: string }).code).toBe("ENOENT");
		expect(ran).toBe(false);
		expect(readdirSync(parent), "no directory, no lock file — nothing at all").toEqual([]);
	});

	it("the identity lookup answering ENOENT in the window (another process just created the dir) throws — no fallback key — and never reclaims a LIVE writer's lock", async () => {
		const parent = scratch("trust-audit-window-");
		const vault = join(parent, "vault");
		mkdirSync(vault);
		const link = join(parent, "vault-link");
		symlinkSync(vault, link);
		track(createAuditWriter(vault, { lockAtCreate: true }));
		const before = readFileSync(lockOf(vault), "utf-8");
		const ino = inodeOf(lockOf(vault));

		let ran = false;
		statWindow.enoentOnce = true;
		const err = await withAuditWriterLock(logOf(link), () => {
			ran = true;
		}).catch((e: unknown) => e);
		expect(statWindow.enoentOnce, "the window was actually hit").toBe(false);
		expect((err as { code?: string }).code).toBe("ENOENT");
		expect(ran, "the body never runs beside A's live lock").toBe(false);
		expect(readFileSync(lockOf(vault), "utf-8"), "A's lock is untouched").toBe(before);
		expect(inodeOf(lockOf(vault))).toBe(ino);

		// Once the directory answers, the same spelling finds A's registration: refused as held.
		const again = await withAuditWriterLock(logOf(link), () => {
			ran = true;
		}).catch((e: unknown) => e);
		expect(again).toBeInstanceOf(AuditWriterLockHeldError);
		expect(ran).toBe(false);
		expect(readFileSync(lockOf(vault), "utf-8")).toBe(before);
	});
});

describe("#195 r3: inode reuse is not an alias (key-and-verify)", () => {
	it("(a) a writer whose directory was deleted and re-created with the SAME identity does not short-circuit on its old claim — it creates the new directory's lock file", async () => {
		const vault = scratch("trust-audit-reuse-self-");
		shareOneIdentity(auditDirOf(vault));
		const w = track(createAuditWriter(vault, { lockAtCreate: true }));
		expect(existsSync(lockOf(vault))).toBe(true);

		// The vault's directory is deleted (its lock file with it) and a new one takes its place —
		// with its old inode, modelled by the override.
		rmSync(join(vault, ".usertrust"), { recursive: true, force: true });
		mkdirSync(auditDirOf(vault), { recursive: true });
		const hitsBefore = identityOverride.get(auditDirOf(vault))?.hits ?? 0;

		await w.appendEvent({ kind: "k", actor: "a", data: {} });

		// Control: the append's key WAS the reused identity (the old claim's key).
		expect(identityOverride.get(auditDirOf(vault))?.hits).toBeGreaterThan(hitsBefore);
		expect(existsSync(lockOf(vault)), "the writer holds a real lock on the new directory").toBe(
			true,
		);
		expect(JSON.parse(readFileSync(lockOf(vault), "utf-8")).pid).toBe(process.pid);
	});

	it("(a) a second writer on a DIFFERENT directory with a dead claim's identity is not refused — it creates its own lock file, and the dead claim's release leaves it alone", () => {
		const parent = scratch("trust-audit-reuse-sibling-");
		const vaultA = join(parent, "A");
		const vaultB = join(parent, "B");
		mkdirSync(auditDirOf(vaultA), { recursive: true });
		mkdirSync(auditDirOf(vaultB), { recursive: true });
		shareOneIdentity(auditDirOf(vaultA), auditDirOf(vaultB));
		const w1 = track(createAuditWriter(vaultA, { lockAtCreate: true }));

		// Control: while A's lock file exists the shared identity IS one vault — refused.
		expect(() => createAuditWriter(vaultB, { lockAtCreate: true })).toThrow(
			AuditWriterLockHeldError,
		);
		expect(existsSync(lockOf(vaultB))).toBe(false);

		// A is deleted (its lock file with it). B now owns the identity.
		rmSync(vaultA, { recursive: true, force: true });
		track(createAuditWriter(vaultB, { lockAtCreate: true }));
		expect(existsSync(lockOf(vaultB)), "B's own lock file").toBe(true);
		const lockB = readFileSync(lockOf(vaultB), "utf-8");

		// The dead claim's release unlinks nothing that is not its own.
		w1.release();
		expect(readFileSync(lockOf(vaultB), "utf-8")).toBe(lockB);
		// And B's writer is a LIVE claim: a third writer is refused.
		expect(() => createAuditWriter(vaultB, { lockAtCreate: true })).toThrow(
			AuditWriterLockHeldError,
		);
	});

	it("(b) while the first claim's lock file EXISTS, a second same-process writer on the same identity is refused (AUD-471), and the live lock is neither recreated nor duplicated", async () => {
		const parent = scratch("trust-audit-reuse-live-");
		const vaultA = join(parent, "A");
		const vaultB = join(parent, "B");
		mkdirSync(auditDirOf(vaultA), { recursive: true });
		mkdirSync(auditDirOf(vaultB), { recursive: true });
		shareOneIdentity(auditDirOf(vaultA), auditDirOf(vaultB));
		const w1 = track(createAuditWriter(vaultA, { lockAtCreate: true }));
		const before = readFileSync(lockOf(vaultA), "utf-8");
		const ino = inodeOf(lockOf(vaultA));

		expect(() => createAuditWriter(vaultB, { lockAtCreate: true })).toThrow(
			AuditWriterLockHeldError,
		);
		expect(existsSync(lockOf(vaultB))).toBe(false);

		// The holder's own verified hit creates nothing.
		await w1.appendEvent({ kind: "k", actor: "a", data: {} });
		expect(readFileSync(lockOf(vaultA), "utf-8")).toBe(before);
		expect(inodeOf(lockOf(vaultA))).toBe(ino);
	});

	it("a lock file replaced by a byte-identical copy is not the claim's lock: the inode is the identity, the bytes are not", () => {
		const parent = scratch("trust-audit-reuse-copy-");
		const vaultA = join(parent, "A");
		const vaultB = join(parent, "B");
		mkdirSync(auditDirOf(vaultA), { recursive: true });
		mkdirSync(auditDirOf(vaultB), { recursive: true });
		shareOneIdentity(auditDirOf(vaultA), auditDirOf(vaultB));
		track(createAuditWriter(vaultA, { lockAtCreate: true }));
		const bytes = readFileSync(lockOf(vaultA), "utf-8");
		const ino = inodeOf(lockOf(vaultA));
		// Re-create A's lock file with the same bytes. The copy is written beside it and renamed
		// over it, so it is allocated while the original's inode still is: never the same number.
		writeFileSync(`${lockOf(vaultA)}.copy`, bytes, { mode: 0o600 });
		renameSync(`${lockOf(vaultA)}.copy`, lockOf(vaultA));
		expect(inodeOf(lockOf(vaultA)), "control: the file really is a different inode").not.toBe(ino);

		track(createAuditWriter(vaultB, { lockAtCreate: true }));
		expect(existsSync(lockOf(vaultB))).toBe(true);
	});

	it("releasing a STALE claim never unlinks the lock file a live writer has since created at the same path", () => {
		const vault = scratch("trust-audit-stale-release-");
		const w1 = track(createAuditWriter(vault, { lockAtCreate: true }));
		unlinkSync(lockOf(vault)); // W1's lock is removed under it…
		track(createAuditWriter(vault, { lockAtCreate: true })); // …and W2 takes the vault.
		const w2Lock = readFileSync(lockOf(vault), "utf-8");

		w1.release();
		expect(readFileSync(lockOf(vault), "utf-8"), "W2's lock survives W1's release").toBe(w2Lock);
		expect(() => createAuditWriter(vault, { lockAtCreate: true })).toThrow(
			AuditWriterLockHeldError,
		);
	});

	it("a writer that lost its lock and re-acquires it chains from the log on disk, never from its cached tail", async () => {
		const vault = scratch("trust-audit-relock-");
		const w1 = track(createAuditWriter(vault, { lockAtCreate: true }));
		await w1.appendEvent({ kind: "k", actor: "w1", data: { n: 1 } });

		// W1's lock file is removed under it; another writer takes the vault and appends.
		unlinkSync(lockOf(vault));
		const w2 = track(createAuditWriter(vault, { lockAtCreate: true }));
		const e2 = await w2.appendEvent({ kind: "k", actor: "w2", data: { n: 2 } });
		// While W2 holds the vault, W1 is refused — its claim is stale, W2's is live.
		await expect(w1.appendEvent({ kind: "k", actor: "w1", data: { n: 0 } })).rejects.toThrow(
			AuditWriterLockHeldError,
		);
		w2.release();

		const e3 = (await w1.appendEvent({ kind: "k", actor: "w1", data: { n: 3 } })) as {
			previousHash: string;
			sequence: number;
		};
		expect(e3.previousHash, "chained from W2's event, not W1's stale cache").toBe(e2.hash);
		expect(e3.sequence).toBe((e2 as unknown as { sequence: number }).sequence + 1);
	});
});
