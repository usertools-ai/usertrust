// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Share of spend window. Day one it holds the three lists the page always drew (kind, model, job type): PR 4
 * replaces this file's body with the donut and its legend.
 */

import { memo } from "react";
import { useDeskData } from "../../desk/desk-state.js";
import { Window } from "../../desk/window.js";
import { Trends } from "../../trends.js";

export const ShareWindow = memo(function ShareWindow(): React.JSX.Element {
	const { list, summary, pastNote } = useDeskData();
	const newestOf = summary?.truncated ? summary.rowCount : undefined;
	return (
		<Window id="share" title="Share of spend" subtitle="by kind, model and job type">
			{() => (
				<Trends
					part="lists"
					rows={list.filtered}
					newestOf={newestOf}
					at={list.at}
					reloading={list.reloading}
					reloadingNote={pastNote}
				/>
			)}
		</Window>
	);
});
