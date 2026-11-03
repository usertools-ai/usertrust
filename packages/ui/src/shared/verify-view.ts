// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The inspector's Verify: what a `/api/verify/:txId` response means, and which row version it belongs to.
 */

/**
 * `verified` is the explicit check passing AGAINST AN ANCHOR. A check that passed without one (the receipt's Merkle
 * row reads `CHAIN CONSISTENT (UNANCHORED)`, or anything short of an inclusion proof) is `consistent-unanchored`:
 * the chain agrees with itself, which a log cut short and rewritten to match also does.
 */
export type VerifyOutcome =
	| { kind: "verified"; receipt: string }
	| { kind: "consistent-unanchored"; receipt: string }
	| { kind: "failed"; receipt: string; reason: string | undefined }
	| { kind: "not-found"; receipt: string; reason: string | undefined }
	| { kind: "request-failed"; reason: string };

/**
 * The receipt's Merkle row: `│  Merkle ........ <label> │`. Read from that row only, never from anywhere in the
 * text, because the receipt also prints the event's own fields, which the vault under audit wrote.
 */
const MERKLE_ROW = /^│ {2}Merkle[ .]+(.+?)\s*│$/m;

/** Whether a receipt proves inclusion against an anchor: its Merkle row says `INCLUSION VERIFIED`, nothing less. */
export function receiptAnchored(receipt: string): boolean {
	return MERKLE_ROW.exec(receipt)?.[1]?.startsWith("INCLUSION VERIFIED") === true;
}

/**
 * `found: false` is NOT a failed verification: the transaction is in none of the audit segments `--tx` reads (no
 * segment at all, empty ones, or a record outside them). The panel read `valid` alone and printed a red "FAILED: Audit log not found".
 * Anything that is not a verification result (a 400, a proxy's error page) is a failed request. A valid check is
 * `verified` only when its receipt is anchored (`receiptAnchored`).
 */
export function verifyOutcome(httpStatus: number, body: unknown): VerifyOutcome {
	if (body === null || typeof body !== "object")
		return { kind: "request-failed", reason: `HTTP ${httpStatus}` };
	const b = body as Record<string, unknown>;
	if (typeof b.found !== "boolean" || typeof b.valid !== "boolean" || typeof b.receipt !== "string")
		return {
			kind: "request-failed",
			reason: typeof b.error === "string" ? b.error : `HTTP ${httpStatus}`,
		};
	const errors = Array.isArray(b.errors) ? b.errors.filter((e) => typeof e === "string") : [];
	const reason = errors[0] as string | undefined;
	if (!b.found) return { kind: "not-found", receipt: b.receipt, reason };
	if (!b.valid) return { kind: "failed", receipt: b.receipt, reason };
	return receiptAnchored(b.receipt)
		? { kind: "verified", receipt: b.receipt }
		: { kind: "consistent-unanchored", receipt: b.receipt };
}

/** A value fetched for one row VERSION: the row object it was requested for. */
export interface Held<R, T> {
	row: R;
	value: T;
}

/**
 * The held value, only while the row is still the version it was requested for. A status correction replaces the
 * row object (`applyStatusChanges`), so a response requested before the correction is never shown beside the new
 * status, even when it lands after the correction cleared the panel, and even when the status later changes back.
 */
export function heldFor<R extends object, T>(held: Held<R, T> | null, row: R): T | null {
	return held !== null && held.row === row ? held.value : null;
}
