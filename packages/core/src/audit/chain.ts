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
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GENESIS_HASH, VAULT_DIR } from "../shared/constants.js";
import type { AuditEvent } from "../shared/types.js";
import { canonicalize } from "./canonical.js";

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

const LOCK_FILE_NAME = ".audit-writer.lock";

/**
 * One lock this process holds, recorded so that a later registry hit can be VERIFIED rather than
 * trusted (#195 r3). The registry key is a directory's inode identity, and an inode number is
 * reused once its directory is deleted — so `key` alone cannot say whether this entry still
 * describes the directory now behind that key. `lockIdentity` + `writerId` can: see
 * {@link lockStillHeld}.
 */
interface LockEntry {
	/** The lock file, at the spelling of the directory it was created through. */
	path: string;
	writerId: string;
	/** The registry key ({@link dirIdentity} of the audit directory) this entry is stored under. */
	key: string;
	/** `dev:ino` of the lock FILE, read from the fd of its exclusive create. */
	lockIdentity: string;
}

/**
 * Dirs currently locked by a LIVE writer in THIS process → dirIdentity → that writer's entry.
 *
 * A same-PID lock file is only safe to reclaim when NO live writer in this
 * process owns the dir (i.e. the lock is from a crashed prior instance or a
 * recycled PID). This registry is what distinguishes a crashed writer from a
 * live sibling — reclaiming a live sibling's lock would fork the chain, which
 * is exactly the vulnerability the advisory lock exists to prevent.
 *
 * It holds the whole entry, not just the writerId, so a sibling's claim can be checked against
 * its lock file before it refuses anyone: an entry whose lock file is gone (its directory was
 * deleted, and a new directory now has the same inode) is stale, not a live sibling.
 */
const inProcessLockOwners = new Map<string, LockEntry>();

function hasFsCode(err: unknown, code: string): boolean {
	return err instanceof Error && (err as { code?: string }).code === code;
}

/**
 * Check if a lock file is stale (held by a dead process).
 * Returns true if stale and cleaned up, false if held by a live process.
 * Throws if the lock is actively held.
 */
function tryCleanStaleLock(candidateLockPath: string, key: string): boolean {
	try {
		const content = readFileSync(candidateLockPath, "utf-8");
		const lockData = JSON.parse(content) as { pid: number };
		if (lockData.pid === process.pid && !inProcessLockOwners.has(key)) {
			// Same PID but no live writer registered for this dir → the lock is
			// from a crashed prior instance (the registry is cleared on release,
			// and a stale entry is dropped before we get here) or a recycled PID.
			// A live sibling is caught earlier by the verified registry guard in
			// acquireProcessLock, which throws before we ever get here.
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
			if (killErr instanceof Error && "code" in killErr) {
				const code = (killErr as { code?: string }).code;
				if (code === "ESRCH") {
					// Process is dead — stale lock
					unlinkSync(candidateLockPath);
					return true;
				}
				if (code === "EPERM") {
					throw new AuditWriterLockHeldError(
						`Audit writer lock held by PID ${lockData.pid}. Only one process may write to the audit log. Lock file: ${candidateLockPath}`,
					);
				}
			}
			throw killErr;
		}
	} catch (parseErr) {
		if (parseErr instanceof AuditWriterLockHeldError) {
			throw parseErr;
		}
		// Corrupt lock file — remove it
		try {
			unlinkSync(candidateLockPath);
		} catch {
			/* best effort */
		}
		return true;
	}
}

/**
 * The in-process registry KEY for a vault's audit directory: its IDENTITY, `(st_dev, st_ino)`,
 * never a spelling (#195 r3). Every spelling of one directory — a relative path, a symlink,
 * macOS's /tmp → /private/tmp, a case variant on a case-insensitive volume — must be ONE key, or
 * a second writer in this process misses the first writer's entry, meets EEXIST, and "reclaims"
 * the LIVE same-PID lock as stale: two live writers, a silently forked chain (AUD-471's class).
 * A path spelling cannot give that guarantee everywhere — the JS realpath keeps the caller's
 * case, and realpath(3) fails on musl without /proc — but every spelling stats to the same inode
 * pair. bigint stat: an ino or dev past 2^53 cannot round into a collision.
 *
 * An absent directory throws ENOENT HERE, before any lock is created, exactly as the lock file's
 * open would (#182.1). There is deliberately no fallback key: a key invented for a directory that
 * another process creates in the window between this call and the open could differ from a live
 * writer's key, miss its registration, and "reclaim" its lock.
 *
 * The key is IN-PROCESS ONLY, which is why inode numbers that are unstable across remounts or
 * reported differently on network and overlay filesystems do not weaken anything: exclusion
 * BETWEEN processes is the lock file's O_EXCL create at a PATH, which never consults this key.
 * All the key must do is name one live directory the same way for every spelling, inside one
 * process. Once that directory is deleted its inode can be reused by a new directory, so a
 * registry hit is never trusted on the key alone — see {@link lockStillHeld}.
 */
function dirIdentity(dir: string): string {
	const st = statSync(dir, { bigint: true });
	return `${st.dev}:${st.ino}`;
}

/**
 * Is `entry`'s lock file still the one THIS entry created (key-and-verify)? A registry entry is a
 * claim about a directory identity, and identities are recycled: delete a vault directory and a
 * new one can get the same `(dev, ino)`. Trusted on the key alone, `locksByDir`'s hit would let a
 * writer append to the new directory while it holds NO lock file there — beside another process
 * that took the lock legitimately: a cross-process fork. So the claim is checked against what only
 * the lock's creator can have: the file at the path it created, with the inode its exclusive
 * create got, still naming its writerId. (The writerId closes the double reuse — the directory's
 * inode AND then the lock file's inode recycled, which filesystems that reuse freed inodes
 * promptly make plausible — that the inode check alone cannot see.)
 *
 * Absent (ENOENT/ENOTDIR) or not this entry's file → false: the claim is stale. Any OTHER failure
 * to look throws — "could not look" must never read as "it is gone", or the caller would reclaim
 * a live sibling's lock.
 */
function lockStillHeld(entry: LockEntry): boolean {
	let holder: unknown;
	try {
		const st = lstatSync(entry.path, { bigint: true });
		if (`${st.dev}:${st.ino}` !== entry.lockIdentity) return false;
		holder = JSON.parse(readFileSync(entry.path, "utf-8"));
	} catch (err) {
		if (hasFsCode(err, "ENOENT") || hasFsCode(err, "ENOTDIR")) return false;
		// Unparseable: not the content this entry wrote and fsync'd before registering.
		if (err instanceof SyntaxError) return false;
		throw err;
	}
	const claim = holder as { pid?: unknown; writerId?: unknown } | null;
	return claim?.pid === process.pid && claim.writerId === entry.writerId;
}

/**
 * The lock file's exclusive create; returns the new file's `dev:ino`.
 *
 * AUD-458: O_WRONLY | O_CREAT | O_EXCL atomically instead of existsSync + openSync('wx'). This
 * eliminates the TOCTOU race where two processes both detect a stale lock, both unlink, and both
 * try to create — one gets EEXIST. This create, at a PATH, is the ONLY cross-process exclusion.
 *
 * The identity is read through the fd, not the path, so it is the file THIS create made, never
 * one swapped in after it.
 */
function createLockFile(lockPath: string, lockContent: string): string {
	const fd = openSync(
		lockPath,
		fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
		0o600,
	);
	try {
		writeSync(fd, lockContent);
		fsyncSync(fd);
		const st = fstatSync(fd, { bigint: true });
		return `${st.dev}:${st.ino}`;
	} finally {
		// AUD-459: Close fd immediately — lock semantics rely on file existence, not open fd
		closeSync(fd);
	}
}

function registerLock(
	locksByDir: Map<string, LockEntry>,
	key: string,
	lockPath: string,
	writerId: string,
	lockIdentity: string,
): void {
	const entry: LockEntry = { path: lockPath, writerId, key, lockIdentity };
	locksByDir.set(key, entry);
	inProcessLockOwners.set(key, entry);
}

/**
 * Take (or confirm) the vault's advisory lock. Returns `true` when a lock file was CREATED by this
 * call, `false` when the writer's existing lock was verified still held. A writer whose earlier
 * lock turned out stale gets `true` here: its lock was lost for a while, someone else may have
 * appended in that time, and any cached chain tail it holds must not be trusted.
 */
function acquireProcessLock(
	logPath: string,
	locksByDir: Map<string, LockEntry>,
	writerId: string,
): boolean {
	// The PATH names the lock file and needs no canonical spelling: any spelling of one directory
	// reaches the same file. The KEY must be canonical, so it is the directory's identity. This
	// stat also throws ENOENT for an absent directory before anything is created (#182.1).
	// `resolve` is string-only (no I/O, no symlinks followed): it just pins a relative spelling to
	// today's cwd, so the stored lock path still names this file at release after a chdir.
	const dir = resolve(dirname(logPath));
	const key = dirIdentity(dir);

	const mine = locksByDir.get(key);
	if (mine !== undefined) {
		if (lockStillHeld(mine)) return false;
		// Stale: the lock file this writer created is gone or replaced (its directory was deleted
		// and this key now names a new one, or the file was removed). Drop the claim and acquire
		// afresh — never keep appending on a lock that no longer exists.
		locksByDir.delete(key);
		if (inProcessLockOwners.get(key)?.writerId === mine.writerId) {
			inProcessLockOwners.delete(key);
		}
	}

	// AUD-471: A live writer already holds this dir in THIS process → refuse.
	// The advisory lock guarantees exactly one writer per vault per process;
	// reclaiming a live sibling's lock (same-PID) would fork the chain because
	// each writer keeps an independent tail cache. "Live" is verified, not assumed:
	// an owner whose lock file is gone is a stale identity (see lockStillHeld).
	const owner = inProcessLockOwners.get(key);
	if (owner !== undefined) {
		if (lockStillHeld(owner)) {
			throw new AuditWriterLockHeldError(
				`Audit writer lock held by another writer in this process (dir ${dir}). Only one writer per vault per process.`,
			);
		}
		// The owner's own `locksByDir` still holds the claim; it fails the same check on that
		// writer's next acquire and re-acquires (or is refused) then.
		inProcessLockOwners.delete(key);
	}

	const candidateLockPath = join(dir, LOCK_FILE_NAME);
	const lockContent = JSON.stringify({
		pid: process.pid,
		writerId,
		startedAt: new Date().toISOString(),
	});

	// First attempt: atomic exclusive create
	try {
		registerLock(
			locksByDir,
			key,
			candidateLockPath,
			writerId,
			createLockFile(candidateLockPath, lockContent),
		);
		return true;
	} catch (err: unknown) {
		if (!hasFsCode(err, "EEXIST")) {
			throw err;
		}
		// File exists — check if stale
	}

	// Lock file exists — check if it's stale and clean up if so
	tryCleanStaleLock(candidateLockPath, key);

	// Second attempt after stale lock cleanup. If another process raced us and
	// already re-created the lock, EEXIST here means they won — report as held.
	try {
		registerLock(
			locksByDir,
			key,
			candidateLockPath,
			writerId,
			createLockFile(candidateLockPath, lockContent),
		);
		return true;
	} catch (retryErr: unknown) {
		if (hasFsCode(retryErr, "EEXIST")) {
			throw new AuditWriterLockHeldError(
				`Audit writer lock acquired by another process during stale lock cleanup. Lock file: ${candidateLockPath}`,
			);
		}
		throw retryErr;
	}
}

// AUD-459: fd is closed immediately after writing PID content.
// releaseLocks only needs to unlink the file — no fd to close.
function releaseLocks(locksByDir: Map<string, LockEntry>): void {
	// By the STORED key and path only: the directory may already be deleted, so it is never
	// re-stat'ed here. Only the lock file is looked at.
	for (const [key, lock] of locksByDir) {
		// Unlink only a lock file that is still THIS entry's. Once the entry is stale, the file at
		// its path (if any) belongs to whoever took the lock since — unlinking it would free a
		// LIVE writer's lock for a third writer. If the file cannot be checked, leave it: a
		// left-behind lock naming this PID or a dead one is reclaimable; an unlinked live one is a
		// fork.
		let ours = false;
		try {
			ours = lockStillHeld(lock);
		} catch {
			/* cannot tell — leave the file */
		}
		if (ours) {
			try {
				unlinkSync(lock.path);
			} catch {
				/* already removed */
			}
		}
		// Clear the live-writer registration so a subsequent same-process writer
		// (or a snapshot restore via withAuditWriterLock) can acquire the dir.
		if (inProcessLockOwners.get(key)?.writerId === lock.writerId) {
			inProcessLockOwners.delete(key);
		}
		locksByDir.delete(key);
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
	// Eager: a second writer fails HERE. The append's own acquire then only verifies this
	// writer's lock (it is already in `locksByDir`) and creates nothing.
	if (options.lockAtCreate === true) acquireProcessLock(logPath, locksByDir, writerId);

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
			if (acquireProcessLock(logPath, locksByDir, writerId)) lastEventCache.clear();

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
