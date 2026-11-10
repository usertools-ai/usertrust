// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * When the budget is reached at the pace so far, as one line under the rate. Props only: the sentence and its tooltip
 * are `projectionOf`'s, which says in both that it is a projection. Nothing is drawn when there is none to make.
 */
export function ProjectionLine(props: {
	projection: { text: string; title: string } | null;
}): React.JSX.Element | null {
	if (props.projection === null) return null;
	return (
		<p className="ut-nw-proj" title={props.projection.title}>
			{props.projection.text}
		</p>
	);
}
