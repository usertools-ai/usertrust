// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { AtPayload } from "../shared/api.js";

/**
 * Export: the records in view, as CSV. Its count and the file it writes come from the list's input, so while that is
 * a held view (`held`: the moment after a new position lands) the button is dimmed and busy like the list, and its
 * title names the position it would export, which is the list's, not the header's.
 */
export function ExportButton(props: {
	count: number;
	/** The list's position (null: live). */
	at: AtPayload | null;
	/** The server's window, when the list holds only the newest records. */
	newestOf: number | undefined;
	held: boolean;
	onExport(): void;
}): React.JSX.Element {
	const { count, at, newestOf, held } = props;
	return (
		<button
			type="button"
			className="ut-btn"
			onClick={props.onExport}
			disabled={count === 0}
			data-held={held}
			aria-busy={held}
			title={
				at !== null
					? `Download the records in view as CSV, as recorded at record ${(at.pos + 1).toLocaleString()}${
							at.windowStartPos > 0
								? `, and the list holds records from position ${(at.windowStartPos + 1).toLocaleString()} only`
								: ""
						}`
					: newestOf === undefined
						? "Download the records in view as CSV"
						: `Download the records in view as CSV: these are within the newest ${newestOf.toLocaleString()} events only`
			}
		>
			Export {count.toLocaleString()} {count === 1 ? "row" : "rows"}
		</button>
	);
}
