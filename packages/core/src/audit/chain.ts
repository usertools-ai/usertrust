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
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
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

/**
 * Check if a lock file is stale (held by a dead process).
 * Returns true if stale and cleaned up, false if held by a live process.
 * Throws if the lock is actively held.
 */
function tryCleanStaleLock(candidateLockPath: string, dir: string): boolean {
	try {
		const content = readFileSync(candidateLockPath, "utf-8");
		const lockData = JSON.parse(content) as { pid: number };
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
			throw new Error(
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
					throw new Error(
						`Audit writer lock held by PID ${lockData.pid}. Only one process may write to the audit log. Lock file: ${candidateLockPath}`,
					);
				}
			}
			throw killErr;
		}
	} catch (parseErr) {
		if (parseErr instanceof Error && parseErr.message.includes("Audit writer lock held")) {
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

function acquireProcessLock(
	logPath: string,
	locksByDir: Map<string, LockEntry>,
	writerId: string,
): void {
	const dir = dirname(logPath);
	if (locksByDir.has(dir)) return;

	// AUD-471: A live writer already holds this dir in THIS process → refuse.
	// The advisory lock guarantees exactly one writer per vault per process;
	// reclaiming a live sibling's lock (same-PID) would fork the chain because
	// each writer keeps an independent tail cache.
	if (inProcessLockOwners.has(dir)) {
		throw new Error(
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
	});

	// First attempt: atomic exclusive create
	try {
		const fd = openSync(
			candidateLockPath,
			fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
			0o600,
		);
		try {
			writeSync(fd, lockContent);
			fsyncSync(fd);
		} finally {
			// AUD-459: Close fd immediately — lock semantics rely on file existence, not open fd
			closeSync(fd);
		}
		locksByDir.set(dir, { path: candidateLockPath, writerId });
		inProcessLockOwners.set(dir, writerId);
		return;
	} catch (err: unknown) {
		if (!(err instanceof Error && "code" in err && (err as { code?: string }).code === "EEXIST")) {
			throw err;
		}
		// File exists — check if stale
	}

	// Lock file exists — check if it's stale and clean up if so
	tryCleanStaleLock(candidateLockPath, dir);

	// Second attempt after stale lock cleanup. If another process raced us and
	// already re-created the lock, EEXIST here means they won — report as held.
	try {
		const fd = openSync(
			candidateLockPath,
			fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
			0o600,
		);
		try {
			writeSync(fd, lockContent);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		locksByDir.set(dir, { path: candidateLockPath, writerId });
		inProcessLockOwners.set(dir, writerId);
	} catch (retryErr: unknown) {
		if (
			retryErr instanceof Error &&
			"code" in retryErr &&
			(retryErr as { code?: string }).code === "EEXIST"
		) {
			throw new Error(
				`Audit writer lock acquired by another process during stale lock cleanup. Lock file: ${candidateLockPath}`,
			);
		}
		throw retryErr;
	}
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
export function createAuditWriter(vaultPath: string): AuditWriter {
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
