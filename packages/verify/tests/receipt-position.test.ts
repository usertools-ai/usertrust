// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * THE POSITION ROW of a `--tx` receipt. `Event N of M` says the event holds place N in a chain of M, which
 * is only true when the chain checked out: then its sequences run 1..M. On a vault that fails, M is the
 * number of events the walk checked and N is the sequence the record carries, so the pair can read
 * `Event 5 of 4` (a deleted start) or `Event 5 of 2` (a log with sequence-less events). The row prints
 * `sequence N (M events checked)` there instead.
 */

import { describe, expect, it } from "vitest";
import { type ReceiptData, renderReceipt, type TransactionEvent } from "../src/receipt.js";

function makeEvent(sequence: number | undefined): TransactionEvent {
	return {
		id: "evt-1",
		timestamp: "2026-03-28T19:59:18.703Z",
		previousHash: "d156f8446a9d2e09ef8e4e9b5047c27b09262d3af8b244a39082dc9be9be61d5",
		kind: "llm_call",
		actor: "local",
		data: { model: "claude-haiku-4-5-20251001", cost: 1, settled: true, transferId: "tx_pos_1" },
		...(sequence === undefined ? {} : { sequence }),
		hash: "33a1bc0fc4e5d86958a4b1460298bdc24a3afaaf128883e690bd401534e6f5db",
	};
}

function receipt(
	sequence: number | undefined,
	chainLength: number,
	overrides: Partial<ReceiptData> = {},
): string {
	return renderReceipt({
		event: makeEvent(sequence),
		chainLength,
		merkleRoot: "954fb19e777b38a3c81ee0c76276cd896fce7c821c31257827028b1d9d8c7048",
		merkleVerified: true,
		chainVerified: true,
		verifiedAt: new Date("2026-03-28T20:15:00.000Z"),
		...overrides,
	});
}

const positionRow = (out: string): string =>
	out.split("\n").find((l) => l.includes("Position")) ?? "";

describe("the receipt's Position row", () => {
	it("an intact vault keeps the wording it always had", () => {
		expect(positionRow(receipt(19, 21))).toContain("Event 19 of 21");
	});

	it("an intact legacy vault whose event has no sequence keeps `Event ? of M`", () => {
		expect(positionRow(receipt(undefined, 3))).toContain("Event ? of 3");
	});

	it("a leading deletion (sequence 5, 4 events checked) never reads `Event 5 of 4`", () => {
		const row = positionRow(receipt(5, 4, { chainVerified: false, merkleVerified: false }));
		expect(row).toContain("sequence 5 (4 events checked)");
		expect(row).not.toContain("Event 5 of 4");
	});

	it("a mixed log (sequence 5, 2 events checked) never reads `Event 5 of 2`", () => {
		const row = positionRow(receipt(5, 2, { chainVerified: false, merkleVerified: false }));
		expect(row).toContain("sequence 5 (2 events checked)");
		expect(row).not.toMatch(/Event \S+ of/);
	});

	it("a failed vault whose number happens to fit is still not called `Event N of M` (a gap)", () => {
		const row = positionRow(receipt(4, 4, { chainVerified: false, merkleVerified: false }));
		expect(row).toContain("sequence 4 (4 events checked)");
		expect(row).not.toMatch(/Event \S+ of/);
	});

	it("one event checked is singular", () => {
		const row = positionRow(receipt(3, 1, { chainVerified: false, merkleVerified: false }));
		expect(row).toContain("sequence 3 (1 event checked)");
	});

	it("a failed vault whose event has no sequence says so without a bogus number", () => {
		const row = positionRow(receipt(undefined, 3, { chainVerified: false, merkleVerified: false }));
		expect(row).toContain("no sequence (3 events checked)");
		expect(row).not.toMatch(/Event \S+ of/);
	});

	it("an event outside the checked chain still says `outside the checked chain`", () => {
		const row = positionRow(
			receipt(undefined, 2, {
				chainVerified: false,
				merkleVerified: false,
				outsideCheckedChain: true,
			}),
		);
		expect(row).toContain("outside the checked chain");
		expect(row).not.toContain("events checked");
	});
});
