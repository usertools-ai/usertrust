// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A RELEASED hold is a terminal: nothing charged, nothing failed.
 *
 * `hold_released` (headless `release()`: a client's give-back, a TTL sweep, a shutdown)
 * carries the hold's `transferId` and no `settled` field. A headless authorize writes
 * no record of its own, so it is the released hold's ONLY record. Before the RELEASED
 * arm it fell through to PENDING, "may still settle" for a hold that never can, and it
 * was not conclusive, so a later appended `settled: true` became the hold's first
 * terminal and rewrote it as a settlement.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyTransaction } from "../src/index.js";
import { renderReceipt, type TransactionEvent } from "../src/receipt.js";

const ESC = String.fromCharCode(0x1b);

function released(data: Record<string, unknown> = {}): TransactionEvent {
	return {
		id: "test-id",
		timestamp: "2026-10-07T12:00:00.000Z",
		previousHash: "0".repeat(64),
		kind: "hold_released",
		actor: "local",
		data: {
			model: "claude-sonnet-4-6",
			transferId: "tx_1",
			source: "headless",
			...data,
		} as TransactionEvent["data"],
		sequence: 1,
		hash: "a".repeat(64),
	};
}

function render(event: TransactionEvent): string {
	return renderReceipt({
		event,
		chainLength: 1,
		merkleRoot: "b".repeat(64),
		merkleVerified: true,
		chainVerified: true,
		cumulativeSpend: 0,
		verifiedAt: new Date("2026-10-07T12:00:01.000Z"),
	});
}

/** Write a chain of events and verify one transfer from it. */
function verifyChainOf(events: Array<Record<string, unknown>>, txId: string) {
	const dir = mkdtempSync(join(tmpdir(), "usertrust-verify-released-"));
	try {
		mkdirSync(join(dir, "audit"), { recursive: true });
		const lines = events.map((e, i) => ({
			actor: "local",
			timestamp: `2026-10-07T12:00:0${i}.000Z`,
			previousHash: i === 0 ? "0".repeat(64) : String(i).repeat(64),
			sequence: i + 1,
			hash: String(i + 1).repeat(64),
			...e,
		}));
		writeFileSync(
			join(dir, "audit", "events.jsonl"),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
			"utf-8",
		);
		return verifyTransaction(dir, txId);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const RELEASE = {
	kind: "hold_released",
	data: { model: "m", transferId: "tx_1", reason: "released" },
};
const SETTLE = {
	kind: "llm_call",
	data: { model: "m", cost: 50, settled: true, transferId: "tx_1" },
};

describe("renderReceipt: a released hold", () => {
	it("renders RELEASED, never PENDING", () => {
		const output = render(released());
		expect(output).toContain("RELEASED");
		expect(output).not.toContain("PENDING");
		expect(output).not.toContain("FAILED");
	});

	it("prints the release reason, scrubbed, under its own label", () => {
		const output = render(released({ reason: `pending TTL${ESC}[2J expired` }));
		expect(output).toContain("Reason:");
		expect(output).toContain("pending TTL");
		expect(output).not.toContain("Error:");
		expect(output).not.toContain(ESC);
	});
});

describe("a release whose ledger void failed shows its evidence", () => {
	it("prints the fixed `voidError` under RELEASED, scrubbed like the reason", () => {
		const output = render(released({ reason: "given back", voidError: "ledger_unavailable" }));
		expect(output).toContain("RELEASED");
		expect(output).toContain("Reason: given back");
		expect(output).toContain("Void error: ledger_unavailable");
		const hostile = render(released({ voidError: `x${ESC}[2Jy` }));
		expect(hostile).toContain("Void error: x");
		expect(hostile).not.toContain(ESC);
	});

	it("a clean release prints no void-error line", () => {
		expect(render(released({ reason: "given back" }))).not.toContain("Void error");
	});

	it("verifyTransaction carries `voidError` from the chain to the receipt", () => {
		const result = verifyChainOf(
			[{ ...RELEASE, data: { ...RELEASE.data, voidError: "pending_transfer_not_found" } }],
			"tx_1",
		);
		expect(result.receipt).toContain("Void error: pending_transfer_not_found");
	});

	it("a `voidError` that is not a string (a hostile chain) is dropped, never rendered", () => {
		const result = verifyChainOf(
			[{ ...RELEASE, data: { ...RELEASE.data, voidError: { injected: true } } }],
			"tx_1",
		);
		expect(result.receipt).toContain("RELEASED");
		expect(result.receipt).not.toContain("Void error");
	});
});

describe("verifyTransaction: a released hold is a conclusive terminal", () => {
	it("a hold whose only record is hold_released resolves RELEASED", () => {
		const result = verifyChainOf([RELEASE], "tx_1");
		expect(result.found).toBe(true);
		expect(result.receipt).toContain("RELEASED");
	});

	it("a LATER settled: true cannot rewrite a release into a settlement (first terminal wins)", () => {
		const result = verifyChainOf([RELEASE, SETTLE], "tx_1");
		expect(result.receipt).toContain("RELEASED");
		expect(result.receipt).not.toContain("SETTLED");
	});

	it("a later ambiguity cannot downgrade it either, as with a failure", () => {
		const ambiguous = {
			kind: "settlement_ambiguous",
			data: { model: "m", cost: 50, transferId: "tx_1", error: "post failed" },
		};
		const result = verifyChainOf([RELEASE, ambiguous], "tx_1");
		expect(result.receipt).toContain("RELEASED");
		expect(result.receipt).not.toContain("AMBIGUOUS");
	});

	it("even a release record that carries `settled`, as a failure's does, is not downgraded", () => {
		const ambiguous = {
			kind: "settlement_ambiguous",
			data: { model: "m", cost: 50, transferId: "tx_1", error: "post failed" },
		};
		const releasedWithFlag = { ...RELEASE, data: { ...RELEASE.data, settled: false } };
		const result = verifyChainOf([releasedWithFlag, ambiguous], "tx_1");
		expect(result.receipt).toContain("RELEASED");
		expect(result.receipt).not.toContain("AMBIGUOUS");
	});

	it("a release that comes AFTER a settlement does not unsettle it", () => {
		const result = verifyChainOf([SETTLE, RELEASE], "tx_1");
		expect(result.receipt).toContain("SETTLED");
		expect(result.receipt).not.toContain("RELEASED");
	});
});
