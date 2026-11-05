// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	CHAIN_INTACT,
	type ReceiptData,
	renderReceipt,
	type TransactionEvent,
} from "../src/receipt.js";

const event: TransactionEvent = {
	id: "test-id",
	timestamp: "2026-03-28T19:59:18.703Z",
	previousHash: "d156f8446a9d2e09ef8e4e9b5047c27b09262d3af8b244a39082dc9be9be61d5",
	kind: "llm_call",
	actor: "local",
	data: { model: "claude-haiku-4-5", cost: 1, settled: true, transferId: "tx_test_12345678" },
	sequence: 19,
	hash: "33a1bc0fc4e5d86958a4b1460298bdc24a3afaaf128883e690bd401534e6f5db",
};

const data = (over: Partial<ReceiptData> = {}): ReceiptData => ({
	event,
	chainLength: 21,
	merkleRoot: "954fb19e777b38a3c81ee0c76276cd896fce7c821c31257827028b1d9d8c7048",
	merkleVerified: true,
	chainVerified: true,
	cumulativeSpend: 14,
	verifiedAt: new Date("2026-03-28T20:15:00.000Z"),
	...over,
});

/** The verdict line: the centred line of the box between the Merkle row and the footer divider. */
function verdictOf(box: string): string {
	const lines = box.split("\n");
	const merkle = lines.findIndex((l) => l.includes("Merkle"));
	return (lines.slice(merkle + 1).find((l) => l.replace(/[│\s]/g, "") !== "") ?? "")
		.replace(/[│]/g, "")
		.trim();
}

describe("a receipt's verdict is VERIFIED only for an anchored pass", () => {
	it("a chain that is consistent but unanchored reads CHAIN INTACT, NOT ANCHORED, never VERIFIED", () => {
		for (const merkleLabel of [undefined, "CHAIN CONSISTENT (UNANCHORED)", "IN UNANCHORED TAIL"]) {
			const box = renderReceipt(data(merkleLabel === undefined ? {} : { merkleLabel }));
			expect(verdictOf(box), String(merkleLabel)).toBe(CHAIN_INTACT);
			expect(box).not.toContain("* VERIFIED *");
		}
		expect(CHAIN_INTACT).toBe("CHAIN INTACT, NOT ANCHORED");
	});

	it("a Merkle row of INCLUSION VERIFIED, reached against a pinned key, reads * VERIFIED *", () => {
		const box = renderReceipt(data({ merkleLabel: "INCLUSION VERIFIED (anchor #3)" }));
		expect(verdictOf(box)).toBe("* VERIFIED *");
	});

	it("a failed chain or inclusion still reads FAILED, with its reason", () => {
		expect(verdictOf(renderReceipt(data({ chainVerified: false })))).toBe("FAILED (chain)");
		expect(
			verdictOf(renderReceipt(data({ merkleVerified: false, merkleLabel: "INCLUSION FAILED" }))),
		).toBe("FAILED (merkle)");
	});

	it("the footer says when the check ran, not that something was verified", () => {
		const box = renderReceipt(data());
		expect(box).toContain("Checked");
		expect(box).not.toMatch(/^\s*│\s*Verified\b/m);
	});
});
