// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import {
	costFromRates,
	type ModelRates,
	type NormalizedUsage,
	withSupported1hTier,
} from "usertrust";
import type { Hold } from "./gate.js";

export interface SettlementAmounts {
	/** The actual cost of the reported usage, in usertokens. */
	actual: number;
	/** What the hold posts: the actual cost, capped at the hold. */
	post: number;
	/** Cost above the hold, debited to the budget's debt account (a later slice). */
	overage: number;
	/**
	 * Present ONLY when the reported usage was refused as implausible (a count above the plausibility ceiling): the
	 * call settles AT THE HOLD, not at the 1-usertoken floor a zeroed snapshot would price to, and the refused figures
	 * are named here so the caller records the anomaly.
	 */
	anomaly?: { implausible: NonNullable<NormalizedUsage["implausible"]> };
}

/**
 * Prices reported usage on all four tiers and splits it against the hold. The rates
 * are the HOLD'S snapshot (`Hold.rates`), never re-resolved: operator rates that
 * changed after the reservation must not settle the call below what it was held at.
 * TigerBeetle refuses a post above its pending amount, so the post is capped at the
 * hold and any excess is an overage — a finding every time, because it means the
 * ceiling was wrong. A reported 1-hour share counts only for rates that have a 1-hour
 * tier (`withSupported1hTier`, the one predicate; `operatorOwned` says the rates are the
 * operator's, not a built-in row), exactly as the core governor decides it.
 */
export function settlementAmounts(
	rates: ModelRates,
	usage: NormalizedUsage,
	hold: number,
	operatorOwned = false,
): SettlementAmounts {
	const metered = withSupported1hTier(usage, rates, operatorOwned);
	// An implausible reading survives the tier decision only when it is real for this model: the snapshot is then an
	// ESTIMATE with zeroed counts, which must never be priced as if the call used nothing.
	if (metered.implausible !== undefined) {
		return {
			actual: hold,
			post: hold,
			overage: 0,
			anomaly: { implausible: { ...metered.implausible } },
		};
	}
	const actual = costFromRates(
		rates,
		metered.inputTokens,
		metered.outputTokens,
		metered.cacheReadTokens,
		metered.cacheWriteTokens,
		metered.cacheWrite1hTokens ?? 0,
	);
	return { actual, post: Math.min(actual, hold), overage: Math.max(0, actual - hold) };
}

/** Settle a hold to reported usage with the hold's OWN rate snapshot and amount. */
export function settleHold(
	hold: Pick<Hold, "rates" | "amount" | "operatorOwned">,
	usage: NormalizedUsage,
): SettlementAmounts {
	return settlementAmounts(hold.rates, usage, hold.amount, hold.operatorOwned ?? false);
}
