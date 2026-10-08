// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { costFromRates, type ModelRates, type NormalizedUsage } from "usertrust";
import type { Hold } from "./gate.js";

export interface SettlementAmounts {
	/** The actual cost of the reported usage, in usertokens. */
	actual: number;
	/** What the hold posts: the actual cost, capped at the hold. */
	post: number;
	/** Cost above the hold, debited to the budget's debt account (a later slice). */
	overage: number;
}

/**
 * Prices reported usage on all four tiers and splits it against the hold. The rates
 * are the HOLD'S snapshot (`Hold.rates`), never re-resolved: operator rates that
 * changed after the reservation must not settle the call below what it was held at.
 * TigerBeetle refuses a post above its pending amount, so the post is capped at the
 * hold and any excess is an overage — a finding every time, because it means the
 * ceiling was wrong.
 */
export function settlementAmounts(
	rates: ModelRates,
	usage: NormalizedUsage,
	hold: number,
): SettlementAmounts {
	const actual = costFromRates(
		rates,
		usage.inputTokens,
		usage.outputTokens,
		usage.cacheReadTokens,
		usage.cacheWriteTokens,
		usage.cacheWrite1hTokens ?? 0,
	);
	return { actual, post: Math.min(actual, hold), overage: Math.max(0, actual - hold) };
}

/** Settle a hold to reported usage with the hold's OWN rate snapshot and amount. */
export function settleHold(
	hold: Pick<Hold, "rates" | "amount">,
	usage: NormalizedUsage,
): SettlementAmounts {
	return settlementAmounts(hold.rates, usage, hold.amount);
}
