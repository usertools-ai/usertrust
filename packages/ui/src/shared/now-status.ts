// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The status tally as the lines the Now window prints. Pure.
 *
 * Counts and spend are `tallyStatus`'s, in its order; this adds only words. Every word is `statusWord`'s, so a status
 * reads the same here as in the ledger. An unresolved record keeps its dollars: it is inside spend, "recorded, not
 * confirmed", and is never shown under another status.
 */

import type { SpendWindow } from "./breakdown.js";
import type { LedgerRow, RowStatus } from "./rows.js";
import { type DeskStatus, tallyStatus } from "./status-tally.js";
import { statusWord, UNRESOLVED_LINE, UNRESOLVED_TIP } from "./status-word.js";

export interface NowStatusLine {
	status: DeskStatus;
	label: string;
	count: number;
	/** The spend of the status's records, or null when it is 0: no figure is printed then. */
	spendUt: number | null;
	tip?: string;
	note?: string;
}

const NOTES: Partial<Record<DeskStatus, string>> = {
	unrecoverable: "ran and recorded, not charged",
	unknown: "no outcome recorded",
};

export function statusLines(rows: readonly LedgerRow[], win: SpendWindow): NowStatusLine[] {
	return tallyStatus(rows, win).map(({ status, count, spendUt }) => {
		const unresolved = status === "unresolved";
		// `statusWord` takes the stored value: `ambiguous` is what an unresolved record carries.
		const word = statusWord((unresolved ? "ambiguous" : status) as RowStatus);
		const line: NowStatusLine = {
			status,
			label: unresolved ? `${word} · ${UNRESOLVED_LINE}` : word,
			count,
			spendUt: spendUt === 0 ? null : spendUt,
		};
		if (unresolved) line.tip = UNRESOLVED_TIP;
		const note = NOTES[status];
		if (note !== undefined) line.note = note;
		return line;
	});
}
