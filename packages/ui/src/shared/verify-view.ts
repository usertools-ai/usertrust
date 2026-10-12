// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The inspector's Verify: what a `/api/verify/:txId` response means, and which row version it belongs to.
 */

export type VerifyOutcome =
	| { kind: "verified"; receipt: string }
	| { kind: "failed"; receipt: string; reason: string | undefined }
	| { kind: "not-found"; receipt: string; reason: string | undefined }
	| { kind: "request-failed"; reason: string };

/**
 * `found: false` is NOT a failed verification: the transaction is not in the log `--tx` reads (no live log, an empty
 * one, or a record outside it). The panel read `valid` alone and printed a red "FAILED: Audit log not found".
 * Anything that is not a verification result (a 400, a proxy's error page) is a failed request.
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
	return b.valid
		? { kind: "verified", receipt: b.receipt }
		: { kind: "failed", receipt: b.receipt, reason };
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
