// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Spend window's range chips. Every chip stays mounted whatever the range, so focus never falls to the page when
 * one is pressed. Not gold: gold is for the primary control only.
 */

import type { RangeId } from "../../../shared/spend-series.js";

export const RANGE_CHIPS: ReadonlyArray<{ id: RangeId; label: string; title: string }> = [
	{ id: "1d", label: "1D", title: "Last 24 hours" },
	{ id: "1w", label: "1W", title: "Last 7 days" },
	{ id: "1m", label: "1M", title: "Last 30 days" },
	{ id: "3m", label: "3M", title: "Last 90 days" },
	{ id: "ytd", label: "YTD", title: "Since Jan 1 (UTC)" },
	{ id: "1y", label: "1Y", title: "Last 365 days" },
];

export function RangeChips(props: {
	range: RangeId;
	onRange(r: RangeId): void;
}): React.JSX.Element {
	return (
		// biome-ignore lint/a11y/useSemanticElements: role="group" keeps the segmented capsule; a fieldset restyles it
		<div className="ut-sp-chips ut-glass" role="group" aria-label="Range">
			{RANGE_CHIPS.map((c) => (
				<button
					key={c.id}
					type="button"
					aria-pressed={props.range === c.id}
					title={c.title}
					onClick={() => props.onRange(c.id)}
				>
					{c.label}
				</button>
			))}
		</div>
	);
}
