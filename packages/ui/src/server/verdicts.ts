// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Every event, indexed by the transfer it belongs to, so each row can show its TRANSFER's verdict: usertrust-verify's
 * `transferVerdict`, the one classification `usertrust-verify --tx` prints. A row's own fields are not enough: the
 * audit-first path writes an optimistic `settled: true` before the POST, and a later `settlement_ambiguous` for the
 * same transfer is what makes it ambiguous.
 */

import type { PersistedAuditEvent } from "usertrust";
import {
	normalizeEvent,
	type TransactionEvent,
	type TransferStatus,
	transferVerdict,
} from "usertrust-verify";

function transferIdOf(e: { data: Record<string, unknown> }): string | undefined {
	const id = e.data.transferId;
	return typeof id === "string" && id !== "" ? id : undefined;
}

export class TransferIndex {
	private readonly byTransfer = new Map<string, TransactionEvent[]>();

	/** Add events in chain order; returns the transfers they touched. */
	add(events: readonly PersistedAuditEvent[]): Set<string> {
		const touched = new Set<string>();
		for (const e of events) {
			const id = transferIdOf(e);
			if (id === undefined) continue;
			const list = this.byTransfer.get(id);
			const normalized = normalizeEvent(e);
			if (list) list.push(normalized);
			else this.byTransfer.set(id, [normalized]);
			touched.add(id);
		}
		return touched;
	}

	/** The verdict of one transfer, by id. */
	verdictOfTransfer(id: string): TransferStatus | undefined {
		return transferVerdict(this.byTransfer.get(id) ?? [])?.status;
	}

	/**
	 * The verdict for the transfer `e` belongs to. An event with no transferId (an unrecoverable settle, which stores
	 * only the id's hash, or a denial written before any hold) is its own transfer.
	 */
	readonly verdictOf = (e: PersistedAuditEvent): TransferStatus | undefined => {
		const id = transferIdOf(e);
		const events = id === undefined ? [normalizeEvent(e)] : (this.byTransfer.get(id) ?? []);
		return transferVerdict(events)?.status;
	};
}
