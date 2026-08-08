// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Flatten persisted audit events into the stable row shape the table and
 * dashboard consume. The `data` payload is schemaless — every per-kind
 * extraction lives HERE, defensively, and nowhere else.
 */

import type { ChainIntegrity, PersistedAuditEvent } from "usertrust";

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
	hash: string;
	previousHash: string;
	integrity: RowIntegrity;
}

const UT_TO_USD = 0.0001;

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

export function toLedgerRows(
	events: PersistedAuditEvent[],
	integrity: ChainIntegrity,
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
		return row;
	});
}

/**
 * Governance denials. Checked FIRST, because a denial event carries an `error`
 * string and the generic mapping would otherwise file every refusal alongside
 * provider failures — a refused call and a broken call are different facts, and
 * the ledger's own table is where an operator tells them apart.
 */
const DENIAL_KINDS = new Set(["policy_denied", "ledger_rejected"]);

export function statusOf(row: LedgerRow): "settled" | "pending" | "failed" | "denied" {
	if (DENIAL_KINDS.has(row.kind)) return "denied";
	if (row.kind === "llm_call_failed" || row.error !== undefined) return "failed";
	if (row.settled === true) return "settled";
	return "pending";
}
