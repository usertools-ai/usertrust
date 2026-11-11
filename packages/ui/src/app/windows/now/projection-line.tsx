// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * When the budget is reached at the pace so far, as one line under the rate. Props only: the sentence and its tooltip
 * are `projectionOf`'s, which says in both that it is a projection. With none to make, the line's place is held empty
 * and unseen, so the facts after it stay where they are when a projection comes or goes.
 */
export function ProjectionLine(props: {
	projection: { text: string; title: string } | null;
}): React.JSX.Element {
	if (props.projection === null)
		return (
			<p className="ut-nw-proj" aria-hidden="true" data-reserve="true">
				{"\u00a0"}
			</p>
		);
	return (
		<p className="ut-nw-proj" title={props.projection.title}>
			{props.projection.text}
		</p>
	);
}
