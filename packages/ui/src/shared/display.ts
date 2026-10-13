// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * What the SPA shows for a summary or a row, decided here, where it is unit-tested, rather than inline in a
 * component. Each function exists because the dashboard once stated something the data did not support.
 */

import type { SummaryPayload } from "./api.js";
import { formatUsd, formatUt } from "./format.js";
import type { LedgerRow } from "./rows.js";

export type ChainStatus = "empty" | "verified" | "broken";

/**
 * A failure always wins: `empty` never quiets one. Before this state existed, a project with no vault yet showed a red
 * CHAIN INTEGRITY FAILURE, and an empty audit directory showed "verified".
 */
export function chainStatus(chain: SummaryPayload["chain"]): ChainStatus {
	if (!chain.valid) return "broken";
	return chain.empty ? "empty" : "verified";
}

/**
 * The anchor file's presence is all the dashboard knows about anchors: the server has no operator-pinned genesis, so
 * it cannot verify them. The cell says that, and how to verify, instead of a bare "absent".
 */
/**
 * How to verify the chain against anchors. Without `--pubkey` the CLI cannot verify anchors at all (it reports them
 * unverifiable), and the key must be pinned outside the vault: anchor trust never comes from the vault under audit.
 */
export const ANCHOR_VERIFY_COMMAND = "usertrust verify --anchors <file> --pubkey <genesis.pem>";

export function anchorView(anchorFile: SummaryPayload["anchorFile"]): {
	label: "present" | "not present";
	explainer: string;
} {
	return {
		label: anchorFile === "present" ? "present" : "not present",
		explainer: `An anchor file mirrors chain checkpoints outside this vault's log. This dashboard only checks whether the file exists; it does not verify anchors. To check the chain against anchors, run ${ANCHOR_VERIFY_COMMAND} in the project directory, where <genesis.pem> is the anchoring public key you pinned outside this vault, never one read from it.`,
	};
}

/** A row's cost, or null when it has none: an absent cost is unknown, never shown as 0. */
export function costView(row: LedgerRow): { ut: string; usd: string; estimated: boolean } | null {
	if (row.costUt === undefined) return null;
	return {
		ut: formatUt(row.costUt),
		usd: formatUsd(row.costUt),
		// The governor estimated the usage (the provider reported none): the cost is an estimate, and says so.
		estimated: row.usageSource === "estimated",
	};
}

/**
 * A row's transfer. A row with none (a denial written before any hold, an ungoverned call) has nothing to verify,
 * and says so: the table printed its EVENT id under "Tx", in the same style, where it read as a transfer id.
 */
export function transferView(row: LedgerRow): { kind: "transfer"; id: string } | { kind: "none" } {
	return row.transferId === undefined ? { kind: "none" } : { kind: "transfer", id: row.transferId };
}

export type LoadPhase = "loading" | "loaded" | "failed";
export type ListState = "loading" | "failed" | "first-run" | "no-rows" | "filtered-out" | "rows";

/**
 * What the ledger list shows. Rows start empty while the first snapshot is in flight, and the list printed "no
 * matching transactions — clear filters" for that, for an empty vault, and for filters that hide every row alike.
 * A vault with no rows is a first run only when its chain is empty: a deleted log has no rows either.
 */
export function listState(input: {
	phase: LoadPhase;
	chain: ChainStatus | null;
	total: number;
	shown: number;
}): ListState {
	if (input.total === 0) {
		if (input.phase === "failed") return "failed";
		if (input.phase === "loading" || input.chain === null) return "loading";
		return input.chain === "empty" ? "first-run" : "no-rows";
	}
	return input.shown === 0 ? "filtered-out" : "rows";
}

/**
 * The server keeps the newest `rowCount` events only. The header's Spend and Chain cover the whole vault; the list,
 * the filters, Trends and Export cover the window. Said once, in words, where it limits what is shown.
 */
export function windowNotice(
	summary: Pick<SummaryPayload, "truncated" | "rowCount" | "chain">,
): string | null {
	if (!summary.truncated) return null;
	return `Showing the newest ${summary.rowCount.toLocaleString()} of ${summary.chain.events.toLocaleString()} events. Filters, Trends and Export cover these only.`;
}
