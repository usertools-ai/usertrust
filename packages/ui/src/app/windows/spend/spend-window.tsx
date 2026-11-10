// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Spend window: the rate of spend over the chosen range, read to the record, with the range chips in the
 * chart's headline row (the title bar keeps only its fill button).
 *
 * The window decides what the chart may claim. The chart runs to now whatever is pinned (`useChartData`), so the
 * headline is anchored to the vault's live total, and only when nothing was filtered away; a filter that removed any
 * record (an actor, a provider, anything) makes it this view's spend. Filtered is judged by comparing row counts,
 * not by asking which filter fields are set.
 */

import { memo, useMemo } from "react";
import { LINE_BUCKETS } from "../../../shared/spend-model.js";
import { useDeskData, useOpenRecord, usePosition, useRange } from "../../desk/desk-state.js";
import { useCategoryTint } from "../../desk/use-tint.js";
import { useWindow, Window } from "../../desk/window.js";
import { resolvedPin, useChartData } from "./chart-data.js";
import { RangeChips } from "./range-chips.js";
import { SpendChart } from "./spend-chart.js";

/** A moment the open record names, or null when its time cannot be read. */
function momentOf(ts: string): number | null {
	const ms = Date.parse(ts);
	return Number.isFinite(ms) ? ms : null;
}

const SpendBody = memo(function SpendBody(): React.JSX.Element {
	const { rows, list, summary, at, head } = useDeskData();
	const { chartRows, allRows, chartWindow, filterNote } = useChartData();
	const { range, setRange } = useRange();
	const { at: addressPos, setAt: onPin } = usePosition();
	const { open } = useOpenRecord();
	const ink = useCategoryTint();
	const { settling } = useWindow();
	const filterKey = useMemo(() => JSON.stringify(list.filters), [list.filters]);
	const controls = useMemo(
		() => <RangeChips range={range} onRange={setRange} />,
		[range, setRange],
	);

	if (chartRows.length === 0) {
		// "No records" is only true of a vault that has loaded: while it loads (or if the load failed) the window keeps
		// the plot's room and says nothing about the records.
		if (list.phase !== "loaded") {
			return <div className="ut-sp-wait" aria-busy={list.phase === "loading"} />;
		}
		return <p className="ut-sp-empty">no records in this view</p>;
	}

	const filtered = chartRows.length !== rows.length;
	// The pin the chart draws is the answered position, which an address past the vault's end is clamped to.
	const pinnedPos = resolvedPin(addressPos, at);
	// Unfiltered, the pinned headline is the snapshot's own total: the rows held may begin after the pin (a cut vault).
	const pinTotalUt =
		!filtered && pinnedPos !== null && at !== null && at.pos === pinnedPos ? at.spentUt : null;
	return (
		<SpendChart
			rows={chartRows}
			win={chartWindow}
			totalUt={filtered ? null : (summary?.spentUt ?? null)}
			filtered={filtered}
			truncated={summary?.truncated ?? false}
			pinnedPos={pinnedPos}
			pinTotalUt={pinTotalUt}
			at={at}
			head={head}
			ink={ink}
			allRows={allRows}
			filterNote={filterNote}
			markMs={open === null ? null : momentOf(open.ts)}
			markPos={open === null ? null : open.pos}
			breakPos={summary?.chain.breakIndex ?? null}
			settling={settling}
			range={range}
			bucket={LINE_BUCKETS[range]}
			filterKey={filterKey}
			controls={controls}
			onPin={onPin}
		/>
	);
});

export const SpendWindow = memo(function SpendWindow(): React.JSX.Element {
	return (
		<Window id="spend" title="Spend" subtitle="per bucket">
			{() => <SpendBody />}
		</Window>
	);
});
