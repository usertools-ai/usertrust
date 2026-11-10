// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/** The one switch that picks what spend is shared by. The desk holds the choice, so every window follows it. */

import { DIMENSION_LABEL, DIMENSIONS } from "../../../shared/level.js";
import { useDimension } from "../../desk/desk-state.js";

export function DimSwitch(): React.JSX.Element {
	const { dim, setDim } = useDimension();
	return (
		// biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, as the desk's other switches are
		<div className="ut-seg" role="group" aria-label="Share by">
			{DIMENSIONS.map((d) => (
				<button key={d} type="button" aria-pressed={d === dim} onClick={() => setDim(d)}>
					{DIMENSION_LABEL[d]}
				</button>
			))}
		</div>
	);
}
