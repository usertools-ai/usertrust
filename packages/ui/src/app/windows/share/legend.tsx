// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Share window's legend: the top categories, each a button that filters the desk to it, and one line for the
 * rest. A row's dollars and percent are the values the ring shows, so the rows and the Other line add up to the
 * figure in the ring's centre. The buttons are the keyboard route to the filter a slice's click sets.
 */

import { useEffect, useRef } from "react";
import type { Dimension } from "../../../shared/breakdown.js";
import { toggleCategory } from "../../../shared/desk-filters.js";
import {
	formatShare,
	legendOf,
	legendTitle,
	SHARE_EMPTY,
	type ShareValues,
} from "../../../shared/donut.js";
import { formatUsdTotal } from "../../../shared/format.js";
import {
	setHoverCategory,
	useDeskData,
	useFilters,
	useHoverCategory,
} from "../../desk/desk-state.js";
import { useLitOf } from "./use-lit-at.js";

/** The folded line's name. It is not a category: its figure carries `data-fold`. */
const OTHER = "Other";

export function ShareLegend(props: {
	/** What the ring shows: the range's keys and each one's spend in the range or in one bucket. */
	values: ShareValues;
	level: Dimension;
	/** Whole percentages in the small window, one decimal when it fills the desk. */
	decimals: 0 | 1;
	/** When the values were read, as a title says it: "this range" or "at <time>". */
	whenLabel: string;
	/** The shown bucket's start, null for the range. */
	startMs: number | null;
}): React.JSX.Element {
	const { values, level, decimals, whenLabel, startMs } = props;
	const { filters, setFilters } = useFilters();
	const colors = useDeskData().colorsFor(level);
	const litOf = useLitOf(level);
	const hover = useHoverCategory();
	const { rows, other } = legendOf(values);
	const hot = hover !== null && hover.dim === level && values.keys.includes(hover.key);
	const when =
		startMs === null || !Number.isFinite(startMs) ? "range" : new Date(startMs).toISOString();
	// The row this legend lit. A row that goes away under the pointer (a filter folds it into Other, the dimension
	// changes) never sees the pointer leave, so the legend clears the hover it published.
	const mine = useRef<string | null>(null);
	const enter = (key: string) => () => {
		mine.current = key;
		setHoverCategory({ dim: level, key, from: "share" });
	};
	const leave = (): void => {
		mine.current = null;
		setHoverCategory(null);
	};
	const shown = rows.map((row) => row.key).join("\n");
	useEffect(() => {
		if (mine.current === null || shown.split("\n").includes(mine.current)) return;
		mine.current = null;
		setHoverCategory(null);
	}, [shown]);
	useEffect(
		() => () => {
			if (mine.current !== null) setHoverCategory(null);
		},
		[],
	);
	return (
		<ul className="ut-sh-legend" data-when={when} data-hot={hot}>
			{rows.length === 0 && <li className="ut-sh-none">{SHARE_EMPTY}</li>}
			{rows.map((row) => {
				const lit = litOf(row.key);
				return (
					<li key={row.key}>
						<button
							type="button"
							className="ut-sh-row"
							data-key={row.key}
							data-lit={lit}
							aria-pressed={lit === "selected"}
							title={legendTitle(row.key, row.spendUt, row.share, whenLabel)}
							onPointerEnter={enter(row.key)}
							onPointerLeave={leave}
							onFocus={enter(row.key)}
							onBlur={leave}
							onClick={() => setFilters(toggleCategory(filters, level, row.key, false))}
						>
							<i style={{ background: colors.of(row.key) }} />
							<span className="n" title={row.key}>
								{row.key}
							</span>
							<span className="v" data-fig="share.legend" data-key={row.key} data-ut={row.spendUt}>
								{formatUsdTotal(row.spendUt)}
							</span>
							<span className="p">{formatShare(row.share, decimals)}</span>
						</button>
					</li>
				);
			})}
			{other !== null && (
				<li
					className="ut-sh-other"
					data-fold="true"
					title={`${other.count} more: ${formatUsdTotal(other.spendUt)}, ${formatShare(other.share, 1)} ${whenLabel}`}
				>
					<i />
					<span className="n">{OTHER}</span>
					<span
						className="v"
						data-fig="share.legend"
						data-key={OTHER}
						data-ut={other.spendUt}
						data-fold="true"
					>
						{formatUsdTotal(other.spendUt)}
					</span>
					<span className="p">{formatShare(other.share, decimals)}</span>
				</li>
			)}
		</ul>
	);
}
