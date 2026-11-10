// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Spend chart's words, pure: the headline's label, its sub-line, the when-line, the slider's value text and the Now
 * button. Each takes the figures already read from exact records, so the words can be tested without a render and
 * never compute a figure of their own.
 */

import { formatUsdTotal, formatUtc } from "../../../shared/format.js";
import { bucketPhrase, type LineBucket, perShort, toBucket } from "../../../shared/spend-model.js";

/** The separator between the parts of a line. */
export const SEP = " · ";

/** A time as the page writes it; a time that is not one (NaN, out of range) reads as such, never throws. */
export const stamp = (ms: number): string => {
	const d = new Date(ms);
	return Number.isNaN(d.getTime()) ? "unknown time" : formatUtc(d.toISOString());
};

/** A record's number as the Ledger shows it: its vault position plus one, grouped the same on every machine. */
export function recordNumber(pos: number): string {
	return (pos + 1).toLocaleString("en-US");
}

/** `Spend` at rest, `Spend by then` with a cursor or a pin; ` in this view` when some record was filtered away. */
export function headLabel(p: { shown: boolean; filtered: boolean }): string {
	return `${p.shown ? "Spend by then" : "Spend"}${p.filtered ? " in this view" : ""}`;
}

/**
 * The sub-line: the range's spend, then the shown bucket's own spend (`shownUt`, null at rest) or, at rest, the
 * range's peak, both per bucket. Under a filter on a vault the page holds only part of, it says the range starts at
 * the oldest record held. No spend in the window says so instead.
 */
export function subLine(p: {
	empty: boolean;
	rangeUt: number;
	peakRate: number;
	bucket: LineBucket;
	shownUt: number | null;
	filtered: boolean;
	truncated: boolean;
}): string {
	if (p.empty) return "No spend recorded in this range";
	const at =
		p.shownUt !== null
			? `${formatUsdTotal(p.shownUt)} ${bucketPhrase(p.bucket.per)}`
			: `peak ${formatUsdTotal(toBucket(p.peakRate, p.bucket))}${perShort(p.bucket.per)}`;
	const held = p.filtered && p.truncated ? `${SEP}since the oldest record held` : "";
	return `+${formatUsdTotal(p.rangeUt)} in this range${SEP}${at}${held}`;
}

/**
 * Where the line is read: the shown record's time and number (with `Pinned · ` first when it is the pin), or, live,
 * the last spend's time. `shown` is null at rest; its `t` is NaN for a pin with no spend record at or before it.
 */
export function whenLine(p: {
	shown: { t: number; pos: number; pinned: boolean } | null;
	pinnedNoRecord: boolean;
	lastT: number | null;
}): string {
	if (p.pinnedNoRecord) return `Pinned${SEP}no spend recorded by then`;
	if (p.shown !== null) {
		const lead = p.shown.pinned ? `Pinned${SEP}` : "";
		return `${lead}${stamp(p.shown.t)}${SEP}record ${recordNumber(p.shown.pos)}`;
	}
	return p.lastT !== null
		? `Live${SEP}last spend ${stamp(p.lastT)}`
		: `Live${SEP}no spend recorded yet`;
}

/** Whether a shown record is at or after the chain's break, so the when-line says the links are broken from there. */
export function brokenFrom(pos: number | null, breakPos: number | null): boolean {
	return pos !== null && breakPos !== null && pos >= breakPos;
}

/**
 * The slider's value text: the shown record of the vault's `head + 1`, what was spent by it and when, ` · pinned` on
 * the pinned record; at rest the live figure; with no spend in the window, that.
 */
export function valueText(p: {
	empty: boolean;
	shown: { t: number; pos: number; pinned: boolean } | null;
	pinnedNoRecord: boolean;
	head: number;
	cumUt: number;
}): string {
	const fig = formatUsdTotal(p.cumUt);
	// A pin with no spend record at or before it has no time to read, whatever `shown` holds.
	if (p.pinnedNoRecord) return `Pinned${SEP}${fig} spent`;
	if (p.shown !== null) {
		const of = Math.max(1, p.head + 1, p.shown.pos + 1).toLocaleString("en-US");
		const pin = p.shown.pinned ? `${SEP}pinned` : "";
		return `Record ${recordNumber(p.shown.pos)} of ${of}${SEP}${fig} spent by ${stamp(p.shown.t)}${pin}`;
	}
	if (p.empty) return "No spend recorded";
	return `Live${SEP}${fig} spent`;
}

/** The count after Now: ` +N new` when N records were added since the position was chosen, else nothing. */
export function newText(fresh: number): string {
	return fresh > 0 ? ` +${fresh.toLocaleString("en-US")} new` : "";
}

/** The plot's name for assistive tech, in the line's own bucket. */
export function plotLabel(per: string): string {
	return `Spend per ${per} over time: hover to preview, click to pin a record, click again for now`;
}
