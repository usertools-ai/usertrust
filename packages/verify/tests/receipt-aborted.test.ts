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
