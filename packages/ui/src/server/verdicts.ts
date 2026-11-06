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
 *
 * Each event keeps its position beside it, so a transfer's verdict can also be taken as recorded at a past position
 * (`verdictAt`), and the transfers open across a position can be found without a pass over them all (`openAcross`).
 */

import type { PersistedAuditEvent } from "usertrust";
import {
	normalizeEvent,
	type TransactionEvent,
	type TransferStatus,
	transferKeysOf,
	transferVerdict,
} from "usertrust-verify";

/** One transfer's events in chain order, each with its position beside it. */
interface Group {
	/** The transfer's order of first appearance: its slot in `LastPositions`. */
	slot: number;
	events: TransactionEvent[];
	/** `positions[i]` is the position of `events[i]`; increasing. */
	positions: number[];
	/** The positions of the events whose ROW shows this transfer's verdict (it is their own key); increasing. */
	rowPositions: number[];
}

export class TransferIndex {
	/** Each transfer's events in chain order, by transfer key. */
	private readonly groups = new Map<string, Group>();
	/** Transfer keys in order of first appearance (the slots of `lastPositions`). */
	private readonly keys: string[] = [];
	/** The position of each transfer's first event, by slot: non-decreasing, since events arrive in position order. */
	private readonly firstPositions: number[] = [];
	/** The position of each transfer's last event, by slot. */
	private readonly lastPositions = new LastPositions();
	/**
	 * The transfer key each event's row shows the verdict of (its own transferId's, when it has one), by the event's
	 * HASH: unique on the chain, where an `id` is the writer's text and a later record can reuse one.
	 */
	private readonly keyOfEvent = new Map<string, string>();
	/** Each transfer's verdict, until an event is added to it; one scan per transfer, not one per row. */
	private readonly verdicts = new Map<string, TransferStatus | undefined>();

	/**
	 * Add events in chain order, `events[i]` at position `firstPos + i` (the position index's, which only the caller
	 * knows); returns the transfer keys they touched.
	 */
	add(events: readonly PersistedAuditEvent[], firstPos: number): Set<string> {
		const touched = new Set<string>();
		for (let i = 0; i < events.length; i++) {
			const e = events[i] as PersistedAuditEvent;
			const pos = firstPos + i;
			const normalized = normalizeEvent(e);
			const keys = transferKeysOf(normalized);
			const [own] = keys;
			if (own === undefined) continue;
			this.keyOfEvent.set(e.hash, own);
			for (const key of keys) {
				let group = this.groups.get(key);
				if (group === undefined) {
					group = { slot: this.keys.length, events: [], positions: [], rowPositions: [] };
					this.groups.set(key, group);
					this.keys.push(key);
					this.firstPositions.push(pos);
				}
				group.events.push(normalized);
				group.positions.push(pos);
				if (key === own) group.rowPositions.push(pos);
				this.lastPositions.set(group.slot, pos);
				this.verdicts.delete(key);
				touched.add(key);
			}
		}
		return touched;
	}

	/** The transfer key of a row's event (by its hash), or undefined for an event outside any transfer. */
	keyOfRow(eventHash: string): string | undefined {
		return this.keyOfEvent.get(eventHash);
	}

	/** The verdict of one transfer, by key. */
	verdictOfTransfer(key: string): TransferStatus | undefined {
		if (this.verdicts.has(key)) return this.verdicts.get(key);
		const status = transferVerdict(this.groups.get(key)?.events ?? [])?.status;
		this.verdicts.set(key, status);
		return status;
	}

	/**
	 * The verdict of one transfer as recorded at `pos`: `transferVerdict` over its events at positions `<= pos`, the
	 * same classification as `verdictOfTransfer`, over a prefix. Undefined when it has no event by then.
	 */
	verdictAt(key: string, pos: number): TransferStatus | undefined {
		const group = this.groups.get(key);
		if (group === undefined) return undefined;
		const n = countAtOrBefore(group.positions, pos);
		if (n === group.events.length) return this.verdictOfTransfer(key);
		return n === 0 ? undefined : transferVerdict(group.events.slice(0, n))?.status;
	}

	/**
	 * The transfers open across `pos`: a first event at or before it and a last event after it, the only ones whose
	 * verdict at `pos` can differ from now. Each with the positions, at or before `pos`, of the rows that show its
	 * verdict. Found through the last-position tree, never by a pass over every transfer or row.
	 */
	openAcross(pos: number): Array<{ key: string; rowPositions: number[] }> {
		const limit = countAtOrBefore(this.firstPositions, pos);
		return this.lastPositions.above(limit, pos).map((slot) => {
			const key = this.keys[slot] as string;
			const rows = (this.groups.get(key) as Group).rowPositions;
			return { key, rowPositions: rows.slice(0, countAtOrBefore(rows, pos)) };
		});
	}

	/**
	 * The verdict for the transfer `e` belongs to. An event in no transfer (a denial written before any hold) is its
	 * own transfer.
	 */
	readonly verdictOf = (e: PersistedAuditEvent): TransferStatus | undefined => {
		const key = this.keyOfEvent.get(e.hash);
		return key === undefined
			? transferVerdict([normalizeEvent(e)])?.status
			: this.verdictOfTransfer(key);
	};
}

/** How many of the increasing `values` are `<= pos` (binary search). */
function countAtOrBefore(values: readonly number[], pos: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((values[mid] as number) <= pos) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * A max tree over each transfer's last position, by slot: `above(limit, pos)` finds the slots below `limit` whose value
 * is above `pos` by descending only into subtrees whose maximum is, so it costs about log(n) per slot found. Leaves
 * start at -1 (no position); the tree doubles when a slot falls past it.
 */
class LastPositions {
	#capacity = 1024;
	#tree = new Float64Array(2 * 1024).fill(-1);

	set(slot: number, pos: number): void {
		while (slot >= this.#capacity) this.#grow();
		let node = this.#capacity + slot;
		this.#tree[node] = pos;
		for (node >>>= 1; node >= 1; node >>>= 1) {
			this.#tree[node] = Math.max(
				this.#tree[2 * node] as number,
				this.#tree[2 * node + 1] as number,
			);
		}
	}

	above(limit: number, pos: number): number[] {
		const out: number[] = [];
		const visit = (node: number, lo: number, hi: number): void => {
			if (lo >= limit || (this.#tree[node] as number) <= pos) return;
			if (node >= this.#capacity) {
				out.push(lo);
				return;
			}
			const mid = (lo + hi) >>> 1;
			visit(2 * node, lo, mid);
			visit(2 * node + 1, mid, hi);
		};
		visit(1, 0, this.#capacity);
		return out;
	}

	#grow(): void {
		const capacity = this.#capacity * 2;
		const tree = new Float64Array(2 * capacity).fill(-1);
		tree.set(this.#tree.subarray(this.#capacity), capacity);
		for (let node = capacity - 1; node >= 1; node--) {
			tree[node] = Math.max(tree[2 * node] as number, tree[2 * node + 1] as number);
		}
		this.#capacity = capacity;
		this.#tree = tree;
	}
}
