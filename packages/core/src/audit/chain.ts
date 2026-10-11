// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Audit Chain Writer — SHA-256 hash-chained JSONL
 *
 * Appends audit events to a JSONL log where each event's hash covers
 * the previous event's hash, creating a tamper-evident chain. Single-writer
 * semantics are enforced via advisory file lock + in-process async mutex.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { GENESIS_HASH, VAULT_DIR } from "../shared/constants.js";
import type { AuditEvent } from "../shared/types.js";
import { canonicalize } from "./canonical.js";

// ── Durable writes ──

/**
 * Write EVERY byte of `data`, or throw (#194). `writeSync` may write fewer bytes than asked (a
 * nearly full disk, a signal); ignoring its count reported a partial line as appended and durable —
 * a torn tail with a durability claim on it. A write that makes no progress throws.
 */
function writeFully(fd: number, data: string): void {
	const buf = Buffer.from(data, "utf-8");
	let off = 0;
	while (off < buf.length) {
		const n = writeSync(fd, buf, off, buf.length - off);
		if (n <= 0) {
			throw new Error(`audit write made no progress (${off} of ${buf.length} bytes written)`);
		}
		off += n;
	}
}

/**
 * Replace the `.meta` head anchor ATOMICALLY: written and fsync'd to a private temp file, then
 * renamed over the anchor, then the directory is fsync'd. Rewriting it in place (open "w" truncates
 * first) left an EMPTY or half-written anchor after a crash mid-write — one that reads as corrupt
 * and refuses every append and verification. Now the anchor is always the old one or the new one.
 */
export function writeAnchorAtomically(metaPath: string, content: string): void {
	const tmp = `${metaPath}.${randomUUID()}.tmp`;
	const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
	try {
		try {
			writeFully(fd, content);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, metaPath);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			/* renamed, or never created */
		}
		throw err;
	}
	// The parent-directory fsync makes the RENAME durable. Only an UNSUPPORTED directory fsync
	// (EINVAL/ENOTSUP/EOPNOTSUPP/EISDIR) is best effort; a genuine failure (EIO, …) propagates into
	// appendEvent's degraded-append / durable-hash contract instead of reporting a durable anchor a
	// crash could roll back.
	let dfd: number | undefined;
	try {
		dfd = openSync(dirname(metaPath), "r");
		fsyncSync(dfd);
	} catch (err) {
		if (!isUnsupportedDirSync(err)) throw err;
	} finally {
		if (dfd !== undefined) closeSync(dfd);
	}
}

/** A directory fsync the platform does not support — the only directory-sync error that is best effort. */
export function isUnsupportedDirSync(err: unknown): boolean {
	const code = errorCode(err);
	return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EISDIR";
}

/**
 * The log ends in a TORN line — bytes after its last newline, from an append that never
 * completed. Nothing is appended after it: the new line would be concatenated onto the torn
 * bytes, burying them mid-file. `usertrust audit quarantine-tail` moves a torn tail aside,
 * recorded on the chain.
 */
export class AuditTornTailError extends Error {
	constructor(logPath: string, bytes: number) {
		super(
			`Audit log ${logPath} ends in a torn line (${bytes} byte(s) after its last newline). Refusing to append. Run \`usertrust audit quarantine-tail\` to move it aside, recorded on the chain.`,
		);
		this.name = "AuditTornTailError";
	}
}

// ── Types ──

export interface AppendEventInput {
	kind: string;
	actor: string;
	data: Record<string, unknown>;
}

/**
 * Where a PARTIALLY-successful append records the hash of the event that did
 * land durably in `events.jsonl`.
 *
 * `appendEvent` writes the log, fsyncs it, and only then writes the `.meta`
 * sidecar. A sidecar failure therefore rejects for an event that IS on the
 * chain — and a caller told only "it failed" throws away the correlation handle
 * for a record an auditor can still read. The hash rides out on the rejection
 * so that caller can recover it.
 *
 * A SYMBOL, not a string key: invisible to `JSON.stringify`, `Object.keys` and
 * any log line that serialises the error, and impossible to collide with a
 * field some other layer sets.
 */
const DURABLE_EVENT_HASH = Symbol.for("usertrust.audit.durableEventHash");

/**
 * Recover the hash of an event that reached the log before the append failed.
 * `undefined` means nothing durable was written — the ordinary total failure.
 */
export function readDurableEventHash(err: unknown): string | undefined {
	if (err === null || typeof err !== "object") return undefined;
	const value = (err as Record<symbol, unknown>)[DURABLE_EVENT_HASH];
	return typeof value === "string" ? value : undefined;
}

export interface AuditWriter {
	appendEvent(input: AppendEventInput): Promise<AuditEvent>;
	getWriteFailures(): number;
	isDegraded(): boolean;
	flush(): Promise<void>;
	/**
	 * Release every advisory lock this writer holds and reset its state. Every lock is attempted;
	 * one that could not be released (its file could not be read, or its unlink failed) is left in
	 * place, and after the last one an {@link AuditLockReleaseError} naming each is thrown. (`destroy()`
	 * never rejects for it: see {@link releaseAuditWriterForTeardown}.)
	 */
	release(): void;
}

/**
 * The audit writer's advisory lock for a vault is held by another LIVE writer — another
 * process, or another writer in this process. Only one writer may append to a vault's chain.
 * A subclass of `Error` with the same message as before, so existing `catch` blocks and
 * message checks behave as they did.
 */
export class AuditWriterLockHeldError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuditWriterLockHeldError";
	}
}

/** The `code` of an error, if it carries a string one (an `errno` code such as `EIO`). */
function errorCode(err: unknown): string | undefined {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

/**
 * `release()` left one or more lock files in place: each could not be read, or its unlink failed.
 * Every lock was attempted. A lock left behind keeps other processes off that vault until this
 * process exits. `errors` holds one error per lock (its `cause` is the filesystem error); `left`
 * lists each lock's path and that error's code — the message carries only those, never an
 * underlying message.
 */
export class AuditLockReleaseError extends AggregateError {
	readonly left: ReadonlyArray<{ path: string; code: string | undefined }>;
	constructor(failures: ReadonlyArray<{ path: string; error: unknown }>) {
		const left = failures.map((f) => ({ path: f.path, code: errorCode(f.error) }));
		super(
			failures.map(
				(f) => new Error(`Audit writer lock ${f.path} could not be released`, { cause: f.error }),
			),
			`Audit writer lock release left ${left.length} lock file(s) in place: ${left
				.map((l) => `${l.path} (${l.code ?? "unknown error"})`)
				.join("; ")}`,
		);
		this.name = "AuditLockReleaseError";
		this.left = left;
	}
}

/**
 * Untrusted text (a vault path) in a human-facing warning: C0, DEL and C1 become `?`, as
 * `scrubForError` does in `audit/verify.ts` — a crafted directory name must not drive the terminal
 * that prints the warning (C1 holds the 8-bit CSI/OSC introducers). Only the PRINTED text is
 * scrubbed: an error's data (`AuditLockReleaseError.left`) keeps the real path, which a substitution
 * would corrupt.
 */
function scrubForWarning(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? "?" : ch;
	}
	return out;
}

/** The `process.emitWarning` code under which a teardown reports an audit lock left behind. */
export const AUDIT_LOCK_LEFT_WARNING = "USERTRUST_AUDIT_LOCK_LEFT";

/**
 * Release `audit` for a teardown that must NEVER reject — `destroy()` on `trust()` and
 * `createGovernor`. Callers routinely call those without await or catch, and an unhandled rejection
 * kills the process: a stranded lock is a liveness problem (other processes wait until this one
 * exits), not a reason to crash. A failed release is therefore reported, not thrown: as a process
 * warning with the stable code {@link AUDIT_LOCK_LEFT_WARNING}, and on `console.warn`. The report
 * names each lock path left behind and its error code — nothing else from the error — scrubbed
 * for the terminal.
 */
export function releaseAuditWriterForTeardown(audit: AuditWriter): void {
	try {
		audit.release();
	} catch (err) {
		const message = describeReleaseFailure(err);
		console.warn(`[AUDIT] ${message}`);
		process.emitWarning(message, { code: AUDIT_LOCK_LEFT_WARNING });
	}
}

/**
 * A release failure, as ONE line fit for a terminal: each lock path left behind and its error code
 * (or, for an unexpected error, only its kind and code — never its message), scrubbed. Never the
 * error object itself: printing that prints its message and every nested error unscrubbed.
 */
function describeReleaseFailure(err: unknown): string {
	return scrubForWarning(
		err instanceof AuditLockReleaseError
			? err.message
			: `Audit writer release failed (${err instanceof Error ? err.name : typeof err}${
					errorCode(err) === undefined ? "" : `: ${errorCode(err)}`
				}); its lock may be left in place.`,
	);
}

export interface CreateAuditWriterOptions {
	/**
	 * Take the vault's advisory lock NOW, in the factory, instead of at the first append.
	 * A second writer (another process, or another live writer in this process) then fails
	 * HERE with {@link AuditWriterLockHeldError} — before its caller does anything that
	 * assumes it is the one writer. Default `false`: the lock is taken at the first append,
	 * exactly as before.
	 */
	lockAtCreate?: boolean;
}

// ── AsyncMutex ──

/**
 * In-process async mutex for serializing audit writes.
 *
 * SINGLE-PROCESS CONSTRAINT: This mutex is process-local (in-memory).
 * It guarantees sequential writes within a single Node.js process but
 * provides NO protection across multiple processes.
 */
class AsyncMutex {
	private queue: Promise<void> = Promise.resolve();

	async acquire(): Promise<() => void> {
		let release: (() => void) | undefined;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const prev = this.queue;
		this.queue = next;
		await prev;
		return release as () => void;
	}
}

// ── Advisory Lock ──
//
// THREAT MODEL. This lock prevents ACCIDENTAL concurrent writers: two processes, or two writers in
// one process, appending to one vault's chain — which would fork it, each writer caching its own
// tail. It is not a defence against an adversary on the host. Anyone who can rename or recreate
// the audit directory can already write the chain directly, so pathname races under a CONCURRENT
// directory replacement are out of scope. They cannot be closed here: Node has no atomic,
// inode-bound unlink, so every check-then-unlink by path — stale-lock cleanup, release, and the
// rollback of a create that will not be reported — has a window in which the directory can be
// swapped under it. What IS checked narrows the window without closing it: an acquire reports
// success only if, after its create, the requested path holds the very file that create made; a
// replacement after that check is out of scope like the rest. A kernel advisory lock held on an
// open fd (flock/fcntl) would remove the dependence on pathnames altogether (see issue #288).
// Holding a file descriptor open for the writer's lifetime was rejected earlier because the lock's
// semantics are the lock file's EXISTENCE at its path; an open fd adds no exclusion by itself,
// only together with such a kernel lock.

const LOCK_FILE_NAME = ".audit-writer.lock";

/** One lock a live writer holds; keyed in {@link heldLocks} by the lock FILE's `dev:ino`. */
interface HeldLock {
	/**
	 * Where the lock file was last SEEN: its physical path (the realpath of its directory) at the
	 * create, refreshed by every acquire that verifies it. Never the caller's spelling — a symlink
	 * alias can be removed or retargeted while the lock is held. Refreshed because the directory
	 * can also be RENAMED while held, the lock file moving with it; see {@link releaseLocks}.
	 */
	path: string;
}

/**
 * writerId → (lock-file `dev:ino` → {@link HeldLock}): every lock every LIVE writer in this process
 * holds (#195). The identity is read through the fd of the lock's exclusive create and kept here;
 * it is never re-derived from what a directory looks like later.
 *
 * This is the ONLY thing that can make a lock file "a live writer's in this process": the file
 * carries a writerId, and it is live iff that writer holds the file's own inode here. A same-PID
 * lock file that is not — a crashed earlier instance of this PID, a recycled PID, a copy — is
 * reclaimable; one that is, is refused (reclaiming a live sibling's lock forks the chain,
 * each writer caching its own tail).
 *
 * Deliberately NOT keyed by the directory. Keyed by the directory's `(dev, ino)`, every hit had to
 * be re-verified, because a directory's identity can be stale by the time it is used: a directory
 * replaced between its lookup and the lock's create registered the new lock under the old
 * directory's key, so a second same-process writer missed it and reclaimed the LIVE lock. The lock
 * file itself is the thing held, and it says who holds it.
 *
 * A writer can hold SEVERAL locks: its vault path may be a symlink retargeted to another vault
 * between appends, and the lock it took on the first vault is still its own to release.
 *
 * A lock is registered only once its create has fully succeeded, and a writer's locks leave only
 * through its release. A writer dropped without `release()` therefore keeps its locks for the life
 * of the process — this process cannot prove the writer is gone (a reference to it may still
 * append), so its locks are not reclaimable here; another process may reclaim them once this PID
 * is dead.
 */
const heldLocks = new Map<string, Map<string, HeldLock>>();

function hasFsCode(err: unknown, code: string): boolean {
	return err instanceof Error && (err as { code?: string }).code === code;
}

/** One read of an existing lock file: its identity and the claim it carries, from ONE fd. */
interface LockFileView {
	identity: string;
	/** `undefined` when the content is not a JSON object (a corrupt file). */
	pid: unknown;
	writerId: unknown;
}

/**
 * Read the lock file at `lockPath` — identity and content through the SAME fd, so they are one
 * file's even if the path is swapped meanwhile. `undefined` if it does not exist (it can vanish
 * between a create's EEXIST and this read).
 *
 * Every other failure THROWS — the open, the fstat, the read itself. A lock that could not be read
 * is never "a lock nobody holds": an acquire that took it for one would unlink a LIVE lock and
 * admit a second writer. Only content that WAS read and does not parse is corrupt.
 */
function readLockFile(lockPath: string): LockFileView | undefined {
	let fd: number;
	try {
		fd = openSync(lockPath, fsConstants.O_RDONLY);
	} catch (err) {
		if (hasFsCode(err, "ENOENT")) return undefined;
		throw err;
	}
	try {
		const st = fstatSync(fd, { bigint: true });
		const content = readFileSync(fd, "utf-8");
		let claim: { pid?: unknown; writerId?: unknown } | undefined;
		try {
			const parsed: unknown = JSON.parse(content);
			if (parsed !== null && typeof parsed === "object") claim = parsed;
		} catch {
			/* read, but corrupt: no claim */
		}
		return { identity: `${st.dev}:${st.ino}`, pid: claim?.pid, writerId: claim?.writerId };
	} finally {
		closeSync(fd);
	}
}

/**
 * The live writer in this process that holds `file`, with its record of that lock — if any: the
 * writerId the file carries holds the file's own inode. The writerId alone is not enough — a copy
 * of the file carries it too; the inode alone is not enough — a freed inode is reused by the next
 * file. No pid check: a file carrying a live writerId AND an inode that writer created is that
 * writer's file.
 */
function liveHolderOf(file: LockFileView): { writerId: string; lock: HeldLock } | undefined {
	if (typeof file.writerId !== "string") return undefined;
	const lock = heldLocks.get(file.writerId)?.get(file.identity);
	return lock === undefined ? undefined : { writerId: file.writerId, lock };
}

/**
 * Remove a lock file that no live writer in this process holds (the caller has established that,
 * from a successful read). Throws if a live process (another PID) holds it.
 */
function tryCleanStaleLock(lockPath: string, pid: unknown): void {
	try {
		if (pid === process.pid) {
			// Same PID, and no live writer in this process holds the file (see liveHolderOf): a
			// crashed earlier instance of this PID — a container's PID 1 is the usual one — or a
			// copy of a lock. Nothing in this process can be appending under it.
			console.warn(
				`[AUDIT] Reclaiming stale same-PID lock (PID ${process.pid}). Previous process exited without releasing the lock.`,
			);
			unlinkSync(lockPath);
			return;
		}
		try {
			process.kill(pid as number, 0);
			// Process is alive — lock is held
			throw new AuditWriterLockHeldError(
				`Audit writer lock held by PID ${pid}. Only one process may write to the audit log. Lock file: ${lockPath}`,
			);
		} catch (killErr: unknown) {
			if (hasFsCode(killErr, "ESRCH")) {
				// Process is dead — stale lock
				unlinkSync(lockPath);
				return;
			}
			if (hasFsCode(killErr, "EPERM")) {
				throw new AuditWriterLockHeldError(
					`Audit writer lock held by PID ${pid}. Only one process may write to the audit log. Lock file: ${lockPath}`,
				);
			}
			throw killErr;
		}
	} catch (err) {
		if (err instanceof AuditWriterLockHeldError) {
			throw err;
		}
		// Corrupt lock file (no usable pid), or already gone — remove it
		try {
			unlinkSync(lockPath);
		} catch {
			/* best effort */
		}
	}
}

/**
 * The lock file's exclusive create. On success the lock is this writer's: recorded in
 * {@link heldLocks} and `true` returned. `false` means the file exists (EEXIST).
 *
 * O_WRONLY | O_CREAT | O_EXCL atomically instead of existsSync + openSync('wx'). This
 * eliminates the TOCTOU race where two processes both detect a stale lock, both unlink, and both
 * try to create — one gets EEXIST. This create, at a PATH, is the ONLY cross-process exclusion.
 *
 * The identity is read through the fd, not the path, so it is the file THIS create made, never
 * one swapped in after it. The fd is then closed: the identity is kept in memory, so
 * nothing needs the fd held open.
 *
 * Registered only after EVERYTHING succeeded, the close included. A failure after the create
 * throws with nothing registered — an owner registered by an acquire that threw could never be
 * released (the caller gets no writer, and a scoped lock never reaches its release) and would
 * refuse this vault in this process for good — and removes the file the create made, if it is
 * still that file (its inode AND this writer's id: an inode alone is reused on Linux), so no lock
 * is left behind for other processes either.
 */
function createLock(lockPath: string, lockContent: string, writerId: string): boolean {
	let fd: number;
	try {
		fd = openSync(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
	} catch (err) {
		if (hasFsCode(err, "EEXIST")) return false;
		throw err;
	}
	let identity: string | undefined;
	try {
		try {
			const st = fstatSync(fd, { bigint: true });
			identity = `${st.dev}:${st.ino}`;
			writeFully(fd, lockContent);
			fsyncSync(fd);
		} finally {
			// Close fd immediately — lock semantics rely on file existence, not open fd
			closeSync(fd);
		}
	} catch (err) {
		if (identity !== undefined) rollBackCreate(lockPath, identity, writerId);
		throw err;
	}
	// The create succeeded — but succeeded WHERE? The directory can be replaced between the open
	// and now, and then the file this create made sits in the old directory while the requested one
	// has no lock. Success is reported only if the file at the requested path is the one this
	// create made: its inode AND this writer's id, read through one fd.
	let there: LockFileView | undefined;
	try {
		there = readLockFile(lockPath);
	} catch (err) {
		rollBackCreate(lockPath, identity, writerId);
		throw err;
	}
	if (there?.identity !== identity || there.writerId !== writerId) {
		throw new AuditWriterLockHeldError(
			`Audit writer lock not taken: the lock file at ${lockPath} is not the one this writer just created — its directory was replaced while the lock was being taken. Only one writer may append to the audit log; retry once the vault is stable.`,
		);
	}
	let mine = heldLocks.get(writerId);
	if (mine === undefined) {
		mine = new Map();
		heldLocks.set(writerId, mine);
	}
	mine.set(identity, { path: lockPath });
	return true;
}

/**
 * Undo a create that will not be reported: unlink the file at `lockPath` if it is still the one
 * the create made — its inode AND this writer's id. The inode ALONE is not this file: once it is
 * unlinked, Linux (ext4) hands the freed inode to the very next file created, so a lock another
 * writer put here in the meantime can carry it, and unlinking that would free a LIVE lock. A file
 * whose content never fully landed fails the check and is left — unregistered, a same-PID lock
 * nobody here holds. (Like every check-then-unlink by path here, this has a window if the
 * directory itself is replaced concurrently: see the threat model at the top of this section.)
 */
function rollBackCreate(lockPath: string, identity: string, writerId: string): void {
	try {
		const file = readLockFile(lockPath);
		if (file?.identity === identity && file.writerId === writerId) unlinkSync(lockPath);
	} catch {
		/* cannot tell: leave it — unregistered, it is a same-PID lock nobody here holds */
	}
}

/**
 * Take (or confirm) the vault's advisory lock. Returns `true` when a lock file was CREATED by this
 * call, `false` when the writer's existing lock was verified still held. A writer whose earlier
 * lock turned out to be gone gets `true` here: its lock was lost for a while, someone else may
 * have appended in that time, and any cached chain tail it holds must not be trusted.
 *
 * Every decision is made from the lock FILE in the requested directory — whose it is, read from
 * the file — never from a directory's identity or a remembered path. A lock file that cannot be
 * read makes this THROW: it is never reclaimed.
 */
function acquireProcessLock(logPath: string, writerId: string): boolean {
	// The physical spelling (the JS realpath: lstat + readlink, no /proc — never `.native`, which
	// needs /proc on musl). An absent directory throws ENOENT here, before anything is created
	// (#182.1).
	const dir = realpathSync(dirname(logPath));
	const lockPath = join(dir, LOCK_FILE_NAME);
	const lockContent = JSON.stringify({
		pid: process.pid,
		writerId,
		startedAt: new Date().toISOString(),
	});

	if (createLock(lockPath, lockContent, writerId)) return true;

	// The lock file exists. Whose it is, the file says — and a read that fails throws out of here.
	const file = readLockFile(lockPath);
	const holder = file === undefined ? undefined : liveHolderOf(file);
	if (holder?.writerId === writerId) {
		// Ours. The directory may have been renamed since this writer last saw the lock (and the
		// caller's symlink repointed): remember where it is NOW, so release reaches it.
		holder.lock.path = lockPath;
		return false;
	}
	if (holder !== undefined) {
		// A LIVE writer in this process holds this vault → refuse.
		throw new AuditWriterLockHeldError(
			`Audit writer lock held by another writer in this process (dir ${dir}). Only one writer per vault per process.`,
		);
	}

	// Read, and no live writer in this process holds it: stale, or another process's.
	tryCleanStaleLock(lockPath, file?.pid);

	// Second attempt after stale lock cleanup. If another process raced us and
	// already re-created the lock, EEXIST here means they won — report as held.
	if (createLock(lockPath, lockContent, writerId)) return true;
	throw new AuditWriterLockHeldError(
		`Audit writer lock acquired by another process during stale lock cleanup. Lock file: ${lockPath}`,
	);
}

/**
 * Release EVERY lock `writerId` holds. Each is unlinked only if the file is still that lock (the
 * writerId and the create-time inode). Once it is not, the file at that path belongs to whoever
 * took the lock since — unlinking it would free a LIVE writer's lock for a third writer.
 *
 * Each lock is looked for where it was last seen, then where the caller's spelling leads NOW: a
 * vault renamed while its lock was held (its symlink repointed to the new name) takes the lock
 * file with it, and a writer with no acquire since — a scoped lock above all — never saw it move.
 * Neither place is trusted: the file found must be this lock.
 *
 * Every lock is attempted, whatever happens to one of them. A lock that could not be READ, or whose
 * unlink failed, is left in place and REPORTED: after the last lock, one {@link AuditLockReleaseError} lists each
 * left behind. A left-behind lock stops other processes until this PID exits; this process reclaims
 * it only after reading it successfully.
 *
 * The writer is deregistered in any case — it is done writing, and keeping it registered would
 * refuse its vaults in this process for good.
 */
function releaseLocks(writerId: string, logPath: string): void {
	const held = heldLocks.get(writerId);
	if (held === undefined) return;
	heldLocks.delete(writerId);
	let spelled: string | undefined;
	try {
		spelled = join(realpathSync(dirname(logPath)), LOCK_FILE_NAME);
	} catch {
		/* the caller's spelling no longer leads anywhere */
	}
	const failures: Array<{ path: string; error: unknown }> = [];
	for (const [identity, lock] of held) {
		// Each place is looked at once: a read that just failed is not retried as if it were news.
		const candidates =
			spelled === undefined || spelled === lock.path ? [lock.path] : [lock.path, spelled];
		// Where each failure happened: the lock is reported where it was actually found to fail —
		// after a rename, that is the new place, not the path the lock was last seen at.
		const problems: Array<{ path: string; error: unknown }> = [];
		let released = false;
		for (const candidate of candidates) {
			try {
				const file = readLockFile(candidate);
				if (file?.writerId !== writerId || file.identity !== identity) continue;
				unlinkSync(candidate);
				released = true;
			} catch (err) {
				// The unlink losing a race to another remover: the lock is gone, which is the point.
				if (hasFsCode(err, "ENOENT")) released = true;
				else problems.push({ path: candidate, error: err });
			}
			if (released) break;
		}
		const failed = problems[0];
		if (!released && failed !== undefined) failures.push(failed);
	}
	if (failures.length > 0) throw new AuditLockReleaseError(failures);
}

/**
 * Run `fn` while holding the audit writer's advisory lock for the vault whose
 * audit log is `logPath`. Acquires the same in-process live-writer registration
 * + on-disk lock that {@link createAuditWriter} uses, so a live writer on the
 * same vault in this process is refused. Use this to mutate the audit log
 * outside the writer (e.g. snapshot restore) without risking a forked chain.
 *
 * The lock is always released, even if `fn` throws. A lock that could not be released rejects
 * with an {@link AuditLockReleaseError} naming it — unless `fn` threw: then `fn`'s error is the rejection,
 * unchanged, and the release failure is reported to `console.error` beside it.
 */
export async function withAuditWriterLock<T>(
	logPath: string,
	fn: () => Promise<T> | T,
): Promise<T> {
	const writerId = randomUUID();
	acquireProcessLock(logPath, writerId);
	let result: T;
	try {
		result = await fn();
	} catch (fnErr) {
		try {
			releaseLocks(writerId, logPath);
		} catch (releaseErr) {
			// One scrubbed line, never the error object: its message and nested errors carry the
			// lock's path raw, and a directory name can carry terminal escapes.
			console.error(
				`[AUDIT] Audit writer lock release failed after an error in the locked section: ${describeReleaseFailure(releaseErr)}`,
			);
		}
		throw fnErr;
	}
	releaseLocks(writerId, logPath);
	return result;
}

// ── Last Event Cache ──

interface CachedTail {
	hash: string;
	sequence: number;
}

function getLastEvent(logPath: string, cache: Map<string, CachedTail>): CachedTail | null {
	const cached = cache.get(logPath);
	if (cached) return cached;

	if (!existsSync(logPath)) return null;

	const raw = readFileSync(logPath, "utf-8");
	// A log whose last byte is not a newline ends in a TORN line (#194). Appending would
	// concatenate onto it; refuse, and let the operator quarantine it (recorded on the chain).
	if (raw.length > 0 && !raw.endsWith("\n")) {
		throw new AuditTornTailError(logPath, Buffer.byteLength(raw.slice(raw.lastIndexOf("\n") + 1)));
	}
	const content = raw.trim();
	if (!content) {
		const metaPath = `${logPath}.meta`;
		if (existsSync(metaPath)) {
			try {
				const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
					lastHash: string;
					sequence: number;
				};
				return { hash: meta.lastHash, sequence: meta.sequence };
			} catch {
				/* ignore corrupt meta */
			}
		}
		return null;
	}

	const lines = content.split("\n");
	const lastLine = lines[lines.length - 1];
	if (!lastLine) return null;

	try {
		const event = JSON.parse(lastLine) as AuditEvent & { sequence?: number };
		const sequence = typeof event.sequence === "number" ? event.sequence : lines.length;
		const tail: CachedTail = { hash: event.hash, sequence };
		cache.set(logPath, tail);
		return tail;
	} catch {
		const metaPath = `${logPath}.meta`;
		if (existsSync(metaPath)) {
			try {
				const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
					lastHash: string;
					sequence: number;
				};
				return { hash: meta.lastHash, sequence: meta.sequence };
			} catch {
				/* ignore corrupt meta */
			}
		}
		return null;
	}
}

// ── DLQ Writer ──

function writeDeadLetter(
	vaultPath: string,
	entry: {
		source: string;
		transferId?: string;
		payload: unknown;
		error: string;
		timestamp: string;
		checksum?: string;
		checksumAlg?: string;
	},
): void {
	try {
		const dlqDir = join(vaultPath, VAULT_DIR, "dlq");
		if (!existsSync(dlqDir)) {
			mkdirSync(dlqDir, { recursive: true, mode: 0o700 });
		}

		// F3: best-effort corruption-detection checksum — NOT
		// tamper-evidence. Any key readable by this writer is readable by an
		// attacker with the same host access, so a keyed MAC here would only
		// imply integrity it cannot provide (the old HMAC key was derived from
		// the vault path — forgeable from public inputs). Tamper-evidence for
		// audit data lives in the hash chain + external anchoring.
		let checksumSource: string;
		try {
			checksumSource = canonicalize(entry);
		} catch {
			// canonicalize throws on NaN/Infinity — but a payload carrying NaN
			// is exactly the kind of failure a dead letter must still record.
			// JSON.stringify coerces them to null (the pre-checksum behavior);
			// the entry must be persisted, never dropped.
			checksumSource = JSON.stringify(entry);
		}
		const checksum = createHash("sha256").update(checksumSource).digest("hex");
		const sealed = { ...entry, checksum, checksumAlg: "sha256" };

		const dlqPath = join(dlqDir, "dead-letters.jsonl");
		const fd = openSync(dlqPath, "a", 0o600);
		try {
			writeSync(fd, `${JSON.stringify(sealed)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		// DLQ write failure — last resort, cannot do anything else
		console.error("[AUDIT] Dead-letter write failed", entry);
	}
}

// ── Factory ──

/**
 * Create an audit writer instance for the given vault path.
 *
 * The writer appends events to `<vaultPath>/.usertrust/audit/events.jsonl`.
 * Each event's SHA-256 hash covers the previous event's hash, creating a
 * tamper-evident chain. The first event chains from GENESIS_HASH.
 */
export function createAuditWriter(
	vaultPath: string,
	options: CreateAuditWriterOptions = {},
): AuditWriter {
	const auditDir = join(vaultPath, VAULT_DIR, "audit");
	if (!existsSync(auditDir)) {
		mkdirSync(auditDir, { recursive: true });
	}
	const logPath = join(auditDir, "events.jsonl");

	const writerId = randomUUID();
	const mutex = new AsyncMutex();
	const lastEventCache = new Map<string, CachedTail>();
	let degraded = false;
	let writeFailures = 0;
	// Eager: a second writer fails HERE. The append's own acquire then only verifies this
	// writer's lock (the file carries this writer's id and inode) and creates nothing.
	if (options.lockAtCreate === true) acquireProcessLock(logPath, writerId);

	async function appendEvent(input: AppendEventInput): Promise<AuditEvent> {
		const release = await mutex.acquire();
		// Set ONLY once the log bytes are fsync'd. Everything after that point can
		// still throw (the sidecar above all), and the event is on the chain
		// regardless — see DURABLE_EVENT_HASH.
		let durableHash: string | undefined;
		try {
			// A lock created by THIS call means this writer did not hold it a moment ago (first
			// append, or its earlier lock was found stale), and another writer may have appended
			// meanwhile. Its cached tail is then not the chain's tail: chaining from it forks.
			if (acquireProcessLock(logPath, writerId)) lastEventCache.clear();

			const last = getLastEvent(logPath, lastEventCache);
			const previousHash = last?.hash ?? GENESIS_HASH;
			const sequence = (last?.sequence ?? 0) + 1;

			const event: Omit<AuditEvent, "hash"> & { sequence: number } = {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash,
				kind: input.kind,
				actor: input.actor,
				data: input.data,
				sequence,
			};

			const canonical = canonicalize(event);
			let snapshot: Record<string, unknown>;
			try {
				snapshot = JSON.parse(canonical) as Record<string, unknown>;
			} catch {
				throw new Error("appendEvent: canonical bytes are not JSON");
			}
			// Refuse drift: the hashed bytes must be what we would persist
			// for the event (minus hash). A Date#toISOString that returns an
			// object is valid JSON in insertion order; re-canonicalizing
			// sorts it. Hash the first snapshot only if it is idempotent.
			const normalized = canonicalize(snapshot);
			if (normalized !== canonical) {
				throw new Error("appendEvent: canonical snapshot is not idempotent");
			}
			const hash = createHash("sha256").update(canonical).digest("hex");
			const persisted = canonicalize({ ...snapshot, hash });
			const fullEvent = snapshot as unknown as AuditEvent & { sequence: number };
			fullEvent.hash = hash;

			// O_NOFOLLOW: an append never writes THROUGH a symlinked log into a file outside the
			// vault. Mode as `openSync(path, "a")` created it (0o666 & ~umask).
			const fd = openSync(
				logPath,
				fsConstants.O_WRONLY |
					fsConstants.O_APPEND |
					fsConstants.O_CREAT |
					(fsConstants.O_NOFOLLOW ?? 0),
				0o666,
			);
			try {
				writeFully(fd, `${persisted}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			lastEventCache.set(logPath, { hash, sequence });
			// The bytes are fsync'd: this event is on the chain even if the sidecar
			// write below throws. Deliberately set AFTER `closeSync` has run, so a
			// close that itself fails leaves this unset — under-claiming durability
			// is the safe direction here.
			durableHash = hash;

			// Persist last hash to sidecar for cross-segment chain continuity
			writeAnchorAtomically(`${logPath}.meta`, JSON.stringify({ lastHash: hash, sequence }));

			return fullEvent;
		} catch (err) {
			degraded = true;
			writeFailures++;
			// The cached tail may no longer be the log's tail (a partial write): the next append
			// re-reads the log, and refuses a torn one.
			lastEventCache.delete(logPath);
			if (durableHash !== undefined && err !== null && typeof err === "object") {
				Object.defineProperty(err, DURABLE_EVENT_HASH, {
					value: durableHash,
					enumerable: false,
					writable: false,
					configurable: true,
				});
			}
			console.warn("[AUDIT] Audit trail degraded — write failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			writeDeadLetter(vaultPath, {
				source: "audit.chain.appendEvent",
				payload: input,
				error: err instanceof Error ? err.message : String(err),
				timestamp: new Date().toISOString(),
			});
			throw err;
		} finally {
			release();
		}
	}

	function getWriteFailures(): number {
		return writeFailures;
	}

	function isDegradedFn(): boolean {
		return degraded;
	}

	async function flush(): Promise<void> {
		const release = await mutex.acquire();
		release();
	}

	function releaseWriter(): void {
		lastEventCache.clear();
		degraded = false;
		writeFailures = 0;
		// Last: it throws (AuditLockReleaseError) if a lock was left in place — after every lock was tried.
		releaseLocks(writerId, logPath);
	}

	return {
		appendEvent,
		getWriteFailures,
		isDegraded: isDegradedFn,
		flush,
		release: releaseWriter,
	};
}
