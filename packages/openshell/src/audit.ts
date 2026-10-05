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
	existsSync,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
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

type ChainEvent = Record<string, unknown> & {
	hash: string;
	previousHash: string;
	sequence: number;
};

/** One event verified as the successor of (`prevHash`, `prevSeq`): its link, sequence and hash. */
function verifyLink(
	raw: string,
	prevHash: string,
	prevSeq: number,
	scope: RefusalScope,
): ChainEvent {
	const where = `sequence ${prevSeq + 1}`;
	let e: Record<string, unknown>;
	try {
		e = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		throw new AuditChainUnverifiableError(`${where} does not parse`, scope);
	}
	const { hash, ...rest } = e;
	if (typeof hash !== "string" || e.previousHash !== prevHash || e.sequence !== prevSeq + 1) {
		throw new AuditChainUnverifiableError(`${where} does not follow sequence ${prevSeq}`, scope);
	}
	if (createHash("sha256").update(canonicalize(rest)).digest("hex") !== hash) {
		throw new AuditChainUnverifiableError(`${where}: its hash does not match its content`, scope);
	}
	return e as ChainEvent;
}

function holdEvent(e: ChainEvent): ChainHoldEvent | null {
	const holdId = (e.data as { holdId?: unknown } | undefined)?.holdId;
	if (typeof e.kind !== "string" || !e.kind.startsWith("openshell.hold.")) return null;
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
		this.checkAnchor(
			read.checkpoint,
			read.headPrev,
			from === null || from.sequence === 0 ? "history" : "tail",
		);
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
			const nl = buf.indexOf(0x0a);
			let ok = nl >= 0 && cp.lineStart + nl + 1 === cp.offset;
			if (ok) {
				try {
					const e = JSON.parse(buf.subarray(0, nl).toString("utf-8")) as Record<string, unknown>;
					const { hash, ...rest } = e;
					ok =
						hash === cp.hash &&
						e.sequence === cp.sequence &&
						createHash("sha256").update(canonicalize(rest)).digest("hex") === hash;
					headPrev = typeof e.previousHash === "string" ? e.previousHash : null;
				} catch {
					ok = false;
				}
			}
			if (!ok) {
				throw new AuditChainUnverifiableError(
					`the verified checkpoint (sequence ${cp.sequence}) is no longer on the chain — truncated or rewritten`,
					"history",
				);
			}
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
	 * The `.meta` head anchor must agree with the verified head — the two states core's writer
	 * accepts: the anchor IS the head, or it is exactly one behind at the head's predecessor (the
	 * log fsync'd, the sidecar write failed). No anchor: a legacy vault, as `verifyVault` allows.
	 * An anchor ahead of the head is a truncation and refuses.
	 */
	private checkAnchor(head: ChainCheckpoint, headPrev: string | null, scope: RefusalScope): void {
		const metaPath = `${this.logPath}.meta`;
		if (!existsSync(metaPath)) return;
		let a: { lastHash?: unknown; sequence?: unknown };
		try {
			a = JSON.parse(readFileSync(metaPath, "utf-8")) as typeof a;
		} catch {
			throw new AuditChainUnverifiableError("the .meta head anchor does not parse", scope);
		}
		const isHead = a.sequence === head.sequence && a.lastHash === head.hash;
		const oneBehind =
			head.sequence > 0 && a.sequence === head.sequence - 1 && a.lastHash === headPrev;
		if (!isHead && !oneBehind) {
			throw new AuditChainUnverifiableError(
				`the .meta head anchor (sequence ${String(a.sequence)}) disagrees with the verified head (sequence ${head.sequence}) — truncated or rewritten`,
				scope,
			);
		}
	}

	async verifyFull(
		checkpoint: ChainCheckpoint | null,
	): Promise<{ checkpoint: ChainCheckpoint; tail: ChainHoldEvent[] }> {
		this.refuseSegments();
		const cp = checkpoint === null || checkpoint.sequence === 0 ? null : checkpoint;
		const tail: ChainHoldEvent[] = [];
		if (!existsSync(this.logPath)) {
			if (cp !== null) throw new AuditChainUnverifiableError("the log is gone", "history");
			return { checkpoint: GENESIS, tail };
		}
		// Up to the checkpoint: those bytes are immutable while this port holds the lock, so a
		// concurrent record (which appends after them) cannot race this read. Without one, to the
		// end as it is now. Streamed, so the event loop is never held for the whole chain.
		const end = cp === null ? sizeOf(this.logPath) : cp.offset;
		let reached: ChainCheckpoint = GENESIS;
		let offset = 0;
		let carry: Buffer = Buffer.alloc(0);
		if (end > 0) {
			for await (const chunk of createReadStream(this.logPath, { start: 0, end: end - 1 })) {
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

	/** Release the vault's audit lock. */
	release(): void {
		this.writer.release();
	}

	/** Core's writer appends only `events.jsonl`; a segmented chain is refused, not half-read. */
	private refuseSegments(): void {
		if (!existsSync(this.auditDir)) return;
		const other = readdirSync(this.auditDir).filter(
			(f) => f.endsWith(".jsonl") && f !== "events.jsonl",
		);
		if (other.length > 0) {
			throw new AuditChainUnverifiableError(
				`the chain has other segments (${other.join(", ")}), which this middleware does not verify`,
				"tail",
			);
		}
	}

	private readBytes(start: number): Buffer {
		if (!existsSync(this.logPath)) {
			if (start > 0) throw new AuditChainUnverifiableError("the log is gone", "history");
			return Buffer.alloc(0);
		}
		const fd = openSync(this.logPath, "r");
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
				const n = readSync(fd, buf, got, buf.length - got, start + got);
				if (n === 0) break;
				got += n;
			}
			return buf.subarray(0, got);
		} finally {
			closeSync(fd);
		}
	}
}

function sizeOf(path: string): number {
	const fd = openSync(path, "r");
	try {
		return fstatSync(fd).size;
	} finally {
		closeSync(fd);
	}
}
