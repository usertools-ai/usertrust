// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Share window's legend: the top categories, each a button that filters the desk to it, and one line for the
 * rest. A row's dollars and percent are the values the ring shows, so the rows and the Other line add up to the
 * figure in the ring's centre. The buttons are the keyboard route to the filter a slice's click sets.
 */

import { useCallback, useEffect, useRef } from "react";
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
import { categoryBus } from "../../../shared/hover-bus.js";
import {
	setHoverCategory,
	useDeskData,
	useFilters,
	useHoverCategory,
} from "../../desk/desk-state.js";
import { isOurs, LEGEND_FROM, rowToShow } from "./legend-hover.js";
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
	// The hover this legend published, and which of its rows the pointer and the keyboard focus are on. The legend
	// clears only a hover it published itself, so a hover another window or the ring set is never wiped by a blur or
	// a pointer-leave here; and when one of the two leaves while the other is still on a row, that row is shown.
	const published = useRef<string | null>(null);
	const pointerRow = useRef<string | null>(null);
	const focusRow = useRef<string | null>(null);
	const publish = useCallback(
		(key: string | null): void => {
			if (key !== null) {
				published.current = key;
				setHoverCategory({ dim: level, key, from: LEGEND_FROM });
				return;
			}
			const ours = isOurs(categoryBus.get(), level, published.current);
			published.current = null;
			if (ours) setHoverCategory(null);
		},
		[level],
	);
	const settle = useCallback(
		(): void => publish(rowToShow(pointerRow.current, focusRow.current)),
		[publish],
	);
	const enter = (key: string) => () => {
		pointerRow.current = key;
		settle();
	};
	const leave = (): void => {
		pointerRow.current = null;
		settle();
	};
	const focus = (key: string) => () => {
		focusRow.current = key;
		settle();
	};
	const blur = (): void => {
		focusRow.current = null;
		settle();
	};
	const shown = rows.map((row) => row.key).join("\n");
	useEffect(() => {
		const gone = (k: string | null): boolean => k !== null && !shown.split("\n").includes(k);
		if (gone(pointerRow.current)) pointerRow.current = null;
		if (gone(focusRow.current)) focusRow.current = null;
		if (published.current !== null && gone(published.current)) settle();
	}, [shown, settle]);
	useEffect(
		() => () => {
			pointerRow.current = null;
			focusRow.current = null;
			publish(null);
		},
		[publish],
	);
	return (
		<ul className="ut-sh-legend" data-when={when} data-hot={hot} data-decimals={decimals}>
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
							onFocus={focus(row.key)}
							onBlur={blur}
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
