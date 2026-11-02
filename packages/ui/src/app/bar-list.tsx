// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { KeyTotal } from "../shared/aggregate.js";
import { formatUt } from "../shared/format.js";

/** How many buckets a list shows unless it says otherwise. */
export const BAR_LIST_LIMIT = 8;

/**
 * A ranked list of totals with a meter each. By default only the top {@link BAR_LIST_LIMIT} are drawn and a line says
 * how many exist; a list whose buckets must add up to a stated total passes a `limit` that shows them all.
 */
export function BarList(props: {
	title: string;
	totals: KeyTotal[];
	/** A line under the title, for a list whose keys need a caveat. */
	note?: string;
	/** The most buckets drawn. Default {@link BAR_LIST_LIMIT}. */
	limit?: number;
}): React.JSX.Element {
	const limit = props.limit ?? BAR_LIST_LIMIT;
	const max = props.totals[0]?.costUt ?? 1;
	return (
		<div className="ut-card">
			<span className="ut-tile-h">{props.title}</span>
			{props.note !== undefined && <span className="ut-sub">{props.note}</span>}
			<div className="ut-blist">
				{props.totals.slice(0, limit).map((t) => (
					<div key={t.key} style={{ display: "contents" }}>
						<span className="k" title={t.key}>
							{t.key}
						</span>
						<span className="v" data-cost-ut={t.costUt}>
							{formatUt(t.costUt)} · {t.count}×
						</span>
						<div className="ut-meter">
							<i style={{ width: `${max > 0 ? (t.costUt / max) * 100 : 0}%` }} />
						</div>
					</div>
				))}
			</div>
			{props.totals.length > limit && (
				<span className="ut-sub">
					top {limit} of {props.totals.length}
				</span>
			)}
			{props.totals.length === 0 && <span className="ut-why">No costed records in view.</span>}
		</div>
	);
}
