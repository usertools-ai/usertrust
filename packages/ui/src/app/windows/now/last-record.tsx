// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The newest record on one line: when, its model (or its kind, for a record with none), who, and its cost when it has
 * one. Props only. With no record to show, the line's place is held empty and unseen, so nothing moves when one
 * arrives. Under a filter it is the newest of the filtered records, and its label says so.
 */

import { compactActor, formatUsdTotal, formatUtc } from "../../../shared/format.js";
import { NOW_COPY } from "../../../shared/now-copy.js";
import type { LedgerRow } from "../../../shared/rows.js";

const DAY_MS = 86_400_000;

export function LastRecord(props: {
	row: LedgerRow | null;
	/** The end of the current minute: the day the line is read on. */
	endMs: number;
	/** The record is the newest under a filter, not the vault's newest. */
	filtered?: boolean;
}): React.JSX.Element {
	const { row } = props;
	if (row === null)
		return (
			<p className="ut-nw-last" aria-hidden="true" data-reserve="true">
				{"\u00a0"}
			</p>
		);
	const at = Date.parse(row.ts);
	// A time alone reads as today's, so only a record of this UTC day is given as one. Any other keeps its date, and a
	// time that cannot be read is shown as it was written.
	const today = Math.floor(at / DAY_MS) === Math.floor((props.endMs - 1) / DAY_MS);
	const when = today ? formatUtc(row.ts).slice(6) : formatUtc(row.ts);
	const cost = row.costUt === undefined ? "" : ` · ${formatUsdTotal(row.costUt)}`;
	return (
		<p className="ut-nw-last" title={`record ${row.pos + 1} · ${row.ts}`}>
			<b>{props.filtered === true ? NOW_COPY.lastRecordFiltered : NOW_COPY.lastRecord}</b>
			{` ${when} · ${row.model ?? row.kind} · ${compactActor(row.actor)}${cost}`}
		</p>
	);
}
