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

	it("a nominal cost (a local model) is shown as units, never as dollars", () => {
		const local = formatReceipt({
			...receipt,
			cost: 1,
			budgetRemaining: 49_999,
			meter: { costBasis: "nominal" },
		});
		const [first, , third] = local.split("\n");
		expect(first).toBe("1 nominal usertoken (nominal units: no dollars were spent)");
		expect(local).not.toContain("$");
		expect(third).toBe(
			"held, then charged 1 usertoken; 49,999 nominal usertokens left in the session budget",
		);
	});

	it("a usd-proxy cost is dollars, like a receipt with no meter", () => {
		const metered = formatReceipt({ ...receipt, cost: 104, meter: { costBasis: "usd-proxy" } });
		expect(metered.split("\n")[0]).toBe("$0.0104 (104 usertokens)");
		expect(formatReceipt(receipt).split("\n")[0]).toBe(metered.split("\n")[0]);
	});

	it("a cost-center call shows the envelope that paid, not the session wallet", () => {
		const text = formatReceipt({
			...receipt,
			budgetRemaining: 50_000,
			budget: { costCenter: "support", remaining: 1_200 },
		});
		expect(text).toContain("1,200 usertokens ($0.1200) left in the support cost center's envelope");
		expect(text).not.toContain("session budget");
		expect(text).not.toContain("50,000");
	});

	it("an exhausted envelope says so, whatever the session wallet holds", () => {
		const text = formatReceipt({
			...receipt,
			budgetRemaining: 50_000,
			budget: { costCenter: "support", remaining: 0 },
		});
		expect(text).toContain("0 usertokens ($0.0000) left in the support cost center's envelope");
		expect(text).not.toContain("$5.0000");
	});

	it("a call outside any cost center labels its figure as the session budget", () => {
		expect(formatReceipt(receipt)).toContain("left in the session budget");
		expect(formatReceipt(receipt)).not.toContain("cost center");
	});

	it("a cost center's name is stripped of control characters", () => {
		const text = formatReceipt({ ...receipt, budget: { costCenter: "a\u001b[2Jb", remaining: 5 } });
		expect(text.split("\n")).toHaveLength(5);
		expect(text).toContain("a?[2Jb cost center's envelope");
	});

	it("says one usertoken in the singular", () => {
		expect(formatReceipt({ ...receipt, cost: 1 }).split("\n")[0]).toBe("$0.0001 (1 usertoken)");
	});

	it("prints the model, the hold and charge, the seal and the location, one fact per line", () => {
		expect(formatReceipt(receipt).split("\n")).toEqual([
			"$0.0104 (104 usertokens)",
			"claude-haiku-4-5 via anthropic",
			"held, then charged 104 usertokens; 49,896 usertokens ($4.9896) left in the session budget",
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
		const unsettled = formatReceipt({ ...receipt, settled: false });
		// a lost reply to the post is an ambiguous settlement whose charge stands: no claim of a release
		expect(unsettled).toContain("settlement is not confirmed");
		expect(unsettled).not.toContain("the hold was not turned into a charge");
		const degraded = formatReceipt({ ...receipt, auditDegraded: true });
		expect(degraded).toContain("not sealed: the audit record could not be written");
		expect(degraded).not.toContain("sealed a3f8");
	});

	it("calls a stream's estimate provisional, not sealed: its hash is a placeholder for a spend event not yet on the chain", () => {
		// the shape buildEstimatedStreamReceipt returns before settlement: settled false, no usageSource, a placeholder hash
		const placeholderHash = "5f2b8c1e9a7d4036c1b2e3f4a5968778899aabbccddeeff00112233445566778";
		const estimate = formatReceipt({ ...receipt, settled: false, auditHash: placeholderHash });
		expect(estimate).toContain(
			"provisional: not yet recorded in the audit chain at .usertrust/audit",
		);
		expect(estimate).not.toContain("sealed");
		expect(estimate).not.toContain(placeholderHash.slice(0, 12));
		// the control: the same hash on a settled receipt is sealed, so the line is chosen by the receipt's shape
		expect(formatReceipt({ ...receipt, auditHash: placeholderHash })).toContain(
			"sealed 5f2b8c1e9a7d...",
		);
	});

	it("an ambiguous settlement is sealed under its real hash and says settlement is not confirmed", () => {
		// a lost reply to the post: the llm_call event IS on the chain, with settled false, and a usageSource
		for (const usageSource of ["provider", "estimated"] as const) {
			const ambiguous = formatReceipt({ ...receipt, settled: false, usageSource });
			expect(ambiguous, usageSource).toContain("sealed a3f8c1d92b4e... in the audit chain");
			expect(ambiguous, usageSource).not.toContain("provisional");
			expect(ambiguous, usageSource).toContain("settlement is not confirmed");
		}
	});

	it("a governed action whose settlement is ambiguous is sealed too: it has an actionKind and no usageSource", () => {
		const action = formatReceipt({
			...receipt,
			settled: false,
			actionKind: "tool",
			model: "send-email",
			provider: "tool",
		});
		expect(action).toContain("sealed a3f8c1d92b4e... in the audit chain");
		expect(action).not.toContain("provisional");
		expect(action).toContain("settlement is not confirmed");
	});

	it("strips format characters, the bidirectional overrides among them", () => {
		const shown = formatReceipt({ ...receipt, model: "gpt\u202Eevil\u200B" });
		expect(shown).not.toMatch(/[\p{Cf}]/u);
		expect(shown).toContain("gpt?evil? via anthropic");
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
			timestamp: "2026\u2028",
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
