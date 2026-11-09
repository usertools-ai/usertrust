// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Records by outcome over a window. Pure, so a test pins it.
 *
 * - `ambiguous` is shown as "unresolved": the charge is recorded, but its outcome is not confirmed. It keeps its cost, so
 *   it stays INSIDE spend as its own line ("recorded, not confirmed"). It is never counted as held or as settled.
 * - Spend has one definition, `isHeaderSpend`, so the spend of every status sums to the breakdown's total. A record that
 *   is not spend-bearing is counted by status and carries no spend.
 * - "held" is listed only if a record ever carries it: no producer writes a hold today.
 * - settled, denied and unresolved are always listed, zeros included.
 */

import { isHeaderSpend } from "./aggregate.js";
import type { SpendWindow } from "./breakdown.js";
import { type LedgerRow, type RowStatus, statusOf } from "./rows.js";

export type DeskStatus =
	| "settled"
	| "held"
	| "denied"
	| "unresolved"
	| Exclude<RowStatus, "settled" | "denied" | "ambiguous">;

export interface StatusLine {
	status: DeskStatus;
	count: number;
	spendUt: number;
}

/** The desk's name for a record's outcome. Typed as text because a hold is not a `RowStatus` yet. */
function deskStatusOf(row: LedgerRow): DeskStatus {
	const s: string = statusOf(row);
	return (s === "ambiguous" ? "unresolved" : s) as DeskStatus;
}

export function tallyStatus(rows: readonly LedgerRow[], win: SpendWindow): StatusLine[] {
	const by = new Map<DeskStatus, { count: number; spendUt: number }>();
	for (const row of rows) {
		const t = Date.parse(row.ts);
		if (!(t >= win.startMs && t < win.endMs)) continue;
		const status = deskStatusOf(row);
		const line = by.get(status) ?? { count: 0, spendUt: 0 };
		line.count += 1;
		if (isHeaderSpend(row.kind, row.costUt)) line.spendUt += row.costUt;
		by.set(status, line);
	}
	const lineOf = (status: DeskStatus): StatusLine => ({
		status,
		count: by.get(status)?.count ?? 0,
		spendUt: by.get(status)?.spendUt ?? 0,
	});
	const out: StatusLine[] = [lineOf("settled")];
	if (by.has("held")) out.push(lineOf("held"));
	out.push(lineOf("denied"), lineOf("unresolved"));
	const listed = new Set<DeskStatus>(["settled", "held", "denied", "unresolved"]);
	const rest = [...by.keys()].filter((s) => !listed.has(s)).sort();
	for (const s of rest) out.push(lineOf(s));
	return out;
}
