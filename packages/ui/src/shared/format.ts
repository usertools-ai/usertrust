// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Display formatting shared by every view. Pure, so it stays unit-tested: one formatter per quantity, so the
 * header, the rows, the inspector and Trends cannot print the same figure two ways.
 */

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

/** The one-line key, said wherever usertokens are shown. */
export const UT_KEY = "1 UT = $0.0001, one hundredth of a cent";

/** Usertokens in a dollar: 1 UT is exactly $0.0001. */
const UT_PER_DOLLAR = 10_000n;

/**
 * Dollars from a usertoken count, by integer arithmetic only: 1 UT is exactly $0.0001, so a count is never
 * multiplied by 0.0001 (a float), and a large vault's figure cannot drift. `dp` is 2 or 4; the cut to 2 dp rounds
 * half up on the magnitude. The whole part is grouped with commas. A count that is not finite has no dollar figure.
 */
function dollarsFromUt(ut: number, dp: 2 | 4): string {
	if (!Number.isFinite(ut)) return "n/a";
	const total = BigInt(Math.round(Math.abs(ut)));
	const scale = dp === 4 ? 1n : 100n;
	const units = (total + scale / 2n) / scale;
	const per = UT_PER_DOLLAR / scale;
	const whole = (units / per).toString().replace(/\B(?=(\d{3})+$)/g, ",");
	const frac = (units % per).toString().padStart(dp, "0");
	return `${ut < 0 && units > 0n ? "-" : ""}$${whole}.${frac}`;
}

/**
 * Dollars at 4 dp, for one call or one record: 1 UT is exactly $0.0001, so 4 dp is exact, and a call can cost under
 * a cent. The header printed 2 dp and the rows 4, so a $0.0097 call summed into a "$0.95" that no row added up to.
 */
export function formatUsd(ut: number): string {
	return dollarsFromUt(ut, 4);
}

/**
 * Dollars at 2 dp with grouping, for a total (`$7.60`, `$1,204.55`). Its exact 4 dp figure is `formatUsd`, for the
 * tooltip beside it.
 */
export function formatUsdTotal(ut: number): string {
	return dollarsFromUt(ut, 2);
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
