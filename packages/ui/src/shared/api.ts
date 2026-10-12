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
	/** `busy`: the vault kept changing while it was read, so there is no verdict (`valid` means nothing). */
	chain: {
		events: number;
		valid: boolean;
		breakIndex: number | null;
		errors: string[];
		busy?: boolean;
	};
	// File presence only — not a verification verdict. The UI has no
	// operator-pinned genesis, and inventing one from the vault under audit
	// would violate "anchor trust never comes from the vault under audit".
	anchorFile: "present" | "absent";
	rowCount: number;
	truncated: boolean;
}
