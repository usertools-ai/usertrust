// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { costFromRates, getModelRates, type ModelRates, type NormalizedUsage } from "usertrust";

export interface SettlementAmounts {
	/** The actual cost of the reported usage, in usertokens. */
	actual: number;
	/** What the hold posts: the actual cost, capped at the hold. */
	post: number;
	/** Cost above the hold, debited to the budget's debt account (a later slice). */
	overage: number;
}

/**
 * Prices reported usage on all four tiers and splits it against the hold.
 * TigerBeetle refuses a post above its pending amount, so the post is capped at
 * the hold and any excess is an overage — a finding every time, because it means
 * the ceiling was wrong.
 */
export function settlementAmounts(
	model: string,
	usage: NormalizedUsage,
	hold: number,
	customRates?: Record<string, ModelRates>,
): SettlementAmounts {
	const actual = costFromRates(
		getModelRates(model, customRates),
		usage.inputTokens,
		usage.outputTokens,
		usage.cacheReadTokens,
		usage.cacheWriteTokens,
	);
	return { actual, post: Math.min(actual, hold), overage: Math.max(0, actual - hold) };
}
