// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * How the client applies the live tail's frames to its rows. A row is identified by its event's HASH, unique on the
 * chain: an `id` is the writer's text, and a later record can reuse one, so matching by id relabelled every row
 * sharing it and dropped the later record from the live list as a "duplicate".
 */

import type { LedgerRow, RowStatus } from "./rows.js";

/** A changed row's new status, as the server sends it in a `status` frame. */
export interface StatusChange {
	id: string;
	hash: string;
	status: RowStatus;
}

/** The rows with each change applied to the ONE row whose event hash it names. */
export function applyStatusChanges(
	rows: readonly LedgerRow[],
	changes: readonly StatusChange[],
): LedgerRow[] {
	const next = new Map(changes.map((c) => [c.hash, c.status]));
	return rows.map((r) => {
		const status = next.get(r.hash);
		return status === undefined ? r : { ...r, status };
	});
}

/**
 * The rows of a `rows` frame not already held. A frame can race the open-triggered resync fetch and redeliver rows the
 * fetch already returned; those are the same events, so the same hashes.
 */
export function novelRows(rows: readonly LedgerRow[], fresh: readonly LedgerRow[]): LedgerRow[] {
	const seen = new Set(rows.map((r) => r.hash));
	return fresh.filter((r) => !seen.has(r.hash));
}
