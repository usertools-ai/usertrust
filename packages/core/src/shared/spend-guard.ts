// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Whether a cumulative session spend may be WRITTEN to `.usertrust/spend-ledger.json`.
 *
 * A figure above `Number.MAX_SAFE_INTEGER` is not a count of usertokens any more: it cannot be represented exactly, it
 * seeds the TigerBeetle wallet as `max(0, budget - spent)` = 0 forever, and it refuses every later call until someone
 * hand-edits the file. Not persisting it keeps the vault usable: the in-process counter still refuses further calls this
 * session, and the next start reads the last value that was safe to keep.
 */
export function isPersistableSpend(budgetSpent: number): boolean {
	return Number.isFinite(budgetSpent) && budgetSpent >= 0 && budgetSpent <= Number.MAX_SAFE_INTEGER;
}

/**
 * A persisted `budgetSpent` this many times the configured budget (or above the safe-integer range) is not a spent
 * budget, it is a runaway: `usertrust health` reports it instead of an ordinary "100% used".
 */
export const RUNAWAY_SPEND_BUDGET_FACTOR = 1000;

export function isRunawaySpend(budgetSpent: number, budget: number): boolean {
	if (!Number.isFinite(budgetSpent)) return false;
	if (budgetSpent > Number.MAX_SAFE_INTEGER) return true;
	return budget > 0 && budgetSpent > budget * RUNAWAY_SPEND_BUDGET_FACTOR;
}
