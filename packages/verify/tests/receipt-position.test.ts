// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * THE POSITION ROW of a `--tx` receipt. `Event N of M` says the event holds place N in a chain of M, which
 * is only true when the chain checked out: then its sequences run 1..M. On a vault that fails, M is the
 * number of events the walk checked and N is the sequence the record carries, so the pair can read
 * `Event 5 of 4` (a deleted start) or `Event 5 of 2` (a log with sequence-less events). There the Position
 * row prints `sequence N` and a second row, `Events checked`, prints M. Two rows, because both in one
 * ran past the row's 34 columns from about a thousand events and was cut mid-word.
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
const checkedRow = (out: string): string =>
	out.split("\n").find((l) => l.includes("Events checked")) ?? "";

const FAILED = { chainVerified: false, merkleVerified: false } as const;

describe("the receipt's Position row", () => {
	it("an intact vault keeps the wording it always had, and has no count row", () => {
		const out = receipt(19, 21);
		expect(positionRow(out)).toContain("Event 19 of 21");
		expect(checkedRow(out)).toBe("");
	});

	it("an intact legacy vault whose event has no sequence keeps `Event ? of M`", () => {
		expect(positionRow(receipt(undefined, 3))).toContain("Event ? of 3");
	});

	it("a leading deletion (sequence 5, 4 events checked) never reads `Event 5 of 4`", () => {
		const out = receipt(5, 4, FAILED);
		expect(positionRow(out)).toMatch(/sequence 5 *│/);
		expect(checkedRow(out)).toMatch(/Events checked \.+ 4 *│/);
		expect(out).not.toMatch(/Event \S+ of/);
	});

	it("a mixed log (sequence 5, 2 events checked) never reads `Event 5 of 2`", () => {
		const out = receipt(5, 2, FAILED);
		expect(positionRow(out)).toMatch(/sequence 5 *│/);
		expect(checkedRow(out)).toMatch(/Events checked \.+ 2 *│/);
		expect(out).not.toMatch(/Event \S+ of/);
	});

	it("a failed vault whose numbers happen to fit (a gap) is still not called `Event N of M`", () => {
		const out = receipt(4, 4, FAILED);
		expect(positionRow(out)).toMatch(/sequence 4 *│/);
		expect(checkedRow(out)).toMatch(/Events checked \.+ 4 *│/);
		expect(out).not.toMatch(/Event \S+ of/);
	});

	it("a failed vault whose event has no sequence says so, with the count on its own row", () => {
		const out = receipt(undefined, 3, FAILED);
		expect(positionRow(out)).toMatch(/no sequence *│/);
		expect(checkedRow(out)).toMatch(/Events checked \.+ 3 *│/);
	});

	it("an event outside the checked chain still says so and prints no count row", () => {
		const out = receipt(undefined, 2, { ...FAILED, outsideCheckedChain: true });
		expect(positionRow(out)).toContain("outside the checked chain");
		expect(checkedRow(out)).toBe("");
	});

	it("a 6-digit sequence AND a 6-digit count both survive whole", () => {
		const out = receipt(200000, 199999, FAILED);
		expect(positionRow(out)).toMatch(/sequence 200000 *│/);
		expect(checkedRow(out)).toMatch(/Events checked \.+ 199999 *│/);
	});
});

describe("no row of the receipt is cut", () => {
	// A value longer than its row is cut at the border. Render every Position shape at sizes up to six
	// digits and check each carries its whole value: the digits of both numbers, to the last one.
	const SIZES = [1, 999, 1500, 99999, 200000, 1234567];
	const rows = (out: string): string[] => out.split("\n");

	it.each(SIZES)("size %i: every row is whole and the box keeps its width", (n) => {
		const shapes: Array<[string, string, string?]> = [
			[receipt(n, n), `Event ${n} of ${n}`],
			[receipt(n + 1, n, FAILED), `sequence ${n + 1}`, String(n)],
			[receipt(undefined, n, FAILED), "no sequence", String(n)],
		];
		for (const [out, position, count] of shapes) {
			expect(positionRow(out)).toMatch(new RegExp(`${position} *│$`));
			if (count !== undefined) expect(checkedRow(out)).toMatch(new RegExp(` ${count} *│$`));
			const widths = new Set(rows(out).map((l) => [...l].length));
			expect(widths.size).toBe(1);
		}
	});
});
