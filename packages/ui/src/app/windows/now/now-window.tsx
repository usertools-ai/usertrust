// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Now window: the vault's facts, and what it is doing now.
 *
 * It holds two readings, and each says which it is. Spend, Budget and Integrity are read AT the shown position (the
 * summary, or a past position's answer). The rate, its line, the projection and the last record are read NOW: from
 * every row the page holds, under the filters the list was drawn with, to the end of the current minute. A pin does
 * not cut them short, so the window has no "up to this point" of its own: the facts that are cut say so themselves.
 *
 * Under a filter, Spend is the sum of the records the Ledger lists, and the rate and the last record say they are
 * filtered; the projection stays the whole vault's and says that.
 */

import { memo, useMemo, useState } from "react";
import { chartWindow as chartWindowOf } from "../../../shared/chart-window.js";
import { applyFilters, isFiltering } from "../../../shared/filters.js";
import { projectionOf } from "../../../shared/now-burn.js";
import { NOW_COPY } from "../../../shared/now-copy.js";
import { lastRecord, spendUpTo } from "../../../shared/now-lists.js";
import { oldestHeldMs, rateNow } from "../../../shared/now-rate.js";
import { useDeskData, useRange } from "../../desk/desk-state.js";
import { useCategoryTint } from "../../desk/use-tint.js";
import { Window } from "../../desk/window.js";
import { SummaryStrip } from "../../summary-strip.js";
import { LastRecord } from "./last-record.js";
import { ProjectionLine } from "./projection-line.js";
import { RateNow } from "./rate-now.js";

const MINUTE_MS = 60_000;

/**
 * Which of two identical fades the container runs: it flips when the filters change, so the fade restarts without
 * the container being rebuilt. "0" is the first draw: no fade.
 */
function useChangeMark(signature: string): string {
	const [mark, setMark] = useState({ signature, gen: "0" });
	if (mark.signature !== signature) setMark({ signature, gen: mark.gen === "a" ? "b" : "a" });
	return mark.gen;
}

function NowSmall(): React.JSX.Element {
	const { rows, list, summary, live, at, headAt, nowMs } = useDeskData();
	const { range } = useRange();
	const tint = useCategoryTint();
	const filters = list.filters;
	const filtering = isFiltering(filters);
	// The chart's end, the end of the current minute whatever is pinned: it changes once a minute, not once a tick.
	const minuteMs = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
	const endMs = useMemo(() => chartWindowOf(range, minuteMs, null).endMs, [range, minuteMs]);
	const chartRows = useMemo(() => applyFilters(rows, filters), [rows, filters]);
	const last = useMemo(() => lastRecord(chartRows), [chartRows]);
	// A whole-vault budget against a whole-vault pace: every row, whatever is filtered. Live only: a projection is
	// of the vault now, not of a past position.
	// On a cut vault the rows are only the newest: where the oldest of every row held falls (not a filter's) is where
	// the rate's hours are whole from, and the pace is stated only when the rows reach back over the week.
	const cut = summary?.truncated === true;
	const heldFromMs = useMemo(() => (cut ? oldestHeldMs(rows) : null), [cut, rows]);
	const rate = useMemo(() => rateNow(chartRows, endMs, heldFromMs), [chartRows, endMs, heldFromMs]);
	const projection = useMemo(
		() => (at === null ? projectionOf(summary, rows, endMs, filtering, cut) : null),
		[at, summary, rows, endMs, filtering, cut],
	);
	// Under a filter Spend is the sum of the records the Ledger lists (`list.filtered`). At a position those are
	// the list's own cut: the rows up to it, each with the status it had there, so a call whose status has changed
	// since counts as the Ledger shows it. The label is the list's too: its position, and, when the list does not
	// hold every record of the vault, that the sum is of the rows held. While the list waits for a point's own
	// records it holds none: the vault's figure at the position stays, under its own label. So it does until the records
	// have loaded (or when their read failed): a sum of rows not yet read would be a claim.
	const spentOverride = useMemo(() => {
		if (!filtering || list.reloading || list.phase !== "loaded") return null;
		const label =
			list.at === null
				? cut
					? NOW_COPY.scopeFilteredHeld
					: NOW_COPY.scopeFiltered
				: cut
					? NOW_COPY.scopeFilteredHeldPast
					: NOW_COPY.scopeFilteredPast;
		return { ut: spendUpTo(list.filtered, null), label };
	}, [filtering, list, cut]);
	// Until the records have loaded there is no rate to state: a figure read from no rows would be a claim. Each of
	// the three is then given nothing, and holds its box empty, so the first load moves nothing.
	const loaded = list.phase === "loaded";
	return (
		<>
			{/* The as-at line follows the header's position: a previewed one while the pointer is on the chart. */}
			<SummaryStrip part="head" summary={summary} live={live} at={headAt} />
			<SummaryStrip
				part="facts"
				summary={summary}
				live={live}
				at={at}
				{...(spentOverride === null ? {} : { spentOverride })}
				budgetNote={
					<>
						<RateNow
							view={loaded ? rate : null}
							color={tint}
							filled={false}
							filtered={filtering}
							failed={list.phase === "failed"}
						/>
						<ProjectionLine projection={loaded ? projection : null} />
					</>
				}
			/>
			<LastRecord row={loaded ? last : null} endMs={endMs} filtered={filtering} />
		</>
	);
}

/**
 * One component at this place whether the window is small or filled, so a fill or a restore does not remount what is
 * under it (an open Details, an open explainer). The filled form's own parts (tiles, charts and lists) are not built
 * yet: until they are, the filled window shows the small form.
 */
function NowBody(): React.JSX.Element {
	const gen = useChangeMark(JSON.stringify(useDeskData().list.filters));
	return (
		<div className="ut-nw" data-gen={gen}>
			<NowSmall />
		</div>
	);
}

export const NowWindow = memo(function NowWindow(): React.JSX.Element {
	return (
		<Window id="now" title="Now">
			{() => <NowBody />}
		</Window>
	);
});
