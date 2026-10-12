// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Every event, indexed by the transfer it belongs to, so each row can show its TRANSFER's verdict: usertrust-verify's
 * `transferVerdict`, the one classification `usertrust-verify --tx` prints. A row's own fields are not enough: the
 * audit-first path writes an optimistic `settled: true` before the POST, and a later `settlement_ambiguous` for the
 * same transfer is what makes it ambiguous.
 *
 * A transfer's events are grouped by `transferKeysOf`, the match `--tx` makes: a `settlement_unrecoverable` stores
 * only its transferId's hash, and joins that transfer (a TTL-swept `hold_released` and then a late settle's
 * unrecoverable record are ONE transfer, RELEASED).
 */

import type { PersistedAuditEvent } from "usertrust";
import {
	normalizeEvent,
	type TransactionEvent,
	type TransferStatus,
	transferKeysOf,
	transferVerdict,
} from "usertrust-verify";

export class TransferIndex {
	/** Each transfer's events in chain order, by transfer key. */
	private readonly groups = new Map<string, TransactionEvent[]>();
	/** The transfer key each event's row shows the verdict of (its own transferId's, when it has one). */
	private readonly keyOfEvent = new Map<string, string>();
	/** Each transfer's verdict, until an event is added to it; one scan per transfer, not one per row. */
	private readonly verdicts = new Map<string, TransferStatus | undefined>();

	/** Add events in chain order; returns the transfer keys they touched. */
	add(events: readonly PersistedAuditEvent[]): Set<string> {
		const touched = new Set<string>();
		for (const e of events) {
			const normalized = normalizeEvent(e);
			const keys = transferKeysOf(normalized);
			const [own] = keys;
			if (own === undefined) continue;
			this.keyOfEvent.set(e.id, own);
			for (const key of keys) {
				const list = this.groups.get(key);
				if (list) list.push(normalized);
				else this.groups.set(key, [normalized]);
				this.verdicts.delete(key);
				touched.add(key);
			}
		}
		return touched;
	}

	/** The transfer key of a row's event, or undefined for an event outside any transfer. */
	keyOfRow(eventId: string): string | undefined {
		return this.keyOfEvent.get(eventId);
	}

	/** The verdict of one transfer, by key. */
	verdictOfTransfer(key: string): TransferStatus | undefined {
		if (this.verdicts.has(key)) return this.verdicts.get(key);
		const status = transferVerdict(this.groups.get(key) ?? [])?.status;
		this.verdicts.set(key, status);
		return status;
	}

	/**
	 * The verdict for the transfer `e` belongs to. An event in no transfer (a denial written before any hold) is its
	 * own transfer.
	 */
	readonly verdictOf = (e: PersistedAuditEvent): TransferStatus | undefined => {
		const key = this.keyOfEvent.get(e.id);
		return key === undefined
			? transferVerdict([normalizeEvent(e)])?.status
			: this.verdictOfTransfer(key);
	};
}
