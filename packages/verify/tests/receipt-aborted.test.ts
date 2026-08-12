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

import { describe, expect, it } from "vitest";
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
	it("renders ABORTED, not PENDING", () => {
		const output = renderReceipt(makeReceiptData({ event: anomalyEvent() }));
		expect(output).toContain("ABORTED");
		expect(output).not.toContain("PENDING");
	});

	it("does not claim the call was DENIED", () => {
		// A denial is a decision made BEFORE the provider was called, and it spent
		// nothing. An abort interrupted a call already in flight, which may have
		// consumed tokens the void returned. Collapsing the two would tell an
		// auditor a killed call was refused.
		const output = renderReceipt(makeReceiptData({ event: anomalyEvent() }));
		expect(output).not.toContain("DENIED");
	});

	it("shows the reason from `message` — the field the producer writes", () => {
		// The anomaly producer writes `message`; every other terminal writes
		// `error`. Reading only `error` would render an abort with no reason at all.
		const output = renderReceipt(makeReceiptData({ event: anomalyEvent() }));
		expect(output).toContain("Aborted:");
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
		expect(output).not.toContain("ABORTED");
	});
});
