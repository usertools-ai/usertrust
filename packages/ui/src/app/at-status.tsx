// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The status under the header's "As recorded at" line, for a past position the address names (`#at=N`): why a point
 * did not show, that a reload may have renamed it, and that the views below are still catching up. Always mounted and
 * empty when idle (a note inserted with its text already in it is often not announced), so a link that fails or is
 * renamed by a reload says so instead of silently showing the live vault. Whether a past point or the live vault is on
 * screen is the header's to say ("As recorded at", or nothing when live), so the failure note does not repeat it.
 */
export function AtStatus(props: {
	error: string | null;
	reloaded: boolean;
	/** The position asked for has no answer yet (`pointLoading`): the note says so until it lands or fails. */
	loading?: boolean;
	/**
	 * Set while the list, the facets, Trends, the inspector and Export still show another position than the header
	 * (they are dimmed meanwhile): "Updating to record N…", seen but not announced; `announce` is.
	 */
	holdNote?: string | null;
	/** The polite live region's text (`holdAnnouncement`): once when the views start to lag, once when they catch up. */
	announce?: string;
}): React.JSX.Element {
	const { error, reloaded } = props;
	return (
		<div className="ut-at-status">
			<p className="ut-tl-msg" role="status">
				{error !== null && `Could not show that point: ${error}.`}
				{error === null && props.loading === true && "Loading this point…"}
				{(error !== null || props.loading === true) && reloaded && " "}
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
