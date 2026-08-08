// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Chain events for governance DENIALS.
 *
 * A denied call used to leave no record at all: nothing for `usertrust verify`
 * to show, nothing for the ledger UI to render, nothing for the entropy health
 * signal to count, and no handle a caller could quote back. The two kinds here
 * close that gap without touching the money path.
 *
 * `policy_denied` records a decision the GOVERNOR made — a policy rule, a
 * budget-family rule, PII, injection, or an unpriceable model. `ledger_rejected`
 * records the ledger's own atomic refusal of a hold, which is a different fact
 * with a different remedy and therefore a different kind.
 *
 * Shared by `govern.ts` and `headless.ts` deliberately: the two governors must
 * write the same shapes, and a file-private helper in one of them guarantees
 * they eventually will not.
 *
 * PAYLOAD DISCIPLINE: every field is PII-safe. Rule ids and names, PII TYPE
 * names, injection PATTERN names, numbers, and a redacted-then-truncated error
 * string — never prompt content, never tool arguments, never a matched value.
 * The DLQ persists whatever an event carried, verbatim and unhashed, so a
 * prompt-bearing field added here lands in the clear on disk.
 */

import { createHash } from "node:crypto";
import { isBudgetRuleMatch, type RuleMatch } from "../policy/gate.js";
import { redactPII } from "../policy/pii.js";
import {
	type DenialAuditMetadata,
	InsufficientBalanceError,
	PolicyDeniedError,
} from "../shared/errors.js";
import type { AuditWriter } from "./chain.js";

/** Both denial kinds carry this, so a reader can tell old records from new. */
export const DENIAL_SCHEMA_VERSION = 1 as const;

/**
 * Names the prompt-hash construction: `sha256(JSON.stringify(promptParts))`.
 * Written beside every `promptHash` so a future construction change is a new
 * algorithm string rather than a silent reinterpretation of old records.
 */
export const PROMPT_HASH_ALG = "sha256-json-v1" as const;

/** The event kinds this module appends. Exported for the consumers that filter on them. */
export const POLICY_DENIED_KIND = "policy_denied" as const;
export const LEDGER_REJECTED_KIND = "ledger_rejected" as const;

export type DenialClass = "policy" | "budget_gate" | "pii" | "injection" | "unknown_model";

/** A hard violation, reduced to the two identifiers that are safe to persist. */
export interface DenialRuleRef {
	id?: string;
	name: string;
}

/**
 * What the THROW SITE knows and the boundary does not.
 *
 * This is a per-invocation mutable record living in the flow's own closure. It
 * is deliberately NOT a property of the thrown error: non-enumerable is not
 * enough, because a descriptor read or a symbol key still reaches it, and the
 * caller's own log line is exactly where "no prompt content leaves the process"
 * would die.
 */
export interface DenialRecord {
	denialClass: DenialClass;
	/** Hard violations only — a soft warning is not evidence for a deny. */
	policyRules?: DenialRuleRef[];
	piiTypes?: string[];
	injectionPatterns?: string[];
	/** Cheap numeric evidence, carried for the `budget_gate` class only. */
	budget?: { estimatedCost: number; budgetRemaining: number };
}

/** What the BOUNDARY knows from its own closure: this call's ambient identity. */
export interface DenialEventFields {
	model?: string | undefined;
	actionKind?: string | undefined;
	actionName?: string | undefined;
	costCenter?: string | undefined;
	/**
	 * The endpoint CLASS captured at authorize ("cloud" / "local"). Spelled
	 * `endpointClass` to match every other persisted audit record — the
	 * `endpoint: { class, runtime }` shape belongs to `TrustReceipt`, which
	 * never reaches the chain. One spelling across the audit surface.
	 */
	endpointClass?: string | undefined;
	transferId?: string | undefined;
	/** Hashed, never persisted. Absent on a surface that has no prompt. */
	promptParts?: unknown;
	/** The hold amount the ledger refused — `ledger_rejected` only. */
	estimatedCost?: number | undefined;
}

export interface AppendDenialEventArgs {
	audit: AuditWriter;
	actor: string;
	/** The error about to be rethrown. Non-denials are ignored. */
	error: unknown;
	/** Absent for a ledger rejection, which has no policy evidence to carry. */
	record: DenialRecord | undefined;
	fields: DenialEventFields;
}

/** How much of the error message survives into the event. */
const ERROR_TEXT_LIMIT = 200;

/**
 * The two error classes that represent a GOVERNANCE DECISION.
 *
 * `CircuitOpenError` is deliberately not here: an open breaker is an
 * infrastructure refusal, not a governance decision, and conflating the two
 * would make a provider outage read as a policy denial. Anomaly aborts already
 * have `anomaly_detected`.
 */
export function isGovernanceDenial(
	err: unknown,
): err is PolicyDeniedError | InsufficientBalanceError {
	return err instanceof PolicyDeniedError || err instanceof InsufficientBalanceError;
}

/**
 * `budget_gate` iff EVERY hard violation is budget-family; `policy` otherwise.
 *
 * The `every` is the point: a call denied by a budget rule AND a content rule is
 * a CONTENT denial that also happened to be short on funds, and telling the
 * operator to top up an envelope would send them to a lever that cannot lift it.
 * An empty violation set answers `policy`, not `budget_gate` — `[].every()` is
 * vacuously true, and a reason-less deny is not a budget deny.
 */
export function classifyPolicyDenial(hardViolations: RuleMatch[]): DenialClass {
	if (hardViolations.length === 0) return "policy";
	return hardViolations.every(isBudgetRuleMatch) ? "budget_gate" : "policy";
}

/**
 * Reduce hard violations to persistable references. An ID-less rule OMITS the
 * property rather than carrying `undefined`; duplicates are preserved, because
 * two distinct rules sharing a name is information about the policy file.
 */
export function toDenialRuleRefs(hardViolations: RuleMatch[]): DenialRuleRef[] {
	return hardViolations.map((v) => ({ ...(v.id !== undefined ? { id: v.id } : {}), name: v.name }));
}

/**
 * The pattern-memory construction, reused so the two hashes JOIN.
 *
 * Returns `undefined` rather than throwing for input `JSON.stringify` refuses
 * (circular, bigint): a denial must never be weakened, or turned into a
 * different error, by a hashing failure. The field is simply absent.
 */
export function computePromptHash(promptParts: unknown): string | undefined {
	try {
		return createHash("sha256").update(JSON.stringify(promptParts)).digest("hex");
	} catch {
		return undefined;
	}
}

/**
 * Attach the correlation handle to the error INSTANCE the caller will receive.
 *
 * `defineProperty` on the original object, never a reconstructed error: the
 * envelope-threading suite pins same-object identity through the governor's
 * terminals, and rebuilding the error here would also drop any subclass a
 * future caller throws.
 */
export function attachDenialAudit(error: object, meta: DenialAuditMetadata): void {
	for (const [key, value] of Object.entries(meta)) {
		if (value === undefined) continue;
		Object.defineProperty(error, key, {
			value,
			enumerable: true,
			writable: false,
			configurable: true,
		});
	}
}

/** Redact, then clip. Redacting after the clip could split a match in half. */
function safeErrorText(message: string): string {
	return String(redactPII(message).data).slice(0, ERROR_TEXT_LIMIT);
}

function buildPolicyDeniedData(
	error: PolicyDeniedError,
	record: DenialRecord,
	fields: DenialEventFields,
): Record<string, unknown> {
	const promptHash =
		fields.promptParts === undefined ? undefined : computePromptHash(fields.promptParts);
	return {
		schemaVersion: DENIAL_SCHEMA_VERSION,
		// Load-bearing: this is the field `usertrust health`'s entropy detector
		// reads to count the violation.
		decision: "deny",
		denialClass: record.denialClass,
		...(fields.model !== undefined ? { model: fields.model } : {}),
		...(fields.actionKind !== undefined ? { actionKind: fields.actionKind } : {}),
		...(fields.actionName !== undefined ? { actionName: fields.actionName } : {}),
		...(record.policyRules !== undefined ? { policyRules: record.policyRules } : {}),
		...(record.piiTypes !== undefined ? { piiTypes: record.piiTypes } : {}),
		...(record.injectionPatterns !== undefined
			? { injectionPatterns: record.injectionPatterns }
			: {}),
		...(record.budget !== undefined ? { budget: record.budget } : {}),
		// The algorithm tag rides with the hash and never without it.
		...(promptHash !== undefined ? { promptHash, promptHashAlg: PROMPT_HASH_ALG } : {}),
		...(fields.costCenter !== undefined ? { costCenter: fields.costCenter } : {}),
		...(fields.endpointClass !== undefined ? { endpointClass: fields.endpointClass } : {}),
		error: safeErrorText(error.message),
		...(fields.transferId !== undefined ? { transferId: fields.transferId } : {}),
	};
}

function buildLedgerRejectedData(
	error: InsufficientBalanceError,
	fields: DenialEventFields,
): Record<string, unknown> {
	// No promptHash here, on purpose: a rejected hold is a MONEY fact, and a
	// second prompt-derived field would be a second place for prompt-adjacent
	// data to reach the chain and the DLQ for no diagnostic gain.
	return {
		schemaVersion: DENIAL_SCHEMA_VERSION,
		decision: "deny",
		...(fields.model !== undefined ? { model: fields.model } : {}),
		...(fields.actionKind !== undefined ? { actionKind: fields.actionKind } : {}),
		...(fields.transferId !== undefined ? { transferId: fields.transferId } : {}),
		...(fields.estimatedCost !== undefined ? { estimatedCost: fields.estimatedCost } : {}),
		...(fields.costCenter !== undefined ? { costCenter: fields.costCenter } : {}),
		...(fields.endpointClass !== undefined ? { endpointClass: fields.endpointClass } : {}),
		error: safeErrorText(error.message),
	};
}

/**
 * Append the denial event and attach its hash to the error. NEVER throws.
 *
 * Call this from a flow BOUNDARY — after the budget mutex has been released,
 * and lexically before the guarded call — then rethrow the original error.
 *
 * The append-failure contract is deliberately flat across every mode, including
 * `audit.failClosed`. `failClosed` exists to stop an unaudited SPEND from
 * settling; a denial already refused the call and moved no money, so there is
 * nothing left for it to fail closed about. Escalating here would replace a
 * typed, actionable denial with an `AuditDegradedError` and hide WHY the call
 * was refused — strictly worse for the operator, and no safer for the ledger.
 * The writer has already dead-lettered the payload by the time it throws; all
 * that is left to record is that the record is missing, which is what
 * `auditDegraded` says.
 */
export async function appendDenialEvent(args: AppendDenialEventArgs): Promise<void> {
	const { audit, actor, error, record, fields } = args;
	if (!isGovernanceDenial(error)) return;

	const isLedgerRejection = error instanceof InsufficientBalanceError;
	const kind = isLedgerRejection ? LEDGER_REJECTED_KIND : POLICY_DENIED_KIND;
	const data = isLedgerRejection
		? buildLedgerRejectedData(error, fields)
		: buildPolicyDeniedData(error, record ?? { denialClass: "policy" }, fields);

	try {
		const event = await audit.appendEvent({ kind, actor, data });
		attachDenialAudit(error, { auditEventHash: event.hash });
	} catch {
		attachDenialAudit(error, { auditDegraded: true });
	}
}
