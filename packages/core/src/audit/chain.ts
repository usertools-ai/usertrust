// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Audit Chain Writer — SHA-256 hash-chained JSONL
 *
 * Appends audit events to a JSONL log where each event's hash covers
 * the previous event's hash, creating a tamper-evident chain. Single-writer
 * semantics are enforced via advisory file lock + in-process async mutex.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	closeSync,
	existsSync,
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

/**
 * Check if a lock file is stale (held by a dead process).
 * Returns true if stale and cleaned up, false if held by a live process.
 * Throws if the lock is actively held.
 */
function tryCleanStaleLock(candidateLockPath: string): boolean {
	try {
		const content = readFileSync(candidateLockPath, "utf-8");
		const lockData = JSON.parse(content) as { pid: number };
		if (lockData.pid === process.pid) {
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

function acquireProcessLock(logPath: string, locksByDir: Map<string, { path: string }>): void {
	const dir = dirname(logPath);
	if (locksByDir.has(dir)) return;

	const candidateLockPath = `${dir}/.audit-writer.lock`;

	// AUD-458: Use O_WRONLY | O_CREAT | O_EXCL atomically instead of existsSync + openSync('wx').
	// This eliminates the TOCTOU race where two processes both detect a stale lock,
	// both unlink, and both try to create — one gets EEXIST.
	const lockContent = JSON.stringify({
		pid: process.pid,
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
		locksByDir.set(dir, { path: candidateLockPath });
		return;
	} catch (err: unknown) {
		if (!(err instanceof Error && "code" in err && (err as { code?: string }).code === "EEXIST")) {
			throw err;
		}
		// File exists — check if stale
	}

	// Lock file exists — check if it's stale and clean up if so
	tryCleanStaleLock(candidateLockPath);

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
		locksByDir.set(dir, { path: candidateLockPath });
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
function releaseLocks(locksByDir: Map<string, { path: string }>): void {
	for (const [dir, lock] of locksByDir) {
		try {
			unlinkSync(lock.path);
		} catch {
			/* already removed */
		}
		locksByDir.delete(dir);
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
		hmac?: string;
	},
): void {
	try {
		const dlqDir = join(vaultPath, VAULT_DIR, "dlq");
		if (!existsSync(dlqDir)) {
			mkdirSync(dlqDir, { recursive: true, mode: 0o700 });
		}

		// AUD-469: Compute HMAC over the entry for integrity protection
		const key = createHash("sha256").update(`dlq-integrity:${vaultPath}`).digest("hex");
		const hmac = createHmac("sha256", key).update(JSON.stringify(entry)).digest("hex");
		const sealed = { ...entry, hmac };

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

	const mutex = new AsyncMutex();
	const lastEventCache = new Map<string, CachedTail>();
	const locksByDir = new Map<string, { path: string }>();
	let degraded = false;
	let writeFailures = 0;

	async function appendEvent(input: AppendEventInput): Promise<AuditEvent> {
		const release = await mutex.acquire();
		try {
			acquireProcessLock(logPath, locksByDir);

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
			const hash = createHash("sha256").update(canonical).digest("hex");

			const fullEvent: AuditEvent & { sequence: number } = {
				...event,
				hash,
			};

			const fd = openSync(logPath, "a");
			try {
				writeSync(fd, `${JSON.stringify(fullEvent)}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			lastEventCache.set(logPath, { hash, sequence });

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
