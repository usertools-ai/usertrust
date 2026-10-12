// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Wire types shared between the server and the SPA. The SPA imports these
 * from `../shared/api.js` — never from server code (Amendment A2).
 */

export interface SummaryPayload {
	vaultPath: string;
	/**
	 * The budget in usertokens, or null when it is UNKNOWN: the vault's governor recorded none and the vault config
	 * gives none. Never 0 standing in for "unknown".
	 */
	budget: number | null;
	/**
	 * Where `budget` came from: the governor's record of what it enforces, or the vault config. Unknown: `several`
	 * governors that disagree, an `unreadable` record, or `unpublished` (no governor has published one yet).
	 */
	budgetSource: "governor" | "config" | "several" | "unreadable" | "unpublished";
	/** When the governor wrote its record (`budgetSource: "governor"` only, else null). */
	budgetWrittenAt: string | null;
	/** Where the budget came from, in words, SHOWN beside it: only a governor record reads as enforced, with its age. */
	budgetProvenance: string;
	spentUt: number;
	/** `budget - spentUt`, or null when the budget is unknown: there is no remaining figure without a budget. */
	remainingUt: number | null;
	/**
	 * `empty`: no events and nothing wrong, a project before its first governed call. It is never set beside a
	 * failure: a log deleted while its anchor still records events has no events either, and is `valid: false`.
	 */
	chain: {
		events: number;
		valid: boolean;
		empty: boolean;
		breakIndex: number | null;
		errors: string[];
	};
	// File presence only — not a verification verdict. The UI has no
	// operator-pinned genesis, and inventing one from the vault under audit
	// would violate "anchor trust never comes from the vault under audit".
	anchorFile: "present" | "absent";
	rowCount: number;
	truncated: boolean;
}
