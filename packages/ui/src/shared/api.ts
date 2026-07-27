// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Wire types shared between the server and the SPA. The SPA imports these
 * from `../shared/api.js` — never from server code (Amendment A2).
 */

export interface SummaryPayload {
	vaultPath: string;
	budget: number;
	spentUt: number;
	remainingUt: number;
	chain: { events: number; valid: boolean; breakIndex: number | null; errors: string[] };
	// ANCHOR-INTEGRATION: presence-only placeholder until external anchoring
	// lands on master; "present" means <vault>/audit/anchors/anchors.jsonl exists.
	anchorState: "unanchored" | "present";
	rowCount: number;
	truncated: boolean;
}
