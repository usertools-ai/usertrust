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
	/** Where `budget` came from: the governor's record of what it enforces, the vault config, or nowhere. */
	budgetSource: "governor" | "config" | "none";
	spentUt: number;
	/** `budget - spentUt`, or null when the budget is unknown: there is no remaining figure without a budget. */
	remainingUt: number | null;
	chain: { events: number; valid: boolean; breakIndex: number | null; errors: string[] };
	// File presence only — not a verification verdict. The UI has no
	// operator-pinned genesis, and inventing one from the vault under audit
	// would violate "anchor trust never comes from the vault under audit".
	anchorFile: "present" | "absent";
	rowCount: number;
	truncated: boolean;
}
