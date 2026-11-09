// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Now window. Day one it holds the header facts the page always drew (spend, budget, chain, anchor): PR 6
 * replaces this file's body. It follows the header's position, not the deferred list the other windows draw.
 */

import { memo } from "react";
import { useDeskData } from "../../desk/desk-state.js";
import { Window } from "../../desk/window.js";
import { SummaryStrip } from "../../summary-strip.js";

export const NowWindow = memo(function NowWindow(): React.JSX.Element {
	const { summary, live, at } = useDeskData();
	return (
		<Window id="now" title="Now">
			{() => <SummaryStrip part="facts" summary={summary} live={live} at={at} />}
		</Window>
	);
});
