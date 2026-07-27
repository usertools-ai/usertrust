// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { deriveChainIntegrity, loadBudgetConfig, readLedgerEvents, verifyVault } from "usertrust";
import type { SummaryPayload } from "../shared/api.js";
import { type LedgerRow, toLedgerRows } from "../shared/rows.js";

export type { SummaryPayload } from "../shared/api.js";

export const ROW_CAP = 100_000;
const GENESIS = "0".repeat(64);

export interface LedgerState {
	rows: LedgerRow[];
	summary: SummaryPayload;
	lastHash: string;
	byteOffset: number;
}

// ANCHOR-INTEGRATION: swap for real anchor verification when feat/external-anchoring lands.
function anchorState(vaultPath: string): "unanchored" | "present" {
	return existsSync(join(vaultPath, "audit", "anchors", "anchors.jsonl"))
		? "present"
		: "unanchored";
}

export function loadState(vaultPath: string): LedgerState {
	const events = readLedgerEvents(vaultPath);
	const integrity = deriveChainIntegrity(events);
	const vault = verifyVault(vaultPath);
	const { budget } = loadBudgetConfig(vaultPath);

	let spentUt = 0;
	for (const e of events) {
		if (e.kind === "llm_call" && typeof e.data.cost === "number") spentUt += e.data.cost;
	}

	const truncated = events.length > ROW_CAP;
	const visible = truncated ? events.slice(-ROW_CAP) : events;
	// Integrity indexes are relative to the full ordered list; re-derive for the slice.
	const offset = events.length - visible.length;
	const sliceIntegrity =
		integrity.breakIndex === null
			? integrity
			: { valid: false, breakIndex: Math.max(0, integrity.breakIndex - offset) };
	const rows = toLedgerRows(visible, sliceIntegrity);

	const logPath = join(vaultPath, "audit", "events.jsonl");
	const byteOffset = existsSync(logPath) ? statSync(logPath).size : 0;

	return {
		rows,
		summary: {
			vaultPath,
			budget,
			spentUt,
			remainingUt: budget - spentUt,
			chain: {
				events: events.length,
				valid: integrity.valid && vault.valid,
				breakIndex: integrity.breakIndex,
				errors: vault.errors,
			},
			anchorState: anchorState(vaultPath),
			rowCount: rows.length,
			truncated,
		},
		lastHash: events.at(-1)?.hash ?? GENESIS,
		byteOffset,
	};
}
