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
 *
 * A text cell is defanged when its first character that is not whitespace is
 * =, +, - or @, or when its first character is a tab or a carriage return.
 * As a precaution, and not because any spreadsheet was measured doing it, the
 * same holds when that character is another form of one of the four (its
 * Unicode compatibility form is =, +, - or @, as for the fullwidth and small
 * forms) or the minus sign. Only such cells differ from an export that
 * defanged a leading =, +, - or @ alone: every other cell is written byte for
 * byte as before.
 */

import type { AtPayload } from "./api.js";
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
	// Last, so the columns before it keep their positions: where the usage behind the cost came from.
	"usage_source",
	// Last three: the job, the type its caller DECLARED and who declared it. The header says "declared, not checked"
	// (`JOB_TYPE_CAVEAT` in rows.ts): the type is a declaration, and it prices nothing.
	"job",
	"job_type_declared_not_checked",
	"type_declared_by",
	// A charge's inputs, as the record carries them: the four token counts, the rate applied to each (usertokens per
	// 1,000 tokens) and the pricing table the rates came from.
	"input_tokens",
	"output_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"input_rate_ut_per_1k",
	"output_rate_ut_per_1k",
	"cache_read_rate_ut_per_1k",
	"cache_write_rate_ut_per_1k",
	"pricing_table_version",
	// The share of cache_write_tokens written with a 1-hour lifetime, and its own rate. The rest of the write count
	// was priced at cache_write_rate_ut_per_1k.
	"cache_write_1h_tokens",
	"cache_write_1h_rate_ut_per_1k",
	// Whether the record carried a 1-hour share at all: `yes`, or empty when it carried none. A share whose count or
	// rate cannot be used leaves that cell empty above, and without this column it would read as no share, with the
	// whole write priced at cache_write_rate_ut_per_1k.
	"cache_write_1h_recorded",
	// THE RULE OF THIS FORMAT: a new column goes here, on the end. No column above ever moves, is renamed or changes
	// what it holds, so a reader of an older export keeps working. `tests/csv.test.ts` pins the whole header as text.
] as const;

/** The minus sign, U+2212, named by its code point so that it is not mistaken for a hyphen here. */
const MINUS_SIGN = String.fromCodePoint(0x2212);
const FORMULA_CHARACTERS: ReadonlySet<string> = new Set(["=", "+", "-", "@", MINUS_SIGN]);

/**
 * Whether the first character that is not whitespace (JavaScript's `\s`, the broad set, line feeds and no-break
 * spaces included) is a formula character: =, +, - or @, which Excel/Sheets may run.
 *
 * As a precaution, and not as a fact about any spreadsheet, another form of one counts too: a character whose
 * compatibility form (Unicode NFKC) is =, +, - or @ or the minus sign. That covers the fullwidth and small forms of
 * the four, their superscript and subscript forms, and the minus sign itself. No spreadsheet was measured reading
 * such a cell as a formula; such a cell is not ordinary data either.
 */
function formulaFirst(value: string): boolean {
	const first = /^\s*(\S)/u.exec(value)?.[1];
	return first !== undefined && FORMULA_CHARACTERS.has(first.normalize("NFKC"));
}

/**
 * Defang, with a quote, a cell a spreadsheet may run: a formula character first or first after leading whitespace,
 * or a tab or carriage return first, whatever follows. A leading line feed before ordinary text is left as it is:
 * it is quoted for the line break already.
 */
function neutralize(value: string): string {
	return /^[\t\r]/.test(value) || formulaFirst(value) ? `'${value}` : value;
}

function cell(value: string | undefined): string {
	if (value === undefined || value === "") return "";
	const safe = neutralize(value);
	// Quote when the payload needs it, and always when defanged: a bare leading
	// apostrophe is handled inconsistently across parsers, quoted is not.
	return /[",\r\n]/.test(safe) || safe !== value ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Numerics are emitted bare so spreadsheets treat them as numbers, in the shortest form that reads back as the same
 * number: 12.5 is `12.5`, 0.1 is `0.1`, and a value under one millionth is exponent notation (1e-7 is `1e-7`).
 */
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
				// "chained", never "verified": an intact hash link is not an explicit, anchored check.
				cell(r.integrity === "verified" ? "chained" : r.integrity),
				cell(r.transferId),
				cell(r.id),
				cell(r.hash),
				cell(r.previousHash),
				cell(r.usageSource),
				cell(r.job),
				cell(r.jobType),
				cell(r.typeSource),
				// What the record carries, and nothing worked out from it: no product, no sum. A count or rate the
				// record does not carry is an empty cell, never 0; a recorded 0 prints 0.
				num(r.usage?.inputTokens),
				num(r.usage?.outputTokens),
				num(r.usage?.cacheReadTokens),
				num(r.usage?.cacheWriteTokens),
				num(r.appliedRates?.inputPer1k),
				num(r.appliedRates?.outputPer1k),
				num(r.appliedRates?.cacheReadPer1k),
				num(r.appliedRates?.cacheWritePer1k),
				cell(r.pricingTableVersion),
				num(r.cacheWrite1h?.tokens),
				num(r.cacheWrite1h?.ratePer1k),
				// `yes` or empty, never `no`: absent stays empty, like every cell here.
				r.cacheWrite1h === undefined ? "" : "yes",
			].join(","),
		);
	}
	return lines.join("\r\n");
}

/**
 * `newestOf`: the server's row window, when it holds only the newest N events. The export then covers those only,
 * and its name says so.
 */
export function csvFilename(
	now: Date,
	filtered: boolean,
	newestOf?: number,
	at?: Pick<AtPayload, "pos" | "windowStartPos"> | null,
): string {
	// At a past position the file is named for that point (counted from 1, as the page counts), and for where the list
	// starts when it does not start at the first record. Today's date would say nothing about what it holds.
	if (at !== undefined && at !== null) {
		const from = at.windowStartPos > 0 ? `-from-${at.windowStartPos + 1}` : "";
		return `usertrust-ledger-as-recorded-${at.pos + 1}${from}${filtered ? "-filtered" : ""}.csv`;
	}
	const day = now.toISOString().slice(0, 10);
	const window = newestOf === undefined ? "" : `-newest-${newestOf}`;
	return `usertrust-ledger-${day}${window}${filtered ? "-filtered" : ""}.csv`;
}
