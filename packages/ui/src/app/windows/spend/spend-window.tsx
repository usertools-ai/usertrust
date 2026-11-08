// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Spend window. Day one it holds the chart card the page always drew: PR 3a replaces this file's body with the
 * window's own chart and range chips. No range chip is drawn until then, because a control that does nothing is a lie.
 */

import { memo } from "react";
import { useDeskData } from "../../desk/desk-state.js";
import { Window } from "../../desk/window.js";
import { Trends } from "../../trends.js";

export const SpendWindow = memo(function SpendWindow(): React.JSX.Element {
	const { list, summary, head, pastNote } = useDeskData();
	// The server's row window, when it holds only the newest N events.
	const newestOf = summary?.truncated ? summary.rowCount : undefined;
	return (
		<Window id="spend" title="Spend">
			{() => (
				<Trends
					part="chart"
					rows={list.filtered}
					newestOf={newestOf}
					at={list.at}
					head={head}
					reloading={list.reloading}
					reloadingNote={pastNote}
				/>
			)}
		</Window>
	);
});
