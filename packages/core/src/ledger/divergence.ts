// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import type { TrustReceipt } from "../shared/types.js";

/**
 * Compute the settlement divergence signal: how far provider-reported cost
 * strayed from the pre-call estimate.
 *
 * ratio = actualCost / estimatedCost. A provider reporting far LESS than
 * estimated (ratio << 1) is the under-reporting-server signal the limitation
 * names; far MORE (ratio >> 1) catches estimate blowouts / misconfigured rates.
 * The comparison is only meaningful against provider-reported usage —
 * estimated-vs-estimated is tautological (ratio === 1 by construction) — so this
 * returns undefined unless usageSource === "provider".
 *
 * flagged = ratio > factor || ratio < 1 / factor.
 *
 * Every input is finite-guarded: a non-finite/non-positive estimate, a
 * non-finite/negative actual, or a non-finite/non-positive factor yields a safe
 * result (undefined, or the default factor). A NaN/Infinity ratio never leaks
 * into a receipt.
 */
export function computeDivergence(
	estimatedCost: number,
	actualCost: number,
	usageSource: "provider" | "estimated",
	factor: number,
): TrustReceipt["divergence"] | undefined {
	// Only provider-reported usage is comparable; estimate-vs-estimate is a tautology.
	if (usageSource !== "provider") return undefined;
	// Nothing trustworthy to compare against a non-positive/non-finite estimate.
	if (!Number.isFinite(estimatedCost) || estimatedCost <= 0) return undefined;
	// A non-finite/negative actual is untrustworthy — omit rather than emit NaN.
	if (!Number.isFinite(actualCost) || actualCost < 0) return undefined;
	// A non-finite/non-positive factor would make the tolerance band nonsensical;
	// fall back to the schema default so the flag stays well defined.
	const f = Number.isFinite(factor) && factor > 0 ? factor : 4;
	const ratio = actualCost / estimatedCost;
	// estimatedCost > 0 and actualCost finite => ratio is finite; guard anyway.
	if (!Number.isFinite(ratio)) return undefined;
	const flagged = ratio > f || ratio < 1 / f;
	return { ratio, estimatedCost, actualCost, flagged };
}
