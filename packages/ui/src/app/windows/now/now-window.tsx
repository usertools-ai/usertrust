// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Now window: the vault's facts, and what it is doing now.
 *
 * It holds two readings, and each says which it is. Spend, Budget and Integrity are read AT the shown position (the
 * summary, or a past position's answer). The rate, its line, the projection and the last record are read NOW: from
 * every row the page holds, under the filters the list was drawn with, to the end of the current minute. A pin does
 * not cut them short, so the window has no "up to this point" of its own: the facts that are cut say so themselves.
 */

import { memo, useMemo, useState } from "react";
import { chartWindow as chartWindowOf } from "../../../shared/chart-window.js";
import { applyFilters, isFiltering } from "../../../shared/filters.js";
import { projectionOf } from "../../../shared/now-burn.js";
import { NOW_COPY } from "../../../shared/now-copy.js";
import { lastRecord, spendUpTo } from "../../../shared/now-lists.js";
import { rateNow } from "../../../shared/now-rate.js";
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
	const { rows, list, summary, live, at, nowMs } = useDeskData();
	const { range } = useRange();
	const tint = useCategoryTint();
	const filters = list.filters;
	// The chart's end, the end of the current minute whatever is pinned: it changes once a minute, not once a tick.
	const minuteMs = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
	const endMs = useMemo(() => chartWindowOf(range, minuteMs, null).endMs, [range, minuteMs]);
	const chartRows = useMemo(() => applyFilters(rows, filters), [rows, filters]);
	const rate = useMemo(() => rateNow(chartRows, endMs), [chartRows, endMs]);
	const last = useMemo(() => lastRecord(chartRows), [chartRows]);
	// A whole-vault budget against a whole-vault pace: every row, whatever is filtered. Live only: a projection is
	// of the vault now, not of a past position.
	const projection = useMemo(
		() => (at === null ? projectionOf(summary, rows, endMs) : null),
		[at, summary, rows, endMs],
	);
	// Under a filter Spend is those records' sum, cut at the position, and its label says both.
	const spentOverride = useMemo(
		() =>
			isFiltering(filters)
				? {
						ut: spendUpTo(chartRows, at === null ? null : at.pos),
						label: at === null ? NOW_COPY.scopeFiltered : NOW_COPY.scopeFilteredPast,
					}
				: null,
		[filters, chartRows, at],
	);
	// Until the records have loaded there is no rate to state: a figure read from no rows would be a claim. Each of
	// the three is then given nothing, and holds its box empty, so the first load moves nothing.
	const loaded = list.phase === "loaded";
	return (
		<>
			<SummaryStrip part="head" summary={summary} live={live} at={at} />
			<SummaryStrip
				part="facts"
				summary={summary}
				live={live}
				at={at}
				{...(spentOverride === null ? {} : { spentOverride })}
				budgetNote={
					<>
						<RateNow view={loaded ? rate : null} color={tint} filled={false} />
						<ProjectionLine projection={loaded ? projection : null} />
					</>
				}
			/>
			<LastRecord row={loaded ? last : null} endMs={endMs} />
		</>
	);
}

/** The filled form. Its own parts (tiles, charts and lists) are not built yet: until they are, it is the small form. */
function NowFilled(): React.JSX.Element {
	return <NowSmall />;
}

function NowBody({ filled }: { filled: boolean }): React.JSX.Element {
	const gen = useChangeMark(JSON.stringify(useDeskData().list.filters));
	return (
		<div className="ut-nw" data-gen={gen}>
			{filled ? <NowFilled /> : <NowSmall />}
		</div>
	);
}

export const NowWindow = memo(function NowWindow(): React.JSX.Element {
	return (
		<Window id="now" title="Now">
			{(filled) => <NowBody filled={filled} />}
		</Window>
	);
});
