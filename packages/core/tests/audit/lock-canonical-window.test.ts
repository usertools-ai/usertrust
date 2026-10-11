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
 * Whether a lock file is held by a live writer in THIS process is read from the lock file itself:
 * the writerId it carries must be held in memory, and the file must be the inode that writer's
 * exclusive create made (#195 r5). Nothing is keyed by a directory — not a path spelling (r2), not
 * the directory's `(st_dev, st_ino)` (r3/r4, replaced: a directory's identity can be stale by the
 * time it is used). The lock's path is remembered PHYSICALLY (the JS realpath of its directory)
 * and refreshed whenever the lock is verified, so release still reaches it after a rename.
 *
 * `node:fs` is mocked at module level, wrapping a few calls and passing everything else through:
 *  - `realpathSync` and `realpathSync.native` COUNT their calls, and `.native` can be made to fail
 *    on every call (musl without /proc), so a test can pin that the lock never needs realpath(3).
 *    The JS realpath can also be made to KEEP the caller's spelling under a prefix — what it does
 *    with letter case on a case-insensitive mount — so the "a spelling is not a second lock" property is
 *    pinned on case-sensitive CI too, where the real case-variant test is skipped;
 *  - `statSync` can be ARMED to answer ENOENT once, and can REPORT A CHOSEN `(dev, ino)` for a
 *    directory (with a hit counter). Nothing in the lock reads a directory's identity any more;
 *    these stay so tests can PIN that — directory inode reuse and the #182.1 window then cannot
 *    reach the lock, and a reintroduced identity lookup turns them red;
 *  - `lstatSync` — and `fstatSync` on any fd opened at that path — can report a chosen inode for a
 *    lock file, and `fstatSync` a chosen inode for the next lock files CREATED (O_EXCL) — together
 *    they model a new lock file REUSING an old one's inode;
 *  - `openSync` can run a hook just before the next exclusive create: a seam for "another process
 *    changes the directory in the window before the lock file's create".
 * Real inode reuse cannot be produced on demand, so it is modelled. Overrides are looked up by the
 * physical path, so every spelling of a directory (or of a lock file's directory) matches.
 *
 * Why the mock and not a seam in chain.ts: the identity lookups are single `stat` calls, so
 * wrapping them here models reuse exactly as the kernel would present it, while adding nothing to
 * the production module's surface (an injectable identity function would be a test-only export).
 * The real call still runs first, so an absent path still throws its real ENOENT.
 */
const statWindow = { enoentOnce: false };
const identityOverride = new Map<string, { dev: bigint; ino: bigint; hits: number }>();
const lockInoOverride = new Map<string, bigint>();
const nextLockIno: { ino: bigint | undefined } = { ino: undefined };
/** Runs once, just BEFORE the next exclusive (O_EXCL) create — the lock file's — is opened. */
const beforeLockCreate: { fn: ((path: string) => void) | undefined } = { fn: undefined };
/** Runs once, just BEFORE the next non-exclusive open of a lock file (a READ of an existing one). */
const beforeLockRead: { fn: ((path: string) => void) | undefined } = { fn: undefined };
const realpathCalls = { native: 0, js: 0, nativeAlwaysFails: false };
/** Paths under these prefixes keep the caller's spelling through the JS realpath (see below). */
const realpathKeepsSpelling = new Set<string>();
/** The UNMOCKED physical spelling of a path, even one not created yet (installed by the mock). */
// vi.hoisted: the factory below runs while this file's own `node:fs` import resolves — before
// ordinary top-level bindings exist — and it installs `physical` at that moment.
const fsHooks = vi.hoisted(() => ({ physical: (p: string): string => p }));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const path = await import("node:path");
	// The deepest existing ancestor's realpath + the rest: a path not created yet still gets the
	// spelling it will have once it exists.
	fsHooks.physical = (p: string) => {
		let head = path.resolve(p);
		let tail = "";
		for (;;) {
			try {
				return path.join(fs.realpathSync(head), tail);
			} catch {
				const up = path.dirname(head);
				if (up === head) return path.resolve(p);
				tail = path.join(path.basename(head), tail);
				head = up;
			}
		}
	};
	const realpathSync = ((p: string, o?: unknown) => {
		realpathCalls.js++;
		const asGiven = path.resolve(p);
		for (const prefix of realpathKeepsSpelling) {
			if (asGiven === prefix || asGiven.startsWith(`${prefix}${path.sep}`)) return asGiven;
		}
		return (fs.realpathSync as (p: string, o?: unknown) => string)(p, o);
	}) as typeof fs.realpathSync;
	realpathSync.native = ((p: string, o?: unknown) => {
		realpathCalls.native++;
		if (realpathCalls.nativeAlwaysFails) {
			throw Object.assign(new Error(`ENOENT: realpath(3) without /proc, '${p}'`), {
				code: "ENOENT",
			});
		}
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
		const forced = identityOverride.get(fsHooks.physical(p));
		if (forced === undefined) return real;
		forced.hits++;
		return { ...real, dev: forced.dev, ino: forced.ino };
	}) as typeof fs.statSync;
	const lstatSync = ((p: string, o?: unknown) => {
		const real = (fs.lstatSync as (p: string, o?: unknown) => object)(p, o);
		const forced = lockInoOverride.get(fsHooks.physical(p));
		return forced === undefined ? real : { ...real, ino: forced };
	}) as typeof fs.lstatSync;
	// Every open fd remembers its physical path, so an fstat answers the same chosen inode a path
	// lookup does — whichever way the module under test reads a lock file's identity.
	const fdPaths = new Map<number, { path: string; excl: boolean }>();
	const openSync = ((p: string, flags?: unknown, mode?: unknown) => {
		const excl = typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0;
		const hookBox = excl
			? beforeLockCreate
			: String(p).endsWith(".audit-writer.lock")
				? beforeLockRead
				: undefined;
		const hook = hookBox?.fn;
		if (hookBox !== undefined && hook !== undefined) {
			hookBox.fn = undefined;
			hook(String(p));
		}
		const fd = (fs.openSync as (p: string, f?: unknown, m?: unknown) => number)(p, flags, mode);
		fdPaths.set(fd, { path: fsHooks.physical(String(p)), excl });
		return fd;
	}) as typeof fs.openSync;
	const closeSync = ((fd: number) => {
		fdPaths.delete(fd);
		fs.closeSync(fd);
	}) as typeof fs.closeSync;
	const fstatSync = ((fd: number, o?: unknown) => {
		const real = (fs.fstatSync as (fd: number, o?: unknown) => object)(fd, o);
		const opened = fdPaths.get(fd);
		const forced = opened === undefined ? undefined : lockInoOverride.get(opened.path);
		if (forced !== undefined) return { ...real, ino: forced };
		// `nextLockIno` models the inode a NEW lock file gets: an exclusive create's fd only.
		if (nextLockIno.ino !== undefined && opened?.excl === true) {
			return { ...real, ino: nextLockIno.ino };
		}
		return real;
	}) as typeof fs.fstatSync;
	const wrapped = { realpathSync, statSync, lstatSync, fstatSync, openSync, closeSync };
	return { ...fs, ...wrapped, default: { ...fs, ...wrapped } };
});

const { AuditWriterLockHeldError, createAuditWriter, withAuditWriterLock } = await import(
	"../../src/audit/chain.js"
);

const cleanups: Array<() => void> = [];
afterEach(() => {
	statWindow.enoentOnce = false;
	identityOverride.clear();
	lockInoOverride.clear();
	nextLockIno.ino = undefined;
	beforeLockCreate.fn = undefined;
	beforeLockRead.fn = undefined;
	realpathCalls.native = 0;
	realpathCalls.js = 0;
	realpathCalls.nativeAlwaysFails = false;
	realpathKeepsSpelling.clear();
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
function shareOneIdentity(...auditDirs: string[]): bigint {
	fakeIno += 1n;
	for (const d of auditDirs) {
		identityOverride.set(fsHooks.physical(d), { dev: 424242n, ino: fakeIno, hits: 0 });
	}
	return fakeIno;
}
const overrideOf = (auditDir: string) => identityOverride.get(fsHooks.physical(auditDir));

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

describe("one lock per directory, whatever the spelling — the lock file says who holds it", () => {
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

	it("a spelling the JS realpath leaves as given (modelled: the caller's case on a case-insensitive mount) still reaches the ONE lock file — the second writer is refused, never a reclaim", () => {
		const parent = scratch("trust-audit-spelling-");
		const vault = join(parent, "vault");
		mkdirSync(vault);
		const other = join(parent, "other-spelling");
		symlinkSync(vault, other);
		// The JS realpath returns `other…` as given, so the PATH differs from the first writer's;
		// only the lock file found through it says it is the same directory.
		realpathKeepsSpelling.add(other);
		track(createAuditWriter(vault, { lockAtCreate: true }));
		const before = readFileSync(lockOf(vault), "utf-8");
		const ino = inodeOf(lockOf(vault));
		// Control: the model holds — the realpath of the other spelling is not the vault's.
		expect(realpathSync(auditDirOf(other))).toBe(auditDirOf(other));

		expect(() => createAuditWriter(other, { lockAtCreate: true })).toThrow(
			AuditWriterLockHeldError,
		);
		expect(readFileSync(lockOf(vault), "utf-8")).toBe(before);
		expect(inodeOf(lockOf(vault))).toBe(ino);
	});

	it("the lock never needs realpath(3): with realpathSync.native failing on EVERY call (musl without /proc), every acquire path works and .native is never called", async () => {
		// Positive control: the counter does see a .native call made through this module.
		const control = scratch("trust-audit-nonative-control-");
		realpathSync.native(control);
		expect(realpathCalls.native).toBe(1);
		realpathCalls.native = 0;
		realpathCalls.nativeAlwaysFails = true;

		const parent = scratch("trust-audit-nonative-");
		const vault = join(parent, "vault");
		mkdirSync(vault);
		const link = join(parent, "vault-link");
		symlinkSync(vault, link);
		const w = track(createAuditWriter(vault, { lockAtCreate: true })); // fresh create
		await w.appendEvent({ kind: "k", actor: "a", data: {} }); // verified re-hit
		expect(() => createAuditWriter(link, { lockAtCreate: true })).toThrow(AuditWriterLockHeldError); // refused sibling
		w.release();
		expect(existsSync(lockOf(vault)), "released").toBe(false);
		await withAuditWriterLock(logOf(link), () => {}); // the scoped lock, through a symlink
		await expect(
			withAuditWriterLock(join(parent, "absent", "events.jsonl"), () => {}),
		).rejects.toMatchObject({ code: "ENOENT" }); // the absent directory

		expect(realpathCalls.native).toBe(0);
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

	it("there is no directory-identity lookup to race: a stat armed to answer ENOENT is never consulted, and a symlink spelling of a LIVE writer's vault is refused, its lock untouched", async () => {
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
		expect(statWindow.enoentOnce, "the acquire never stat'ed a directory").toBe(true);
		expect(err).toBeInstanceOf(AuditWriterLockHeldError);
		expect(ran, "the body never runs beside A's live lock").toBe(false);
		expect(readFileSync(lockOf(vault), "utf-8"), "A's lock is untouched").toBe(before);
		expect(inodeOf(lockOf(vault))).toBe(ino);
	});
});

describe("#195 r3→r5: directory inode reuse cannot alias a lock — nothing is keyed by it", () => {
	it("(a) a writer whose directory was deleted and re-created with the SAME identity does not short-circuit on its old claim — it creates the new directory's lock file", async () => {
		const vault = scratch("trust-audit-reuse-self-");
		shareOneIdentity(auditDirOf(vault));
		const w = track(createAuditWriter(vault, { lockAtCreate: true }));
		expect(existsSync(lockOf(vault))).toBe(true);

		// The vault's directory is deleted (its lock file with it) and a new one takes its place —
		// with its old inode, modelled by the override.
		rmSync(join(vault, ".usertrust"), { recursive: true, force: true });
		mkdirSync(auditDirOf(vault), { recursive: true });
		const hitsBefore = overrideOf(auditDirOf(vault))?.hits ?? 0;

		await w.appendEvent({ kind: "k", actor: "a", data: {} });

		// The directory's (reused) identity is never read: there is no key for it to alias.
		expect(overrideOf(auditDirOf(vault))?.hits).toBe(hitsBefore);
		expect(existsSync(lockOf(vault)), "the writer holds a real lock on the new directory").toBe(
			true,
		);
		expect(JSON.parse(readFileSync(lockOf(vault), "utf-8")).pid).toBe(process.pid);
	});

	it("(a) a second writer on a DIFFERENT directory that now has a deleted directory's identity is not refused — it creates its own lock file, and the dead claim's release leaves it alone", () => {
		const parent = scratch("trust-audit-reuse-sibling-");
		const vaultA = join(parent, "A");
		const vaultB = join(parent, "B");
		mkdirSync(auditDirOf(vaultA), { recursive: true });
		mkdirSync(auditDirOf(vaultB), { recursive: true });
		const w1 = track(createAuditWriter(vaultA, { lockAtCreate: true }));
		expect(existsSync(lockOf(vaultA))).toBe(true);

		// A is deleted (its lock file with it), and B is modelled as having received A's identity.
		// (Two LIVE directories never share one: the moment B has it, A no longer exists.)
		shareOneIdentity(auditDirOf(vaultA), auditDirOf(vaultB));
		rmSync(vaultA, { recursive: true, force: true });
		track(createAuditWriter(vaultB, { lockAtCreate: true }));
		// The shared identity is never read: there is no key for it to alias.
		expect(overrideOf(auditDirOf(vaultB))?.hits).toBe(0);
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

	it("(b) while the first claim's lock file EXISTS, a second same-process writer on the same identity — the same directory, by another spelling — is refused (AUD-471), and the live lock is neither recreated nor duplicated", async () => {
		const parent = scratch("trust-audit-reuse-live-");
		const vaultA = join(parent, "A");
		mkdirSync(auditDirOf(vaultA), { recursive: true });
		const alias = join(parent, "A-alias");
		symlinkSync(vaultA, alias);
		shareOneIdentity(auditDirOf(vaultA));
		const w1 = track(createAuditWriter(vaultA, { lockAtCreate: true }));
		const before = readFileSync(lockOf(vaultA), "utf-8");
		const ino = inodeOf(lockOf(vaultA));

		expect(() => createAuditWriter(alias, { lockAtCreate: true })).toThrow(
			AuditWriterLockHeldError,
		);
		await expect(withAuditWriterLock(logOf(alias), () => {})).rejects.toThrow(
			AuditWriterLockHeldError,
		);

		// The holder's own verified hit creates nothing.
		await w1.appendEvent({ kind: "k", actor: "a", data: {} });
		expect(readFileSync(lockOf(vaultA), "utf-8")).toBe(before);
		expect(inodeOf(lockOf(vaultA))).toBe(ino);
	});

	it("a lock file replaced by a byte-identical copy is not the claim's lock: the inode is the identity, the bytes are not", () => {
		const vault = scratch("trust-audit-reuse-copy-");
		track(createAuditWriter(vault, { lockAtCreate: true }));
		const bytes = readFileSync(lockOf(vault), "utf-8");
		const ino = inodeOf(lockOf(vault));
		// Re-create the lock file with the same bytes. The copy is written beside it and renamed
		// over it, so it is allocated while the original's inode still is: never the same number.
		writeFileSync(`${lockOf(vault)}.copy`, bytes, { mode: 0o600 });
		renameSync(`${lockOf(vault)}.copy`, lockOf(vault));
		expect(inodeOf(lockOf(vault)), "control: the file really is a different inode").not.toBe(ino);

		// The first claim is stale, so a second writer is not refused by it.
		track(createAuditWriter(vault, { lockAtCreate: true }));
		expect(JSON.parse(readFileSync(lockOf(vault), "utf-8")).writerId).not.toBe(
			JSON.parse(bytes).writerId,
		);
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

describe("#195 r4: a lock is verified in the directory itself, at its physical path", () => {
	it.each(["removed", "retargeted"] as const)(
		"P1: a live scoped lock taken through a symlink stays live when the symlink is %s — the real path is refused, and release leaves no lock behind",
		async (mode) => {
			const parent = scratch("trust-audit-alias-");
			const real = join(parent, "real");
			mkdirSync(auditDirOf(real), { recursive: true });
			const elsewhere = join(parent, "elsewhere");
			mkdirSync(auditDirOf(elsewhere), { recursive: true });
			const link = join(parent, "link");
			symlinkSync(real, link);

			let inner: unknown = "never ran";
			let sibling: unknown = "never ran";
			await withAuditWriterLock(logOf(link), async () => {
				expect(existsSync(lockOf(real)), "the lock is in the real directory").toBe(true);
				const before = readFileSync(lockOf(real), "utf-8");
				unlinkSync(link);
				if (mode === "retargeted") symlinkSync(elsewhere, link);

				inner = await withAuditWriterLock(logOf(real), () => "ran").catch((e: unknown) => e);
				try {
					track(createAuditWriter(real, { lockAtCreate: true }));
				} catch (e) {
					sibling = e;
				}
				expect(readFileSync(lockOf(real), "utf-8"), "the live lock is untouched").toBe(before);
			});

			expect(inner, "a nested scoped lock on the real path is refused").toBeInstanceOf(
				AuditWriterLockHeldError,
			);
			expect(sibling, "a writer on the real path is refused").toBeInstanceOf(
				AuditWriterLockHeldError,
			);
			expect(existsSync(lockOf(real)), "release removed the real lock — no leftover").toBe(false);
			expect(existsSync(lockOf(elsewhere)), "nothing was ever created behind the new target").toBe(
				false,
			);
		},
	);

	it("P2: a writer's claim on a directory that was re-created is not revived by a reused lock-file inode — an unrelated vault that later gets the old identity is NOT refused", async () => {
		const parent = scratch("trust-audit-p2-");
		const vault = join(parent, "V");
		const unrelated = join(parent, "U");
		mkdirSync(auditDirOf(vault), { recursive: true });
		mkdirSync(auditDirOf(unrelated), { recursive: true });

		// W takes V while V's directory reports K1, and its lock file gets inode X.
		const k1 = shareOneIdentity(auditDirOf(vault));
		const x = (1n << 61n) + k1;
		nextLockIno.ino = x;
		lockInoOverride.set(fsHooks.physical(lockOf(vault)), x);
		const w = track(createAuditWriter(vault, { lockAtCreate: true }));

		// V's directory is deleted and re-created: a NEW identity (K2). W re-acquires on its next
		// append, and the new lock file reuses inode X.
		rmSync(join(vault, ".usertrust"), { recursive: true, force: true });
		mkdirSync(auditDirOf(vault), { recursive: true });
		shareOneIdentity(auditDirOf(vault));
		await w.appendEvent({ kind: "k", actor: "w", data: {} });
		nextLockIno.ino = undefined;
		// Control: the model holds — V's lock file reports the reused inode.
		expect(inodeOf(lockOf(vault))).toBe(x);

		// Later an unrelated vault's directory reports K1, W's OLD identity. It has no lock file.
		const u = overrideOf(auditDirOf(vault));
		identityOverride.set(fsHooks.physical(auditDirOf(unrelated)), {
			dev: 424242n,
			ino: k1,
			hits: 0,
		});
		expect(u?.ino, "control: V is no longer K1").not.toBe(k1);
		let refused: unknown;
		try {
			track(createAuditWriter(unrelated, { lockAtCreate: true }));
		} catch (e) {
			refused = e;
		}
		expect(refused, "the unrelated vault is not locked by W's dead claim").toBeUndefined();
		expect(existsSync(lockOf(unrelated))).toBe(true);

		// W's release removes its own (current) lock and nothing of the unrelated vault's.
		const unrelatedLock = readFileSync(lockOf(unrelated), "utf-8");
		w.release();
		expect(existsSync(lockOf(vault))).toBe(false);
		expect(readFileSync(lockOf(unrelated), "utf-8")).toBe(unrelatedLock);
	});
});

describe("#195 r5: a lock is held by the writer whose id and lock-file inode it carries — never by what a directory looks like", () => {
	it("P1: a directory replaced between the lookup and the lock's create — while the first scoped lock is held, a second same-process scoped lock and a writer are refused, and the live lock is untouched", async () => {
		const parent = scratch("trust-audit-r5-replace-");
		const vault = join(parent, "vault");
		mkdirSync(auditDirOf(vault), { recursive: true });
		let fired = false;
		// Another process replaces the audit directory in the window before the exclusive create:
		// the old directory moves aside (so its inode is not reused) and a new one takes its name.
		beforeLockCreate.fn = () => {
			fired = true;
			renameSync(auditDirOf(vault), join(parent, "old-audit"));
			mkdirSync(auditDirOf(vault));
		};

		let innerRan = false;
		let inner: unknown = "never ran";
		let sibling: unknown = "never ran";
		await withAuditWriterLock(logOf(vault), async () => {
			expect(fired, "control: the replacement happened inside the acquire").toBe(true);
			expect(existsSync(lockOf(vault)), "the lock is in the NEW directory").toBe(true);
			const before = readFileSync(lockOf(vault), "utf-8");
			const ino = inodeOf(lockOf(vault));

			inner = await withAuditWriterLock(logOf(vault), () => {
				innerRan = true;
			}).catch((e: unknown) => e);
			try {
				track(createAuditWriter(vault, { lockAtCreate: true }));
			} catch (e) {
				sibling = e;
			}
			expect(readFileSync(lockOf(vault), "utf-8"), "the live lock's bytes").toBe(before);
			expect(inodeOf(lockOf(vault)), "the live lock was never unlinked and re-created").toBe(ino);
		});

		expect(innerRan, "two scoped locks never overlap").toBe(false);
		expect(inner).toBeInstanceOf(AuditWriterLockHeldError);
		expect(sibling).toBeInstanceOf(AuditWriterLockHeldError);
		expect(existsSync(lockOf(vault)), "release removed the lock it held").toBe(false);
	});

	/** A vault reached through a symlink; `move()` renames the physical vault and repoints the link. */
	function movableVault(prefix: string) {
		const parent = scratch(prefix);
		const v1 = join(parent, "v1");
		const v2 = join(parent, "v2");
		mkdirSync(auditDirOf(v1), { recursive: true });
		const link = join(parent, "link");
		symlinkSync(v1, link);
		return {
			v2,
			link,
			move() {
				renameSync(v1, v2);
				unlinkSync(link);
				symlinkSync(v2, link);
			},
		};
	}

	it("P2: the physical vault renamed and the writer's symlink repointed — an append still verifies the lock, and release removes it at its NEW place", async () => {
		const { v2, link, move } = movableVault("trust-audit-r5-rename-");
		const w = track(createAuditWriter(link, { lockAtCreate: true }));
		const mine = JSON.parse(readFileSync(lockOf(link), "utf-8")).writerId;
		move();
		await w.appendEvent({ kind: "k", actor: "a", data: {} });
		expect(JSON.parse(readFileSync(lockOf(v2), "utf-8")).writerId, "control: still w's lock").toBe(
			mine,
		);

		w.release();
		expect(existsSync(lockOf(v2)), "no lock left behind at the vault's new place").toBe(false);
		const next = track(createAuditWriter(v2, { lockAtCreate: true }));
		expect(JSON.parse(readFileSync(lockOf(v2), "utf-8")).writerId).not.toBe(mine);
		next.release();
	});

	it("P2: …and release still reaches it when the symlink is removed after that append (the place the append VERIFIED is remembered)", async () => {
		const { v2, link, move } = movableVault("trust-audit-r5-rename-unlinked-");
		const w = track(createAuditWriter(link, { lockAtCreate: true }));
		move();
		await w.appendEvent({ kind: "k", actor: "a", data: {} });
		unlinkSync(link);

		w.release();
		expect(existsSync(lockOf(v2)), "no lock left behind").toBe(false);
	});

	it.each(["scoped lock", "writer"] as const)(
		"P2: a %s whose vault is renamed and symlink repointed with NO later acquire — release finds the lock through the caller's spelling",
		async (kind) => {
			const { v2, link, move } = movableVault("trust-audit-r5-rename-noappend-");
			if (kind === "scoped lock") {
				await withAuditWriterLock(logOf(link), () => {
					move();
					expect(existsSync(lockOf(v2)), "control: the lock moved with the vault").toBe(true);
				});
			} else {
				const w = track(createAuditWriter(link, { lockAtCreate: true }));
				move();
				expect(existsSync(lockOf(v2)), "control: the lock moved with the vault").toBe(true);
				w.release();
			}
			expect(existsSync(lockOf(v2)), "no lock left behind").toBe(false);
		},
	);

	it("a same-PID lock file that reports a LIVE writer's lock-file inode but another writer id (the inode reused) is not that writer's — it is reclaimable", () => {
		const parent = scratch("trust-audit-r5-ino-reuse-");
		const a = join(parent, "A");
		const b = join(parent, "B");
		mkdirSync(auditDirOf(a), { recursive: true });
		mkdirSync(auditDirOf(b), { recursive: true });
		track(createAuditWriter(a, { lockAtCreate: true })); // live, in memory
		const ino = inodeOf(lockOf(a));
		// A's lock file is removed under its writer, and B gets a lock file left by a crashed earlier
		// instance of this PID — on the freed inode, modelled.
		unlinkSync(lockOf(a));
		writeFileSync(lockOf(b), JSON.stringify({ pid: process.pid, writerId: "crashed-instance" }));
		lockInoOverride.set(fsHooks.physical(lockOf(b)), ino);
		expect(inodeOf(lockOf(b)), "control: B's lock reports A's old inode").toBe(ino);

		let refused: unknown;
		try {
			track(createAuditWriter(b, { lockAtCreate: true }));
		} catch (e) {
			refused = e;
		}
		lockInoOverride.clear();
		expect(refused, "a reused inode is not a live writer's lock").toBeUndefined();
		expect(JSON.parse(readFileSync(lockOf(b), "utf-8")).writerId).not.toBe("crashed-instance");
	});

	it("a lock file that vanishes between the create's EEXIST and the read of it is simply gone — the acquire takes the lock", () => {
		const vault = scratch("trust-audit-r5-vanish-");
		mkdirSync(auditDirOf(vault), { recursive: true });
		// A lock left by a dead process; it is removed (by its own cleanup, say) just as we look.
		writeFileSync(lockOf(vault), JSON.stringify({ pid: 999999999 }));
		let fired = false;
		beforeLockRead.fn = (p) => {
			fired = true;
			unlinkSync(p);
		};
		track(createAuditWriter(vault, { lockAtCreate: true }));
		expect(fired, "control: the file vanished in that window").toBe(true);
		expect(JSON.parse(readFileSync(lockOf(vault), "utf-8")).pid).toBe(process.pid);
	});

	it("a lock its release could NOT reach (the vault renamed, and no spelling leads to it) is left behind — and, once released, is reclaimable by this process", () => {
		const parent = scratch("trust-audit-r5-unreachable-");
		const v1 = join(parent, "v1");
		const v2 = join(parent, "v2");
		mkdirSync(auditDirOf(v1), { recursive: true });
		const w = track(createAuditWriter(v1, { lockAtCreate: true }));
		const mine = JSON.parse(readFileSync(lockOf(v1), "utf-8")).writerId;
		renameSync(v1, v2);
		w.release();
		expect(JSON.parse(readFileSync(lockOf(v2), "utf-8")).writerId, "left behind").toBe(mine);

		track(createAuditWriter(v2, { lockAtCreate: true }));
		expect(JSON.parse(readFileSync(lockOf(v2), "utf-8")).writerId).not.toBe(mine);
	});

	it("a writer that is never released keeps its lock: while its id is held in this process, a same-process writer is refused, and release() frees it", () => {
		const vault = scratch("trust-audit-r5-unreleased-");
		const w = createAuditWriter(vault, { lockAtCreate: true }); // never released by the test body
		cleanups.unshift(() => w.release());
		expect(() => createAuditWriter(vault, { lockAtCreate: true })).toThrow(
			AuditWriterLockHeldError,
		);
		w.release();
		track(createAuditWriter(vault, { lockAtCreate: true }));
	});
});
