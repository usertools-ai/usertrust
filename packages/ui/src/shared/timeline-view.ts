// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The timeline's words and steps. Pure: the label for the position shown, where a key moves it, and how many records
 * have arrived since it was chosen.
 */

import type { AtPayload } from "./api.js";
import { formatUtc } from "./format.js";

/** The keys the timeline moves by itself (the browser's own steps for them differ). */
export type StepKey = "ArrowLeft" | "ArrowRight" | "PageUp" | "PageDown" | "Home" | "End";

const STEP_KEYS: ReadonlySet<string> = new Set<StepKey>([
	"ArrowLeft",
	"ArrowRight",
	"PageUp",
	"PageDown",
	"Home",
	"End",
]);

export function isStepKey(key: string): key is StepKey {
	return STEP_KEYS.has(key);
}

/**
 * The time a record carries, as the rows show it (`formatUtc`), with the year in front when it is not the year of
 * `nowIso`: the rows' `MM-DD` never needs one, a point a year back does.
 */
function recordedAt(ts: string, nowIso: string): string {
	const t = Date.parse(ts);
	const now = Date.parse(nowIso);
	if (Number.isNaN(t) || Number.isNaN(now)) return formatUtc(ts);
	const year = new Date(t).getUTCFullYear();
	return year === new Date(now).getUTCFullYear() ? formatUtc(ts) : `${year}-${formatUtc(ts)}`;
}

/**
 * What the screen shows: `Live`, or the time of the record at the position shown. "As recorded", never "verified": a
 * past view is what the vault held there, and the dashboard is not an anchored check. A position asked for past the
 * head is answered with the head, and says so.
 */
export function timelineLabel(at: AtPayload | null, nowIso: string): string {
	if (at === null) return "Live";
	return `As recorded at ${recordedAt(at.ts, nowIso)}${at.clamped ? " (latest record)" : ""}`;
}

/**
 * Where a key moves the timeline from `pos`, within `0..head`. The arrows move one position; PageUp and PageDown move
 * 5% of the positions (`head + 1`), rounded up, so a short vault still moves; Home and End go to the ends.
 */
export function stepFor(key: StepKey, pos: number, head: number): number {
	// Integer arithmetic: 0.05 * 60 is 3.0000000000000004, which rounds up to 4.
	const page = Math.ceil((head + 1) / 20);
	const next =
		key === "ArrowLeft"
			? pos - 1
			: key === "ArrowRight"
				? pos + 1
				: key === "PageUp"
					? pos + page
					: key === "PageDown"
						? pos - page
						: key === "Home"
							? 0
							: head;
	return Math.min(head, Math.max(0, next));
}

/**
 * Records added since the position shown was chosen: the live head minus the head the position was answered at
 * (`AtFollower` keeps that head while it re-reads the position). 0 when live.
 */
export function newSince(at: AtPayload | null, head: number): number {
	return at === null ? 0 : Math.max(0, head - at.head);
}

/** Why `/api/at` gave no answer, in a few words: a status code, or null when the dashboard did not answer at all. */
export function atFailureText(status: number | null): string {
	if (status === null) return "the dashboard did not answer";
	if (status === 400) return "the dashboard did not accept that position";
	if (status === 404) return "the vault has no records";
	return "the dashboard could not read the vault at that point";
}

/**
 * The label for the answer shown against the live head: a clamped answer ("latest record") stops saying so once
 * records have arrived after it.
 */
export function shownLabel(at: AtPayload | null, head: number, nowIso: string): string {
	if (at === null || !at.clamped || newSince(at, head) === 0) return timelineLabel(at, nowIso);
	return timelineLabel({ ...at, clamped: false }, nowIso);
}

/**
 * The slider's `aria-valuetext`: `Live`, or the record the thumb is on (counted from 1, of the live count) and, only
 * when the screen shows that record, its label. A thumb the answer has not caught up with says `loading`, so a
 * screen reader never hears the previous position's time for a new position.
 */
export function timelineValueText(
	value: number | null,
	head: number,
	shown: AtPayload | null,
	nowIso: string,
): string {
	if (value === null) return "Live";
	const record = `Record ${(value + 1).toLocaleString()} of ${(head + 1).toLocaleString()}`;
	if (shown === null || shown.pos !== value) return `${record} · loading`;
	return `${record} · ${shownLabel(shown, head, nowIso)}`;
}
