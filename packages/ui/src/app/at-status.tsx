// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { AtPayload } from "../shared/api.js";

/**
 * The status under the header's "As recorded at" line, for a past position the address names (`#at=N`): why a point
 * did not show, that a reload may have renamed it, and that the views below are still catching up. Always mounted and
 * empty when idle (a note inserted with its text already in it is often not announced), so a link that fails or is
 * renamed by a reload says so instead of silently showing the live vault.
 */
export function AtStatus(props: {
	/** The answer shown (null: live, or nothing loaded yet for the position asked for). */
	at: AtPayload | null;
	error: string | null;
	reloaded: boolean;
	/**
	 * Set while the list, the facets, Trends, the inspector and Export still show another position than the header
	 * (they are dimmed meanwhile): "Updating to record N…", seen but not announced; `announce` is.
	 */
	holdNote?: string | null;
	/** The polite live region's text (`holdAnnouncement`): once when the views start to lag, once when they catch up. */
	announce?: string;
}): React.JSX.Element {
	const { at, error, reloaded } = props;
	return (
		<div className="ut-at-status">
			<p className="ut-tl-msg" role="status">
				{error !== null &&
					(at !== null
						? `Could not show that point: ${error}. Still showing the last point loaded.`
						: `Could not show that point: ${error}; showing the live vault.`)}
				{error !== null && reloaded && " "}
				{reloaded &&
					"Read again because the vault was reloaded: this position may now name another record."}
			</p>
			<span className="ut-tl-held" aria-hidden="true">
				{props.holdNote ?? ""}
			</span>
			<span className="sr-only" role="status">
				{props.announce ?? ""}
			</span>
		</div>
	);
}
