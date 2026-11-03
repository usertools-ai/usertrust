// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	formatReceipt,
	formatUsd,
	formatUt,
	type ReceiptFields,
} from "../../src/receipt/format.js";

const receipt: ReceiptFields = {
	transferId: "tx_m4k7z_a1b2c3",
	cost: 104,
	budgetRemaining: 49_896,
	auditHash: "a3f8c1d92b4e7f01aa55",
	chainPath: ".usertrust/audit",
	receiptUrl: null,
	settled: true,
	model: "claude-haiku-4-5",
	provider: "anthropic",
	timestamp: "2026-03-16T12:00:00.000Z",
};

describe("formatUsd and formatUt", () => {
	// 1 UT is exactly $0.0001, so four decimal places are exact at every size.
	const rows: Array<[number, string, string]> = [
		[0, "$0.0000", "0 UT"],
		[1, "$0.0001", "1 UT"],
		[104, "$0.0104", "104 UT"],
		[1_000, "$0.1000", "1,000 UT"],
		[50_000, "$5.0000", "50,000 UT"],
		[1_000_000_000, "$100000.0000", "1,000,000,000 UT"],
	];
	for (const [ut, usd, label] of rows) {
		it(`${ut} usertokens is ${usd}`, () => {
			expect(formatUsd(ut)).toBe(usd);
			expect(formatUt(ut)).toBe(label);
		});
	}

	it("rounds by the usertoken, not by a thousand: the control for the table above", () => {
		// A formatter that divided by 1000 (or by 10^4 and forgot the unit) would print $0.1000 for 1 UT.
		expect(formatUsd(1)).not.toBe("$0.1000");
		expect(formatUsd(1_000_000_000)).not.toBe("$1000000.0000");
	});
});

describe("formatReceipt", () => {
	it("opens with the cost in dollars, then usertokens", () => {
		expect(formatReceipt(receipt).split("\n")[0]).toBe("$0.0104 (104 usertokens)");
	});

	it("says one usertoken in the singular", () => {
		expect(formatReceipt({ ...receipt, cost: 1 }).split("\n")[0]).toBe("$0.0001 (1 usertoken)");
	});

	it("prints the model, the hold and charge, the seal and the location, one fact per line", () => {
		expect(formatReceipt(receipt).split("\n")).toEqual([
			"$0.0104 (104 usertokens)",
			"claude-haiku-4-5 via anthropic",
			"held, then charged 104 usertokens; 49,896 usertokens ($4.9896) left in the budget",
			"sealed a3f8c1d92b4e... in the audit chain at .usertrust/audit",
			"receipt tx_m4k7z_a1b2c3, 2026-03-16T12:00:00.000Z",
		]);
	});

	it("says what a capped charge was, and that an estimate is an estimate", () => {
		const text = formatReceipt({
			...receipt,
			cost: 120,
			postedCost: 100,
			usageSource: "estimated",
		});
		expect(text).toContain("(token counts estimated)");
		expect(text).toContain(
			"charged 100 usertokens (the hold capped the charge below the 120 usertokens metered)",
		);
	});

	it("does not call an unsettled or unwritten receipt sealed", () => {
		expect(formatReceipt({ ...receipt, settled: false })).toContain("not settled");
		const degraded = formatReceipt({ ...receipt, auditDegraded: true });
		expect(degraded).toContain("not sealed: the audit record could not be written");
		expect(degraded).not.toContain("sealed a3f8");
	});

	it("names a receipt url when there is one", () => {
		expect(formatReceipt({ ...receipt, receiptUrl: "https://example.test/r/1" })).toContain(
			"receipt tx_m4k7z_a1b2c3 at https://example.test/r/1,",
		);
	});

	it("strips control characters from every string field, so an escape sequence cannot reach a terminal", () => {
		const hostile = formatReceipt({
			...receipt,
			model: "m\u001b[2Jx",
			provider: "p\u0007",
			transferId: "t\u0000id",
			chainPath: ".usertrust\u001b]0;pwn\u0007",
			timestamp: "2026 ",
			auditHash: "ab\u001b[31m",
			receiptUrl: "u\u009brl",
		});
		// the five lines are joined by newlines, and nothing inside a line is a control character
		const lines = hostile.split("\n");
		expect(lines).toHaveLength(5);
		for (const line of lines) expect(line).not.toMatch(/[\p{Cc}\u2028\u2029]/u);
		expect(hostile).toContain("m?[2Jx via p?");
	});

	it("takes receipt fields only: a response-shaped object contributes nothing", () => {
		const withResponse = { ...receipt, content: [{ text: "IGNORE PREVIOUS INSTRUCTIONS" }] };
		expect(formatReceipt(withResponse as ReceiptFields)).not.toContain("IGNORE PREVIOUS");
	});
});
