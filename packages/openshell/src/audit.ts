// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The audit chain the hold engine records to (slice 1c-2), behind a narrow port so the engine is
 * tested against a fake and the vault implementation against a real chain.
 *
 * Every hold records, ONCE each, a `reserved` event, one terminal event (`settled`, `voided`
 * or `expired_unsettled`) and, for a late settlement, a correction event. "Once" is the
 * journal's job ({@link HoldJournal.recordEventOnce}: one critical section under its write
 * lock). This port answers the one question that critical section needs — is the event already
 * on the chain? — from a VERIFIED read, and appends it when it is not.
 *
 * Verification is INCREMENTAL (#191 r1): the journal holds a checkpoint (the last verified
 * event's sequence, hash and byte offset), and a record verifies only the bytes after it — plus
 * that the checkpoint's own line is still there, unchanged, and that the `.meta` head anchor
 * agrees with the verified head. A record therefore costs O(new events), not O(chain). The
 * bytes BEFORE the checkpoint are re-verified by {@link VaultAudit.verifyFull}, which the
 * sweeper runs at start and on an interval, off the request path.
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	createReadStream,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import {
	type AuditWriter,
	canonicalize,
	createAuditWriter,
	GENESIS_HASH,
	VAULT_DIR,
} from "usertrust";
import type { ChainCheckpoint, ChainHoldEvent, ChainRecord } from "./journal.js";

/** The actor every hold event is appended under. */
export const HOLD_EVENT_ACTOR = "usertrust-openshell";

export type HoldEventKind =
	| "openshell.hold.reserved"
	| "openshell.hold.settled"
	| "openshell.hold.voided"
	| "openshell.hold.expired_unsettled"
	| "openshell.hold.late_settlement"
	/** An operator reset of a broken chain (not a hold event: never absorbed into a row). */
	| "openshell.audit.reset";

export interface AuditPort {
	/**
	 * The event of `kind` for `data.holdId` with a sequence above `afterSequence`, if the chain —
	 * verified from `from` (the journal's checkpoint; null = from genesis) — already holds one;
	 * otherwise append it. Returns the event, every hold event in the verified tail (for the
	 * journal to absorb), and the new checkpoint.
	 *
	 * The verification, the scan and the append are ONE operation, serialized against every
	 * other `record` on this port: a record whose caller gave up (the journal's deadline) still
	 * finishes before the next one reads. Throws {@link AuditChainUnverifiableError} when the
	 * chain does not verify — an unverifiable chain is never read as "absent".
	 */
	record(
		kind: HoldEventKind,
		afterSequence: number,
		data: Record<string, unknown> & { holdId: string },
		from: ChainCheckpoint | null,
	): Promise<ChainRecord>;
	/**
	 * Verify the WHOLE chain from genesis: up to `checkpoint` (and that the checkpoint's event is
	 * on it), or, without one, to its end — returning the checkpoint at the end and every hold
	 * event on the way (for an operator reset to absorb). Throws
	 * {@link AuditChainUnverifiableError} with scope `history`.
	 */
	verifyFull(
		checkpoint: ChainCheckpoint | null,
	): Promise<{ checkpoint: ChainCheckpoint; tail: ChainHoldEvent[] }>;
	/**
	 * Forget the writer's cached tail, so the next append re-reads the log (#191 r2): an operator
	 * reset after the chain was repaired or rewritten under this live port. The lock is kept.
	 */
	resync(): void;
}

/**
 * Where a refusal lies, defined positively:
 *  - `history`: bytes already VERIFIED are no longer as verified (the checkpoint's line is gone
 *    or changed, the log is shorter than it, or a verification from genesis fails) — a definite
 *    finding. The journal's checkpoint goes `broken` and stays so until an operator reset.
 *  - `tail`: the bytes AFTER the checkpoint do not verify yet (a torn line, a bad link, an anchor
 *    disagreement past the checkpoint, another segment) — this record is refused; the
 *    checkpoint is untouched and the next record re-reads from it.
 */
export type RefusalScope = "history" | "tail";

/** The chain could not be read in full, or does not verify: nothing may be appended on it. */
export class AuditChainUnverifiableError extends Error {
	constructor(
		why: string,
		readonly scope: RefusalScope,
	) {
		super(`openshell audit: the audit chain cannot be trusted as "absent" — ${why}`);
		this.name = "AuditChainUnverifiableError";
	}
}

/**
 * An I/O failure that is NOT a finding about the chain: an errno on the allow-list below, read
 * from a real `stat`/`open`/`read`/`readdir` (never `existsSync`, which answers `false` for
 * EACCES and EIO as for ENOENT). Nothing changes; the caller retries.
 */
export class AuditTransientError extends Error {
	constructor(
		why: string,
		readonly code: string,
	) {
		super(`openshell audit: a transient I/O failure (${code}) — ${why}; retried, nothing changed`);
		this.name = "AuditTransientError";
	}
}

/** The ONLY errnos read as transient (#191 r2): environment, not evidence. Anything else is not. */
export const TRANSIENT_ERRNOS: ReadonlySet<string> = new Set([
	"EACCES",
	"EPERM",
	"EIO",
	"EAGAIN",
	"EBUSY",
	"EINTR",
	"EMFILE",
	"ENFILE",
	"ENOMEM",
	"ENOSPC",
	"EROFS",
	"ETIMEDOUT",
]);

/**
 * THE classifier (#191 r2): every failure a record or a verification can meet maps to exactly
 * one of three readings, defined POSITIVELY —
 *  - `tail`: an {@link AuditChainUnverifiableError} scoped `tail` (the bytes after the
 *    checkpoint): this record is refused, nothing changes;
 *  - `transient`: an {@link AuditTransientError}, an error whose errno is on
 *    {@link TRANSIENT_ERRNOS}, or the journal's own deadline / busy errors: retried, nothing
 *    changes;
 *  - `history`: EVERYTHING ELSE — a `history`-scoped refusal, and any error not recognised
 *    above (a TypeError, an unknown errno, …). An unrecognised failure fails toward `broken`.
 */
export function classifyAuditFailure(err: unknown): RefusalScope | "transient" {
	if (err instanceof AuditChainUnverifiableError) return err.scope;
	if (err instanceof AuditTransientError) return "transient";
	if (err instanceof Error) {
		if (err.name === "LedgerDeadlineError" || err.name === "JournalBusyError") return "transient";
		const code = (err as NodeJS.ErrnoException).code;
		if (typeof code === "string" && TRANSIENT_ERRNOS.has(code)) return "transient";
	}
	return "history";
}

/** An fs failure: transient iff its errno is on the allow-list; otherwise a `history` finding. */
function ioFailure(err: unknown, what: string): never {
	const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
	if (typeof code === "string" && TRANSIENT_ERRNOS.has(code))
		throw new AuditTransientError(what, code);
	throw new AuditChainUnverifiableError(`${what}: ${code ?? String(err)}`, "history");
}

/** ENOENT → null; an allow-listed errno → transient; anything else → `history`. */
function statOrAbsent(path: string, what: string): { size: number; isFile: boolean } | null {
	try {
		const st = statSync(path);
		return { size: st.size, isFile: st.isFile() };
	} catch (err) {
		if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
		return ioFailure(err, what);
	}
}

type ChainEvent = Record<string, unknown> & {
	hash: string;
	previousHash: string;
	sequence: number;
};

/**
 * Parse one line STRICTLY into an event shape: a non-null, non-array object with a 64-hex
 * `hash`, a string `previousHash` and a safe-integer `sequence`. Every parse or shape failure is
 * an {@link AuditChainUnverifiableError} with the given scope — never a TypeError (#191 r2: a
 * checkpointed line rewritten to `null` threw a TypeError that read as transient).
 */
function parseEvent(raw: string, where: string, scope: RefusalScope): ChainEvent {
	let e: unknown;
	try {
		e = JSON.parse(raw);
	} catch {
		throw new AuditChainUnverifiableError(`${where} does not parse`, scope);
	}
	if (e === null || typeof e !== "object" || Array.isArray(e)) {
		throw new AuditChainUnverifiableError(`${where} is not an event object`, scope);
	}
	const o = e as Record<string, unknown>;
	if (
		typeof o.hash !== "string" ||
		!/^[0-9a-f]{64}$/.test(o.hash) ||
		typeof o.previousHash !== "string" ||
		!Number.isSafeInteger(o.sequence)
	) {
		throw new AuditChainUnverifiableError(
			`${where} is missing or mistypes hash / previousHash / sequence`,
			scope,
		);
	}
	return o as ChainEvent;
}

function hashesToContent(e: ChainEvent): boolean {
	const { hash, ...rest } = e;
	return createHash("sha256").update(canonicalize(rest)).digest("hex") === hash;
}

/** One event verified as the successor of (`prevHash`, `prevSeq`): its link, sequence and hash. */
function verifyLink(
	raw: string,
	prevHash: string,
	prevSeq: number,
	scope: RefusalScope,
): ChainEvent {
	const where = `sequence ${prevSeq + 1}`;
	const e = parseEvent(raw, where, scope);
	if (e.previousHash !== prevHash || e.sequence !== prevSeq + 1) {
		throw new AuditChainUnverifiableError(`${where} does not follow sequence ${prevSeq}`, scope);
	}
	if (!hashesToContent(e)) {
		throw new AuditChainUnverifiableError(`${where}: its hash does not match its content`, scope);
	}
	return e;
}

function holdEvent(e: ChainEvent): ChainHoldEvent | null {
	const holdId = (e.data as { holdId?: unknown } | undefined)?.holdId;
	// Every openshell event: hold events (absorbed into their rows) and audit resets (found by a
	// retried reset, never absorbed).
	if (typeof e.kind !== "string" || !e.kind.startsWith("openshell.")) return null;
	if (typeof holdId !== "string") return null;
	return { kind: e.kind, holdId, sequence: e.sequence, hash: e.hash };
}

const GENESIS: ChainCheckpoint = { offset: 0, lineStart: 0, sequence: 0, hash: GENESIS_HASH };

/**
 * The vault's audit chain, on core's writer. {@link VaultAudit.open} takes the vault's audit lock
 * NOW (`lockAtCreate`): another live writer — another process, or another writer in this one —
 * fails here with `AuditWriterLockHeldError`, before its caller opens the journal, sweeps or
 * replays anything (one process per vault, enforced at START). While it is held, every append
 * to the chain is this port's own.
 */
export class VaultAudit implements AuditPort {
	/** Every record runs after the previous one settles (see {@link AuditPort.record}). */
	private tail: Promise<unknown> = Promise.resolve();
	/** Events the latest record parsed: O(new events) past the checkpoint, not O(chain). */
	lastScanned = 0;

	private constructor(
		private readonly writer: AuditWriter,
		private readonly auditDir: string,
	) {}

	static open(vaultPath: string): VaultAudit {
		const writer = createAuditWriter(vaultPath, { lockAtCreate: true });
		return new VaultAudit(writer, join(vaultPath, VAULT_DIR, "audit"));
	}

	private get logPath(): string {
		return join(this.auditDir, "events.jsonl");
	}

	record(
		kind: HoldEventKind,
		afterSequence: number,
		data: Record<string, unknown> & { holdId: string },
		from: ChainCheckpoint | null,
	): Promise<ChainRecord> {
		const run = () => this.recordNow(kind, afterSequence, data, from);
		const next = this.tail.then(run, run);
		this.tail = next.catch(() => undefined);
		return next;
	}

	private async recordNow(
		kind: HoldEventKind,
		afterSequence: number,
		data: Record<string, unknown> & { holdId: string },
		from: ChainCheckpoint | null,
	): Promise<ChainRecord> {
		this.refuseSegments();
		const read = this.readFrom(from);
		// Without a checkpoint this read IS the verification of history; past one, it is the tail.
		this.checkAnchor(from, read.events, read.checkpoint);
		this.lastScanned = read.events.length;
		const tail = read.events.map(holdEvent).filter((e) => e !== null);
		const found = tail.find(
			(e) => e.kind === kind && e.holdId === data.holdId && e.sequence > afterSequence,
		);
		if (found !== undefined) {
			return {
				event: { hash: found.hash, sequence: found.sequence },
				tail,
				checkpoint: read.checkpoint,
			};
		}
		const appended = await this.writer.appendEvent({ kind, actor: HOLD_EVENT_ACTOR, data });
		// Read the append back: exactly one new line, ours, chained onto the verified head.
		const after = this.readFrom(read.checkpoint);
		const [line, ...extra] = after.events;
		if (line === undefined || extra.length > 0 || line.hash !== appended.hash) {
			throw new AuditChainUnverifiableError(
				"the appended event is not the chain's next event",
				"tail",
			);
		}
		const own = holdEvent(line);
		return {
			event: { hash: line.hash, sequence: line.sequence },
			tail: own === null ? tail : [...tail, own],
			checkpoint: after.checkpoint,
		};
	}

	/**
	 * Verify the log from `from` to its end. The checkpoint's own line must still be there,
	 * unchanged (a truncation or rewrite at or before it REFUSES — never a silent fallback to
	 * genesis); every later line must parse, follow its predecessor and hash to its content; and
	 * the log must end with a newline (a torn final line refuses).
	 */
	private readFrom(from: ChainCheckpoint | null): {
		events: ChainEvent[];
		checkpoint: ChainCheckpoint;
		headPrev: string | null;
	} {
		const cp = from === null || from.sequence === 0 ? GENESIS : from;
		const buf = this.readBytes(cp.lineStart);
		let pos = 0;
		let headPrev: string | null = null;
		if (cp !== GENESIS) {
			const gone = () =>
				new AuditChainUnverifiableError(
					`the verified checkpoint (sequence ${cp.sequence}) is no longer on the chain — truncated or rewritten`,
					"history",
				);
			const nl = buf.indexOf(0x0a);
			if (nl < 0 || cp.lineStart + nl + 1 !== cp.offset) throw gone();
			let e: ChainEvent;
			try {
				e = parseEvent(buf.subarray(0, nl).toString("utf-8"), "the checkpoint's line", "history");
			} catch {
				throw gone();
			}
			if (e.hash !== cp.hash || e.sequence !== cp.sequence || !hashesToContent(e)) throw gone();
			headPrev = e.previousHash;
			pos = nl + 1;
		}
		// From genesis, every line is history being verified; past a checkpoint, the tail.
		const scope: RefusalScope = cp === GENESIS ? "history" : "tail";
		const events: ChainEvent[] = [];
		let checkpoint = cp;
		while (pos < buf.length) {
			const nl = buf.indexOf(0x0a, pos);
			if (nl < 0) throw new AuditChainUnverifiableError("the log ends in a torn line", "tail");
			const e = verifyLink(
				buf.subarray(pos, nl).toString("utf-8"),
				checkpoint.hash,
				checkpoint.sequence,
				scope,
			);
			events.push(e);
			headPrev = checkpoint.hash;
			checkpoint = {
				offset: cp.lineStart + nl + 1,
				lineStart: cp.lineStart + pos,
				sequence: e.sequence,
				hash: e.hash,
			};
			pos = nl + 1;
		}
		return { events, checkpoint, headPrev };
	}

	/**
	 * The `.meta` head anchor must agree with the verified chain (#191 r2), defined POSITIVELY:
	 * absent (a legacy vault, as `verifyVault` allows); or at or behind the verified head, where
	 * the event at the anchor's sequence — the checkpoint's own, or one of this read's verified
	 * events — carries the anchor's hash; or BELOW the checkpoint, which the checkpoint already
	 * guards (a truncation there fails the checkpoint's line). An anchor behind by several events
	 * is accepted when the chain reaches it: it lags only by appends whose sidecar write failed.
	 * An anchor ahead of the head, unreadable, malformed, or not on the chain refuses — `history`
	 * when this read verifies from genesis, `tail` past a checkpoint.
	 */
	private checkAnchor(
		from: ChainCheckpoint | null,
		events: ChainEvent[],
		head: ChainCheckpoint,
	): void {
		const cp = from === null || from.sequence === 0 ? GENESIS : from;
		const scope: RefusalScope = cp === GENESIS ? "history" : "tail";
		const metaPath = `${this.logPath}.meta`;
		let text: string;
		try {
			text = readFileSync(metaPath, "utf-8");
		} catch (err) {
			if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return;
			ioFailure(err, "the .meta head anchor cannot be read");
		}
		let a: unknown;
		try {
			a = JSON.parse(text);
		} catch {
			throw new AuditChainUnverifiableError("the .meta head anchor does not parse", scope);
		}
		const o = a as { lastHash?: unknown; sequence?: unknown } | null;
		if (
			o === null ||
			typeof o !== "object" ||
			typeof o.lastHash !== "string" ||
			!Number.isSafeInteger(o.sequence) ||
			(o.sequence as number) < 0
		) {
			throw new AuditChainUnverifiableError("the .meta head anchor is malformed", scope);
		}
		const seq = o.sequence as number;
		const refuse = (why: string): never => {
			throw new AuditChainUnverifiableError(
				`the .meta head anchor (sequence ${seq}) ${why} (the verified head is sequence ${head.sequence}) — truncated or rewritten`,
				scope,
			);
		};
		if (seq > head.sequence) refuse("is ahead of the chain");
		if (seq < cp.sequence) return; // below the checkpoint: the checkpoint guards it
		const at = seq === cp.sequence ? cp.hash : events.find((e) => e.sequence === seq)?.hash;
		if (at === undefined || at !== o.lastHash) refuse("is not on the verified chain");
	}

	async verifyFull(
		checkpoint: ChainCheckpoint | null,
	): Promise<{ checkpoint: ChainCheckpoint; tail: ChainHoldEvent[] }> {
		this.refuseSegments();
		const cp = checkpoint === null || checkpoint.sequence === 0 ? null : checkpoint;
		const tail: ChainHoldEvent[] = [];
		const st = statOrAbsent(this.logPath, "the log cannot be read");
		if (st === null) {
			if (cp !== null) throw new AuditChainUnverifiableError("the log is gone", "history");
			return { checkpoint: GENESIS, tail };
		}
		if (!st.isFile) throw new AuditChainUnverifiableError("the log is not a file", "history");
		// Up to the checkpoint: those bytes are immutable while this port holds the lock, so a
		// concurrent record (which appends after them) cannot race this read. Without one, to the
		// end as it is now. Streamed, so the event loop is never held for the whole chain.
		const end = cp === null ? st.size : cp.offset;
		let reached: ChainCheckpoint = GENESIS;
		let offset = 0;
		let carry: Buffer = Buffer.alloc(0);
		if (end > 0) {
			const stream = createReadStream(this.logPath, { start: 0, end: end - 1 });
			const chunks = (async function* () {
				try {
					for await (const c of stream) yield c as Buffer;
				} catch (err) {
					ioFailure(err, "the log cannot be read");
				}
			})();
			for await (const chunk of chunks) {
				carry = carry.length === 0 ? (chunk as Buffer) : Buffer.concat([carry, chunk as Buffer]);
				let pos = 0;
				for (let nl = carry.indexOf(0x0a); nl >= 0; nl = carry.indexOf(0x0a, pos)) {
					const e = verifyLink(
						carry.subarray(pos, nl).toString("utf-8"),
						reached.hash,
						reached.sequence,
						"history",
					);
					if (cp === null) {
						const h = holdEvent(e);
						if (h !== null) tail.push(h);
					}
					reached = {
						offset: offset + nl + 1 - pos,
						lineStart: offset,
						sequence: e.sequence,
						hash: e.hash,
					};
					offset += nl + 1 - pos;
					pos = nl + 1;
				}
				carry = carry.subarray(pos);
			}
		}
		if (carry.length > 0) {
			throw new AuditChainUnverifiableError(
				"the log ends in a torn line",
				cp === null ? "tail" : "history",
			);
		}
		if (offset !== end) {
			throw new AuditChainUnverifiableError(
				"the log is shorter than the verified checkpoint",
				"history",
			);
		}
		if (cp !== null && (reached.hash !== cp.hash || reached.sequence !== cp.sequence)) {
			throw new AuditChainUnverifiableError(
				`the verified checkpoint (sequence ${cp.sequence}) is no longer on the chain — rewritten`,
				"history",
			);
		}
		return { checkpoint: cp ?? reached, tail };
	}

	resync(): void {
		this.writer.invalidateTail();
	}

	/** Release the vault's audit lock. */
	release(): void {
		this.writer.release();
	}

	/** Core's writer appends only `events.jsonl`; a segmented chain is refused, not half-read. */
	private refuseSegments(): void {
		let entries: string[];
		try {
			entries = readdirSync(this.auditDir);
		} catch (err) {
			if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return;
			ioFailure(err, "the audit directory cannot be listed");
		}
		const other = entries.filter((f) => f.endsWith(".jsonl") && f !== "events.jsonl");
		if (other.length > 0) {
			throw new AuditChainUnverifiableError(
				`the chain has other segments (${other.join(", ")}), which this middleware does not verify`,
				"tail",
			);
		}
	}

	private readBytes(start: number): Buffer {
		let fd: number;
		try {
			fd = openSync(this.logPath, "r");
		} catch (err) {
			if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
				if (start > 0) throw new AuditChainUnverifiableError("the log is gone", "history");
				return Buffer.alloc(0);
			}
			return ioFailure(err, "the log cannot be opened");
		}
		try {
			const size = fstatSync(fd).size;
			if (size < start) {
				throw new AuditChainUnverifiableError(
					"the log is shorter than the verified checkpoint",
					"history",
				);
			}
			const buf = Buffer.alloc(size - start);
			let got = 0;
			while (got < buf.length) {
				let n: number;
				try {
					n = readSync(fd, buf, got, buf.length - got, start + got);
				} catch (err) {
					return ioFailure(err, "the log cannot be read");
				}
				if (n === 0) break;
				got += n;
			}
			return buf.subarray(0, got);
		} finally {
			closeSync(fd);
		}
	}
}
