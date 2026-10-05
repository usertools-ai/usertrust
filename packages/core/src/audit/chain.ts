// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Audit Chain Writer — SHA-256 hash-chained JSONL
 *
 * Appends audit events to a JSONL log where each event's hash covers
 * the previous event's hash, creating a tamper-evident chain. Single-writer
 * semantics are enforced via advisory file lock + in-process async mutex.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	constants as fsConstants,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { uptime } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GENESIS_HASH, VAULT_DIR } from "../shared/constants.js";
import type { AuditEvent } from "../shared/types.js";
import { canonicalize } from "./canonical.js";

// ── Durable writes ──

/**
 * Write EVERY byte of `data`, or throw (#194.1). `writeSync` may write fewer bytes than asked
 * (a nearly full disk, a signal); ignoring its count reported a partial line as appended and
 * durable — a torn tail with a durability claim on it. A write that makes no progress throws.
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
 * renamed over the anchor. Rewriting it in place (open "w" truncates first) left an EMPTY or
 * half-written anchor after a crash mid-write — one that reads as corrupt and refuses every
 * append and verification. Now the anchor is always the old one or the new one.
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
	// crash could roll back (#196 r2 P2).
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
	const code = err instanceof Error && "code" in err ? (err as { code?: string }).code : undefined;
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

interface LockEntry {
	path: string;
	writerId: string;
}

/**
 * Dirs currently locked by a LIVE writer in THIS process → dir → writerId.
 *
 * A same-PID lock file is only safe to reclaim when NO live writer in this
 * process owns the dir (i.e. the lock is from a crashed prior instance or a
 * recycled PID). This registry is what distinguishes a crashed writer from a
 * live sibling — reclaiming a live sibling's lock would fork the chain, which
 * is exactly the vulnerability the advisory lock exists to prevent.
 */
const inProcessLockOwners = new Map<string, string>();

/** Pause the thread for `ms` (the lock path is synchronous end to end). */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** How long a lock may stay incomplete before it reads as abandoned rather than mid-write. */
const INCOMPLETE_LOCK_GRACE_MS = 60_000;

/**
 * What a lock file says, classified POSITIVELY — every state its bytes can be in:
 *  - `gone`: it no longer exists (its holder released it);
 *  - `parsed`: a JSON object with a numeric `pid`;
 *  - `incomplete`: empty, or a JSON object cut short (a writer mid-write, from a version that
 *    created the file before writing it);
 *  - `garbage`: anything else.
 */
type LockReading =
	| { kind: "gone" }
	| { kind: "parsed"; lock: { pid: number; bootId?: unknown; bootTime?: unknown } }
	| { kind: "incomplete"; mtimeMs: number }
	| { kind: "garbage" };

function readLock(path: string): LockReading {
	let content: string;
	let mtimeMs: number;
	try {
		content = readFileSync(path, "utf-8");
		mtimeMs = statSync(path).mtimeMs;
	} catch (err: unknown) {
		if (err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT") {
			return { kind: "gone" };
		}
		throw err;
	}
	try {
		const parsed = JSON.parse(content) as { pid?: unknown };
		if (parsed !== null && typeof parsed === "object" && typeof parsed.pid === "number") {
			return { kind: "parsed", lock: parsed as { pid: number } };
		}
		return { kind: "garbage" };
	} catch {
		const t = content.trim();
		return t === "" || t.startsWith("{") ? { kind: "incomplete", mtimeMs } : { kind: "garbage" };
	}
}

/**
 * Check if a lock file is stale (held by a dead process, or written in a previous boot).
 * Returns true if stale and cleaned up (or already gone). Throws AuditWriterLockHeldError if it
 * is held — including a lock that is still being WRITTEN (#194.3): an incomplete lock is
 * re-read briefly and, while it is younger than the grace, read as held, never as corrupt.
 */
function tryCleanStaleLock(candidateLockPath: string, dir: string): boolean {
	let reading = readLock(candidateLockPath);
	for (let i = 0; i < 20 && reading.kind === "incomplete"; i++) {
		sleepSync(5);
		reading = readLock(candidateLockPath);
	}
	if (reading.kind === "gone") return true;
	if (reading.kind === "incomplete") {
		if (Date.now() - reading.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
			throw new AuditWriterLockHeldError(
				`Audit writer lock is being written by another writer (incomplete). Retry. Lock file: ${candidateLockPath}`,
			);
		}
		// Incomplete for longer than any write takes: an abandoned lock.
		unlinkQuietly(candidateLockPath);
		return true;
	}
	if (reading.kind === "garbage") {
		// Corrupt lock file — remove it
		unlinkQuietly(candidateLockPath);
		return true;
	}
	const lockData = reading.lock;
	if (fromPreviousBoot(lockData)) {
		// #194.4: a PID recorded before this boot names no process of this boot.
		console.warn(
			`[AUDIT] Reclaiming a lock written in a previous boot (PID ${lockData.pid}). Lock file: ${candidateLockPath}`,
		);
		unlinkSync(candidateLockPath);
		return true;
	}
	// BEFORE the same-PID branch and the probe (#196 r2 P2): containers often run their writer as
	// PID 1, so a live writer in ANOTHER namespace can carry this process's own PID.
	if (fromForeignPidNamespace(lockData as { pidNs?: unknown })) {
		throw new AuditWriterLockHeldError(
			`Audit writer lock held by PID ${lockData.pid} in ANOTHER PID namespace (${String((lockData as { pidNs?: unknown }).pidNs)}); this process cannot probe it, so it is never reclaimed. Remove it by hand only if that writer is gone. Lock file: ${candidateLockPath}`,
		);
	}
	if (lockData.pid === process.pid && !inProcessLockOwners.has(dir)) {
		// Same PID but no live writer registered for this dir → the lock is
		// from a crashed prior instance (the registry is cleared on release)
		// or a recycled PID. A live sibling is caught earlier by the registry
		// guard in acquireProcessLock, which throws before we ever get here.
		console.warn(
			`[AUDIT] Reclaiming stale same-PID lock (PID ${process.pid}). Previous process exited without releasing the lock.`,
		);
		unlinkSync(candidateLockPath);
		return true;
	}
	try {
		process.kill(lockData.pid, 0);
		// Process is alive — lock is held
		throw new AuditWriterLockHeldError(
			`Audit writer lock held by PID ${lockData.pid}. Only one process may write to the audit log. Lock file: ${candidateLockPath}`,
		);
	} catch (killErr: unknown) {
		if (killErr instanceof AuditWriterLockHeldError) throw killErr;
		const code =
			killErr instanceof Error && "code" in killErr
				? (killErr as { code?: string }).code
				: undefined;
		if (code === "EPERM") {
			throw new AuditWriterLockHeldError(
				`Audit writer lock held by PID ${lockData.pid}. Only one process may write to the audit log. Lock file: ${candidateLockPath}`,
			);
		}
		// ESRCH: the process is dead — a stale lock. (Any other answer from the probe was
		// treated as stale before #194, and still is.)
		unlinkQuietly(candidateLockPath);
		return true;
	}
}

function unlinkQuietly(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		/* best effort */
	}
}

/**
 * The ONE spelling of a vault's audit directory every lock key uses. Two spellings of the same
 * directory (a relative path, a symlink, macOS's /tmp → /private/tmp) must be the same key, or a
 * second writer in this process misses the first writer's entry, meets EEXIST, and "reclaims"
 * the LIVE same-PID lock as stale — two live writers, a silently forked chain (AUD-471's class).
 * `resolve` only when the directory does not exist yet (nothing can hold a lock in it).
 */
function canonicalDir(dir: string): string {
	try {
		return realpathSync(dir);
	} catch (err: unknown) {
		if (err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT") {
			return resolve(dir);
		}
		throw err;
	}
}

function acquireProcessLock(
	logPath: string,
	locksByDir: Map<string, LockEntry>,
	writerId: string,
): void {
	const dir = canonicalDir(dirname(logPath));
	if (locksByDir.has(dir)) return;

	// AUD-471: A live writer already holds this dir in THIS process → refuse.
	// The advisory lock guarantees exactly one writer per vault per process;
	// reclaiming a live sibling's lock (same-PID) would fork the chain because
	// each writer keeps an independent tail cache.
	if (inProcessLockOwners.has(dir)) {
		throw new AuditWriterLockHeldError(
			`Audit writer lock held by another writer in this process (dir ${dir}). Only one writer per vault per process.`,
		);
	}

	const candidateLockPath = `${dir}/.audit-writer.lock`;

	// AUD-458: Use O_WRONLY | O_CREAT | O_EXCL atomically instead of existsSync + openSync('wx').
	// This eliminates the TOCTOU race where two processes both detect a stale lock,
	// both unlink, and both try to create — one gets EEXIST.
	const lockContent = JSON.stringify({
		pid: process.pid,
		writerId,
		startedAt: new Date().toISOString(),
		...bootIdentity(),
	});

	// First attempt: atomic exclusive create
	if (createLockAtomically(candidateLockPath, lockContent, writerId)) {
		locksByDir.set(dir, { path: candidateLockPath, writerId });
		inProcessLockOwners.set(dir, writerId);
		return;
	}
	// File exists — check if stale

	// Lock file exists — check if it's stale and clean up if so
	tryCleanStaleLock(candidateLockPath, dir);

	// Second attempt after stale lock cleanup. If another process raced us and
	// already re-created the lock, EEXIST here means they won — report as held.
	if (!createLockAtomically(candidateLockPath, lockContent, writerId)) {
		throw new AuditWriterLockHeldError(
			`Audit writer lock acquired by another process during stale lock cleanup. Lock file: ${candidateLockPath}`,
		);
	}
	locksByDir.set(dir, { path: candidateLockPath, writerId });
	inProcessLockOwners.set(dir, writerId);
}

/**
 * Create the lock file ATOMICALLY with its full content (#194.3): the content is written and
 * fsync'd to a private temp file, then hard-linked into place — `link` fails with EEXIST if the
 * lock exists, and a lock that exists is never empty or half-written (the old O_EXCL-then-write
 * left a window in which another starter read "" as corrupt and deleted a LIVE lock).
 * Returns false when the lock already exists.
 */
function createLockAtomically(lockPath: string, content: string, writerId: string): boolean {
	const tmp = `${lockPath}.${writerId}.tmp`;
	const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
	try {
		try {
			writeFully(fd, content);
			fsyncSync(fd);
		} finally {
			// AUD-459: Close fd immediately — lock semantics rely on file existence, not open fd
			closeSync(fd);
		}
		try {
			linkSync(tmp, lockPath);
			return true;
		} catch (err: unknown) {
			const code =
				err instanceof Error && "code" in err ? (err as { code?: string }).code : undefined;
			if (code === "EEXIST") return false;
			if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS") {
				// #196 r1 P3: the lock is created by hard link so it is never visible half-written.
				// Filesystems without link() (exFAT/FAT, some network and FUSE mounts) cannot host a
				// vault's writer — fail closed and say why (LIMITATIONS.md), never fall back to the racy
				// O_EXCL-then-write this replaced.
				throw new Error(
					`Audit writer lock cannot be created: this filesystem does not support hard links (${code}). A vault's audit directory must live on a filesystem with link() — see LIMITATIONS.md. Lock file: ${lockPath}`,
				);
			}
			throw err;
		}
	} finally {
		try {
			unlinkSync(tmp);
		} catch {
			/* best effort */
		}
	}
}

/**
 * This boot's identity, recorded in the lock (#194.4): a PID from a PREVIOUS boot says nothing
 * about this one — after a reboot the PID may be reused by an unrelated live process, and the
 * stale lock would read as held forever.
 *
 * ONLY an EXACT per-boot id may reclaim a lock (#196 r1 P1): Linux's
 * `/proc/sys/kernel/random/boot_id`, macOS's `sysctl kern.bootsessionuuid`. The uptime-derived
 * boot time is still recorded, for diagnosis only — it moves with every wall-clock step, and
 * reclaiming a lock on it deleted a LIVE writer's lock after a clock adjustment of more than the
 * old 30 s tolerance, forking the chain. Read once per process: a boot id cannot change while
 * this process lives.
 */
let cachedBootId: string | undefined;
function exactBootId(): string | undefined {
	if (cachedBootId !== undefined) return cachedBootId;
	let id: string | undefined;
	try {
		if (process.platform === "linux") {
			id = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim() || undefined;
		} else if (process.platform === "darwin") {
			id =
				execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
					encoding: "utf-8",
					timeout: 2_000,
					stdio: ["ignore", "pipe", "ignore"],
				}).trim() || undefined;
		}
	} catch {
		id = undefined; // unknown → the PID probe decides (never a time estimate)
	}
	// Cache only a SUCCESSFUL read (#196 r2 P3): a transient failure (a sysctl timeout under load)
	// must not leave every lock this process writes without a boot id for its whole lifetime.
	if (id !== undefined) cachedBootId = id;
	return id;
}

/**
 * This process's PID NAMESPACE (#196 r2 P2): containers on one Linux host share `boot_id`, but
 * `kill(pid, 0)` sees only the caller's own PID namespace — a writer in another container probes as
 * ESRCH (or as an unrelated process) and its LIVE lock would be reclaimed. Linux: the
 * `/proc/self/ns/pid` link target (`pid:[<inode>]`); elsewhere none (one namespace).
 */
function pidNamespace(): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const ns = readlinkSync("/proc/self/ns/pid");
		return /^pid:\[\d+\]$/.test(ns) ? ns : undefined;
	} catch {
		return undefined;
	}
}

function bootIdentity(): { bootId?: string; bootTime: number; pidNs?: string } {
	const bootId = exactBootId();
	const pidNs = pidNamespace();
	const bootTime = Math.round(Date.now() / 1000 - uptime()); // diagnostic only
	return {
		...(bootId === undefined ? {} : { bootId }),
		bootTime,
		...(pidNs === undefined ? {} : { pidNs }),
	};
}

/**
 * Was this lock written from ANOTHER PID namespace (in this boot)? Then this process's
 * `kill(pid, 0)` cannot see its writer, and the lock is HELD — never reclaimed by a probe that is
 * looking in the wrong namespace. Positive only: both sides carry a namespace and they differ.
 */
function fromForeignPidNamespace(lock: { pidNs?: unknown }): boolean {
	const now = pidNamespace();
	return typeof lock.pidNs === "string" && now !== undefined && lock.pidNs !== now;
}

/**
 * Was this lock written in a PREVIOUS boot? ONLY when the lock and this boot both carry an EXACT
 * boot id and they differ. Anything else — no id on either side, a pre-#194 lock, a boot time
 * however far off — is NOT a previous-boot verdict: the `kill(pid, 0)` probe decides, and a live
 * PID holds (a reboot-reused PID then holds too, as before #194: fail-closed, never a fork).
 */
function fromPreviousBoot(lock: { bootId?: unknown; bootTime?: unknown }): boolean {
	const now = exactBootId();
	return typeof lock.bootId === "string" && now !== undefined && lock.bootId !== now;
}

// AUD-459: fd is closed immediately after writing PID content.
// releaseLocks only needs to unlink the file — no fd to close.
function releaseLocks(locksByDir: Map<string, LockEntry>): void {
	for (const [dir, lock] of locksByDir) {
		try {
			unlinkSync(lock.path);
		} catch {
			/* already removed */
		}
		// Clear the live-writer registration so a subsequent same-process writer
		// (or a snapshot restore via withAuditWriterLock) can acquire the dir.
		if (inProcessLockOwners.get(dir) === lock.writerId) {
			inProcessLockOwners.delete(dir);
		}
		locksByDir.delete(dir);
	}
}

/**
 * Run `fn` while holding the audit writer's advisory lock for the vault whose
 * audit log is `logPath`. Acquires the same in-process live-writer registration
 * + on-disk lock that {@link createAuditWriter} uses, so a live writer on the
 * same vault in this process is refused. Use this to mutate the audit log
 * outside the writer (e.g. snapshot restore) without risking a forked chain.
 * The lock is always released, even if `fn` throws.
 */
export async function withAuditWriterLock<T>(
	logPath: string,
	fn: () => Promise<T> | T,
): Promise<T> {
	const locksByDir = new Map<string, LockEntry>();
	const writerId = randomUUID();
	acquireProcessLock(logPath, locksByDir, writerId);
	try {
		return await fn();
	} finally {
		releaseLocks(locksByDir);
	}
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
	// #194: a log whose last byte is not a newline ends in a TORN line. Appending would
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

		// AUD-469 / F3: best-effort corruption-detection checksum — NOT
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
	const locksByDir = new Map<string, LockEntry>();
	let degraded = false;
	let writeFailures = 0;
	// Eager: a second writer fails HERE. The append's own acquire is then a no-op for this
	// writer (the lock is already in `locksByDir`).
	if (options.lockAtCreate === true) acquireProcessLock(logPath, locksByDir, writerId);

	async function appendEvent(input: AppendEventInput): Promise<AuditEvent> {
		const release = await mutex.acquire();
		// Set ONLY once the log bytes are fsync'd. Everything after that point can
		// still throw (the sidecar above all), and the event is on the chain
		// regardless — see DURABLE_EVENT_HASH.
		let durableHash: string | undefined;
		try {
			acquireProcessLock(logPath, locksByDir, writerId);

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
			// vault (#196 r2 P1's class). Mode as `openSync(path, "a")` created it (0o666 & ~umask).
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
			const metaPath = `${logPath}.meta`;
			writeAnchorAtomically(metaPath, JSON.stringify({ lastHash: hash, sequence }));

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
		releaseLocks(locksByDir);
		degraded = false;
		writeFailures = 0;
	}

	return {
		appendEvent,
		getWriteFailures,
		isDegraded: isDegradedFn,
		flush,
		release: releaseWriter,
	};
}
