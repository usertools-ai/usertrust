// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { AtView } from "./at-follow.js";

/**
 * What the page header shows: the previewed position's view once it has answered, else the committed one (the
 * address's pin, or live). Until the preview's own answer lands the header keeps the committed PAYLOAD, never live,
 * but takes the preview request's own status (loading, a failure), so a failed or slow preview is not silent.
 */
export function headerView(
	previewPos: number | null,
	committed: AtView,
	previewed: AtView,
): AtView {
	if (previewPos === null) return committed;
	if (previewed.at !== null) return previewed;
	return { ...previewed, at: committed.at, rows: committed.rows, rowsVault: committed.rowsVault };
}
