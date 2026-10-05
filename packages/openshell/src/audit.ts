// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The audit chain the hold engine records to (slice 1c-2), behind a narrow port so the engine is
 * tested against a fake and the vault implementation against a real chain.
 *
 * Every hold records, ONCE each, a `reserved` event, one terminal event (`settled`, `voided`
 * or `expired_unsettled`) and, for a late settlement, a correction event. "Once" is the
 * journal's job ({@link HoldJournal.recordEventOnce}: one critical section under its write
 * lock); this port answers the one question that critical section needs — is the event already
 * on the chain? — and appends it when it is not.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AuditWriter,
	createAuditWriter,
	deriveChainIntegrity,
	type PersistedAuditEvent,
	VAULT_DIR,
} from "usertrust";
import type { RecordedEvent } from "./journal.js";

/** The actor every hold event is appended under. */
export const HOLD_EVENT_ACTOR = "usertrust-openshell";

export type HoldEventKind =
	| "openshell.hold.reserved"
	| "openshell.hold.settled"
	| "openshell.hold.voided"
	| "openshell.hold.expired_unsettled"
	| "openshell.hold.late_settlement";

export interface AuditPort {
	/**
	 * The event of `kind` for `data.holdId` with a sequence above `afterSequence` if the chain —
	 * which MUST verify — already holds one; otherwise append it. Returns its hash and sequence
	 * once durable.
	 *
	 * The scan and the append are ONE operation, serialized against every other `record` on this
	 * port: a record whose caller gave up (the journal's deadline) still finishes before the next
	 * one scans, so a retry finds it instead of appending it again. Throws when the chain cannot
	 * be read in full or does not verify — an unverifiable chain is never read as "absent".
	 */
	record(
		kind: HoldEventKind,
		afterSequence: number,
		data: Record<string, unknown> & { holdId: string },
	): Promise<RecordedEvent>;
}

/** The chain could not be read in full, or does not verify: nothing may be appended on it. */
export class AuditChainUnverifiableError extends Error {
	constructor(why: string) {
		super(`openshell audit: the audit chain cannot be trusted as "absent" — ${why}`);
		this.name = "AuditChainUnverifiableError";
	}
}

/**
 * The vault's audit chain, on core's writer. {@link VaultAudit.open} takes the vault's audit lock
 * NOW (`lockAtCreate`): another live writer — another process, or another writer in this one —
 * fails here with `AuditWriterLockHeldError`, before its caller opens the journal, sweeps or
 * replays anything (one process per vault, enforced at START).
 */
export class VaultAudit implements AuditPort {
	/** Every record runs after the previous one settles (see {@link AuditPort.record}). */
	private tail: Promise<unknown> = Promise.resolve();

	private constructor(
		private readonly writer: AuditWriter,
		private readonly auditDir: string,
	) {}

	static open(vaultPath: string): VaultAudit {
		const writer = createAuditWriter(vaultPath, { lockAtCreate: true });
		return new VaultAudit(writer, join(vaultPath, VAULT_DIR, "audit"));
	}

	record(
		kind: HoldEventKind,
		afterSequence: number,
		data: Record<string, unknown> & { holdId: string },
	): Promise<RecordedEvent> {
		const run = async (): Promise<RecordedEvent> =>
			this.find(data.holdId, kind, afterSequence) ?? this.append(kind, data);
		const next = this.tail.then(run, run);
		this.tail = next.catch(() => undefined);
		return next;
	}

	/**
	 * STRICT read of the whole chain (the main log and every segment, gathered and ordered as
	 * core's `verifyVault` does): every non-empty line must parse — core's reader skips a
	 * malformed line, which here would read as "absent" — and the parsed chain must verify from
	 * genesis. Only then is a missing event absent.
	 */
	private find(holdId: string, kind: HoldEventKind, afterSequence: number): RecordedEvent | null {
		const events = this.readStrict();
		const integrity = deriveChainIntegrity(events);
		if (!integrity.valid) {
			throw new AuditChainUnverifiableError(`the chain breaks at index ${integrity.breakIndex}`);
		}
		for (const e of events) {
			const seq = e.sequence ?? 0;
			if (e.kind === kind && e.data?.holdId === holdId && seq > afterSequence) {
				return { hash: e.hash, sequence: seq };
			}
		}
		return null;
	}

	private async append(
		kind: HoldEventKind,
		data: Record<string, unknown> & { holdId: string },
	): Promise<RecordedEvent> {
		const ev = await this.writer.appendEvent({ kind, actor: HOLD_EVENT_ACTOR, data });
		const sequence = (ev as PersistedAuditEvent).sequence;
		if (typeof sequence !== "number") {
			throw new AuditChainUnverifiableError("an appended event carries no sequence number");
		}
		return { hash: ev.hash, sequence };
	}

	/** Release the vault's audit lock. */
	release(): void {
		this.writer.release();
	}

	private readStrict(): PersistedAuditEvent[] {
		if (!existsSync(this.auditDir)) return [];
		const files: string[] = [];
		const main = join(this.auditDir, "events.jsonl");
		if (existsSync(main)) files.push(main);
		for (const entry of readdirSync(this.auditDir).sort()) {
			if (entry.endsWith(".jsonl") && entry !== "events.jsonl")
				files.push(join(this.auditDir, entry));
		}
		const events: PersistedAuditEvent[] = [];
		for (const file of files) {
			for (const line of readFileSync(file, "utf-8").split("\n")) {
				if (line.trim() === "") continue;
				try {
					events.push(JSON.parse(line) as PersistedAuditEvent);
				} catch {
					throw new AuditChainUnverifiableError(`a line of ${file} does not parse`);
				}
			}
		}
		const sequenced = events.every((e) => typeof e.sequence === "number");
		return sequenced
			? [...events].sort((a, b) => (a.sequence as number) - (b.sequence as number))
			: events;
	}
}
