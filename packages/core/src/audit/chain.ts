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

// ── Byte-complete writes ──

/**
 * Write every byte of `bytes` to `fd`, looping until the buffer is drained.
 *
 * `writeSync` is allowed to return a SHORT count — it is `write(2)`, not a
 * promise to write everything — and a single unchecked call therefore silently
 * truncates a line under memory pressure, a signal, or a pipe-like fd. A
 * truncated audit line is an unparseable record: `getLastEvent` cannot read the
 * tail back, and `verifyChain` reports the vault as broken with no way to tell
 * a torn write from tampering.
 *
 * The loop takes a Buffer rather than a string on purpose: the return value
 * counts BYTES, so slicing a string by that count would cut multi-byte UTF-8
 * characters in half at exactly the moment the write went short.
 */
function writeAll(fd: number, bytes: Buffer): void {
	let offset = 0;
	while (offset < bytes.length) {
		const written = writeSync(fd, bytes, offset, bytes.length - offset);
		// A non-advancing write would spin forever. Fail loudly instead: the
		// caller's degrade-and-dead-letter path can act on a throw.
		if (written <= 0) {
			throw new Error(
				`appendEvent: write made no progress (${offset}/${bytes.length} bytes written)`,
			);
		}
		offset += written;
	}
}

// ── Per-event chain step ──

/** One event, chained, canonicalized and hashed — with no I/O performed. */
interface ChainedEvent {
	/** The event as it will be returned to the caller, `hash` included. */
	event: AuditEvent & { sequence: number };
	/** The exact bytes to persist, WITHOUT the trailing newline. */
	line: string;
	hash: string;
	sequence: number;
}

/**
 * Build the next event in the chain from `previousHash` / `sequence`.
 *
 * Split out of `appendEvent` so the flush can run this per event without the
 * per-event work drifting from what a single append used to do. The order of
 * the four steps below is load-bearing and unchanged: canonicalize, refuse
 * bytes that are not JSON, refuse a snapshot that is not idempotent, and only
 * then hash. Performs NO I/O — every throw here happens before anything is
 * written, which is what lets a caller whose build fails reject alone.
 */
function buildChainedEvent(
	input: AppendEventInput,
	previousHash: string,
	sequence: number,
): ChainedEvent {
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

	return { event: fullEvent, line: persisted, hash, sequence };
}

// ── Group commit ──

/**
 * The flush every caller who wrote during one event-loop gap shares.
 *
 * `fd` is opened by the batch's first writer and closed by its flush, so every
 * member's bytes go through ONE descriptor and one `fsyncSync` covers all of
 * them. `lastHash`/`lastSequence` track the batch's final event, which is what
 * the `.meta` sidecar records — once per flush rather than once per event.
 */
interface FlushBatch {
	fd: number;
	members: FlushMember[];
	lastHash: string;
	lastSequence: number;
	/**
	 * Resolves when the flush has finished, whether it succeeded or not — it is
	 * a completion signal for `flush()`, never a verdict. Each member carries
	 * its own outcome on its own promise, so a failed batch must not turn into
	 * a rejected `flush()`.
	 */
	done: Promise<void>;
	finish: () => void;
}

/** One caller riding a shared flush, with the event it is owed. */
interface FlushMember {
	input: AppendEventInput;
	event: AuditEvent & { sequence: number };
	hash: string;
	resolve: (event: AuditEvent) => void;
	reject: (err: unknown) => void;
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

	let pendingBatch: FlushBatch | undefined;

	/**
	 * Join the batch now accepting writes, opening one if none is.
	 *
	 * The batching window is the EVENT-LOOP GAP, not the duration of the
	 * flush: `writeSync` and `fsyncSync` block the thread, so nothing can
	 * arrive while a flush runs and a design that tries to accumulate arrivals
	 * during one batches nothing. `setImmediate` yields the rest of this turn —
	 * including the whole microtask chain by which the mutex hands off to the
	 * next caller — so everyone queued behind the mutex lands in one batch.
	 */
	function openBatch(): FlushBatch {
		const existing = pendingBatch;
		if (existing) return existing;
		const fd = openSync(logPath, "a");
		let finish: (() => void) | undefined;
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const batch: FlushBatch = {
			fd,
			members: [],
			lastHash: "",
			lastSequence: 0,
			done,
			finish: finish as () => void,
		};
		pendingBatch = batch;
		setImmediate(() => {
			runFlush(batch);
		});
		return batch;
	}

	/** Degrade bookkeeping for ONE failed event. Identical for both paths. */
	function recordFailure(input: AppendEventInput, err: unknown): void {
		degraded = true;
		writeFailures++;
		console.warn("[AUDIT] Audit trail degraded — write failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		writeDeadLetter(vaultPath, {
			source: "audit.chain.appendEvent",
			payload: input,
			error: err instanceof Error ? err.message : String(err),
			timestamp: new Date().toISOString(),
		});
	}

	function defineDurableHash(target: object, durableHash: string): void {
		Object.defineProperty(target, DURABLE_EVENT_HASH, {
			value: durableHash,
			enumerable: false,
			writable: false,
			configurable: true,
		});
	}

	/**
	 * The rejection handed to ONE member of a failed flush.
	 *
	 * `DURABLE_EVENT_HASH` is a per-EVENT handle: it means "this caller's event
	 * is on the chain at this hash". A batch that failed after the log fsync
	 * has every member's bytes durable, so each member needs its OWN hash —
	 * decorating one shared error instance would overwrite the property once
	 * per member and hand everybody the LAST member's hash, i.e. a correlation
	 * handle pointing at somebody else's record, which is worse than none.
	 *
	 * A single-member batch still rejects with the ORIGINAL instance, because
	 * that is exactly what the writer did before batching existed and what
	 * `harden/denial-meta-failure.test.ts` reads the hash back off. A shared
	 * failure with nothing durable to attach likewise passes the original
	 * through untouched.
	 */
	function memberRejection(
		err: unknown,
		durableHash: string | undefined,
		shared: boolean,
	): unknown {
		if (durableHash === undefined || err === null || typeof err !== "object") return err;
		if (!shared) {
			defineDurableHash(err, durableHash);
			return err;
		}
		// Only an Error can be faithfully re-carried. Anything else keeps the
		// original and simply goes without a handle — under-claiming durability
		// is the safe direction, the same call the pre-batching writer made
		// when `closeSync` failed.
		if (!(err instanceof Error)) return err;
		const carrier = new Error(err.message);
		carrier.name = err.name;
		if (err.stack !== undefined) carrier.stack = err.stack;
		// errno / code / syscall / path — the own enumerable fields a caller
		// switches on. `message` and `stack` are non-enumerable and set above.
		Object.assign(carrier, err);
		defineDurableHash(carrier, durableHash);
		return carrier;
	}

	/** Persist the batch's last hash for cross-segment chain continuity. */
	function writeSidecar(lastHash: string, sequence: number): void {
		const metaPath = `${logPath}.meta`;
		const metaFd = openSync(metaPath, "w");
		try {
			writeAll(metaFd, Buffer.from(JSON.stringify({ lastHash, sequence }), "utf-8"));
			fsyncSync(metaFd);
		} finally {
			closeSync(metaFd);
		}
	}

	/**
	 * Flush one batch: one fsync for the log, one sidecar write, then settle
	 * every member. Fully synchronous, so no caller can slip a write in between
	 * the fsync and the settles.
	 */
	function runFlush(batch: FlushBatch): void {
		if (pendingBatch === batch) pendingBatch = undefined;
		try {
			if (batch.members.length === 0) {
				// The batch's only writer threw before joining, so there is
				// nothing to flush and nobody to tell. Any partial bytes it left
				// behind are covered by the next batch's fsync, exactly as they
				// were when each append opened the log for itself.
				closeSync(batch.fd);
				return;
			}

			// Set ONLY once the log bytes are fsync'd AND the descriptor closed
			// cleanly. Everything after that point can still throw (the sidecar
			// above all) and every member's event is on the chain regardless —
			// see DURABLE_EVENT_HASH. A close that itself fails leaves this
			// unset: under-claiming durability is the safe direction.
			let durable = false;
			let failed = false;
			let error: unknown;
			try {
				try {
					fsyncSync(batch.fd);
				} finally {
					closeSync(batch.fd);
				}
				durable = true;
				writeSidecar(batch.lastHash, batch.lastSequence);
			} catch (err) {
				failed = true;
				error = err;
			}

			if (!failed) {
				for (const member of batch.members) member.resolve(member.event);
				return;
			}

			const shared = batch.members.length > 1;
			try {
				for (const member of batch.members) recordFailure(member.input, error);
			} finally {
				// EVERY member settles, whatever the bookkeeping above did. A
				// throwing console or dead-letter write must never strand a
				// caller on a promise that resolves nowhere.
				for (const member of batch.members) {
					let rejection: unknown = error;
					try {
						rejection = memberRejection(error, durable ? member.hash : undefined, shared);
					} catch {
						// A decoration failure costs the correlation handle, never
						// the rejection itself.
					}
					member.reject(rejection);
				}
			}
		} catch (err) {
			// `runFlush` is a `setImmediate` callback, so anything escaping it is
			// an UNCAUGHT exception that takes down the host process the governor
			// is embedded in — the same failure the anchoring emitter's
			// capture-never-reject rule exists to prevent. Every member has
			// already been settled by the paths above (the `finally` there runs
			// before this catch), so there is nobody left to tell: degrade, say
			// so, and keep the process alive.
			degraded = true;
			console.error("[AUDIT] Audit flush raised after settling its batch", err);
		} finally {
			batch.finish();
		}
	}

	async function appendEvent(input: AppendEventInput): Promise<AuditEvent> {
		const release = await mutex.acquire();
		let settled: Promise<AuditEvent>;
		try {
			acquireProcessLock(logPath, locksByDir, writerId);

			const last = getLastEvent(logPath, lastEventCache);
			const built = buildChainedEvent(input, last?.hash ?? GENESIS_HASH, (last?.sequence ?? 0) + 1);

			// Write only THIS event's line, and do not flush it: the shared
			// fsync happens after the mutex is released, which is the whole
			// point. Holding the money-adjacent write lock across a 2 ms flush
			// is what capped throughput at one event per flush.
			const batch = openBatch();
			writeAll(batch.fd, Buffer.from(`${built.line}\n`, "utf-8"));

			// The tail must advance HERE, before the mutex is released, or the
			// next caller in this same batch chains onto the previous event and
			// forks the chain. The bytes are in the file (not yet durable),
			// which is precisely what the next line must chain onto.
			lastEventCache.set(logPath, { hash: built.hash, sequence: built.sequence });
			batch.lastHash = built.hash;
			batch.lastSequence = built.sequence;

			let resolve: ((event: AuditEvent) => void) | undefined;
			let reject: ((err: unknown) => void) | undefined;
			settled = new Promise<AuditEvent>((res, rej) => {
				resolve = res;
				reject = rej;
			});
			batch.members.push({
				input,
				event: built.event,
				hash: built.hash,
				resolve: resolve as (event: AuditEvent) => void,
				reject: reject as (err: unknown) => void,
			});
		} catch (err) {
			// Nothing of this event reached the chain: `buildChainedEvent` does
			// no I/O, and a write that threw is never flushed by this caller.
			// So this caller fails ALONE and without a DURABLE_EVENT_HASH —
			// members that already wrote into the batch are unaffected.
			recordFailure(input, err);
			throw err;
		} finally {
			release();
		}
		// Durability before return: this resolves only once an fsync covering
		// these bytes has completed.
		return await settled;
	}

	function getWriteFailures(): number {
		return writeFailures;
	}

	function isDegradedFn(): boolean {
		return degraded;
	}

	async function flush(): Promise<void> {
		// The mutex is drained first, so every append already queued has WRITTEN
		// by the time we look for a batch to wait on.
		const release = await mutex.acquire();
		const batch = pendingBatch;
		release();
		if (batch) await batch.done;
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
