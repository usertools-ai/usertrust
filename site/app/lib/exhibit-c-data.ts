import denialJson from "../evidence/denial-event.json";
import type { DenialEvidence } from "../evidence/types";

/**
 * Exhibit C's denial evidence — BOTH halves, both captured, neither typed by
 * hand.
 *
 * The history matters, because the page used to say the opposite. A denial
 * wrote nothing to the audit chain: the deny gate threw out of a finally-only
 * try, never entering the catch that emits `llm_call_failed`. That was verified
 * empirically (two calls in, one event out) and the page said only what was
 * true — "the request throws, the ledger never moves" — while the gap was filed
 * as a product defect.
 *
 * #87 closed it. A denial now appends a real `policy_denied` (or
 * `ledger_rejected`) chain event before the error is rethrown, carrying the
 * denial class, the rules that fired, a HASH of the prompt (never the prompt),
 * and the transferId of the hold that never opened. So the honest artifact of a
 * denial is no longer just the throw — it is the throw AND its chain event, and
 * this module exposes both from the same capture run as every other fixture.
 *
 * The fixture is imported here, OUTSIDE app/components/sections/, for the same
 * reason it always was: the captured message carries digits that are the SDK's
 * words, not marketing copy, and the check-facts prebuild gate scans sections
 * line by line. Sections read these exports; they never retype them.
 *
 * Re-capture: `npm run evidence:capture` at the repo root. Never hand-edit.
 */

const denial = denialJson as DenialEvidence;

/** The error the caller receives, verbatim. */
export const THROWN_DENIAL: ThrownDenial = {
	name: denial.error.name,
	message: denial.error.message,
	capturedFrom: denial.reproduce,
	capturedWith: `usertrust ${denial.provenance.usertrustVersion} @ ${denial.provenance.commit}`,
};

/** The chain event that denial wrote — the record it now leaves behind. */
export const DENIAL_EVENT = denial.event;

/** Provenance of the capture both halves came from. */
export const DENIAL_PROVENANCE = denial.provenance;

/**
 * The denial's chain event reduced to the rows the page shows. Built here so
 * Exhibit C renders labels and values, never digit-bearing literals.
 */
export function denialEventRows(): Array<{ label: string; value: string }> {
	const d = denial.event.data;
	const rows: Array<{ label: string; value: string }> = [
		{ label: "kind", value: denial.event.kind },
		{ label: "decision", value: d.decision },
		{ label: "denialClass", value: d.denialClass },
	];
	if (d.policyRules?.[0])
		rows.push({ label: "rule", value: d.policyRules[0].id ?? d.policyRules[0].name });
	if (d.model) rows.push({ label: "model", value: d.model });
	if (d.budget) {
		rows.push({
			label: "estimatedCost",
			value: `${d.budget.estimatedCost.toLocaleString("en-US")} ut`,
		});
		rows.push({
			label: "budgetRemaining",
			value: `${d.budget.budgetRemaining.toLocaleString("en-US")} ut`,
		});
	}
	if (d.promptHash) rows.push({ label: "promptHash", value: d.promptHash });
	if (d.transferId) rows.push({ label: "transferId", value: d.transferId });
	rows.push({ label: "hash", value: denial.event.hash });
	rows.push({ label: "previousHash", value: denial.event.previousHash });
	return rows;
}

export interface ThrownDenial {
	/** Error class name, exactly as the runtime reports it. */
	name: string;
	/** `Error.message`, verbatim — reason clause, hint, and docs line included. */
	message: string;
	/** How the throw was reproduced. */
	capturedFrom: string;
	/** The build it was reproduced against. */
	capturedWith: string;
}

/** Exactly what a terminal prints for the uncaught throw. */
export function denialThrowText(): string {
	return `${THROWN_DENIAL.name}: ${THROWN_DENIAL.message}`;
}

/**
 * Counterfactual-replay media. The paths live here for the same reason the
 * intro's sources live in sections/intro-video-sources.ts (Task 5b): a
 * container extension is a literal digit inside a scanned section file, and
 * the answer is to move the plumbing out of sections/ rather than to loosen
 * the gate.
 */
export const REPLAY_VIDEO = {
	src: "/demo/runaway-agent.mp4",
	poster: "/demo/runaway-agent-poster.jpg",
} as const;
