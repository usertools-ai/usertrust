// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CSV serialization of ledger rows.
 *
 * Spreadsheet-facing: the finance workflow is "close the books, hand the
 * auditor the receipts". Cost columns stay unquoted numerics so Excel/Sheets
 * sum them without coercion; every free-text cell is formula-neutralized
 * (CSV injection) because `actor`/`model` originate in caller-supplied event
 * data. CRLF line endings — Excel's expectation.
 */

import { type LedgerRow, statusOf } from "./rows.js";

export const CSV_HEADERS = [
	"seq",
	"timestamp",
	"kind",
	"actor",
	"model",
	"provider",
	"cost_ut",
	"cost_usd",
	"status",
	"integrity",
	"transfer_id",
	"event_id",
	"hash",
	"previous_hash",
] as const;

/** Leading =,+,-,@ make a cell executable in Excel/Sheets — defang with a quote. */
function neutralize(value: string): string {
	return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function cell(value: string | undefined): string {
	if (value === undefined || value === "") return "";
	const safe = neutralize(value);
	// Quote when the payload needs it, and always when defanged: a bare leading
	// apostrophe is handled inconsistently across parsers, quoted is not.
	return /[",\r\n]/.test(safe) || safe !== value ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Numerics are emitted bare so spreadsheets treat them as numbers. */
function num(value: number | undefined): string {
	return value === undefined ? "" : String(value);
}

export function toCsv(rows: LedgerRow[]): string {
	const lines = [CSV_HEADERS.join(",")];
	for (const r of rows) {
		lines.push(
			[
				num(r.seq ?? undefined),
				cell(r.ts),
				cell(r.kind),
				cell(r.actor),
				cell(r.model),
				cell(r.provider),
				num(r.costUt),
				num(r.costUsd),
				cell(statusOf(r)),
				cell(r.integrity),
				cell(r.transferId),
				cell(r.id),
				cell(r.hash),
				cell(r.previousHash),
			].join(","),
		);
	}
	return lines.join("\r\n");
}

export function csvFilename(now: Date, filtered: boolean): string {
	const day = now.toISOString().slice(0, 10);
	return `usertrust-ledger-${day}${filtered ? "-filtered" : ""}.csv`;
}
