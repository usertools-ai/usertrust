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
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
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
//
// The lock file APPEARS COMPLETE. Its content is written and fsync'd to a private temp file, which
// is then hard-linked to the lock's name: `link` fails with EEXIST when the name is taken, so it is
// the exclusive create, and the name never exists without its full content. (An exclusive create
// followed by a write left a window in which another process read the lock empty, judged it
// corrupt, and unlinked a LIVE writer's lock.) A filesystem without hard links cannot host a vault's
// writer: the acquire fails closed rather than fall back to that window.
//
// Liveness is judged on ONE KERNEL. The lock records the writer's PID and, where they can be read,
// the kernel's boot id and the writer's PID namespace. A lock whose boot id is known and differs
// from this boot's — both known — was written before a reboot, and its PID names nothing now. A
// lock from another PID namespace cannot be probed from this one, and is held. A vault shared
// between kernels (two hosts, two VMs) is outside the model: no PID probe means anything there.

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
	/** The writer's kernel boot id, if it recorded one (see {@link thisBootId}). */
	bootId: unknown;
	/** The writer's PID namespace, if it recorded one (see {@link thisPidNamespace}). */
	pidNs: unknown;
}

/** `O_NOFOLLOW` where the platform has it (not Windows, which has no such flag). */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Read the lock file at `lockPath` — identity and content through the SAME fd, so they are one
 * file's even if the path is swapped meanwhile. `undefined` if it does not exist (it can vanish
 * between a create's EEXIST and this read).
 *
 * Every other failure THROWS — the open, the fstat, the read itself. A lock that could not be read
 * is never "a lock nobody holds": an acquire that took it for one would unlink a LIVE lock and
 * admit a second writer. Only content that WAS read and does not parse is corrupt.
 *
 * The name is never followed: a symlink at the lock's name is not a lock any writer made (each
 * links a regular file there), and the open fails (ELOOP) — so it throws, like any lock that
 * cannot be read, and is never judged by whatever it points at.
 */
function readLockFile(lockPath: string): LockFileView | undefined {
	let fd: number;
	try {
		fd = openSync(lockPath, fsConstants.O_RDONLY | O_NOFOLLOW);
	} catch (err) {
		if (hasFsCode(err, "ENOENT")) return undefined;
		throw err;
	}
	try {
		const st = fstatSync(fd, { bigint: true });
		const content = readFileSync(fd, "utf-8");
		let claim: { pid?: unknown; writerId?: unknown; bootId?: unknown; pidNs?: unknown } | undefined;
		try {
			const parsed: unknown = JSON.parse(content);
			if (parsed !== null && typeof parsed === "object") claim = parsed;
		} catch {
			/* read, but corrupt: no claim */
		}
		return {
			identity: `${st.dev}:${st.ino}`,
			pid: claim?.pid,
			writerId: claim?.writerId,
			bootId: claim?.bootId,
			pidNs: claim?.pidNs,
		};
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

// ── Whose kernel, whose namespace ──

/** A boot id as Linux writes it: a lower-case UUID. Anything else is not one this code compares. */
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A PID namespace as Linux names it: the `/proc/<pid>/ns/pid` link target. */
const PID_NS = /^pid:\[\d+\]$/;

let cachedBootId: string | undefined;
let cachedPidNs: string | undefined;

/**
 * This kernel's boot id (Linux: `/proc/sys/kernel/random/boot_id`), or `undefined` when it cannot
 * be read — not Linux, no `/proc`, or a failed read. Only a SUCCESSFUL read is cached (a boot id
 * cannot change while this process lives): a transient failure must not leave every later lock
 * this process writes, and every later judgement it makes, without a boot id for its lifetime.
 * No other platform's boot identity is read: macOS has one only through a subprocess, which would
 * sit inside every acquire; there the PID probe decides, as before.
 */
function thisBootId(): string | undefined {
	if (cachedBootId !== undefined) return cachedBootId;
	try {
		const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
		if (BOOT_ID.test(id)) cachedBootId = id;
	} catch {
		/* unknown — and not cached */
	}
	return cachedBootId;
}

/**
 * This process's PID namespace (Linux: the `/proc/self/ns/pid` link target), or `undefined` when it
 * cannot be read. Cached only once read, like {@link thisBootId}. Containers on one host share the
 * kernel — and its boot id — but `kill(pid, 0)` sees only the caller's own PID namespace, and a
 * container's writer is often PID 1 there, the same number as a writer in a sibling container.
 */
function thisPidNamespace(): string | undefined {
	if (cachedPidNs !== undefined) return cachedPidNs;
	try {
		const ns = readlinkSync("/proc/self/ns/pid");
		if (PID_NS.test(ns)) cachedPidNs = ns;
	} catch {
		/* unknown — and not cached */
	}
	return cachedPidNs;
}

/**
 * Was this lock written before this boot? ONLY when the lock carries a boot id, this process can
 * read its own, and the two differ EXACTLY. An unknown boot id on either side is never a verdict
 * (fail toward live): the PID judgement decides, as it did before boot ids were recorded. Never a
 * time estimate — an uptime-derived boot time moves with every wall-clock step, and a step would
 * reclaim a LIVE writer's lock.
 */
function writtenBeforeThisBoot(lock: LockFileView): boolean {
	if (typeof lock.bootId !== "string" || !BOOT_ID.test(lock.bootId)) return false;
	const now = thisBootId();
	return now !== undefined && lock.bootId !== now;
}

/**
 * How the lock's PID namespace relates to this process's:
 *  - `unrecorded`: the lock names none (written before namespaces were recorded, or where they
 *    cannot be read) — the PID is judged as before;
 *  - `same`: both are known and equal — the PID means the same process here;
 *  - `foreign`: both are known and differ — this process cannot probe that PID;
 *  - `unknown`: the lock names one, and this process cannot read its own (or the lock's is not a
 *    namespace) — it cannot tell, and fails toward live.
 */
function namespaceOf(lock: LockFileView): "unrecorded" | "same" | "foreign" | "unknown" {
	if (lock.pidNs === undefined) return "unrecorded";
	const now = thisPidNamespace();
	if (now === undefined || typeof lock.pidNs !== "string" || !PID_NS.test(lock.pidNs)) {
		return "unknown";
	}
	return lock.pidNs === now ? "same" : "foreign";
}

/** The lock's content: who holds it, and — where they can be read — on which boot and namespace. */
function lockContentFor(writerId: string): string {
	const bootId = thisBootId();
	const pidNs = thisPidNamespace();
	return JSON.stringify({
		pid: process.pid,
		writerId,
		startedAt: new Date().toISOString(),
		...(bootId === undefined ? {} : { bootId }),
		...(pidNs === undefined ? {} : { pidNs }),
	});
}

/**
 * Remove a lock file that no live writer in this process holds (the caller has established that,
 * from a successful read). Throws if a live process (another PID) holds it.
 *
 * In order: the same PID in the same namespace (or a lock that names none) is a crashed earlier
 * instance of this PID. Anything else is another process's lock: reclaimed if it was written
 * before this boot (exact boot ids, both known); HELD if its namespace is another one, or cannot
 * be compared; otherwise judged by `kill(pid, 0)`, as before.
 */
function tryCleanStaleLock(lockPath: string, lock: LockFileView): void {
	const { pid } = lock;
	const namespace = namespaceOf(lock);
	try {
		if (pid === process.pid && (namespace === "same" || namespace === "unrecorded")) {
			// Same PID, and no live writer in this process holds the file (see liveHolderOf): a
			// crashed earlier instance of this PID — a container's PID 1 is the usual one — or a
			// copy of a lock. Nothing in this process can be appending under it.
			console.warn(
				`[AUDIT] Reclaiming stale same-PID lock (PID ${process.pid}). Previous process exited without releasing the lock.`,
			);
			unlinkSync(lockPath);
			return;
		}
		if (writtenBeforeThisBoot(lock)) {
			// Its PID was recorded before this boot and names no process of this one — whatever
			// process carries that number now. The boot ids are validated UUIDs: safe to print.
			console.warn(
				`[AUDIT] Reclaiming a lock written before this boot (PID ${String(pid)}, boot ${String(lock.bootId)}; this boot ${String(thisBootId())}).`,
			);
			unlinkSync(lockPath);
			return;
		}
		if (namespace === "foreign" || namespace === "unknown") {
			throw new AuditWriterLockHeldError(
				namespace === "foreign"
					? `Audit writer lock held by PID ${String(pid)} in another PID namespace (${String(lock.pidNs)}). This process cannot probe that namespace, so the lock is never reclaimed from here; remove the lock file by hand only once that writer is gone. Lock file: ${lockPath}`
					: `Audit writer lock held by PID ${String(pid)} in a PID namespace this process cannot compare with its own. The lock is never reclaimed from here; remove the lock file by hand only once that writer is gone. Lock file: ${lockPath}`,
			);
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
 * A lock's private temp file, `<lock>.<writerId>.tmp` in the lock's own directory. Only the exact
 * name `.audit-writer.lock` is ever read as a lock: a temp file — complete, half-written, or left
 * by a writer that crashed — never is.
 */
const LOCK_TEMP_NAME =
	/^\.audit-writer\.lock\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/**
 * How old a temp file must be before {@link sweepLeftoverTemps} removes it. A live create holds its
 * temp file for a few syscalls; this is far longer. The age is only ever a HOUSEKEEPING judgement,
 * never a lock's: removing a live creator's temp file can only fail that create (its link meets
 * ENOENT), never admit a second writer.
 */
const LEFTOVER_TEMP_AGE_MS = 60_000;

/** `link` answers these where the filesystem cannot make a hard link (FAT/exFAT, some network and FUSE mounts). */
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"]);

/** Remove a temp file, if it is there. Never throws: an unremoved temp file is never read as a lock. */
function removeTemp(tmp: string): void {
	try {
		unlinkSync(tmp);
	} catch {
		/* gone already, or left for the sweep */
	}
}

/**
 * Write `content` to the private temp file `tmp` — created exclusively, never through a symlink,
 * written in full and fsync'd — and return its `dev:ino`, read through the create's own fd. On any
 * failure the temp file is removed and the error thrown.
 *
 * A temp file already at `tmp` is this writer's own leftover: the name carries the writer's random
 * id, and one writer never takes two locks at once (every acquire is synchronous). It is removed
 * and the create made afresh.
 */
function writeLockTemp(tmp: string, content: string): string {
	const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW;
	let fd: number;
	try {
		fd = openSync(tmp, flags, 0o600);
	} catch (err) {
		if (!hasFsCode(err, "EEXIST")) throw err;
		unlinkSync(tmp);
		fd = openSync(tmp, flags, 0o600);
	}
	try {
		try {
			const st = fstatSync(fd, { bigint: true });
			writeFully(fd, content);
			fsyncSync(fd);
			return `${st.dev}:${st.ino}`;
		} finally {
			closeSync(fd);
		}
	} catch (err) {
		removeTemp(tmp);
		throw err;
	}
}

/**
 * Fsync `dir`, so the lock's link (and its temp file's removal) reach the disk. Best effort, as
 * the spend ledger's directory fsync is: a platform that cannot fsync a directory is silent, and
 * any other failure is reported and does not fail the acquire. Nothing depends on the lock
 * surviving a power loss — every writer that held it dies with that boot.
 */
function syncDirectory(dir: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(dir, fsConstants.O_RDONLY);
		fsyncSync(fd);
	} catch (err) {
		const code = errorCode(err);
		const unsupported =
			code === "EINVAL" ||
			code === "ENOTSUP" ||
			code === "EOPNOTSUPP" ||
			code === "EISDIR" ||
			code === "EPERM" ||
			code === "EBADF";
		if (!unsupported) {
			console.warn(
				`[AUDIT] Audit writer lock directory not fsynced (${code ?? "unknown error"}); the lock is held regardless.`,
			);
		}
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* a directory fd: nothing was written through it */
			}
		}
	}
}

/**
 * Remove temp files that crashed writers left in `dir` (a writer that died between its temp file's
 * create and its removal leaves one behind, one per crash). Run by a writer that has just taken
 * the lock, so they cannot accumulate without bound. Only names of the temp-file form, only once
 * older than {@link LEFTOVER_TEMP_AGE_MS}; `lstat` and `unlink` never follow a symlink. Best
 * effort: a temp file that cannot be judged or removed is left for a later sweep.
 */
function sweepLeftoverTemps(dir: string): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	const now = Date.now();
	for (const name of names) {
		if (!LOCK_TEMP_NAME.test(name)) continue;
		const path = join(dir, name);
		try {
			const st = lstatSync(path);
			if (st.isDirectory() || now - st.mtimeMs < LEFTOVER_TEMP_AGE_MS) continue;
			unlinkSync(path);
		} catch {
			/* gone, or not removable now: a later sweep tries again */
		}
	}
}

/**
 * The lock file's exclusive create. On success the lock is this writer's: recorded in
 * {@link heldLocks} and `true` returned. `false` means the lock file exists (EEXIST).
 *
 * The lock APPEARS COMPLETE: its content is written in full and fsync'd to a private temp file
 * ({@link writeLockTemp}), which is then hard-linked to the lock's name. `link` never replaces an
 * existing name — it fails with EEXIST — so it is the atomic exclusive create, and two processes
 * that both found a lock stale and both removed it cannot both take it. And no reader ever finds
 * the lock's name with no content, or half of it: an exclusive create followed by a write left
 * exactly that window, and a reader that judged the empty lock corrupt removed a LIVE writer's lock.
 * `link` does not follow a symlink at the lock's name; a name that is taken is taken. This link,
 * at a PATH, is the ONLY cross-process exclusion.
 *
 * A filesystem that cannot make a hard link fails the acquire, closed: falling back to the exclusive
 * create and write would bring that window back, and a forked chain is worse than a writer that
 * cannot start. The error keeps `link`'s code.
 *
 * The identity is read through the temp file's create fd — the link gives the lock that very inode
 * — so it is the file THIS create made, never one swapped in after it. The temp file is removed
 * on every path, success included.
 *
 * Registered only after EVERYTHING succeeded. A failure after the link throws with nothing
 * registered — an owner registered by an acquire that threw could never be released (the caller
 * gets no writer, and a scoped lock never reaches its release) and would refuse this vault in this
 * process for good — and removes the lock the link made, if it is still that file (its inode AND
 * this writer's id: an inode alone is reused on Linux), so no lock is left behind for other
 * processes either.
 */
function createLock(lockPath: string, lockContent: string, writerId: string): boolean {
	const tmp = `${lockPath}.${writerId}.tmp`;
	const identity = writeLockTemp(tmp, lockContent);
	try {
		linkSync(tmp, lockPath);
	} catch (err) {
		removeTemp(tmp);
		if (hasFsCode(err, "EEXIST")) return false;
		const code = errorCode(err);
		if (code !== undefined && LINK_UNSUPPORTED.has(code)) {
			throw Object.assign(
				new Error(
					`Audit writer lock cannot be created: link() failed with ${code}, so this filesystem cannot make the hard link the lock is created with. A vault's audit directory must be on a filesystem with hard links (see LIMITATIONS.md). Lock file: ${lockPath}`,
					{ cause: err },
				),
				{ code },
			);
		}
		throw err;
	}
	removeTemp(tmp);
	syncDirectory(dirname(lockPath));
	// The link succeeded — but WHERE? The directory can be replaced between the temp file's create
	// and now, and then the lock this create made sits in the old directory while the requested one
	// has none (or another writer's). Success is reported only if the file at the requested path is
	// the one this create made: its inode AND this writer's id, read through one fd.
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
 * that cannot be read is left — unregistered, a same-PID lock nobody here holds. (Like every
 * check-then-unlink by path here, this has a window if the directory itself is replaced
 * concurrently: see the threat model at the top of this section.)
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
 * Is `file` — the lock file at `lockPath` — this writer's own? Then remember where it is NOW: the
 * directory may have been renamed since this writer last saw it (and the caller's symlink
 * repointed), and release must reach it.
 */
function verifyOwnLockFile(file: LockFileView, lockPath: string, writerId: string): boolean {
	const holder = liveHolderOf(file);
	if (holder?.writerId !== writerId) return false;
	holder.lock.path = lockPath;
	return true;
}

/** {@link verifyOwnLockFile} on a fresh read of `lockPath`; a read that fails throws. */
function verifyOwnLock(lockPath: string, writerId: string): boolean {
	const file = readLockFile(lockPath);
	return file !== undefined && verifyOwnLockFile(file, lockPath, writerId);
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

	// A writer that already holds a lock first looks for it here, so its every append does not
	// create (and fsync) a temp file only to meet EEXIST. The same decision from the same read the
	// create's EEXIST would lead to: the file carries this writer's id and inode, so it is this
	// writer's. Anything else falls through to the create.
	if (heldLocks.has(writerId) && verifyOwnLock(lockPath, writerId)) return false;

	const lockContent = lockContentFor(writerId);
	if (createLock(lockPath, lockContent, writerId)) {
		sweepLeftoverTemps(dir);
		return true;
	}

	// The lock file exists. Whose it is, the file says — and a read that fails throws out of here.
	const file = readLockFile(lockPath);
	if (file !== undefined && verifyOwnLockFile(file, lockPath, writerId)) return false;
	const holder = file === undefined ? undefined : liveHolderOf(file);
	if (holder !== undefined) {
		// A LIVE writer in this process holds this vault → refuse.
		throw new AuditWriterLockHeldError(
			`Audit writer lock held by another writer in this process (dir ${dir}). Only one writer per vault per process.`,
		);
	}

	// Read, and no live writer in this process holds it: stale, or another process's. (Gone
	// since the EEXIST: nothing to clean.)
	if (file !== undefined) tryCleanStaleLock(lockPath, file);

	// Second attempt after stale lock cleanup. If another process raced us and
	// already re-created the lock, EEXIST here means they won — report as held.
	if (createLock(lockPath, lockContent, writerId)) {
		sweepLeftoverTemps(dir);
		return true;
	}
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

	const content = readFileSync(logPath, "utf-8").trim();
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

			const fd = openSync(logPath, "a");
			try {
				writeSync(fd, `${persisted}\n`);
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
			const metaPath = `${logPath}.meta`;
			const metaFd = openSync(metaPath, "w");
			try {
				writeSync(metaFd, JSON.stringify({ lastHash: hash, sequence }));
				fsyncSync(metaFd);
			} finally {
				closeSync(metaFd);
			}

			return fullEvent;
		} catch (err) {
			degraded = true;
			writeFailures++;
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
