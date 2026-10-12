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
	utimesSync,
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
 * time it is used). The lock's path is remembered PHYSICALLY (its directory resolved as a vault is:
 * realpath(3), or the JS realpath only where it names the directory the path opens) and refreshed
 * whenever the lock is verified, so release still reaches it after a rename.
 *
 * `node:fs` is mocked at module level, wrapping a few calls and passing everything else through:
 *  - `realpathSync` and `realpathSync.native` COUNT their calls, and `.native` can be made to fail
 *    on every call (musl without /proc), so a test can pin that the lock works without realpath(3).
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
 *  - `openSync` can run a hook just before the next exclusive create (the lock's temp file): a seam
 *    for "another process changes the directory in the window before the lock file's create";
 *  - `linkSync` can run a hook just after the lock's link succeeds — the moment the lock file
 *    appears: a seam for "another process changes the directory between the create and its
 *    success";
 *  - every wrapped call can run a PROBE before and after it: a seam for "another process reads the
 *    lock at this point" — at every point of a create.
 * A lock's temp file (`<lock>.<writerId>.tmp`) becomes the lock by a hard link — the same inode — so
 * an inode chosen for a lock path is reported for its temp file's fd too.
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
/** Runs once, just AFTER the next link that creates a lock file (successfully) — with its path. */
const afterLockCreate: { fn: ((path: string) => void) | undefined } = { fn: undefined };
/**
 * Runs before AND after every wrapped fs call (and with the call's name), while armed. It must read
 * the disk through `fsHooks.real`, never through the wrapped module.
 */
const everyStep: { fn: ((step: string) => void) | undefined } = { fn: undefined };
/**
 * Faults injected ONCE into the next matching operation on a lock file or a lock's temp file, then
 * disarmed: a READ of an existing lock (`open` / `fstat` / `read` on a non-exclusive fd), a `write`
 * or `close` of an exclusive create's fd (the temp file's; for `close` the real close runs first,
 * then `before`, then the throw), an `fsync` of any fd, a `link` (by its destination), or an
 * `unlink`. Without a `path` it matches any lock or temp file; with one (physical), exactly that
 * file — a directory included.
 */
type LockFaultOp = "open" | "fstat" | "read" | "write" | "fsync" | "close" | "link" | "unlink";
const lockFaults: Array<{ op: LockFaultOp; code: string; path?: string; before?: () => void }> = [];
const realpathCalls = { native: 0, js: 0, nativeAlwaysFails: false };
/** Paths under these prefixes keep the caller's spelling through the JS realpath (see below). */
const realpathKeepsSpelling = new Set<string>();
/** The UNMOCKED physical spelling of a path, even one not created yet (installed by the mock). */
// vi.hoisted: the factory below runs while this file's own `node:fs` import resolves — before
// ordinary top-level bindings exist — and it installs `physical` at that moment.
const fsHooks = vi.hoisted(() => ({
	physical: (p: string): string => p,
	/** The UNWRAPPED `node:fs` (installed by the mock): what a probe reads the disk through. */
	real: undefined as unknown as typeof import("node:fs"),
}));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const path = await import("node:path");
	fsHooks.real = fs;
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
	// lookup does — whichever way the module under test reads a lock file's identity. A temp file's
	// fd also remembers the lock it will become (`lock`): the link gives the lock its inode.
	const fdPaths = new Map<number, { path: string; lock: string; excl: boolean }>();
	const TEMP = /\.audit-writer\.lock\.[^/\\]+\.tmp$/;
	const lockOfTemp = (p: string) => (TEMP.test(p) ? p.replace(/\.[^.]+\.tmp$/, "") : p);
	const step = (name: string) => everyStep.fn?.(name);
	// A fault with no `path` matches any lock or temp file; one with a `path` matches exactly that
	// file — a directory included (its fsync).
	const lockish = (p: string) => p.endsWith(".audit-writer.lock") || TEMP.test(p);
	const fault = (op: LockFaultOp, physicalPath: string) => {
		const i = lockFaults.findIndex(
			(f) =>
				f.op === op && (f.path === undefined ? lockish(physicalPath) : f.path === physicalPath),
		);
		if (i < 0) return;
		const [f] = lockFaults.splice(i, 1);
		f?.before?.();
		throw Object.assign(new Error(`${f?.code}: injected ${op} fault, '${physicalPath}'`), {
			code: f?.code,
		});
	};
	const openSync = ((p: string, flags?: unknown, mode?: unknown) => {
		const excl = typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0;
		if (!excl) fault("open", fsHooks.physical(String(p)));
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
		step("open");
		const fd = (fs.openSync as (p: string, f?: unknown, m?: unknown) => number)(p, flags, mode);
		step("open:done");
		const physicalPath = fsHooks.physical(String(p));
		fdPaths.set(fd, { path: physicalPath, lock: lockOfTemp(physicalPath), excl });
		return fd;
	}) as typeof fs.openSync;
	const closeSync = ((fd: number) => {
		const opened = fdPaths.get(fd);
		fdPaths.delete(fd);
		step("close");
		fs.closeSync(fd);
		step("close:done");
		if (opened?.excl === true) fault("close", opened.path);
	}) as typeof fs.closeSync;
	const writeSync = ((fd: number, ...rest: unknown[]) => {
		const opened = fdPaths.get(fd);
		if (opened?.excl === true) fault("write", opened.path);
		step("write");
		const n = (fs.writeSync as (fd: number, ...a: unknown[]) => number)(fd, ...rest);
		step("write:done");
		return n;
	}) as typeof fs.writeSync;
	const fsyncSync = ((fd: number) => {
		const opened = fdPaths.get(fd);
		if (opened !== undefined) fault("fsync", opened.path);
		step("fsync");
		fs.fsyncSync(fd);
		step("fsync:done");
	}) as typeof fs.fsyncSync;
	const linkSync = ((existing: string, dest: string) => {
		const physicalDest = fsHooks.physical(String(dest));
		fault("link", physicalDest);
		step("link");
		fs.linkSync(existing, dest);
		step("link:done");
		if (physicalDest.endsWith(".audit-writer.lock")) {
			const hook = afterLockCreate.fn;
			if (hook !== undefined) {
				afterLockCreate.fn = undefined;
				hook(physicalDest);
			}
		}
	}) as typeof fs.linkSync;
	const readFileSync = ((p: unknown, o?: unknown) => {
		if (typeof p === "number") {
			const opened = fdPaths.get(p);
			if (opened !== undefined && !opened.excl) fault("read", opened.path);
		}
		step("read");
		const content = (fs.readFileSync as (p: unknown, o?: unknown) => unknown)(p, o);
		step("read:done");
		return content;
	}) as typeof fs.readFileSync;
	const unlinkSync = ((p: string) => {
		fault("unlink", fsHooks.physical(String(p)));
		step("unlink");
		fs.unlinkSync(p);
		step("unlink:done");
	}) as typeof fs.unlinkSync;
	const fstatSync = ((fd: number, o?: unknown) => {
		const opened = fdPaths.get(fd);
		if (opened !== undefined && !opened.excl) fault("fstat", opened.path);
		step("fstat");
		const real = (fs.fstatSync as (fd: number, o?: unknown) => object)(fd, o);
		const forced = opened === undefined ? undefined : lockInoOverride.get(opened.lock);
		if (forced !== undefined) return { ...real, ino: forced };
		// `nextLockIno` models the inode a NEW lock file gets: an exclusive create's fd only.
		if (nextLockIno.ino !== undefined && opened?.excl === true) {
			return { ...real, ino: nextLockIno.ino };
		}
		return real;
	}) as typeof fs.fstatSync;
	const wrapped = {
		realpathSync,
		statSync,
		lstatSync,
		fstatSync,
		openSync,
		closeSync,
		writeSync,
		fsyncSync,
		linkSync,
		readFileSync,
		unlinkSync,
	};
	return { ...fs, ...wrapped, default: { ...fs, ...wrapped } };
});

const {
	AuditWriterLockHeldError,
	createAuditWriter,
	releaseAuditWriterForTeardown,
	withAuditWriterLock,
} = await import("../../src/audit/chain.js");
const { createSnapshot } = await import("../../src/snapshot/checkpoint.js");

const cleanups: Array<() => void> = [];
afterEach(() => {
	statWindow.enoentOnce = false;
	identityOverride.clear();
	lockInoOverride.clear();
	nextLockIno.ino = undefined;
	beforeLockCreate.fn = undefined;
	beforeLockRead.fn = undefined;
	afterLockCreate.fn = undefined;
	everyStep.fn = undefined;
	lockFaults.length = 0;
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
/** The lock temp files (`.audit-writer.lock.<id>.tmp`) in a vault's audit directory. */
const tempsIn = (vault: string) =>
	existsSync(auditDirOf(vault))
		? readdirSync(auditDirOf(vault)).filter((n) => /^\.audit-writer\.lock\..+\.tmp$/.test(n))
		: [];

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

	it("the lock works without realpath(3): with realpathSync.native failing on EVERY call (musl without /proc), every acquire path works through the portable resolver", async () => {
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

		// realpath(3) was tried, and failed, every time: each path above ran on the fallback.
		expect(realpathCalls.native).toBeGreaterThan(0);
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

	it("(b) while the first claim's lock file EXISTS, a second same-process writer on the same identity — the same directory, by another spelling — is refused, and the live lock is neither recreated nor duplicated", async () => {
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

		const e3 = (await w1.appendEvent({
			kind: "k",
			actor: "w1",
			data: { n: 3 },
		})) as unknown as { previousHash: string; sequence: number };
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

describe("#195: a lock that cannot be read, released or closed is never treated as free", () => {
	const phys = (p: string) => fsHooks.physical(p);
	const idOf = (lock: string) => JSON.parse(readFileSync(lock, "utf-8")).writerId as string;

	it.each(["open", "fstat", "read"] as const)(
		"P1: a %s error reading a LIVE scoped lock makes a second same-process acquire THROW — never reclaim — and the first critical section runs alone",
		async (op) => {
			const vault = scratch(`trust-audit-eio-${op}-`);
			mkdirSync(auditDirOf(vault), { recursive: true });
			let innerRan = false;
			let inner: unknown = "never ran";
			await withAuditWriterLock(logOf(vault), async () => {
				const before = readFileSync(lockOf(vault), "utf-8");
				const ino = inodeOf(lockOf(vault));
				lockFaults.push({ op, code: "EIO", path: phys(lockOf(vault)) });
				inner = await withAuditWriterLock(logOf(vault), () => {
					innerRan = true;
				}).catch((e: unknown) => e);
				expect(lockFaults, "control: the fault was hit").toHaveLength(0);
				expect(readFileSync(lockOf(vault), "utf-8"), "the live lock's bytes").toBe(before);
				expect(inodeOf(lockOf(vault)), "never unlinked and re-created").toBe(ino);
			});
			expect(innerRan, "two critical sections never overlap").toBe(false);
			expect((inner as { code?: string }).code).toBe("EIO");
			expect(existsSync(lockOf(vault)), "the first section's release removed its lock").toBe(false);
		},
	);

	it("P1: a read error while a writer VERIFIES its own lock (the path-refresh path) fails the append and leaves the lock in place; once reads work, the writer appends and releases normally", async () => {
		const parent = scratch("trust-audit-eio-refresh-");
		const v1 = join(parent, "v1");
		const v2 = join(parent, "v2");
		mkdirSync(auditDirOf(v1), { recursive: true });
		const link = join(parent, "link");
		symlinkSync(v1, link);
		const w = track(createAuditWriter(link, { lockAtCreate: true }));
		const mine = idOf(lockOf(v1));
		renameSync(v1, v2);
		unlinkSync(link);
		symlinkSync(v2, link);
		const ino = inodeOf(lockOf(v2));

		lockFaults.push({ op: "read", code: "EIO", path: phys(lockOf(v2)) });
		const err = await w.appendEvent({ kind: "k", actor: "a", data: {} }).catch((e: unknown) => e);
		expect((err as { code?: string }).code).toBe("EIO");
		expect(idOf(lockOf(v2)), "the lock is untouched").toBe(mine);
		expect(inodeOf(lockOf(v2))).toBe(ino);

		await w.appendEvent({ kind: "k", actor: "a", data: {} });
		unlinkSync(link); // only the refreshed path can reach it now
		w.release();
		expect(existsSync(lockOf(v2))).toBe(false);
	});

	it("release: a read error leaves the lock file in place and is REPORTED (an AggregateError naming it); the writer's state is reset regardless", async () => {
		const vault = scratch("trust-audit-eio-release-");
		const w = createAuditWriter(vault, { lockAtCreate: true });
		const mine = idOf(lockOf(vault));
		// Make the writer degraded first, so the reset is observable.
		lockFaults.push({ op: "read", code: "EIO", path: phys(lockOf(vault)) });
		await w.appendEvent({ kind: "k", actor: "a", data: {} }).catch(() => {});
		expect(w.isDegraded(), "control: degraded").toBe(true);

		lockFaults.push({ op: "read", code: "EIO", path: phys(lockOf(vault)) });
		let err: unknown;
		try {
			w.release();
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(AggregateError);
		expect((err as Error).message).toContain(phys(lockOf(vault)));
		expect(((err as AggregateError).errors[0] as { cause?: { code?: string } }).cause?.code).toBe(
			"EIO",
		);
		expect(idOf(lockOf(vault)), "a lock it could not read is never unlinked").toBe(mine);
		expect(w.isDegraded()).toBe(false);
		expect(w.getWriteFailures()).toBe(0);
		// Released (deregistered): the left-behind lock is reclaimable by this process.
		track(createAuditWriter(vault, { lockAtCreate: true }));
		expect(idOf(lockOf(vault))).not.toBe(mine);
	});

	it("release: an unlink that fails (other than already-gone) is REPORTED, not swallowed", () => {
		const vault = scratch("trust-audit-unlink-release-");
		const w = track(createAuditWriter(vault, { lockAtCreate: true }));
		lockFaults.push({ op: "unlink", code: "EACCES", path: phys(lockOf(vault)) });
		expect(() => w.release()).toThrow(AggregateError);
		expect(existsSync(lockOf(vault)), "control: the unlink really failed").toBe(true);
	});

	it("release: an unlink that loses the race to another remover (ENOENT) is a released lock, not a failure", () => {
		const vault = scratch("trust-audit-unlink-race-");
		const w = track(createAuditWriter(vault, { lockAtCreate: true }));
		lockFaults.push({
			op: "unlink",
			code: "ENOENT",
			path: phys(lockOf(vault)),
			before: () => unlinkSync(lockOf(vault)), // the other remover gets there first
		});
		expect(() => w.release()).not.toThrow();
		expect(lockFaults, "control: the race was hit").toHaveLength(0);
		expect(existsSync(lockOf(vault))).toBe(false);
	});

	/** A writer that locks A through `link`, then — the link retargeted to B — appends and locks B. */
	async function writerHoldingTwo(prefix: string) {
		const parent = scratch(prefix);
		const a = join(parent, "A");
		const b = join(parent, "B");
		mkdirSync(auditDirOf(a), { recursive: true });
		mkdirSync(auditDirOf(b), { recursive: true });
		const link = join(parent, "link");
		symlinkSync(a, link);
		const w = track(createAuditWriter(link, { lockAtCreate: true }));
		unlinkSync(link);
		symlinkSync(b, link);
		await w.appendEvent({ kind: "k", actor: "a", data: {} });
		const mine = idOf(lockOf(a));
		expect(idOf(lockOf(b)), "control: the writer now holds B's lock too").toBe(mine);
		return { a, b, w, mine };
	}

	it("P2: a writer that locked A, then (its symlink retargeted) B, releases BOTH — and A is free again", async () => {
		const { a, b, w, mine } = await writerHoldingTwo("trust-audit-two-");
		w.release();
		expect(existsSync(lockOf(a)), "A's lock is not left behind").toBe(false);
		expect(existsSync(lockOf(b))).toBe(false);
		track(createAuditWriter(a, { lockAtCreate: true }));
		expect(idOf(lockOf(a))).not.toBe(mine);
	});

	it("P2: release continues past one lock's failure — the other is released — and the error names the failed lock", async () => {
		const { a, b, w, mine } = await writerHoldingTwo("trust-audit-two-fail-");
		lockFaults.push({ op: "read", code: "EIO", path: phys(lockOf(a)) });
		let err: unknown;
		try {
			w.release();
		} catch (e) {
			err = e;
		}
		expect(lockFaults, "control: the fault was hit").toHaveLength(0);
		expect(err).toBeInstanceOf(AggregateError);
		expect((err as AggregateError).errors).toHaveLength(1);
		expect((err as Error).message).toContain(phys(lockOf(a)));
		expect((err as Error).message).not.toContain(phys(lockOf(b)));
		expect(existsSync(lockOf(b)), "B was still released").toBe(false);
		expect(idOf(lockOf(a)), "A's unreadable lock is left in place").toBe(mine);
	});

	it.each(["writer", "scoped lock"] as const)(
		"P2: a %s whose lock's temp-file close fails: the acquire throws, no lock and no temp file are left, no owner is left registered, and a later acquire succeeds",
		async (kind) => {
			const vault = scratch("trust-audit-close-");
			mkdirSync(auditDirOf(vault), { recursive: true });
			lockFaults.push({ op: "close", code: "EIO" });
			let ran = false;
			const err = await (async () =>
				kind === "writer"
					? track(createAuditWriter(vault, { lockAtCreate: true }))
					: withAuditWriterLock(logOf(vault), () => {
							ran = true;
						}))().catch((e: unknown) => e);
			expect(lockFaults, "control: the close fault was hit").toHaveLength(0);
			expect((err as { code?: string }).code).toBe("EIO");
			expect(ran).toBe(false);
			expect(existsSync(lockOf(vault)), "no lock was ever linked").toBe(false);
			expect(tempsIn(vault), "the temp file was removed").toEqual([]);

			track(createAuditWriter(vault, { lockAtCreate: true }));
			expect(JSON.parse(readFileSync(lockOf(vault), "utf-8")).pid).toBe(process.pid);
		},
	);

	it("P2: a failure after the link whose rollback cannot even READ the file leaves it in place UNREGISTERED — a later acquire in this process reclaims it, never refused by a phantom owner", () => {
		const vault = scratch("trust-audit-close-unreadable-");
		mkdirSync(auditDirOf(vault), { recursive: true });
		// The check's read fails, and then so does the rollback's own read of the lock.
		afterLockCreate.fn = (p) => {
			lockFaults.push({
				op: "read",
				code: "EIO",
				path: p,
				before: () => lockFaults.push({ op: "open", code: "EIO", path: p }),
			});
		};
		expect(() => createAuditWriter(vault, { lockAtCreate: true })).toThrow(/EIO/);
		expect(lockFaults, "control: both faults were hit").toHaveLength(0);
		expect(existsSync(lockOf(vault)), "could not be read, so not removed").toBe(true);
		const left = idOf(lockOf(vault));

		track(createAuditWriter(vault, { lockAtCreate: true }));
		expect(idOf(lockOf(vault))).not.toBe(left);
	});

	it("P2: the rollback of a failure after the link removes only the file its own create made — a lock that replaced it is left alone", () => {
		const vault = scratch("trust-audit-close-replaced-");
		mkdirSync(auditDirOf(vault), { recursive: true });
		const foreign = JSON.stringify({ pid: 999999999, writerId: "someone-else" });
		// The check's read fails — just after another remover replaced the lock.
		afterLockCreate.fn = (p) => {
			lockFaults.push({
				op: "read",
				code: "EIO",
				path: p,
				before: () => {
					unlinkSync(lockOf(vault));
					writeFileSync(lockOf(vault), foreign);
				},
			});
		};
		expect(() => createAuditWriter(vault, { lockAtCreate: true })).toThrow(/EIO/);
		expect(readFileSync(lockOf(vault), "utf-8"), "not ours: left in place").toBe(foreign);
	});

	it("P2: …even when the replacement REUSES the inode of the file the create made (Linux ext4 does: the freed inode goes to the next file) — the writer id tells them apart", () => {
		const vault = scratch("trust-audit-close-reused-");
		mkdirSync(auditDirOf(vault), { recursive: true });
		const foreign = JSON.stringify({ pid: 999999999, writerId: "someone-else" });
		afterLockCreate.fn = (p) => {
			lockFaults.push({
				op: "read",
				code: "EIO",
				path: p,
				before: () => {
					const ours = inodeOf(lockOf(vault));
					unlinkSync(lockOf(vault));
					writeFileSync(lockOf(vault), foreign);
					// Modelled reuse, so every platform sees it: the replacement reports our freed inode.
					lockInoOverride.set(phys(lockOf(vault)), ours);
				},
			});
		};
		expect(() => createAuditWriter(vault, { lockAtCreate: true })).toThrow(/EIO/);
		expect(lockFaults, "control: the check's read fault was hit").toHaveLength(0);
		expect(readFileSync(lockOf(vault), "utf-8"), "not ours: left in place").toBe(foreign);
	});

	it("withAuditWriterLock: when fn succeeds, a release failure rejects (naming the lock)", async () => {
		const vault = scratch("trust-audit-scoped-release-");
		mkdirSync(auditDirOf(vault), { recursive: true });
		const err = await withAuditWriterLock(logOf(vault), () => {
			lockFaults.push({ op: "read", code: "EIO", path: phys(lockOf(vault)) });
			return "done";
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AggregateError);
		expect((err as Error).message).toContain(phys(lockOf(vault)));
	});

	it("withAuditWriterLock: when fn throws, ITS error is the rejection — the release failure is reported beside it, never masking it", async () => {
		const vault = scratch("trust-audit-scoped-both-");
		mkdirSync(auditDirOf(vault), { recursive: true });
		const fnErr = new Error("restore failed");
		const reported = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const err = await withAuditWriterLock(logOf(vault), () => {
				lockFaults.push({ op: "read", code: "EIO", path: phys(lockOf(vault)) });
				throw fnErr;
			}).catch((e: unknown) => e);
			expect(err).toBe(fnErr);
			// One printed line naming the lock left behind — never the raw error object.
			expect(reported).toHaveBeenCalledTimes(1);
			expect(reported.mock.calls[0]).toHaveLength(1);
			expect(String(reported.mock.calls[0]?.[0])).toContain("[AUDIT]");
			expect(String(reported.mock.calls[0]?.[0])).toContain(phys(lockOf(vault)));
		} finally {
			reported.mockRestore();
		}
	});
});

describe("#195: the threat model's edge — directory replacement during an acquire, and what release reports", () => {
	const phys = (p: string) => fsHooks.physical(p);
	const idOf = (lock: string) => JSON.parse(readFileSync(lock, "utf-8")).writerId as string;
	const char = (code: number) => String.fromCharCode(code);
	/** C0, DEL and C1 characters in `text`. */
	const controlsIn = (text: string) =>
		[...text].filter((ch) => {
			const code = ch.codePointAt(0) ?? 0;
			return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
		});

	/**
	 * A vault whose audit directory is moved to `elsewhere` (a second vault) and replaced by a new,
	 * empty one right after the lock's link creates it — before the acquire reports success.
	 */
	function replacedAfterClose(prefix: string, foreignLock?: string) {
		const parent = scratch(prefix);
		const vault = join(parent, "vault");
		const elsewhere = join(parent, "elsewhere");
		mkdirSync(auditDirOf(vault), { recursive: true });
		mkdirSync(join(elsewhere, ".usertrust"), { recursive: true });
		let fired = false;
		afterLockCreate.fn = () => {
			fired = true;
			renameSync(auditDirOf(vault), auditDirOf(elsewhere));
			mkdirSync(auditDirOf(vault));
			if (foreignLock !== undefined) writeFileSync(lockOf(vault), foreignLock);
		};
		return { vault, elsewhere, fired: () => fired };
	}

	it("P1: the audit directory replaced between the create and its success — the acquire THROWS (never reports a lock the requested directory does not have), the callback never runs, and no owner is registered", async () => {
		const { vault, elsewhere, fired } = replacedAfterClose("trust-audit-replaced-after-close-");
		let ran = false;
		const err = await withAuditWriterLock(logOf(vault), () => {
			ran = true;
		}).catch((e: unknown) => e);

		expect(fired(), "control: the directory was replaced in that window").toBe(true);
		expect(err).toBeInstanceOf(AuditWriterLockHeldError);
		expect(ran, "no critical section without a lock in the requested directory").toBe(false);
		expect(existsSync(lockOf(vault)), "the requested directory has no lock").toBe(false);
		// The file the create made moved with the old directory. Unregistered, it is a same-PID lock
		// nobody here holds: a writer on that directory reclaims it, never refused by a phantom owner.
		const orphan = idOf(lockOf(elsewhere));
		track(createAuditWriter(elsewhere, { lockAtCreate: true }));
		expect(idOf(lockOf(elsewhere))).not.toBe(orphan);
	});

	it("P1: …and when the new directory already holds ANOTHER writer's lock, that lock is left untouched", () => {
		const foreign = JSON.stringify({ pid: 999999999, writerId: "someone-else" });
		const { vault, fired } = replacedAfterClose("trust-audit-replaced-foreign-", foreign);
		expect(() => createAuditWriter(vault, { lockAtCreate: true })).toThrow(
			AuditWriterLockHeldError,
		);
		expect(fired()).toBe(true);
		expect(readFileSync(lockOf(vault), "utf-8"), "another writer's lock: untouched").toBe(foreign);
	});

	it("P1: …the check needs the writer id: a replacement lock that REUSES the create's inode (as ext4 does) is not ours", () => {
		const parent = scratch("trust-audit-replaced-reused-");
		const vault = join(parent, "vault");
		mkdirSync(auditDirOf(vault), { recursive: true });
		const foreign = JSON.stringify({ pid: 999999999, writerId: "someone-else" });
		afterLockCreate.fn = () => {
			const ours = inodeOf(lockOf(vault));
			renameSync(auditDirOf(vault), join(parent, "old-audit"));
			mkdirSync(auditDirOf(vault));
			writeFileSync(lockOf(vault), foreign);
			lockInoOverride.set(phys(lockOf(vault)), ours); // modelled reuse
		};
		expect(() => createAuditWriter(vault, { lockAtCreate: true })).toThrow(
			AuditWriterLockHeldError,
		);
		expect(readFileSync(lockOf(vault), "utf-8")).toBe(foreign);
	});

	it("P1: …and the inode: a byte-identical COPY of the lock (it carries this writer's id) is not the file the create made", () => {
		const parent = scratch("trust-audit-replaced-copy-");
		const vault = join(parent, "vault");
		mkdirSync(auditDirOf(vault), { recursive: true });
		afterLockCreate.fn = () => {
			const bytes = readFileSync(lockOf(vault), "utf-8");
			renameSync(auditDirOf(vault), join(parent, "old-audit"));
			mkdirSync(auditDirOf(vault));
			writeFileSync(lockOf(vault), bytes);
		};
		expect(() => createAuditWriter(vault, { lockAtCreate: true })).toThrow(
			AuditWriterLockHeldError,
		);
	});

	it("P1: a read error in that check fails the acquire, and the file the create made is rolled back — nothing registered", () => {
		const vault = scratch("trust-audit-check-eio-");
		mkdirSync(auditDirOf(vault), { recursive: true });
		afterLockCreate.fn = (p) => {
			lockFaults.push({ op: "read", code: "EIO", path: p });
		};
		const err = (() => {
			try {
				createAuditWriter(vault, { lockAtCreate: true });
			} catch (e) {
				return e;
			}
		})();
		expect(lockFaults, "control: the check's read hit the fault").toHaveLength(0);
		expect((err as { code?: string }).code).toBe("EIO");
		expect(existsSync(lockOf(vault)), "rolled back").toBe(false);
		track(createAuditWriter(vault, { lockAtCreate: true }));
	});

	/** A vault reached through `link`; `move()` renames the physical vault A→B and repoints the link. */
	function movable(prefix: string) {
		const parent = scratch(prefix);
		const a = join(parent, "A");
		const b = join(parent, "B");
		mkdirSync(auditDirOf(a), { recursive: true });
		const link = join(parent, "link");
		symlinkSync(a, link);
		return {
			a,
			b,
			link,
			move() {
				renameSync(a, b);
				unlinkSync(link);
				symlinkSync(b, link);
			},
		};
	}

	it("P2: a lock found at its NEW place (A renamed to B, the link repointed) whose unlink fails is reported at B — in `left` and in the message — never at the obsolete A", async () => {
		const { a, b, link, move } = movable("trust-audit-report-moved-");
		const aLock = lockOf(a);
		const err = await withAuditWriterLock(logOf(link), () => {
			move();
			lockFaults.push({ op: "unlink", code: "EACCES", path: phys(lockOf(b)) });
		}).catch((e: unknown) => e);

		expect(lockFaults, "control: the unlink at B failed").toHaveLength(0);
		const left = (err as { left?: ReadonlyArray<{ path: string; code?: string }> }).left;
		expect(left?.[0]).toEqual({ path: phys(lockOf(b)), code: "EACCES" });
		expect((err as Error).message).toContain(phys(lockOf(b)));
		expect((err as Error).message).not.toContain(aLock.slice(aLock.lastIndexOf("/A/")));
	});

	it("P2: …and the teardown warning names B too", () => {
		const { b, link, move } = movable("trust-audit-warn-moved-");
		const w = createAuditWriter(link, { lockAtCreate: true });
		move();
		lockFaults.push({ op: "unlink", code: "EACCES", path: phys(lockOf(b)) });
		const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			releaseAuditWriterForTeardown(w);
			const [message] = emitWarning.mock.calls[0] as [string];
			expect(message).toContain(phys(lockOf(b)));
			expect(message).not.toContain("/A/.usertrust");
		} finally {
			emitWarning.mockRestore();
			warn.mockRestore();
		}
	});

	it("P2: when the callback AND release fail, the release failure is printed SCRUBBED — the lock path's planted terminal control never reaches stderr — and the callback's error is the rejection", async () => {
		// A real directory whose name carries an SGR, an OSC title, CR, DEL and C1's 8-bit CSI.
		const planted = `vault-planted${char(0x1b)}[31m${char(0x1b)}]0;pwned${char(0x07)}${char(0x0d)}${char(0x7f)}${char(0x9b)}2J`;
		const vault = join(scratch("trust-audit-scoped-scrub-"), planted);
		mkdirSync(auditDirOf(vault), { recursive: true });
		const fnErr = new Error("restore failed");
		const printed: string[] = [];
		const reported = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			printed.push(
				args.map((a) => (a instanceof Error ? `${a.stack ?? a.message}` : String(a))).join(" "),
			);
		});
		try {
			const err = await withAuditWriterLock(logOf(vault), () => {
				lockFaults.push({ op: "unlink", code: "EACCES", path: phys(lockOf(vault)) });
				throw fnErr;
			}).catch((e: unknown) => e);
			expect(err).toBe(fnErr);
			const out = printed.join("\n");
			const start = out.indexOf("vault-planted");
			expect(start, "control: the planted path is printed").toBeGreaterThanOrEqual(0);
			const end = out.indexOf(".audit-writer.lock", start);
			expect(end).toBeGreaterThan(start);
			expect(controlsIn(out.slice(start, end)), "nothing planted reaches stderr").toEqual([]);
			expect(controlsIn(out), "no control character anywhere in the diagnostic").toEqual([]);
		} finally {
			reported.mockRestore();
		}
	});
});

describe("the lock appears complete: written to a temp file, then hard-linked into place", () => {
	const phys = (p: string) => fsHooks.physical(p);
	const idOf = (lock: string) => JSON.parse(readFileSync(lock, "utf-8")).writerId as string;
	const code = (e: unknown) => (e as { code?: string } | undefined)?.code;
	/** A lock file left by a live process other than this one: the parent (as chain.test.ts does). */
	const heldByAnotherProcess = (vault: string) =>
		writeFileSync(lockOf(vault), JSON.stringify({ pid: process.ppid, writerId: "other" }));
	/** What another process reading the lock path sees right now: absent, a complete claim, or not. */
	function lookAtLock(lock: string): "absent" | "complete" | string {
		let content: string;
		try {
			content = fsHooks.real.readFileSync(lock, "utf-8");
		} catch (e) {
			if (code(e) === "ENOENT") return "absent";
			throw e;
		}
		try {
			const claim = JSON.parse(content) as { pid?: unknown; writerId?: unknown };
			if (typeof claim.pid === "number" && typeof claim.writerId === "string") return "complete";
		} catch {
			/* reported below */
		}
		return `INCOMPLETE ${JSON.stringify(content)}`;
	}

	it.each(["writer", "scoped lock"] as const)(
		"P1: another process reading the lock path at EVERY point of a %s's create sees no lock or a complete one — never an empty or unparseable lock it would judge corrupt and remove",
		async (kind) => {
			const vault = scratch("trust-audit-atomic-probe-");
			mkdirSync(auditDirOf(vault), { recursive: true });
			const seen: string[] = [];
			everyStep.fn = (step) => {
				seen.push(`${step}: ${lookAtLock(lockOf(vault))}`);
			};
			try {
				if (kind === "writer") {
					track(createAuditWriter(vault, { lockAtCreate: true }));
				} else {
					await withAuditWriterLock(logOf(vault), () => {
						everyStep.fn = undefined; // the create is over
					});
				}
			} finally {
				everyStep.fn = undefined;
			}
			expect(seen.filter((v) => v.includes("INCOMPLETE"))).toEqual([]);
			// Controls: the probe ran before the lock existed, and after it appeared.
			expect(seen.some((v) => v.endsWith(": absent"))).toBe(true);
			expect(seen.some((v) => v.endsWith(": complete"))).toBe(true);
		},
	);

	it("P1: …and through a stale-lock reclaim too: between the stale lock's removal and the new lock, the path is absent, never half-written", () => {
		const vault = scratch("trust-audit-atomic-reclaim-");
		mkdirSync(auditDirOf(vault), { recursive: true });
		writeFileSync(lockOf(vault), JSON.stringify({ pid: 999999999, writerId: "dead" }));
		const seen: string[] = [];
		everyStep.fn = (step) => {
			seen.push(`${step}: ${lookAtLock(lockOf(vault))}`);
		};
		try {
			track(createAuditWriter(vault, { lockAtCreate: true }));
		} finally {
			everyStep.fn = undefined;
		}
		expect(seen.filter((v) => v.includes("INCOMPLETE"))).toEqual([]);
		expect(
			seen.some((v) => v.endsWith(": absent")),
			"control: the stale lock was removed",
		).toBe(true);
		expect(idOf(lockOf(vault))).not.toBe("dead");
	});

	it("no temp file is left: after a create, after a refusal (EEXIST), and after release", async () => {
		const vault = scratch("trust-audit-temp-clean-");
		const w = createAuditWriter(vault, { lockAtCreate: true });
		await w.appendEvent({ kind: "k", actor: "a", data: {} });
		expect(tempsIn(vault), "after the create").toEqual([]);
		w.release();
		expect(tempsIn(vault), "after release").toEqual([]);

		heldByAnotherProcess(vault);
		expect(() => createAuditWriter(vault, { lockAtCreate: true })).toThrow(
			AuditWriterLockHeldError,
		);
		expect(tempsIn(vault), "after a refusal").toEqual([]);
	});

	it.each(["write", "fsync", "close"] as const)(
		"a %s failure on the temp file fails the acquire with no lock, no temp file and no owner left — a later acquire succeeds",
		(op) => {
			const vault = scratch(`trust-audit-temp-${op}-`);
			mkdirSync(auditDirOf(vault), { recursive: true });
			lockFaults.push({ op, code: "EIO" });
			let err: unknown;
			try {
				createAuditWriter(vault, { lockAtCreate: true });
			} catch (e) {
				err = e;
			}
			expect(lockFaults, "control: the fault was hit").toHaveLength(0);
			expect(code(err)).toBe("EIO");
			expect(existsSync(lockOf(vault)), "no lock").toBe(false);
			expect(tempsIn(vault), "no temp file").toEqual([]);
			track(createAuditWriter(vault, { lockAtCreate: true }));
		},
	);

	it("a link that fails for another reason (EIO) fails the acquire with no lock and no temp file", () => {
		const vault = scratch("trust-audit-link-eio-");
		mkdirSync(auditDirOf(vault), { recursive: true });
		lockFaults.push({ op: "link", code: "EIO" });
		expect(() => createAuditWriter(vault, { lockAtCreate: true })).toThrow(/EIO/);
		expect(lockFaults, "control: the fault was hit").toHaveLength(0);
		expect(existsSync(lockOf(vault))).toBe(false);
		expect(tempsIn(vault)).toEqual([]);
	});

	it.each(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"])(
		"link() unsupported (%s): the acquire FAILS CLOSED — never falls back to a create-then-write — keeps the code, says why, and leaves no lock, no temp file and no owner",
		async (linkCode) => {
			const vault = scratch("trust-audit-link-unsupported-");
			mkdirSync(auditDirOf(vault), { recursive: true });
			lockFaults.push({ op: "link", code: linkCode });
			let ran = false;
			const err = await withAuditWriterLock(logOf(vault), () => {
				ran = true;
			}).catch((e: unknown) => e);
			expect(lockFaults, "control: the fault was hit").toHaveLength(0);
			expect(ran).toBe(false);
			expect(code(err)).toBe(linkCode);
			expect((err as Error).message).toMatch(/hard link/);
			expect(((err as Error).cause as { code?: string }).code).toBe(linkCode);
			expect(existsSync(lockOf(vault)), "no lock was created another way").toBe(false);
			expect(tempsIn(vault)).toEqual([]);
			track(createAuditWriter(vault, { lockAtCreate: true }));
		},
	);

	it("a temp file whose removal failed after the link does not fail the acquire; the writer's next create removes its own leftover and creates afresh", async () => {
		const vault = scratch("trust-audit-temp-leftover-");
		mkdirSync(auditDirOf(vault), { recursive: true });
		afterLockCreate.fn = (p) => {
			// The temp file's removal, just after the link, fails once.
			const temp = readdirSync(auditDirOf(vault)).find((n) => n.endsWith(".tmp"));
			lockFaults.push({ op: "unlink", code: "EIO", path: phys(join(p, "..", temp ?? "?")) });
		};
		const w = track(createAuditWriter(vault, { lockAtCreate: true }));
		expect(lockFaults, "control: the temp file's removal failed").toHaveLength(0);
		const mine = idOf(lockOf(vault));
		expect(tempsIn(vault), "control: the temp file was left").toEqual([
			`.audit-writer.lock.${mine}.tmp`,
		]);

		w.release();
		expect(existsSync(lockOf(vault)), "released").toBe(false);
		await w.appendEvent({ kind: "k", actor: "a", data: {} }); // re-acquires: same temp name
		expect(idOf(lockOf(vault))).toBe(mine);
		expect(tempsIn(vault), "the leftover was replaced and removed").toEqual([]);
	});

	it("a lock temp file the writer really made (its removal failed, as after a crash) is never captured by a snapshot", async () => {
		const vault = scratch("trust-audit-temp-snapshot-");
		mkdirSync(auditDirOf(vault), { recursive: true });
		afterLockCreate.fn = (p) => {
			const temp = readdirSync(auditDirOf(vault)).find((n) => n.endsWith(".tmp"));
			lockFaults.push({ op: "unlink", code: "EIO", path: phys(join(p, "..", temp ?? "?")) });
		};
		const w = track(createAuditWriter(vault, { lockAtCreate: true }));
		await w.appendEvent({ kind: "k", actor: "a", data: {} });
		const temps = tempsIn(vault);
		expect(temps, "control: the writer's temp file is there").toHaveLength(1);

		const files = (await createSnapshot(join(vault, ".usertrust"), "with-temp")).files;
		expect(files, "control: the log is captured").toContain("audit/events.jsonl");
		expect(files).not.toContain(`audit/${temps[0]}`);
	});

	it("leftover temp files of crashed writers are never read as a lock, and a writer that takes the lock removes those older than a minute — a young one (a live create's) is left", () => {
		const vault = scratch("trust-audit-temp-sweep-");
		mkdirSync(auditDirOf(vault), { recursive: true });
		const temp = (id: string) => join(auditDirOf(vault), `.audit-writer.lock.${id}.tmp`);
		const old = ["0", "1", "2"].map((n) => temp(`${n.repeat(8)}-0000-4000-8000-000000000000`));
		const young = temp("33333333-0000-4000-8000-000000000000");
		const notOurs = join(auditDirOf(vault), ".audit-writer.lock.not-a-writer-id.tmp");
		// Each carries a LIVE process's complete claim: were any read as the lock, it would hold.
		const claim = JSON.stringify({ pid: process.ppid, writerId: "crashed" });
		for (const f of [...old, young, notOurs]) writeFileSync(f, claim);
		const anHourAgo = new Date(Date.now() - 3_600_000);
		for (const f of [...old, notOurs]) utimesSync(f, anHourAgo, anHourAgo);

		track(createAuditWriter(vault, { lockAtCreate: true }));
		expect(JSON.parse(readFileSync(lockOf(vault), "utf-8")).pid).toBe(process.pid);
		expect(
			old.filter((f) => existsSync(f)),
			"the old leftovers were removed",
		).toEqual([]);
		expect(existsSync(young), "a young temp file is left").toBe(true);
		expect(existsSync(notOurs), "a name not of the temp-file form is never touched").toBe(true);
	});

	it("a symlink at the lock's name is never followed: the acquire THROWS (ELOOP), and neither the link nor its target is touched", async () => {
		const parent = scratch("trust-audit-lock-symlink-");
		const vault = join(parent, "vault");
		mkdirSync(auditDirOf(vault), { recursive: true });
		// The target holds a dead process's claim: followed, it would be judged stale and reclaimed.
		const target = join(parent, "elsewhere.json");
		const dead = JSON.stringify({ pid: 999999999, writerId: "dead" });
		writeFileSync(target, dead);
		symlinkSync(target, lockOf(vault));
		const err = await withAuditWriterLock(logOf(vault), () => {}).catch((e: unknown) => e);
		expect(code(err)).toBe("ELOOP");
		expect(lstatSync(lockOf(vault)).isSymbolicLink(), "the symlink is still there").toBe(true);
		expect(readFileSync(target, "utf-8")).toBe(dead);
		expect(tempsIn(vault)).toEqual([]);
	});

	it("a symlink at the writer's temp-file name is never written through: it is removed and the temp file created afresh", async () => {
		const parent = scratch("trust-audit-temp-symlink-");
		const vault = join(parent, "vault");
		const w = track(createAuditWriter(vault, { lockAtCreate: true }));
		const mine = idOf(lockOf(vault));
		w.release();
		const outside = join(parent, "outside.txt");
		writeFileSync(outside, "untouched");
		symlinkSync(outside, join(auditDirOf(vault), `.audit-writer.lock.${mine}.tmp`));

		await w.appendEvent({ kind: "k", actor: "a", data: {} });
		expect(readFileSync(outside, "utf-8")).toBe("untouched");
		expect(idOf(lockOf(vault))).toBe(mine);
		expect(lstatSync(lockOf(vault)).isSymbolicLink()).toBe(false);
		expect(tempsIn(vault)).toEqual([]);
	});

	it("an append by a writer that holds its lock verifies it by one read — no temp file, no link", async () => {
		const vault = scratch("trust-audit-fast-verify-");
		const w = track(createAuditWriter(vault, { lockAtCreate: true }));
		const steps: string[] = [];
		everyStep.fn = (step) => {
			steps.push(step);
		};
		try {
			for (let i = 0; i < 3; i++) await w.appendEvent({ kind: "k", actor: "a", data: { i } });
		} finally {
			everyStep.fn = undefined;
		}
		expect(steps.filter((s) => s === "link")).toEqual([]);
		expect(steps.filter((s) => s === "write").length, "control: the probe saw the appends").toBe(
			6, // each append: the log line and the sidecar
		);
	});

	it.each([
		["EIO", true],
		["EINVAL", false],
	] as const)(
		"the directory is fsync'd after the link; a failure (%s) never fails the acquire — reported unless the platform just cannot (warned: %s)",
		(fsyncCode, warned) => {
			const vault = scratch("trust-audit-dir-fsync-");
			mkdirSync(auditDirOf(vault), { recursive: true });
			lockFaults.push({ op: "fsync", code: fsyncCode, path: phys(auditDirOf(vault)) });
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				track(createAuditWriter(vault, { lockAtCreate: true }));
				expect(lockFaults, "control: the directory fsync was attempted").toHaveLength(0);
				const lines = warn.mock.calls.map((c) => String(c[0]));
				expect(lines.some((l) => l.includes(`not fsynced (${fsyncCode})`))).toBe(warned);
			} finally {
				warn.mockRestore();
			}
			expect(JSON.parse(readFileSync(lockOf(vault), "utf-8")).pid).toBe(process.pid);
		},
	);
});
