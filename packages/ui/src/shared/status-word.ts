// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The one word for a record's outcome, in every view. An ambiguous charge is shown as "unresolved": its cost is
 * recorded, its outcome is not confirmed, and it stays inside spend. The URL and filter VALUE stays `ambiguous`, so old
 * links round-trip; only what a reader sees changes.
 */

import type { RowStatus } from "./rows.js";

/** The tooltip for an unresolved record. */
export const UNRESOLVED_TIP = "the outcome isn't confirmed yet";

/** The line under an unresolved figure. */
export const UNRESOLVED_LINE = "recorded, not confirmed";

/** What a reader sees for a status: `unresolved` for `ambiguous`, the status itself for every other. */
export function statusWord(status: RowStatus): string {
	return status === "ambiguous" ? "unresolved" : status;
}
