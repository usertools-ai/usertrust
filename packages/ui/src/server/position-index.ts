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

/**
 * A time given as input: ISO-8601 extended form, a date AND a time, with its zone (`Z` or a `±hh:mm` offset), seconds and
 * a fraction optional. A time with no zone would be read as local time; a date alone, as UTC midnight, by accident.
 */
const ZONED_ISO =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Epoch ms for a time given as input (`ZONED_ISO`), or NaN when it is not one. Every field is checked against the
 * instant it names, so a date the calendar does not have (Feb 30, hour 24) is NaN, never rolled over to another day.
 */
export function parseZonedTime(t: string): number {
	const m = ZONED_ISO.exec(t);
	if (m === null) return Number.NaN;
	const [, y, mo, d, h, mi, s, sign, oh, om] = m;
	const ms = Date.parse(t);
	if (Number.isNaN(ms) || Number(oh ?? 0) > 23 || Number(om ?? 0) > 59) return Number.NaN;
	const offsetMin = (sign === "-" ? -1 : 1) * (Number(oh ?? 0) * 60 + Number(om ?? 0));
	// The wall clock the input names, read back from the instant: any field out of range shows as a difference.
	const wall = new Date(ms + offsetMin * 60_000);
	const same =
		wall.getUTCFullYear() === Number(y) &&
		wall.getUTCMonth() + 1 === Number(mo) &&
		wall.getUTCDate() === Number(d) &&
		wall.getUTCHours() === Number(h) &&
		wall.getUTCMinutes() === Number(mi) &&
		wall.getUTCSeconds() === Number(s ?? 0);
	return same ? ms : Number.NaN;
}

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
	/** The time of the first event whose time parses, or NaN while none does. */
	#firstTimedMs = Number.NaN;

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
		if (Number.isNaN(this.#firstTimedMs) && !Number.isNaN(t)) this.#firstTimedMs = t;
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
	 * The time of the first event whose recorded time parses, as epoch ms, or null when none does. When the first
	 * event's time does not parse, `positionAt` never answers null (that event's running maximum is -Infinity, at or
	 * before any time), so a caller that needs "before the first record" compares with this.
	 */
	get firstTimedMs(): number | null {
		return Number.isNaN(this.#firstTimedMs) ? null : this.#firstTimedMs;
	}

	/**
	 * The latest recorded time over positions `0..pos`, as epoch ms (the event's own time, in a log written in order), or
	 * null when no time up to it parses. The instant the position stands for: what `positionAt` searches over.
	 */
	timeMsAt(pos: number): number | null {
		const ms = this.#maxTs[this.#check(pos)] as number;
		return ms === Number.NEGATIVE_INFINITY ? null : ms;
	}

	/**
	 * The last position whose running maximum time is `<= t`, or null before the first event. The search runs over the
	 * running maximum, so a log whose times are out of order (several writers) stays searchable: a position is reached
	 * once every event up to it is at or before `t`. A `t` that is not a zoned ISO-8601 time (`parseZonedTime`) is a
	 * RangeError.
	 */
	positionAt(t: string): number | null {
		const ms = parseZonedTime(t);
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
