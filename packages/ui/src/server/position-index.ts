// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { PersistedAuditEvent } from "usertrust";
import { isHeaderSpend } from "../shared/aggregate.js";

/** What `countsAt` counts: `llm_call` records, denials, and every other record. */
export type PositionCounts = Record<"llm_call" | "denied" | "other", number>;

/**
 * The kinds usertrust-verify reads as a DENIED transfer (`policy_denied`, `ledger_rejected`). Mirrored here because the
 * verifier does not export its set.
 */
const DENIAL_KINDS: ReadonlySet<string> = new Set(["policy_denied", "ledger_rejected"]);

/** 2^16 slots: about 2 MB across the arrays before the first doubling. */
const INITIAL_CAPACITY = 65_536;

/** A time given as input names its zone (`Z` or an offset): one without would be read as local time. */
const ZONED = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * Prefix sums over the WHOLE vault, by position. A position is an event's index in the ordered list the chain is
 * verified over (`loadState`'s `events`, the list a chain break's index points into): an unparseable line takes none,
 * and `sequence` plays no part beyond the order that list already has. Each live append takes the next position.
 *
 * Kept in typed arrays grown by doubling, never as an object per event: 32 bytes per event (cumulative spend, the
 * event's time and the running maximum time as epoch ms, and two cumulative counts), so 1,000,000 events hold 32 MB.
 */
export class PositionIndex {
	#length = 0;
	/** Cumulative `isHeaderSpend` cost over positions `0..p`. */
	#spent = new Float64Array(INITIAL_CAPACITY);
	/** Cumulative counts of `llm_call` records and of denials; `other` is what remains. */
	#llm = new Uint32Array(INITIAL_CAPACITY);
	#denied = new Uint32Array(INITIAL_CAPACITY);
	/** The event's own time (NaN when it does not parse). */
	#ts = new Float64Array(INITIAL_CAPACITY);
	/** The largest time over positions `0..p` (-Infinity before any that parses): non-decreasing, so searchable. */
	#maxTs = new Float64Array(INITIAL_CAPACITY);
	/** Recorded times that `toISOString` would not give back exactly (an offset form, or no time at all). Sparse. */
	#rawTs = new Map<number, string>();

	get length(): number {
		return this.#length;
	}

	/** Records the next event and returns its position. */
	add(e: PersistedAuditEvent): number {
		const pos = this.#length;
		if (pos === this.#spent.length) this.#grow();
		const prev = pos - 1;
		const cost = e.data?.cost;
		const spent = isHeaderSpend(e.kind, cost) ? cost : 0;
		this.#spent[pos] = (prev < 0 ? 0 : (this.#spent[prev] as number)) + spent;
		const llm = e.kind === "llm_call" ? 1 : 0;
		this.#llm[pos] = (prev < 0 ? 0 : (this.#llm[prev] as number)) + llm;
		const denied = DENIAL_KINDS.has(e.kind) ? 1 : 0;
		this.#denied[pos] = (prev < 0 ? 0 : (this.#denied[prev] as number)) + denied;
		const raw: unknown = e.timestamp;
		const t = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
		this.#ts[pos] = t;
		const before = prev < 0 ? Number.NEGATIVE_INFINITY : (this.#maxTs[prev] as number);
		this.#maxTs[pos] = Number.isNaN(t) || t < before ? before : t;
		if (Number.isNaN(t) || new Date(t).toISOString() !== raw) {
			this.#rawTs.set(pos, typeof raw === "string" ? raw : "");
		}
		this.#length = pos + 1;
		return pos;
	}

	/** The sum of `isHeaderSpend` costs over positions `0..pos`. */
	spentUtAt(pos: number): number {
		return this.#spent[this.#check(pos)] as number;
	}

	countsAt(pos: number): PositionCounts {
		const p = this.#check(pos);
		const llm = this.#llm[p] as number;
		const denied = this.#denied[p] as number;
		return { llm_call: llm, denied, other: p + 1 - llm - denied };
	}

	/** The event's time as recorded. */
	tsAt(pos: number): string {
		const p = this.#check(pos);
		return this.#rawTs.get(p) ?? new Date(this.#ts[p] as number).toISOString();
	}

	/**
	 * The last position whose running maximum time is `<= t`, or null before the first event. The search runs over the
	 * running maximum, so a log whose times are out of order (several writers) stays searchable: a position is reached
	 * once every event up to it is at or before `t`. A `t` that names no zone, or does not parse, is a RangeError.
	 */
	positionAt(t: string): number | null {
		const ms = ZONED.test(t) ? Date.parse(t) : Number.NaN;
		if (Number.isNaN(ms)) throw new RangeError(`not a time with a zone: ${JSON.stringify(t)}`);
		let lo = 0;
		let hi = this.#length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if ((this.#maxTs[mid] as number) <= ms) lo = mid + 1;
			else hi = mid;
		}
		return lo === 0 ? null : lo - 1;
	}

	#check(pos: number): number {
		if (!Number.isInteger(pos) || pos < 0 || pos >= this.#length) {
			throw new RangeError(`position ${pos} is outside 0..${this.#length - 1}`);
		}
		return pos;
	}

	#grow(): void {
		const size = this.#spent.length * 2;
		const f64 = (from: Float64Array): Float64Array<ArrayBuffer> => {
			const to = new Float64Array(size);
			to.set(from);
			return to;
		};
		const u32 = (from: Uint32Array): Uint32Array<ArrayBuffer> => {
			const to = new Uint32Array(size);
			to.set(from);
			return to;
		};
		this.#spent = f64(this.#spent);
		this.#ts = f64(this.#ts);
		this.#maxTs = f64(this.#maxTs);
		this.#llm = u32(this.#llm);
		this.#denied = u32(this.#denied);
	}
}
