// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Spend chart's keys and which cursor is drawn, pure: what a key asks for, the step arithmetic, and the precedence
 * between the live cursor, another window's moment and the pin. The component only applies the answers.
 */

import { indexAtPos, type SpendRecords, stepIndex } from "../../../shared/cumulative.js";
import type { CursorValue } from "../../../shared/cursor-store.js";

/** What a key on the plot asks for; null when the plot leaves the key alone. */
export type KeyAction =
	| { type: "bucket"; by: number }
	| { type: "record"; by: number }
	| { type: "home" }
	| { type: "end" }
	| { type: "toggle" }
	| { type: "escape" };

/**
 * Left/Right move one bucket (Shift: ten); Up/Down one record, Up forward (Shift: a hundred); Home/End the window's
 * first and last bucket; Enter or Space pin or unpin; Escape goes back. A key held with Ctrl, Meta or Alt is a
 * shortcut of the page's, never the plot's.
 */
export function keyAction(e: {
	key: string;
	shiftKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
}): KeyAction | null {
	if (e.ctrlKey || e.metaKey || e.altKey) return null;
	switch (e.key) {
		case "ArrowLeft":
			return { type: "bucket", by: e.shiftKey ? -10 : -1 };
		case "ArrowRight":
			return { type: "bucket", by: e.shiftKey ? 10 : 1 };
		case "ArrowUp":
			return { type: "record", by: e.shiftKey ? 100 : 1 };
		case "ArrowDown":
			return { type: "record", by: e.shiftKey ? -100 : -1 };
		case "Home":
			return { type: "home" };
		case "End":
			return { type: "end" };
		case "Enter":
		case " ":
			return { type: "toggle" };
		case "Escape":
			return { type: "escape" };
		default:
			return null;
	}
}

/** Bucket `k` moved by `by`, kept on the line's `nB` buckets; -1 when the line has none. */
export function stepBucket(k: number, by: number, nB: number): number {
	if (!(nB > 0)) return -1;
	const j = Number.isFinite(k) ? k + by : 0;
	return Math.min(nB - 1, Math.max(0, j));
}

/** The bucket a time falls in, kept on the line's buckets (the window's end is in the last one). */
export function bucketOf(t: number, startMs: number, bucketMs: number, nB: number): number {
	if (!(nB > 0) || !(bucketMs > 0)) return 0;
	const k = Math.floor((t - startMs) / bucketMs);
	return Math.min(nB - 1, Math.max(0, Number.isFinite(k) ? k : 0));
}

/** Whether the cursor is the live one, a pointer's or the keys'. */
export function isLiveCursor(v: CursorValue | null): v is CursorValue & { via: "pointer" | "key" } {
	return v !== null && (v.via === "pointer" || v.via === "key");
}

/**
 * What the store holds, so what is drawn: a live cursor wins, then another window's moment inside this window, then
 * the pinned record inside it, else nothing.
 */
export function drawnCursor(
	live: CursorValue | null,
	sync: CursorValue | null,
	pin: CursorValue | null,
): CursorValue | null {
	if (isLiveCursor(live)) return live;
	return sync ?? pin;
}

/**
 * What Enter or Space does with the live cursor on record `i`: go live when that record is the one pinned, else pin
 * it; nothing without a live cursor.
 */
export function toggleTarget(
	liveI: number,
	pinI: number,
	pinned: boolean,
): "live" | "pin" | "none" {
	if (liveI < 0) return "none";
	return pinned && liveI === pinI ? "live" : "pin";
}

/** What Escape does: go live when pinned, else clear a keyboard cursor, else nothing (the page's own Escape runs). */
export function escapeTarget(
	pinned: boolean,
	via: CursorValue["via"] | null,
): "live" | "clear" | "none" {
	if (pinned) return "live";
	return via === "key" ? "clear" : "none";
}

/**
 * The key the marks' wrapper is remounted by, so the one fade runs: every filter change, and the move between no rows
 * and some. Never the window, which the clock moves, so a live append never fades.
 */
export function frameKey(filterKey: string, empty: boolean): string {
	return `${filterKey}|${empty}`;
}

/**
 * A live cursor against a newer model of the same rows (a live append, a filter, a window one bucket later): the same
 * record when it is still inside the span, in the bucket of its time on the new line; null when the record is gone,
 * and the cursor must be dropped. `prevPos` is the position of the record the cursor was on, read from the old model.
 *
 * A cursor placed by a key may rest on a bucket that holds no record (a bucket step across an empty stretch lands on
 * the record nearest it). `next.key` carries that bucket: the one holding the old bucket's start time on the new line
 * is kept while it still resolves to the same record, so rows streaming in never send the cursor back.
 */
export function reconcileCursor(
	v: CursorValue | null,
	prevPos: number | undefined,
	next: {
		records: SpendRecords;
		span: { i0: number; i1: number };
		bucketOf(t: number): number;
		key?: {
			prevStartMs: number;
			startMs: number;
			bucketMs: number;
			recordIn(k: number): number;
		};
	},
): CursorValue | null {
	if (!isLiveCursor(v) || prevPos === undefined) return null;
	const i = indexAtPos(next.records, prevPos);
	if (i < next.span.i0 || i > next.span.i1 || next.records.pos[i] !== prevPos) return null;
	const own = next.bucketOf(next.records.t[i] as number);
	const key = next.key;
	if (
		v.via === "key" &&
		key !== undefined &&
		Number.isFinite(key.prevStartMs) &&
		key.bucketMs > 0
	) {
		const k = next.bucketOf(key.prevStartMs);
		const start = key.startMs + k * key.bucketMs;
		if (
			key.prevStartMs >= start &&
			key.prevStartMs < start + key.bucketMs &&
			key.recordIn(k) === i
		) {
			return { k, via: v.via, i };
		}
	}
	return { k: own, via: v.via, i };
}

/** The time to republish when a kept cursor's record now reads a different time (a running maximum shifts when a filter drops an earlier row); null when it is unchanged. */
export function movedTime(was: number | undefined, now: number | undefined): number | null {
	if (now === undefined || Number.isNaN(now)) return null;
	return now === was ? null : now;
}

/** Where a movement key puts the cursor: on record `i`, or in bucket `k` (the component finds the record in it). */
export type KeyMove = { to: "record"; i: number } | { to: "bucket"; k: number };

/**
 * A movement key's answer. With no live cursor the first press shows it where the line is read from: the pin when it
 * is inside the span, else the newest record. With one, a bucket key steps the bucket and a record key the record
 * (clamped to the span); Home and End are the first and last bucket. `liveK` is null unless a live cursor is drawn.
 */
export function keyMove(
	act: KeyAction,
	s: {
		liveI: number;
		liveK: number | null;
		pinI: number;
		span: { i0: number; i1: number };
		buckets: number;
	},
): KeyMove | null {
	const { span } = s;
	if (span.i1 < span.i0) return null;
	const inSpan = (i: number): boolean => i >= span.i0 && i <= span.i1;
	const base = s.liveI >= 0 ? s.liveI : inSpan(s.pinI) ? s.pinI : span.i1;
	switch (act.type) {
		case "bucket":
			if (s.liveI < 0 || s.liveK === null) return { to: "record", i: base };
			return { to: "bucket", k: stepBucket(s.liveK, act.by, s.buckets) };
		case "record":
			return {
				to: "record",
				i: s.liveI < 0 ? base : stepIndex(s.liveI, act.by > 0 ? 1 : -1, Math.abs(act.by), span),
			};
		case "home":
			return { to: "bucket", k: 0 };
		case "end":
			return { to: "bucket", k: s.buckets - 1 };
		default:
			return null;
	}
}
