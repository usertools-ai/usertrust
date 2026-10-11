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
 * The lock FILE is stored at its PHYSICAL path (the JS realpath of its directory), and a registry
 * hit is verified in the directory itself (#195 r4).
 *
 * `node:fs` is mocked at module level, wrapping a few calls and passing everything else through:
 *  - `realpathSync` and `realpathSync.native` COUNT their calls, and `.native` can be made to fail
 *    on every call (musl without /proc), so a test can pin that the lock never needs realpath(3).
 *    The JS realpath can also be made to KEEP the caller's spelling under a prefix — what it does
 *    with letter case on a case-insensitive mount — so the "a spelling is not a key" property is
 *    pinned on case-sensitive CI too, where the real case-variant test is skipped;
 *  - `statSync` can be ARMED to answer ENOENT once (#182.1's window: the directory does not exist
 *    yet at the identity lookup, and another process creates it before the lock file's open), and
 *    can REPORT A CHOSEN `(dev, ino)` for a directory;
 *  - `lstatSync` can report a chosen inode for a lock file, and `fstatSync` a chosen inode for the
 *    next lock files created — together they model a new lock file REUSING an old one's inode.
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
	const fstatSync = ((fd: number, o?: unknown) => {
		const real = (fs.fstatSync as (fd: number, o?: unknown) => object)(fd, o);
		return nextLockIno.ino === undefined ? real : { ...real, ino: nextLockIno.ino };
	}) as typeof fs.fstatSync;
	const wrapped = { realpathSync, statSync, lstatSync, fstatSync };
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

	it("a spelling the JS realpath leaves as given (modelled: the caller's case on a case-insensitive mount) is still ONE key — the second writer is refused, never a reclaim", () => {
		const parent = scratch("trust-audit-spelling-");
		const vault = join(parent, "vault");
		mkdirSync(vault);
		const other = join(parent, "other-spelling");
		symlinkSync(vault, other);
		// The JS realpath returns `other…` as given, so the PATH differs from the first writer's;
		// only the identity says it is the same directory.
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
		const hitsBefore = overrideOf(auditDirOf(vault))?.hits ?? 0;

		await w.appendEvent({ kind: "k", actor: "a", data: {} });

		// Control: the append's key WAS the reused identity (the old claim's key).
		expect(overrideOf(auditDirOf(vault))?.hits).toBeGreaterThan(hitsBefore);
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
		// Control: B's acquire really was keyed by the shared identity.
		expect(overrideOf(auditDirOf(vaultB))?.hits).toBeGreaterThan(0);
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

describe("#195 r4: a claim is verified in the directory itself, at its physical path", () => {
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
