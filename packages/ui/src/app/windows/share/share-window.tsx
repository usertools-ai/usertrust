// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Share of spend window: where spend went, by the dimension the switch picks, as a ring and a legend. A click on
 * a slice or a legend row filters the whole desk to that category.
 *
 * Its range is a chart's: it reads every row the page holds, under the filters the list was drawn with (less the
 * level's own, so a picked slice is still drawn among the others), over the range to the end of the current minute.
 * A pin does not cut it short. While a record is pinned, or another window's crosshair is on a moment inside the range,
 * it shows that moment's bucket instead and says so ("At <time>"); a moment outside the range, or a pin it cannot place,
 * shows the whole range. The keys and their order stay the range's.
 */

import { memo, useMemo, useState } from "react";
import {
	type Breakdown,
	breakdown,
	categoryRows,
	type Dimension,
	type SpendWindow,
} from "../../../shared/breakdown.js";
import { chartWindow as chartWindowOf, LINE_BUCKETS } from "../../../shared/chart-window.js";
import { selectedKeys, withoutDimension } from "../../../shared/desk-filters.js";
import {
	atWhen,
	bucketAt,
	bucketStartMs,
	centreOf,
	formatShare,
	legendOf,
	type ShareValues,
	shareValues,
} from "../../../shared/donut.js";
import { applyFilters, type FilterState } from "../../../shared/filters.js";
import { formatUsdTotal } from "../../../shared/format.js";
import {
	effectiveLevel,
	LEVEL_NOUN,
	levelSubtitle,
	roleCaption,
	roleSources,
	scopeOf,
} from "../../../shared/level.js";
import type { LedgerRow, RowStatus } from "../../../shared/rows.js";
import { bucketCount } from "../../../shared/spend-series.js";
import { statusWord } from "../../../shared/status-word.js";
import {
	useDeskData,
	useDimension,
	useFilters,
	useHoverCategory,
	useHoverMoment,
	usePosition,
	useRange,
} from "../../desk/desk-state.js";
import { memoOnce } from "../../desk/use-breakdown.js";
import { Window } from "../../desk/window.js";
import { DimSwitch } from "./dim-switch.js";
import { ShareDonut } from "./donut.js";
import { ShareLegend } from "./legend.js";

const MINUTE_MS = 60_000;

/** What the window draws from: the chart's window, the level, the rows under every filter but the level's own. */
interface ShareData {
	chartWindow: SpendWindow;
	level: Dimension;
	/** What a followed-down level is within ("Anthropic", a model's name), or null. */
	scope: string | null;
	rowsExcl: LedgerRow[];
	bd: Breakdown;
	/** The filters the rows were drawn under. */
	filters: FilterState;
}

function useShareData(): ShareData {
	const { rows, list, nowMs } = useDeskData();
	const { range } = useRange();
	const { dim } = useDimension();
	const filters = list.filters;
	// The line's window, to the end of the current minute whatever is pinned: it changes once a minute, not once a tick.
	const minuteMs = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
	// No first record is passed: opening at it moves the start along bucket marks only, over buckets with no spend, so
	// every total, share and bucket the ring reads is the same.
	const chartWindow = useMemo(() => chartWindowOf(range, minuteMs, null), [range, minuteMs]);
	return useMemo(() => {
		// Provider follows a single provider down to its models, and a single model to its lanes. The level is read
		// from the rows drawn here (not the desk window's, which ends at a pin), so the subtitle names what is drawn.
		let level = dim;
		let scope: string | null = null;
		if (dim === "provider") {
			const rowsNoModel = applyFilters(rows, withoutDimension(filters, "model"));
			level = effectiveLevel(dim, rowsNoModel, chartWindow).dim;
			let scoped = rowsNoModel;
			// Lanes lift the lane filter, which widens the rows: the lane level stands only if the widened rows still
			// hold the one provider and the one model. Otherwise it stays at models, with the lane filter in force.
			if (level === "lane") {
				const widened = applyFilters(rows, withoutDimension(filters, "lane"));
				if (effectiveLevel(dim, widened, chartWindow).dim === "lane") scoped = widened;
				else level = "model";
			}
			// Named from the rows the level counts: at lanes the widened ones, which may share nothing with the narrow.
			if (level !== "provider") scope = scopeOf(dim, level, scoped, chartWindow);
		}
		const rowsExcl = applyFilters(rows, withoutDimension(filters, level));
		return {
			chartWindow,
			level,
			scope,
			rowsExcl,
			bd: breakdown(rowsExcl, chartWindow, level),
			filters,
		};
	}, [rows, filters, dim, chartWindow]);
}

/** The pinned record's own time, or null: nothing pinned, the record is not held, or its time cannot be read. */
function usePinMs(): number | null {
	const { at } = usePosition();
	const { rows } = useDeskData();
	return useMemo(() => {
		if (at === null) return null;
		const row = rows.find((r) => r.pos === at);
		const ms = row === undefined ? Number.NaN : Date.parse(row.ts);
		return Number.isFinite(ms) ? ms : null;
	}, [at, rows]);
}

/**
 * Which of two identical fades the container runs: it flips when the range, the dimension or the filters change, so
 * the fade restarts without the container (and the ring's tween) being rebuilt. "0" is the first draw: no fade.
 */
function useChangeMark(signature: string): string {
	const [mark, setMark] = useState({ signature, gen: "0" });
	if (mark.signature !== signature) setMark({ signature, gen: mark.gen === "a" ? "b" : "a" });
	return mark.gen;
}

/** The ring said in words: what is shared, when it was read, each legend line, and any status filter narrowing it. */
function ringLabel(
	values: ShareValues,
	level: Dimension,
	startMs: number | null,
	statuses: readonly string[],
): string {
	const { rows, other } = legendOf(values);
	const said = rows.map((r) => `${r.key} ${formatUsdTotal(r.spendUt)}, ${formatShare(r.share, 1)}`);
	if (other !== null) {
		said.push(`Other ${formatUsdTotal(other.spendUt)}, ${formatShare(other.share, 1)}`);
	}
	const status =
		statuses.length === 0
			? ""
			: `, status: ${statuses.map((s) => statusWord(s as RowStatus)).join(", ")}`;
	const lines = said.length === 0 ? "no spend" : said.join("; ");
	return `Share of spend by ${LEVEL_NOUN[level]}, ${atWhen(startMs)}: ${lines}${status}`;
}

function ShareBody({ data, filled }: { data: ShareData; filled: boolean }): React.JSX.Element {
	const { chartWindow, level, rowsExcl, bd, filters } = data;
	const { range } = useRange();
	const { dim } = useDimension();
	const view = useFilters().filters;
	const hover = useHoverCategory();
	const hoverMoment = useHoverMoment("share");
	const pinMs = usePinMs();
	const { list, pastNote } = useDeskData();
	const reloading = list.reloading === true;

	// The moment shown: another window's crosshair, else the pinned record's time; its bucket is the Spend line's.
	const momentMs = hoverMoment?.ms ?? pinMs;
	const bucketMs = LINE_BUCKETS[range];
	const k =
		momentMs === null
			? null
			: bucketAt(momentMs, chartWindow, bucketMs, bucketCount(chartWindow, bucketMs));
	// Bucketed on the first moment after the rows change, and kept: a crosshair moving reads, it does not recount.
	const bucketsOf = useMemo(
		() => memoOnce(() => categoryRows(rowsExcl, chartWindow, level, bucketMs)),
		[rowsExcl, chartWindow, level, bucketMs],
	);
	const values = useMemo(
		() => shareValues(bd, k === null ? null : bucketsOf(), k),
		[bd, bucketsOf, k],
	);
	const startMs = k === null ? null : bucketStartMs(chartWindow, bucketMs, k);

	// The centre's category: the one under a pointer, else the only one selected.
	const selected = selectedKeys(view, level);
	const only = selected.size === 1 ? ([...selected][0] ?? null) : null;
	const litKey = hover !== null && hover.dim === level ? hover.key : only;
	const litAt = litKey === null ? -1 : values.keys.indexOf(litKey);
	const hot =
		litKey === null || litAt < 0 ? null : { key: litKey, spendUt: values.values[litAt] ?? 0 };
	const spending = values.values.reduce((n, v) => (v > 0 ? n + 1 : n), 0);
	const centre = {
		...centreOf({ hot, total: values.total, spending, noun: LEVEL_NOUN[level], startMs }),
		key: hot?.key ?? null,
	};

	const gen = useChangeMark(`${range}|${dim}|${JSON.stringify(filters)}`);
	// While the point's own records are on their way the ring would only say "no spend": it waits, as the Spend line does.
	if (reloading) {
		return (
			<div className="ut-sh" data-filled={filled} data-gen={gen}>
				<div className="ut-sh-dims">
					<DimSwitch />
				</div>
				<div className="ut-empty">
					<b>{pastNote}</b>
				</div>
			</div>
		);
	}
	return (
		<div className="ut-sh" data-filled={filled} data-gen={gen}>
			<div className="ut-sh-dims">
				<DimSwitch />
			</div>
			{level === "role" && (
				<p className="ut-sh-cap">{roleCaption(roleSources(rowsExcl, chartWindow))}</p>
			)}
			<ShareDonut
				keys={values.keys}
				values={values.values}
				level={level}
				centre={centre}
				snapKey={String(k)}
				ariaLabel={ringLabel(values, level, startMs, filters.statuses)}
			/>
			<ShareLegend
				values={values}
				level={level}
				decimals={filled ? 1 : 0}
				whenLabel={atWhen(startMs)}
				startMs={startMs}
			/>
		</div>
	);
}

export const ShareWindow = memo(function ShareWindow(): React.JSX.Element {
	const data = useShareData();
	const { dim } = useDimension();
	return (
		<Window id="share" title="Share of spend" subtitle={levelSubtitle(dim, data.level, data.scope)}>
			{(filled) => <ShareBody data={data} filled={filled} />}
		</Window>
	);
});
