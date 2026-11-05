// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Display formatting shared by every view. Pure, so it stays unit-tested: one formatter per quantity, so the
 * header, the rows, the inspector and Trends cannot print the same figure two ways.
 */

// The usertoken and dollar formatters live in core, so the command line, the demo and this ledger print one figure one way.
// The `usertrust/receipt` entry point is pure, so it is safe in the browser bundle.
import { dollarsFromUt, formatUsd, formatUt } from "usertrust/receipt";

export { formatUsd, formatUt };

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

/** The one-line key, said wherever usertokens are shown. */
export const UT_KEY = "1 UT = $0.0001, one hundredth of a cent";

/**
 * Dollars at 2 dp with grouping, for a total (`$7.60`, `$1,204.55`). Its exact 4 dp figure is `formatUsd`, for the
 * tooltip beside it.
 */
export function formatUsdTotal(ut: number): string {
	// A nonzero total under a cent (1-99 UT) keeps 4 dp: at 2 dp it would read "$0.00" (or a rounded "$0.01"), and
	// "overspent by $0.00" contradicts itself.
	return dollarsFromUt(ut, ut !== 0 && Math.abs(ut) < 100 ? 4 : 2);
}

/**
 * A dollar echo for a bound the reader typed in usertokens: `≈ $0.50`. Under a cent (100 UT) a 2 dp figure would
 * read `$0.00` or `$0.01`, so it keeps 4 dp there.
 */
export function formatUsdApprox(ut: number): string {
	return `≈ ${Math.abs(ut) >= 100 ? formatUsdTotal(ut) : formatUsd(ut)}`;
}

/**
 * The active-filter chip for a cost bound: the bound as typed (the ledger's unit) with its dollar echo. A cost bound
 * hides every row WITHOUT a cost (an unknown cost is not 0), and the chip says so.
 */
export function costBoundLabel(op: "≥" | "≤", ut: number): string {
	return `cost ${op} ${ut} UT ${formatUsdApprox(ut)} · uncosted hidden`;
}

/**
 * The cost axis plots whole usertokens, so its ticks are whole too. With decimals allowed, a 1 UT tallest bar gets
 * ticks at 0, 0.25, 0.5, 0.75 and 1, and the dollar labels (exact to 1 UT) repeat and misstate their heights.
 * Kept here, beside `formatUsdAxis`, so a test can import it without the chart's JSX module.
 */
export const Y_AXIS_ALLOW_DECIMALS = false;

/** A chart axis tick in dollars: 4 dp with trailing zeros dropped, never fewer than 2 dp (`$2.00`, `$0.0005`). */
export function formatUsdAxis(ut: number): string {
	return formatUsd(ut).replace(/(\.\d\d)(\d*?)0+$/, "$1$2");
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
