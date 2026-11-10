// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { AtView } from "./at-follow.js";

/**
 * What the page header shows: the previewed position's view once it has answered, else the committed one (the
 * address's pin, or live). Until the preview's own answer lands the header keeps the committed view, never live.
 */
export function headerView(
	previewPos: number | null,
	committed: AtView,
	previewed: AtView,
): AtView {
	return previewPos === null || previewed.at === null ? committed : previewed;
}
