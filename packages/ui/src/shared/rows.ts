// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Flatten persisted audit events into the stable row shape the table and
 * dashboard consume. The `data` payload is schemaless — every per-kind
 * extraction lives HERE, defensively, and nowhere else.
 */

import type { ChainIntegrity, PersistedAuditEvent } from "usertrust";
import type { TransferStatus } from "usertrust-verify";

export type RowIntegrity = "verified" | "after-break";

export interface LedgerRow {
	seq: number | null;
	id: string;
	ts: string;
	kind: string;
	actor: string;
	source?: string;
	model?: string;
	provider?: string;
	costUt?: number;
	costUsd?: number;
	settled?: boolean;
	error?: string;
	transferId?: string;
	usageSource?: "provider" | "estimated";
	/** The job the record belongs to, when it carries one. */
	job?: string;
	/**
	 * What KIND of work the job was, as DECLARED when it was authorized (see `JOB_TYPE_CAVEAT`). One of
	 * `JOB_TYPES`, or `UNRECOGNIZED` for a value outside that list. Absent on a record that carries none.
	 */
	jobType?: string;
	/** Who declared the type: one of `TYPE_SOURCES`, or `UNRECOGNIZED`. Absent when the record carries none. */
	typeSource?: string;
	/**
	 * The row's status, set by the SERVER from its transfer's verdict (`transferVerdict` in usertrust-verify, the one
	 * classification `usertrust-verify --tx` prints). Absent only on a row built without one; `statusOf` then falls
	 * back to the kind's class.
	 */
	status?: RowStatus;
	hash: string;
	previousHash: string;
	integrity: RowIntegrity;
}

/**
 * The closed list of job types core accepts (`JOB_TYPES`) and of who may declare one (`TYPE_SOURCES`). Mirrored here
 * because the browser bundle cannot import core at runtime; `tests/job-type.test.ts` fails when either list drifts.
 */
export const JOB_TYPES = [
	"feature",
	"bugfix",
	"review",
	"test",
	"docs",
	"ops",
	"research",
	"other",
] as const;
export const TYPE_SOURCES = ["explicit", "agent"] as const;

/** A record with no job type: written before typed jobs, or by a caller that declared none. */
export const UNTYPED = "untyped";
/** A job type or source outside the closed lists: shown as found, never dropped, never counted as a listed type. */
export const UNRECOGNIZED = "unrecognized";

/**
 * Wherever a job-type total or a job type is shown, it carries this: a type is what the caller DECLARED when it
 * authorized the job. usertrust cannot tell a person from an agent, and an agent-declared type can be wrong or chosen
 * by a prompt. It selects no account, enters no policy and prices nothing.
 */
export const JOB_TYPE_CAVEAT = "declared by the caller, not checked";

/** The row's job type bucket: its declared type, or `untyped`. */
export function jobTypeOf(row: Pick<LedgerRow, "jobType">): string {
	return row.jobType ?? UNTYPED;
}

/** Who declared the row's type: `explicit`, `agent`, `unrecognized`, or `untyped` for a record with no type. */
export function typeSourceOf(row: Pick<LedgerRow, "jobType" | "typeSource">): string {
	return row.typeSource ?? (row.jobType === undefined ? UNTYPED : "not stated");
}

function closed(value: unknown, list: readonly string[]): string | undefined {
	const v = str(value);
	if (v === undefined) return undefined;
	return list.includes(v) ? v : UNRECOGNIZED;
}

/** Core's fixed rate (`ledger/pricing.ts`): 1 usertoken is $0.0001. */
export const UT_TO_USD = 0.0001;

/** Mirrors packages/verify/src/receipt.ts (verify stays zero-dep). */
export function detectProvider(model: string): string {
	if (model.startsWith("claude")) return "anthropic";
	if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
	if (model.startsWith("gemini")) return "google";
	if (model.startsWith("command")) return "cohere";
	if (model.startsWith("mistral") || model.startsWith("mixtral")) return "mistral";
	return "unknown";
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
	return typeof v === "number" ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
	return typeof v === "boolean" ? v : undefined;
}

/**
 * `verdictOf` gives an event's TRANSFER verdict (the server builds it over every event of the transfer, with
 * usertrust-verify's `transferVerdict`). Without it, a row whose kind carries a transfer's outcome is "unknown":
 * this module never guesses an outcome from one row's fields.
 */
export function toLedgerRows(
	events: PersistedAuditEvent[],
	integrity: ChainIntegrity,
	verdictOf?: (e: PersistedAuditEvent) => TransferStatus | undefined,
): LedgerRow[] {
	return events.map((e, i) => {
		const model = str(e.data.model);
		const costUt = num(e.data.cost);
		const usageSource =
			e.data.usageSource === "provider" || e.data.usageSource === "estimated"
				? e.data.usageSource
				: undefined;
		const row: LedgerRow = {
			seq: typeof e.sequence === "number" ? e.sequence : null,
			id: e.id,
			ts: e.timestamp,
			kind: e.kind,
			actor: e.actor,
			hash: e.hash,
			previousHash: e.previousHash,
			integrity:
				integrity.breakIndex !== null && i >= integrity.breakIndex ? "after-break" : "verified",
		};
		const source = str(e.data.source);
		if (source !== undefined) row.source = source;
		if (model !== undefined) {
			row.model = model;
			row.provider = detectProvider(model);
		}
		if (costUt !== undefined) {
			row.costUt = costUt;
			row.costUsd = costUt * UT_TO_USD;
		}
		const settled = bool(e.data.settled);
		if (settled !== undefined) row.settled = settled;
		const error = str(e.data.error);
		if (error !== undefined) row.error = error;
		const transferId = str(e.data.transferId);
		if (transferId !== undefined) row.transferId = transferId;
		if (usageSource !== undefined) row.usageSource = usageSource;
		const job = str(e.data.job);
		if (job !== undefined) row.job = job;
		const jobType = closed(e.data.jobType, JOB_TYPES);
		if (jobType !== undefined) row.jobType = jobType;
		const typeSource = closed(e.data.typeSource, TYPE_SOURCES);
		if (typeSource !== undefined) row.typeSource = typeSource;
		row.status = statusFor(e.kind, e.data, verdictOf?.(e));
		return row;
	});
}

// ── Status ──

/**
 * A row's status. Every status has a reachable input on today's vaults:
 * - settled, ambiguous, failed, denied, released, unrecoverable: the TRANSFER's verdict (usertrust-verify's
 *   `transferVerdict`), shown on every row that carries the transfer's outcome. `ambiguous` covers the audit-first
 *   path's OPTIMISTIC `settled: true` written before the POST: its later `settlement_ambiguous` downgrades the
 *   transfer, so a per-row reading of `settled` showed it as settled. `unrecoverable` is a money state of its own: the
 *   call ran and was recorded, and was NOT charged.
 * - ungoverned: a call let through `trust({ allowUngoverned })`, unmetered.
 * - info: a record that annotates or detects, and carries no outcome.
 * - unknown: anything else, including a transfer with no terminal yet. There is no "pending": no producer writes a
 *   hold-placed event, so a hold that is genuinely open has no record to show.
 */
export type RowStatus =
	| "settled"
	| "ambiguous"
	| "failed"
	| "denied"
	| "released"
	| "unrecoverable"
	| "ungoverned"
	| "info"
	| "unknown";

export type KindClass = "outcome" | "info" | "ungoverned";

/**
 * Every kind a producer writes to `events.jsonl`, by class. A kind not listed here is "unknown", unless it ends in
 * `_failed` or carries `settled` (the dynamic action kinds, which `governAction` names after the caller's action):
 * those carry a transfer's outcome.
 */
export const KIND_CLASS: Readonly<Record<string, KindClass>> = {
	// A transfer's outcome.
	llm_call: "outcome",
	llm_call_failed: "outcome",
	stream_partial_delivery: "outcome",
	settlement_ambiguous: "outcome",
	settlement_unrecoverable: "outcome",
	policy_denied: "outcome",
	ledger_rejected: "outcome",
	hold_released: "outcome",
	tool_use: "outcome",
	file_access: "outcome",
	shell_command: "outcome",
	api_request: "outcome",
	// Annotations and detections: no outcome of their own.
	settlement_shortfall: "info",
	usage_implausible: "info",
	injection_detected: "info",
	anomaly_detected: "info",
	budget_allocated: "info",
	budget_reclaimed: "info",
	"audit.quarantine.torn_tail": "info",
	credential_added: "info",
	credential_removed: "info",
	credential_rotated: "info",
	credential_access: "info",
	credential_denied: "info",
	// An unmetered call.
	ungoverned_call: "ungoverned",
};

export function kindClass(kind: string, data: Record<string, unknown>): KindClass | "unknown" {
	// OWN properties only: an action kind is the caller's text, and `KIND_CLASS["constructor"]` is a function.
	if (Object.hasOwn(KIND_CLASS, kind)) return KIND_CLASS[kind] as KindClass;
	if (kind.endsWith("_failed") || typeof data.settled === "boolean") return "outcome";
	return "unknown";
}

/** A transfer verdict's row status. A transfer with no terminal yet is unknown, never "pending". */
export const VERDICT_STATUS: Readonly<Record<TransferStatus, RowStatus>> = {
	SETTLED: "settled",
	AMBIGUOUS: "ambiguous",
	FAILED: "failed",
	DENIED: "denied",
	RELEASED: "released",
	UNRECOVERABLE: "unrecoverable",
	PENDING: "unknown",
};

export function statusFor(
	kind: string,
	data: Record<string, unknown>,
	verdict: TransferStatus | undefined,
): RowStatus {
	const cls = kindClass(kind, data);
	if (cls === "outcome") return verdict === undefined ? "unknown" : VERDICT_STATUS[verdict];
	return cls;
}

export function statusOf(row: LedgerRow): RowStatus {
	return row.status ?? statusFor(row.kind, {}, undefined);
}
