// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A TRANSFER's verdict, from all of its chain records: the ONE classification. `verifyTransaction` renders it as a
 * receipt; the ledger UI shows it on every row of the transfer. Both call this, so they cannot disagree.
 *
 * `matching` is every event recorded for one transfer, in chain order (the caller matches them: by `transferId`, and
 * `settlement_unrecoverable` by the hash of the queried id).
 */

import {
	eventStatus,
	RELEASE_KINDS,
	type TransactionEvent,
	UNRECOVERABLE_KINDS,
} from "./receipt.js";

export type TransferStatus =
	| "SETTLED"
	| "AMBIGUOUS"
	| "FAILED"
	| "DENIED"
	| "RELEASED"
	| "UNRECOVERABLE"
	| "PENDING";

export interface TransferVerdict {
	status: TransferStatus;
	/** The record the verdict rests on. */
	event: TransactionEvent;
}

const isFailureTerminal = (e: TransactionEvent): boolean =>
	e.kind === "stream_partial_delivery" ||
	e.kind === "llm_call_failed" ||
	e.kind.endsWith("_failed");
// A DENIAL is conclusive too. It was missing from this predicate, so a later
// appended `settled: true` could still override an earlier `policy_denied` or
// `ledger_rejected` — the same forgery, one kind along. A refused call moved no
// money and will never settle, which is exactly what "terminal" means here.
const isDenialTerminal = (e: TransactionEvent): boolean =>
	e.kind === "policy_denied" || e.kind === "ledger_rejected";
// A RELEASE is conclusive at the failure tier: a hold given back moved no money and
// will never settle, so a later appended `settled: true` must not rewrite it.
const isReleaseTerminal = (e: TransactionEvent): boolean => RELEASE_KINDS.has(e.kind);
// `settlement_ambiguous` is CONCLUSIVE and comes FIRST. The producer appends it
// BEFORE the `llm_call` it corrects (`headless.ts:1425` then `:1484`;
// `govern.ts:1798` then `:1887`), so a crash or a failed second append can
// leave it as the only durable record of the outcome. Excluding it let a later
// hash-valid `settled: true` rewrite an ambiguous settlement into a clean one —
// the same forgery as the failure and denial cases, one kind along, and the
// most valuable one to forge because it converts "we do not know whether this
// spend landed" into "it did".
const isTerminal = (e: TransactionEvent): boolean =>
	e.data.settled !== undefined ||
	isFailureTerminal(e) ||
	isDenialTerminal(e) ||
	isReleaseTerminal(e) ||
	UNRECOVERABLE_KINDS.has(e.kind) ||
	e.kind === "settlement_ambiguous";

// FIRST TERMINAL IN CHAIN ORDER WINS. Not the best-TYPED terminal anywhere in
// the log — that was a forgery vector, and it was mine.
//
// Ranking settlement above failure across the WHOLE history let a LATER record
// override an EARLIER one. The audited party owns `events.jsonl`, so it could
// append a hash-valid `settled: true` reusing a transferId after an anchored
// FAILURE or DENIAL, and the receipt would read SETTLED — without altering the
// anchored prefix, so anchoring would not catch it either. `finalizeOnce`
// makes first-terminal-wins a producer invariant (AGENTS.md); a verifier that
// ranks by type instead of by order does not merely miss a forgery, it
// performs one.
//
// A DETECTION is still outranked, which is the whole point of scanning past
// the first match: `anomaly_detected` precedes its terminal by construction
// and is not conclusive on its own.
export function firstTerminalOf(
	matching: readonly TransactionEvent[],
): TransactionEvent | undefined {
	return matching.find(isTerminal);
}

/** The record a transfer's verdict rests on, or undefined for a transfer with no records. */
export function selectTransferEvent(
	matching: readonly TransactionEvent[],
): TransactionEvent | undefined {
	const firstTerminal = firstTerminalOf(matching);
	// AMBIGUITY DOWNGRADES A SETTLEMENT, from anywhere in the transfer's records.
	//
	// First-terminal-wins alone is wrong here because the two producers order
	// these differently. The AUDIT-FIRST path writes the `llm_call` with an
	// optimistic `settled: true` BEFORE the POST, then appends
	// `settlement_ambiguous` only if the POST throws (`govern.ts`); the headless
	// and stream paths append the ambiguity FIRST. Taking the first terminal in
	// chain order therefore printed SETTLED for an ordinary POST failure.
	//
	// The safe generalisation is directional. A correction that REDUCES certainty
	// can be honoured from anywhere, because forging one gains an attacker
	// nothing — the worst it does is make a real settlement read as unknown. A
	// record that INCREASES certainty must never override an earlier terminal,
	// which is the forgery this selector already refuses. So: ambiguity beats a
	// settlement, and nothing beats a failure or a denial.
	const ambiguity = matching.find((e) => e.kind === "settlement_ambiguous");
	// A SETTLEMENT is not "anything carrying `settled`": `llm_call_failed` records
	// `settled: false`, so a presence test let ambiguity downgrade a FAILURE. That
	// inverts the rule above — losing certainty is harmless on a settlement, but a
	// failure is already the worst verdict, so moving it to "unknown" launders it.
	const firstIsSettlement =
		firstTerminal !== undefined &&
		firstTerminal.data.settled !== undefined &&
		!isFailureTerminal(firstTerminal) &&
		!isDenialTerminal(firstTerminal) &&
		!isReleaseTerminal(firstTerminal);
	const targetEvent =
		ambiguity !== undefined && (firstTerminal === undefined || firstIsSettlement)
			? ambiguity
			: (firstTerminal ?? matching[0]);
	return targetEvent;
}

/** The transfer's verdict: the selected record's status. Undefined for a transfer with no records. */
export function transferVerdict(
	matching: readonly TransactionEvent[],
): TransferVerdict | undefined {
	const event = selectTransferEvent(matching);
	return event === undefined ? undefined : { status: eventStatus(event), event };
}
