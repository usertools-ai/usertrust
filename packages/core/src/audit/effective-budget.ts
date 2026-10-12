// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The budget a governor ENFORCES, recorded in its own vault.
 *
 * A governor resolves its budget from several places: `opts.budget` (how the server passes a tenant's budget, and how
 * an SDK caller passes one to `trust()`), a config file that may live outside the vault (`opts.configPath`), the
 * vault's own `usertrust.config.json`, or the built-in default when there is no file at all. Vault readers (the
 * ledger UI, `inspect`, `health`, `report`) see only the vault, so before this record they read the vault's config
 * file and answered 0 whenever the budget came from anywhere else: "no budget set", and a negative remaining.
 *
 * The governor writes the value it resolved, after resolving it, so a reader takes the enforced number rather than
 * re-deriving it. The record is ADVISORY: enforcement never reads it, so a failed write never stops a governor from
 * starting. A failed write does remove any earlier record, so a reader falls back rather than showing the budget of an
 * earlier run as if it were current.
 *
 * It is derived state, rewritten at every governor start, so snapshots do not capture it. This module only READS it
 * (readers never write to the vault); the governor's writer is `budget/effective-record.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const EFFECTIVE_BUDGET_FILE = "effective-budget.json";

export type EffectiveBudgetReading =
	| { state: "recorded"; budget: number }
	| { state: "absent" }
	| { state: "unreadable"; reason: string };

/** The recorded enforced budget. Only a missing file is "absent"; anything else that is not a valid record is unreadable. */
export function readEffectiveBudget(vaultDir: string): EffectiveBudgetReading {
	let text: string;
	try {
		text = readFileSync(join(vaultDir, EFFECTIVE_BUDGET_FILE), "utf-8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") return { state: "absent" };
		return { state: "unreadable", reason: typeof code === "string" ? code : "read failed" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { state: "unreadable", reason: "not valid JSON" };
	}
	const budget = (parsed as { budget?: unknown } | null)?.budget;
	if (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget <= 0) {
		return { state: "unreadable", reason: "no positive integer budget" };
	}
	return { state: "recorded", budget };
}
