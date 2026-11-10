// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The buckets that are not history for the usual range: those before the first spend record. Pure.
 *
 * A range is cut into buckets back from now, so a young vault's buckets begin with zeros that are not quiet hours:
 * nothing had been spent yet. Passed to `usualBand` as `skip`, they are left out of every history, and its
 * BAND_MIN_HISTORY then counts only buckets from the first spend on. Quiet buckets after the first spend are real
 * zeros and stay.
 */

import { isHeaderSpend } from "./aggregate.js";
import type { LedgerRow } from "./rows.js";

/**
 * For `n` buckets of `bucketMs` from `startMs`: true for each bucket before the one the earliest spend record
 * (`isHeaderSpend`) falls in. None is true when spend began at or before `startMs`; all are when there is no spend
 * record with a readable time, or none before the buckets end.
 */
export function skipBeforeFirstSpend(
	rows: readonly LedgerRow[],
	startMs: number,
	bucketMs: number,
	n: number,
): boolean[] {
	let firstMs = Number.POSITIVE_INFINITY;
	for (const row of rows) {
		if (!isHeaderSpend(row.kind, row.costUt)) continue;
		const t = Date.parse(row.ts);
		// An unreadable time is NaN, which is below nothing: it is passed over.
		if (t < firstMs) firstMs = t;
	}
	const firstBucket = Math.floor((firstMs - startMs) / bucketMs);
	return Array.from({ length: n }, (_, k) => k < firstBucket);
}
