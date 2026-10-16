// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Display formatting shared by every view. Pure, so it stays unit-tested: one formatter per quantity, so the
 * header, the rows, the inspector and Trends cannot print the same figure two ways.
 */

import { UT_TO_USD } from "./rows.js";

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * `MM-DD HH:MM:SSZ`: the UTC date and time, with the `Z` that says so. The date filters compare the UTC date
 * (`filters.ts`), so the date a row shows is the date it is filtered under. An unreadable timestamp is shown as it
 * was written, never as a made-up time.
 */
export function formatUtc(iso: string): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	const d = new Date(t);
	return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z`;
}

/**
 * The UTC date `YYYY-MM-DD` of a timestamp: what the date filters compare, and the date `formatUtc` shows. A
 * timestamp written with an offset is converted, not sliced; an unreadable one keeps its first ten characters.
 */
export function utcDay(iso: string): string {
	const t = Date.parse(iso);
	return Number.isNaN(t) ? iso.slice(0, 10) : new Date(t).toISOString().slice(0, 10);
}

/** The UTC hour bucket `YYYY-MM-DD HH:00` of a timestamp: converted like `utcDay`, never sliced. */
export function utcHour(iso: string): string {
	const t = Date.parse(iso);
	const s = Number.isNaN(t) ? iso : new Date(t).toISOString();
	return `${s.slice(0, 10)} ${s.slice(11, 13)}:00`;
}

/** `YYYY-MM-DD HH:MMZ` at the UTC instant; an unreadable timestamp is shown as it was written. */
export function formatUtcMinute(iso: string): string {
	const t = Date.parse(iso);
	return Number.isNaN(t) ? iso : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

/** Usertokens, with their unit. */
export function formatUt(ut: number): string {
	return `${ut.toLocaleString()} UT`;
}

/**
 * Dollars at 4 dp: 1 UT is exactly $0.0001, so 4 dp is exact. The header printed 2 dp and the rows 4, so a $0.0097
 * call summed into a "$0.95" that no row added up to.
 */
export function formatUsd(ut: number): string {
	return `$${(ut * UT_TO_USD).toFixed(4)}`;
}

/**
 * An actor `name:instance` as `name · first 8 of instance`. A fixed-width cell cut "claude-code:5f1c2a9e-…" to
 * "claude-code:5f…", which is exactly the part that tells two sessions apart. The full value stays in the tooltip
 * and the inspector.
 */
export function compactActor(actor: string): string {
	const m = /^(.+):([^:]+)$/.exec(actor);
	return m === null ? actor : `${m[1]} · ${(m[2] as string).slice(0, 8)}`;
}

/** Keep both ends of a long string (a path's root and its vault directory), eliding the middle. */
export function middleTruncate(s: string, max: number): string {
	if (s.length <= max) return s;
	const keep = max - 1;
	const head = Math.ceil(keep / 2);
	return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`;
}
