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
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
 * The lock a LIVE writer in this process holds. Both fields are fixed at that lock's exclusive
 * create and kept in memory; neither is ever re-derived from what a directory looks like later.
 */
interface HeldLock {
	/** `dev:ino` of the lock FILE, read through the fd of its exclusive create. */
	lockIdentity: string;
	/**
	 * Where the lock file was last SEEN: its physical path (the realpath of its directory) at the
	 * create, refreshed by every acquire that verifies it. Never the caller's spelling — a symlink
	 * alias can be removed or retargeted while the lock is held. Refreshed because the directory
	 * can also be RENAMED while held, the lock file moving with it; see {@link releaseLock}.
	 */
	path: string;
}

/**
 * writerId → the lock that writer holds, for every LIVE writer in this process (#195 r5).
 *
 * This is the ONLY thing that can make a lock file "a live writer's in this process": the file
 * carries a writerId, and it is live iff that writerId is held here AND the file is the very inode
 * that writer's exclusive create made. A same-PID lock file that is not — a crashed earlier
 * instance of this PID, a recycled PID, a copy — is reclaimable; one that is, is refused
 * (AUD-471: reclaiming a live sibling's lock forks the chain, each writer caching its own tail).
 *
 * Deliberately NOT keyed by the directory. r3/r4 keyed it by the directory's `(dev, ino)` and then
 * had to re-verify every hit, because a directory's identity can be stale by the time it is used:
 * a directory replaced between its lookup and the lock's create registered the new lock under the
 * old directory's key, so a second same-process writer missed it and reclaimed the LIVE lock
 * (#195 r5 P1). The lock file itself is the thing held, and it says who holds it.
 *
 * A writer's entry is replaced when it creates a new lock, and removed only by its release. A writer
 * dropped without `release()` therefore keeps its lock for the life of the process — this process
 * cannot prove the writer is gone (a reference to it may still append), so its lock is not
 * reclaimable here; another process may reclaim it once this PID is dead.
 */
const heldLocks = new Map<string, HeldLock>();

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
 * between a create's EEXIST and this read). Any other failure throws: "could not look" must never
 * read as "nobody holds it", or the caller would reclaim a live lock.
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
		let claim: { pid?: unknown; writerId?: unknown } | undefined;
		try {
			const parsed: unknown = JSON.parse(readFileSync(fd, "utf-8"));
			if (parsed !== null && typeof parsed === "object") claim = parsed;
		} catch {
			/* corrupt: no claim */
		}
		return { identity: `${st.dev}:${st.ino}`, pid: claim?.pid, writerId: claim?.writerId };
	} finally {
		closeSync(fd);
	}
}

/**
 * The live writer in this process that holds `file`, if any: the writerId it carries is held here,
 * and it is the inode that writer's create made. The writerId alone is not enough — a copy of the
 * file carries it too; the inode alone is not enough — a freed inode is reused by the next file.
 * No pid check: a file carrying a live writerId AND its create-time inode is that writer's file.
 */
function liveHolderOf(file: LockFileView): string | undefined {
	if (typeof file.writerId !== "string") return undefined;
	return heldLocks.get(file.writerId)?.lockIdentity === file.identity ? file.writerId : undefined;
}

/**
 * Remove a lock file that no live writer in this process holds (the caller has established that).
 * Throws if a live process (another PID) holds it.
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
 * AUD-458: O_WRONLY | O_CREAT | O_EXCL atomically instead of existsSync + openSync('wx'). This
 * eliminates the TOCTOU race where two processes both detect a stale lock, both unlink, and both
 * try to create — one gets EEXIST. This create, at a PATH, is the ONLY cross-process exclusion.
 *
 * The identity is read through the fd, not the path, so it is the file THIS create made, never
 * one swapped in after it. The fd is then closed (AUD-459): the identity is kept in memory, so
 * nothing needs the fd held open.
 */
function createLock(lockPath: string, lockContent: string, writerId: string): boolean {
	let fd: number;
	try {
		fd = openSync(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
	} catch (err) {
		if (hasFsCode(err, "EEXIST")) return false;
		throw err;
	}
	try {
		writeSync(fd, lockContent);
		fsyncSync(fd);
		const st = fstatSync(fd, { bigint: true });
		heldLocks.set(writerId, { lockIdentity: `${st.dev}:${st.ino}`, path: lockPath });
		return true;
	} finally {
		// AUD-459: Close fd immediately — lock semantics rely on file existence, not open fd
		closeSync(fd);
	}
}

/**
 * Take (or confirm) the vault's advisory lock. Returns `true` when a lock file was CREATED by this
 * call, `false` when the writer's existing lock was verified still held. A writer whose earlier
 * lock turned out to be gone gets `true` here: its lock was lost for a while, someone else may
 * have appended in that time, and any cached chain tail it holds must not be trusted.
 *
 * Every decision is made from the lock FILE in the requested directory — whose it is, read from
 * the file — never from a directory's identity or a remembered path (#195 r5).
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

	// The lock file exists. Whose it is, the file says.
	const file = readLockFile(lockPath);
	const holder = file === undefined ? undefined : liveHolderOf(file);
	if (holder === writerId) {
		// Ours. The directory may have been renamed since this writer last saw the lock (and the
		// caller's symlink repointed): remember where it is NOW, so release reaches it.
		(heldLocks.get(writerId) as HeldLock).path = lockPath;
		return false;
	}
	if (holder !== undefined) {
		// AUD-471: a LIVE writer in this process holds this vault → refuse.
		throw new AuditWriterLockHeldError(
			`Audit writer lock held by another writer in this process (dir ${dir}). Only one writer per vault per process.`,
		);
	}

	// No live writer in this process holds it: stale, or another process's.
	tryCleanStaleLock(lockPath, file?.pid);

	// Second attempt after stale lock cleanup. If another process raced us and
	// already re-created the lock, EEXIST here means they won — report as held.
	if (createLock(lockPath, lockContent, writerId)) return true;
	throw new AuditWriterLockHeldError(
		`Audit writer lock acquired by another process during stale lock cleanup. Lock file: ${lockPath}`,
	);
}

/**
 * Release `writerId`'s lock: unlink the lock file only if it is still THIS writer's (its writerId
 * and its create-time inode). Once it is not, the file at that path belongs to whoever took the
 * lock since — unlinking it would free a LIVE writer's lock for a third writer. If the file cannot
 * be checked, leave it: a left-behind lock naming this PID or a dead one is reclaimable; an
 * unlinked live one is a fork.
 *
 * Looked for where it was last seen, then where the caller's spelling leads NOW: a vault renamed
 * while its lock was held (its symlink repointed to the new name) takes the lock file with it,
 * and a writer with no acquire since — a scoped lock above all — never saw it move. Neither place
 * is trusted: the file found must be this writer's.
 */
function releaseLock(writerId: string, logPath: string): void {
	const held = heldLocks.get(writerId);
	if (held === undefined) return;
	try {
		const candidates = [held.path];
		try {
			candidates.push(join(realpathSync(dirname(logPath)), LOCK_FILE_NAME));
		} catch {
			/* the caller's spelling no longer leads anywhere */
		}
		for (const candidate of candidates) {
			let ours = false;
			try {
				const file = readLockFile(candidate);
				ours = file !== undefined && liveHolderOf(file) === writerId;
			} catch {
				/* cannot tell — leave the file */
			}
			if (ours) {
				try {
					unlinkSync(candidate);
				} catch {
					/* already removed */
				}
				return;
			}
		}
	} finally {
		// Clear the live-writer registration so a subsequent same-process writer
		// (or a snapshot restore via withAuditWriterLock) can acquire the vault.
		heldLocks.delete(writerId);
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
	const writerId = randomUUID();
	acquireProcessLock(logPath, writerId);
	try {
		return await fn();
	} finally {
		releaseLock(writerId, logPath);
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
		releaseLock(writerId, logPath);
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
