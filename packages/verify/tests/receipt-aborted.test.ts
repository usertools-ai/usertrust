// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * An anomaly-killed call must not render as one that might still settle.
 *
 * This is the same defect the DENIED arm was added to fix, one step further
 * along. Two facts make `anomaly_detected` the receipt's SUBJECT rather than a
 * footnote beside a normal call:
 *
 *   - it carries the call's `transferId` (`govern.ts:2081`), and
 *     `verifyTransaction` selects the FIRST event matching that id
 *     (`packages/verify/src/index.ts:653`);
 *   - a mid-stream abort voids the hold and never reaches the `llm_call` write
 *     (`govern.ts:2073-2095`), so there is no later event to be selected instead.
 *
 * It carries no `settled` field, so before the ABORT arm it fell through to the
 * `settled !== true` default and printed PENDING — "may still settle" for a call
 * the breaker killed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyTransaction } from "../src/index.js";
import { type ReceiptData, renderReceipt, type TransactionEvent } from "../src/receipt.js";

/** ESC, built from a code point so no literal control byte lives in this file. */
const ESC = String.fromCharCode(0x1b);

function makeEvent(overrides: Partial<TransactionEvent> = {}): TransactionEvent {
	return {
		id: "test-id",
		timestamp: "2026-03-28T19:59:18.703Z",
		previousHash: "d156f8446a9d2e09ef8e4e9b5047c27b09262d3af8b244a39082dc9be9be61d5",
		kind: "llm_call",
		actor: "local",
		data: {
			model: "claude-haiku-4-5-20251001",
			cost: 1,
			settled: true,
			transferId: "tx_test_12345678",
		},
		sequence: 19,
		hash: "33a1bc0fc4e5d86958a4b1460298bdc24a3afaaf128883e690bd401534e6f5db",
		...overrides,
	};
}

function makeReceiptData(overrides: Partial<ReceiptData> = {}): ReceiptData {
	return {
		event: makeEvent(),
		chainLength: 21,
		merkleRoot: "954fb19e777b38a3c81ee0c76276cd896fce7c821c31257827028b1d9d8c7048",
		merkleVerified: true,
		chainVerified: true,
		cumulativeSpend: 14,
		verifiedAt: new Date("2026-03-28T20:15:00.000Z"),
		...overrides,
	};
}

/** The shape `govern.ts:2075-2083` actually writes. */
const anomalyEvent = (message = "token rate exceeded: 5000 tok/s over threshold 1000") =>
	makeEvent({
		kind: "anomaly_detected",
		data: {
			model: "claude-haiku-4-5-20251001",
			message,
			transferId: "tx_test_12345678",
		} as TransactionEvent["data"],
	});

describe("renderReceipt — an anomaly-killed call", () => {
	it("does NOT claim the call was aborted", () => {
		// The detection is emitted BEFORE the best-effort `emitter.abort()`, which
		// may not exist. Three futures are still open at that moment: the void
		// wins, the call settles anyway, or the terminal append fails. Asserting
		// the first replaced an honestly-uncertain label with a confidently-wrong
		// one — and no producer records that the void won, so the evidence for a
		// terminal abort does not exist on the chain.
		const output = renderReceipt(makeReceiptData({ event: anomalyEvent() }));
		expect(output).not.toContain("ABORTED");
	});

	it("does not claim the call was DENIED", () => {
		// A denial is a decision made BEFORE the provider was called, and it spent
		// nothing. An abort interrupted a call already in flight, which may have
		// consumed tokens the void returned. Collapsing the two would tell an
		// auditor a killed call was refused.
		const output = renderReceipt(makeReceiptData({ event: anomalyEvent() }));
		expect(output).not.toContain("DENIED");
	});

	it("SURFACES the anomaly so an auditor knows the breaker fired", () => {
		// The anomaly producer writes `message`; every other terminal writes
		// `error`. Reading only `error` would render an abort with no reason at all.
		const output = renderReceipt(makeReceiptData({ event: anomalyEvent() }));
		expect(output).toContain("Anomaly:");
		expect(output).toContain("token rate exceeded");
	});

	it("renders no spend lines — the hold was voided, so nothing settled", () => {
		const output = renderReceipt(makeReceiptData({ event: anomalyEvent() }));
		expect(output).not.toContain("Conversion");
	});

	it("scrubs control characters out of the abort reason", () => {
		// Same terminal-forgery surface as every other untrusted string here: this
		// text comes from `events.jsonl` and lands on an auditor's terminal.
		const output = renderReceipt(makeReceiptData({ event: anomalyEvent(`rate${ESC}[2Jexceeded`) }));
		expect(output).not.toContain(ESC);
	});

	it("keeps the box structure intact", () => {
		const lines = renderReceipt(makeReceiptData({ event: anomalyEvent() })).split("\n");
		expect(lines[0]?.startsWith("┌")).toBe(true);
		expect(lines[lines.length - 1]?.startsWith("└")).toBe(true);
		expect(new Set(lines.map((l) => l.length)).size).toBe(1);
	});

	it("leaves a settled call rendering as SETTLED", () => {
		const output = renderReceipt(makeReceiptData());
		expect(output).toContain("SETTLED");
	});
});

describe("verifyTransaction — an anomaly that did NOT stop the call", () => {
	/**
	 * `govern.ts:2093-2094` appends `anomaly_detected` and only then calls
	 * `emitter.abort()` IF the emitter has one. A provider whose stream object
	 * lacks `abort` keeps streaming and settles normally, so the chain holds BOTH
	 * the anomaly and a real `llm_call` for one transfer.
	 *
	 * Plain first-match selected the anomaly and rendered a settled, billed call
	 * as ABORTED with its spend lines suppressed — an affirmative false statement
	 * about money, which is worse than the PENDING the ABORTED arm replaced.
	 */
	it("resolves to the settlement terminal, not the earlier anomaly", () => {
		const dir = mkdtempSync(join(tmpdir(), "usertrust-verify-abort-"));
		try {
			const auditDir = join(dir, "audit");
			mkdirSync(auditDir, { recursive: true });
			const lines = [
				{
					kind: "anomaly_detected",
					actor: "local",
					data: { anomalyKind: "token_rate", message: "rate exceeded", transferId: "tx_1" },
					timestamp: "2026-08-12T00:00:00.000Z",
					previousHash: "0".repeat(64),
					sequence: 1,
					hash: "a".repeat(64),
				},
				{
					kind: "llm_call",
					actor: "local",
					data: {
						model: "claude-haiku-4-5-20251001",
						cost: 120,
						settled: true,
						transferId: "tx_1",
					},
					timestamp: "2026-08-12T00:00:01.000Z",
					previousHash: "a".repeat(64),
					sequence: 2,
					hash: "b".repeat(64),
				},
			];
			writeFileSync(
				join(auditDir, "events.jsonl"),
				`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
				"utf-8",
			);

			const result = verifyTransaction(dir, "tx_1");
			expect(result.found).toBe(true);
			// The billed call must not be reported as stopped, and its spend must show.
			expect(result.receipt).toContain("SETTLED");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("an anomaly with no terminal surfaces the anomaly without asserting an outcome", () => {
		// No settlement terminal exists, so nothing outranks the anomaly.
		const dir = mkdtempSync(join(tmpdir(), "usertrust-verify-abort2-"));
		try {
			const auditDir = join(dir, "audit");
			mkdirSync(auditDir, { recursive: true });
			const ev = {
				kind: "anomaly_detected",
				actor: "local",
				data: { anomalyKind: "token_rate", message: "rate exceeded", transferId: "tx_2" },
				timestamp: "2026-08-12T00:00:00.000Z",
				previousHash: "0".repeat(64),
				sequence: 1,
				hash: "c".repeat(64),
			};
			writeFileSync(join(auditDir, "events.jsonl"), `${JSON.stringify(ev)}\n`, "utf-8");

			const result = verifyTransaction(dir, "tx_2");
			// Still PENDING — the outcome genuinely is unresolved — but the anomaly
			// is now visible rather than silent.
			expect(result.receipt).toContain("Anomaly:");
			expect(result.receipt).not.toContain("ABORTED");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("verifyTransaction — terminal evidence and untrusted tails", () => {
	function writeVault(dir: string, lines: Array<Record<string, unknown>>): void {
		const auditDir = join(dir, "audit");
		mkdirSync(auditDir, { recursive: true });
		writeFileSync(
			join(auditDir, "events.jsonl"),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
			"utf-8",
		);
	}
	const ev = (over: Record<string, unknown>, i: number) => ({
		actor: "local",
		timestamp: `2026-08-12T00:00:0${i}.000Z`,
		previousHash: "0".repeat(64),
		sequence: i + 1,
		hash: String.fromCharCode(97 + i).repeat(64),
		...over,
	});

	it("a cutoff that TOOK EFFECT resolves to its failure terminal, not PENDING forever", () => {
		// `finalizeStreamVoid` wins `finalizeOnce("void")` and then appends
		// `stream_partial_delivery` with the same id. That record IS the evidence
		// the abort completed — falling back to the detection left a finished call
		// reading PENDING indefinitely.
		const dir = mkdtempSync(join(tmpdir(), "usertrust-verify-term-"));
		try {
			writeVault(dir, [
				ev(
					{
						kind: "anomaly_detected",
						data: { anomalyKind: "token_rate", message: "rate", transferId: "tx_9" },
					},
					0,
				),
				ev(
					{
						kind: "stream_partial_delivery",
						data: { transferId: "tx_9", chunksDelivered: 3, error: "anomaly cutoff" },
					},
					1,
				),
			]);
			const result = verifyTransaction(dir, "tx_9");
			expect(result.receipt).toContain("FAILED");
			expect(result.receipt).not.toContain("PENDING");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a tampered TAIL cannot break verification of an earlier transaction", () => {
		// The old first-match lookup stopped AT the target; scanning the whole array
		// reaches records after it, and `events.jsonl` is untrusted. A later object
		// with a null `data` would throw on the dereference and take verification
		// of an EARLIER transaction down with it.
		const dir = mkdtempSync(join(tmpdir(), "usertrust-verify-tail-"));
		try {
			writeVault(dir, [
				ev(
					{
						kind: "llm_call",
						data: {
							model: "claude-haiku-4-5-20251001",
							cost: 5,
							settled: true,
							transferId: "tx_a",
						},
					},
					0,
				),
				ev({ kind: "llm_call", data: null }, 1),
				ev({ kind: "llm_call" }, 2),
			]);
			expect(() => verifyTransaction(dir, "tx_a")).not.toThrow();
			expect(verifyTransaction(dir, "tx_a").found).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("verifyTransaction — every hostile shape a valid-JSON record can take", () => {
	/**
	 * Three separate review findings were three CONSUMERS of one unchecked cast,
	 * not three bugs: `kind.endsWith(...)`, the cumulative-spend walk over
	 * `data.cost`, and `forDisplay` iterating `message`/`error`. Guarding each use
	 * site would have been one guard per consumer and a fourth waiting to be
	 * found. `normalizeEvent` makes the boundary honest instead.
	 *
	 * Each case here is valid JSON — the log is written by the party under audit,
	 * so "it parsed" is the only thing that can be assumed about it.
	 */
	function vaultWith(dir: string, tail: Record<string, unknown>): string {
		const auditDir = join(dir, "audit");
		mkdirSync(auditDir, { recursive: true });
		const target = {
			kind: "llm_call",
			actor: "local",
			timestamp: "2026-08-12T00:00:00.000Z",
			previousHash: "0".repeat(64),
			sequence: 1,
			hash: "a".repeat(64),
			data: { model: "claude-haiku-4-5-20251001", cost: 5, settled: true, transferId: "tx_t" },
		};
		writeFileSync(
			join(auditDir, "events.jsonl"),
			`${JSON.stringify(target)}\n${JSON.stringify(tail)}\n`,
			"utf-8",
		);
		return dir;
	}

	const hostile: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
		["data is null", { kind: "llm_call", data: null }],
		["data is missing", { kind: "llm_call" }],
		["data is an array", { kind: "llm_call", data: [1, 2, 3] }],
		["kind is missing", { data: { transferId: "tx_t" } }],
		["kind is a number", { kind: 42, data: { transferId: "tx_t" } }],
		["cost is a string", { kind: "llm_call", data: { transferId: "tx_t", cost: "12" } }],
		[
			"message is an object",
			{ kind: "anomaly_detected", data: { transferId: "tx_t", message: { a: 1 } } },
		],
		[
			"error is a number",
			{ kind: "stream_partial_delivery", data: { transferId: "tx_t", error: 7 } },
		],
		["the whole record is a scalar", {}],
	];

	for (const [label, tail] of hostile) {
		it(`returns a verdict rather than throwing when ${label}`, () => {
			const dir = mkdtempSync(join(tmpdir(), "usertrust-verify-hostile-"));
			try {
				vaultWith(dir, tail);
				expect(() => verifyTransaction(dir, "tx_t")).not.toThrow();
				expect(verifyTransaction(dir, "tx_t").found).toBe(true);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	it("a wrong-typed cost is ABSENT, not coerced into a plausible number", () => {
		// Rendering `"12"` as a cost would be a different lie than crashing.
		const dir = mkdtempSync(join(tmpdir(), "usertrust-verify-coerce-"));
		try {
			const auditDir = join(dir, "audit");
			mkdirSync(auditDir, { recursive: true });
			writeFileSync(
				join(auditDir, "events.jsonl"),
				`${JSON.stringify({
					kind: "llm_call",
					actor: "local",
					timestamp: "2026-08-12T00:00:00.000Z",
					previousHash: "0".repeat(64),
					sequence: 1,
					hash: "b".repeat(64),
					data: { transferId: "tx_c", cost: "999999", settled: true },
				})}\n`,
				"utf-8",
			);
			const out = verifyTransaction(dir, "tx_c").receipt;
			expect(out).not.toContain("999999");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("verifyTransaction — absences the normalizer must not invent", () => {
	function vault(dir: string, records: Array<Record<string, unknown>>): string {
		const auditDir = join(dir, "audit");
		mkdirSync(auditDir, { recursive: true });
		writeFileSync(
			join(auditDir, "events.jsonl"),
			`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
			"utf-8",
		);
		return dir;
	}
	const base = (over: Record<string, unknown>) => ({
		actor: "local",
		timestamp: "2026-08-12T00:00:00.000Z",
		previousHash: "0".repeat(64),
		hash: "d".repeat(64),
		...over,
	});

	it("an EMPTY --tx is not found, never verified", () => {
		// `--tx "$TX_ID"` with an unset variable is a real invocation. Defaulting a
		// missing `transferId` to "" mapped every such event onto the empty id, so
		// this returned found/valid with exit 0 for a transaction that cannot exist.
		const dir = mkdtempSync(join(tmpdir(), "usertrust-verify-empty-"));
		try {
			vault(dir, [
				base({ kind: "injection_detected", sequence: 1, data: { patterns: ["x"], score: 1 } }),
			]);
			const result = verifyTransaction(dir, "");
			expect(result.found).toBe(false);
			expect(result.valid).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a legacy record with NO sequence keeps its absence", () => {
		// The v1 event schema allows a sequence-less segment. Inventing 0 killed the
		// `leafIndex + 1` fallback downstream, so `pos >= 1` failed and an otherwise
		// covered event was reported INCLUSION UNVERIFIABLE.
		const dir = mkdtempSync(join(tmpdir(), "usertrust-verify-legacy-"));
		try {
			vault(dir, [
				base({
					kind: "llm_call",
					data: { model: "claude-haiku-4-5-20251001", cost: 4, settled: true, transferId: "tx_l" },
				}),
			]);
			const result = verifyTransaction(dir, "tx_l");
			expect(result.found).toBe(true);
			// Rendered as unknown rather than as event 0 of N.
			expect(result.receipt).toMatch(/Event \? of/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a successful cutoff keeps the DETECTOR's reason, not the SDK's", () => {
		// `stream_partial_delivery.error` is whatever the SDK abort produced. Ranking
		// the terminal above the detection is right for status and wrong for reason.
		const dir = mkdtempSync(join(tmpdir(), "usertrust-verify-reason-"));
		try {
			vault(dir, [
				base({
					kind: "anomaly_detected",
					sequence: 1,
					data: {
						anomalyKind: "token_rate",
						message: "token rate exceeded threshold",
						transferId: "tx_r",
					},
				}),
				base({
					kind: "stream_partial_delivery",
					sequence: 2,
					hash: "e".repeat(64),
					data: { transferId: "tx_r", chunksDelivered: 2, error: "Request was aborted" },
				}),
			]);
			const out = verifyTransaction(dir, "tx_r").receipt;
			expect(out).toContain("FAILED");
			// BOTH appear, and neither is presented as the other. The terminal's own
			// error stays the reason; the detection is a separate observation. An
			// earlier cut had the detection REPLACE the terminal error — which reads
			// as "the anomaly caused this failure", and the anomaly is only causal
			// when the cutoff actually took effect.
			expect(out).toContain("Request was aborted");
			expect(out).toContain("Anomaly flagged:");
			expect(out).toContain("token rate exceeded");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("a SETTLED call still shows that the breaker flagged it", () => {
		// The previous precedence dropped the detection entirely when the terminal
		// settled, so a receipt for an unabortable stream that the detector had
		// flagged showed no sign the breaker fired at all. It is an observation
		// about the transfer, not a property of how the call ended.
		const dir = mkdtempSync(join(tmpdir(), "usertrust-verify-flagged-"));
		try {
			vault(dir, [
				base({
					kind: "anomaly_detected",
					sequence: 1,
					data: {
						anomalyKind: "token_rate",
						message: "token rate exceeded threshold",
						transferId: "tx_s",
					},
				}),
				base({
					kind: "llm_call",
					sequence: 2,
					hash: "f".repeat(64),
					data: { model: "claude-haiku-4-5-20251001", cost: 9, settled: true, transferId: "tx_s" },
				}),
			]);
			const out = verifyTransaction(dir, "tx_s").receipt;
			expect(out).toContain("SETTLED");
			expect(out).toContain("Anomaly flagged:");
			expect(out).toContain("token rate exceeded");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
