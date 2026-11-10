// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The month's spend day by day, and when the budget is reached: both carried forward at the past week's pace. Pure.
 *
 * Each is a projection, not a promise: it assumes the average of the 7 days before `endMs` holds, and says so. A
 * budget that is not known gives no projection at all.
 *
 * A vault whose first spend record is under 7 days old has no week to average: its spend is averaged over its own
 * age, and never over less than one day. Under one day of history there is no date for the budget at all.
 */

import { isHeaderSpend } from "./aggregate.js";
import type { SummaryPayload } from "./api.js";
import { budgetAsOf, budgetDisplay } from "./budget-display.js";
import { formatUsdTotal, formatUtc } from "./format.js";
import { NOW_COPY, weekPaceWords, wholeVaultProjection, youngPaceWords } from "./now-copy.js";
import { HOUR_MS, reachesBack } from "./now-rate.js";
import type { LedgerRow } from "./rows.js";
import { bucketTotals } from "./spend-series.js";

const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

interface Pace {
	/** Spend per day over the 7 days before `endMs`, half-open, averaged over `days`. */
	utPerDay: number;
	/** Days since the first spend record: 7 or more is a whole week of history. With no such record, infinite. */
	ageDays: number;
}

function weekPace(rows: readonly LedgerRow[], endMs: number, wholeWeek = false): Pace {
	const week = bucketTotals(rows, { startMs: endMs - WEEK_MS, endMs }, WEEK_MS);
	let firstMs = Number.POSITIVE_INFINITY;
	for (const row of rows) {
		if (!isHeaderSpend(row.kind, row.costUt)) continue;
		const t = Date.parse(row.ts);
		// A time that cannot be read is NaN, and NaN is below nothing: such a record does not age the vault. Nor
		// does one dated at or after `endMs`.
		if (t < endMs && t < firstMs) firstMs = t;
	}
	const ageDays = Number.isFinite(firstMs) ? (endMs - firstMs) / DAY_MS : Number.POSITIVE_INFINITY;
	// Rows that reach back over the week say the vault is at least a week old, whatever its oldest held spend says.
	const days = wholeWeek ? 7 : Math.min(7, Math.max(1, ageDays));
	return {
		utPerDay: (week[0] as number) / days,
		ageDays: wholeWeek ? Math.max(7, ageDays) : ageDays,
	};
}

/** Whether `rows` reach back over the whole week before `endMs` (see `reachesBack`). */
export function coversWeek(rows: readonly LedgerRow[], endMs: number): boolean {
	return reachesBack(rows, endMs, WEEK_MS);
}

export interface MonthBurn {
	/** Days in the UTC month of `endMs`. */
	days: number;
	/** Cumulative spend at the end of each UTC day begun so far; the last is up to `endMs`. */
	pts: number[];
	/** Where the curve starts: the vault's spend before the month, or 0 when that is not known. */
	startUt: number;
	inMonthUt: number;
	paceUtPerDay: number;
	/** The last point carried to the month's end at `paceUtPerDay`: a projection. */
	endUt: number;
}

/**
 * `wholeVaultSpentUt` is the vault's spend over every record, or null when `rows` are a filtered part of it: the
 * curve then starts at 0 and is those records' month alone.
 */
export function monthBurn(
	rows: readonly LedgerRow[],
	endMs: number,
	wholeVaultSpentUt: number | null,
): MonthBurn {
	const end = new Date(endMs);
	const monthStart = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1);
	const monthEnd = Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 1);
	const perDay = bucketTotals(rows, { startMs: monthStart, endMs }, DAY_MS);
	let inMonthUt = 0;
	for (const ut of perDay) inMonthUt += ut;
	// What the vault has spent beyond this month's dated records is drawn as spent before the month. That takes in
	// spend with no readable time and spend dated at or after `endMs`: neither can be placed on a day drawn here.
	const startUt = wholeVaultSpentUt === null ? 0 : Math.max(0, wholeVaultSpentUt - inMonthUt);
	const pts: number[] = [];
	let acc = startUt;
	// One point per day begun: at a day's first instant that day has a point and no spend yet.
	for (let i = 0; i < end.getUTCDate(); i++) {
		acc += perDay[i] ?? 0;
		pts.push(acc);
	}
	const paceUtPerDay = weekPace(rows, endMs).utPerDay;
	return {
		days: Math.round((monthEnd - monthStart) / DAY_MS),
		pts,
		startUt,
		inMonthUt,
		paceUtPerDay,
		endUt: acc + (paceUtPerDay * (monthEnd - endMs)) / DAY_MS,
	};
}

/**
 * When the budget is reached at the past week's pace, as a sentence and its tooltip. `rows` are the whole vault's: a
 * whole-vault budget is set against a whole-vault pace. Null when there is no summary, when the budget is not known
 * (the Budget fact gives the reason), or when the day is past what a date can hold.
 *
 * `filtered`: the figures beside the sentence are a filter's. The projection is not, and its opening then says it
 * is the whole vault's.
 *
 * `cut`: `rows` are only the newest of the vault's records. They give the week's pace only when they reach back over
 * the whole week (the vault is then at least a week old, whatever its oldest held spend says); when they do not, no
 * pace can be stated of the vault and there is no projection.
 */
export function projectionOf(
	summary: SummaryPayload | null,
	rows: readonly LedgerRow[],
	endMs: number,
	filtered = false,
	cut = false,
): { text: string; title: string } | null {
	if (summary === null || budgetDisplay(summary).kind === "unknown") return null;
	if (cut && !coversWeek(rows, endMs)) return null;
	const left = summary.remainingUt as number;
	const { utPerDay: paceUtPerDay, ageDays } = weekPace(rows, endMs, cut);
	const young = ageDays < 7;
	// The pace is named by the day: by the hour a small one would print as nothing.
	const perDay = `${formatUsdTotal(paceUtPerDay)}/day`;
	const assumes = young ? youngPaceWords(perDay, ageDays) : weekPaceWords(perDay);
	// A controller's record is named by its age: its provenance sentence says more than an old record can.
	const title = `A projection, not a forecast: it assumes ${assumes} holds. Budget: ${budgetAsOf(summary, endMs).text}`;
	const say = (sentence: string): { text: string; title: string } => ({
		text: filtered ? wholeVaultProjection(sentence) : sentence,
		title,
	});
	if (left <= 0) return say(NOW_COPY.projectionUsed);
	if (!(paceUtPerDay > 0)) return say(NOW_COPY.projectionIdle);
	// Under a day of history is too little to date a budget by: no line, as with a budget that is not known.
	if (ageDays < 1) return null;
	const daysLeft = left / paceUtPerDay;
	const when = new Date(endMs + daysLeft * DAY_MS);
	if (Number.isNaN(when.getTime())) return null;
	const iso = when.toISOString();
	// A month and a day name one date only within a year; further out the year is printed.
	const date = daysLeft < 365 ? formatUtc(iso).slice(0, 5) : iso.slice(0, iso.indexOf("T"));
	return say(
		`${NOW_COPY.projectionLead} reaches ${formatUsdTotal(summary.budget as number)} on ${date} at ${young ? NOW_COPY.projectionPaceYoung : NOW_COPY.projectionPaceWeek}`,
	);
}
