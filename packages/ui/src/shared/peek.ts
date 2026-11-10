// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * What the record panel works out about one record from the records around it. Pure.
 *
 * The records show counts and times, never a cause, so a busy hour is only ever "unusual": the note gives the
 * count and the usual count and leaves the reason to the reader.
 */

import type { AtPayload, SummaryPayload } from "./api.js";
import type { LedgerRow } from "./rows.js";

const HOUR_MS = 3_600_000;
/** The hours before a record's hour that make "the usual": one week. */
const USUAL_HOURS = 168;

/** An hour is unusual only with at least this many calls in it. */
export const UNUSUAL_MIN = 8;
/** And only at this many times the usual hourly count (a usual under 1 counts as 1). */
export const UNUSUAL_FACTOR = 3;

export interface UnusualNote {
	/** The calls in the record's hour by its actor to its model. */
	calls: number;
	/** The usual calls an hour over the week before, rounded, and never below 1: the figure the test used. */
	usual: number;
	/** The sentence shown. */
	text: string;
}

/**
 * Whether `row`'s actor called `row`'s model unusually often in `row`'s hour, or null when there is nothing to say.
 *
 * Counted over the records of `rows` with the same actor, model and kind as `row`: `calls` are those in the UTC
 * hour `[h0, h0 + 1h)` that holds `row`, and the usual is those in the 168 hours before `h0`, divided by 168. A
 * record whose time cannot be read is in neither count. Null for a record with no model or no readable time.
 *
 * `rows` are the records held: a vault with more history than is held gives a lower usual than the whole vault
 * would, so the note can be said where the full history would not say it, never the other way round.
 */
export function unusualNote(rows: readonly LedgerRow[], row: LedgerRow): UnusualNote | null {
	if (row.model === undefined) return null;
	const t = Date.parse(row.ts);
	if (!Number.isFinite(t)) return null;
	const h0 = Math.floor(t / HOUR_MS) * HOUR_MS;
	const h1 = h0 + HOUR_MS;
	const w0 = h0 - USUAL_HOURS * HOUR_MS;
	let calls = 0;
	let before = 0;
	for (const r of rows) {
		if (r.actor !== row.actor || r.model !== row.model || r.kind !== row.kind) continue;
		const u = Date.parse(r.ts);
		// An unreadable time is NaN, which is in neither range.
		if (u >= h0 && u < h1) calls++;
		else if (u >= w0 && u < h0) before++;
	}
	const rawUsual = before / USUAL_HOURS;
	if (calls < UNUSUAL_MIN || calls < UNUSUAL_FACTOR * Math.max(1, rawUsual)) return null;
	const usual = Math.max(1, Math.round(rawUsual));
	// A usual under half a call an hour is said as "under 1": rounded up to 1 it would be a figure it is not.
	const said = rawUsual < 0.5 ? "under 1" : String(usual);
	return {
		calls,
		usual,
		text: `Unusual: ${calls} calls from ${row.actor} to ${row.model} in this hour (usual ${said})`,
	};
}

/**
 * The record's cost as a share of the budget, with the decimals a small share needs to not read as zero: 1 at 1%
 * and above, 3 at 0.01% and above, else 5. Null without a cost, or without a budget above 0 to be a share of.
 */
export function budgetShare(costUt: number | undefined, budgetUt: number | null): string | null {
	if (costUt === undefined || budgetUt === null || !(budgetUt > 0)) return null;
	const p = (costUt / budgetUt) * 100;
	if (!Number.isFinite(p)) return null;
	const digits = p >= 1 ? 1 : p >= 0.01 ? 3 : 5;
	return `${p.toFixed(digits)}% of the budget`;
}

export interface BudgetView {
	/** The budget in usertokens, or null when it is unknown. Never 0 standing in for unknown. */
	ut: number | null;
	/** Where the budget came from, in the words shown beside it. Empty only while nothing is loaded. */
	provenance: string;
	/** What a past position says about its budget (it is the budget in force now), or null for the live view. */
	note: string | null;
}

/**
 * The budget the panel reads a share against. At a past position (`at` is not null) it is that answer's own budget,
 * with its note; live, it is the summary's. With neither loaded there is no budget and nothing is claimed about one.
 */
export function budgetOf(
	summary: Pick<SummaryPayload, "budget" | "budgetProvenance"> | null,
	at: Pick<AtPayload, "budget"> | null,
): BudgetView {
	if (at !== null) {
		return { ut: at.budget.ut, provenance: at.budget.provenance, note: at.budget.note };
	}
	if (summary === null) return { ut: null, provenance: "", note: null };
	return { ut: summary.budget, provenance: summary.budgetProvenance, note: null };
}

/**
 * The hash of the record before (`-1`) or after (`1`) the one with `hash`, in the order shown. Null at either end,
 * and for a hash that is not in the order.
 */
export function stepRecord(
	order: readonly { hash: string }[],
	hash: string,
	dir: -1 | 1,
): string | null {
	const i = order.findIndex((r) => r.hash === hash);
	if (i < 0) return null;
	return order[i + dir]?.hash ?? null;
}

/**
 * Whether a record's time falls in `span`, the half-open `[span[0], span[1])` in ms. False with no span and for a
 * time that cannot be read.
 */
export function rowInSpan(ts: string, span: readonly [number, number] | null): boolean {
	if (span === null) return false;
	const t = Date.parse(ts);
	return t >= span[0] && t < span[1];
}
