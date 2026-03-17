/**
 * Audit Chain Writer — SHA-256 hash-chained JSONL
 *
 * Appends audit events to a JSONL log where each event's hash covers
 * the previous event's hash, creating a tamper-evident chain. Single-writer
 * semantics are enforced via advisory file lock + in-process async mutex.
 *
 * Adapted from usertools-stealth governance/audit/writer.ts — removes
 * SurrealDB dual-write, replaces sendAlert with console.warn, replaces
 * writeDeadLetter with local DLQ JSONL.
 */

import { createHash, randomUUID } from "node:crypto";
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

function acquireProcessLock(
	logPath: string,
	locksByDir: Map<string, { fd: number; path: string }>,
): void {
	const dir = dirname(logPath);
	if (locksByDir.has(dir)) return;

	const candidateLockPath = `${dir}/.audit-writer.lock`;

	if (existsSync(candidateLockPath)) {
		try {
			const content = readFileSync(candidateLockPath, "utf-8");
			const lockData = JSON.parse(content) as { pid: number };
			if (lockData.pid === process.pid) {
				console.warn(
					`[AUDIT] Reclaiming stale same-PID lock (PID ${process.pid}). Previous process exited without releasing the lock.`,
				);
				unlinkSync(candidateLockPath);
			} else {
				try {
					process.kill(lockData.pid, 0);
					throw new Error(
						`Audit writer lock held by PID ${lockData.pid}. Only one process may write to the audit log. Lock file: ${candidateLockPath}`,
					);
				} catch (killErr: unknown) {
					if (killErr instanceof Error && "code" in killErr) {
						const code = (killErr as { code?: string }).code;
						if (code === "ESRCH") {
							unlinkSync(candidateLockPath);
						} else if (code === "EPERM") {
							throw new Error(
								`Audit writer lock held by PID ${lockData.pid}. Only one process may write to the audit log. Lock file: ${candidateLockPath}`,
							);
						} else {
							throw killErr;
						}
					} else {
						throw killErr;
					}
				}
			}
		} catch (parseErr) {
			if (parseErr instanceof Error && parseErr.message.includes("Audit writer lock held")) {
				throw parseErr;
			}
			try {
				unlinkSync(candidateLockPath);
			} catch {
				/* best effort */
			}
		}
	}

	const fd = openSync(candidateLockPath, "wx");
	const lockContent = JSON.stringify({
		pid: process.pid,
		startedAt: new Date().toISOString(),
	});
	writeSync(fd, lockContent);
	fsyncSync(fd);
	locksByDir.set(dir, { fd, path: candidateLockPath });
}

function releaseLocks(locksByDir: Map<string, { fd: number; path: string }>): void {
	for (const [dir, lock] of locksByDir) {
		try {
			closeSync(lock.fd);
		} catch {
			/* already closed */
		}
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
	},
): void {
	try {
		const dlqDir = join(vaultPath, VAULT_DIR, "dlq");
		if (!existsSync(dlqDir)) {
			mkdirSync(dlqDir, { recursive: true });
		}
		const dlqPath = join(dlqDir, "dead-letters.jsonl");
		const fd = openSync(dlqPath, "a");
		try {
			writeSync(fd, `${JSON.stringify(entry)}\n`);
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
 * The writer appends events to `<vaultPath>/.usertools/audit/events.jsonl`.
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
	const locksByDir = new Map<string, { fd: number; path: string }>();
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
