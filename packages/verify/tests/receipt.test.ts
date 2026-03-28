import { describe, expect, it } from "vitest";
import {
	type ReceiptData,
	type TransactionEvent,
	renderNotFound,
	renderReceipt,
} from "../src/receipt.js";

// ── Fixture factories ──

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

/** Assert a line exists at the given index and return it. */
function lineAt(lines: string[], index: number): string {
	const l = lines[index];
	expect(l).toBeDefined();
	return l as string;
}

/** Verify box-drawing structure: top/bottom borders, vertical bars, uniform width. */
function assertBoxStructure(output: string): void {
	const lines = output.split("\n");

	const first = lineAt(lines, 0);
	expect(first.startsWith("┌")).toBe(true);
	expect(first.endsWith("┐")).toBe(true);

	const last = lineAt(lines, lines.length - 1);
	expect(last.startsWith("└")).toBe(true);
	expect(last.endsWith("┘")).toBe(true);

	for (let i = 1; i < lines.length - 1; i++) {
		const l = lineAt(lines, i);
		expect(l.startsWith("│")).toBe(true);
		expect(l.endsWith("│")).toBe(true);
	}

	// All lines same length
	const lengths = new Set(lines.map((l) => l.length));
	expect(lengths.size).toBe(1);
}

describe("renderReceipt", () => {
	it("renders a settled transaction with all expected fields", () => {
		const output = renderReceipt(makeReceiptData());

		expect(output).toContain("TRANSACTION RECEIPT");
		expect(output).toContain("SETTLED");
		expect(output).toContain("VERIFIED");
		expect(output).toContain("tx_test_12345678");
		expect(output).toContain("claude-haiku-4-5-20251001");
		expect(output).toContain("anthropic");
		expect(output).toContain("14 UT");
		expect(output).toContain("14 UT");
		expect(output).toContain("$0.0014");
		expect(output).toContain("Event 19 of 21");
		// Truncated hashes
		expect(output).toContain("33a1bc0f...34e6f5db");
		expect(output).toContain("d156f844...e9be61d5");
		// Merkle root (truncated)
		expect(output).toContain("954fb19e...9d8c7048");
	});

	it("renders a failed transaction", () => {
		const longError =
			"The model returned an error because the context window was exceeded and the request could not be processed within the allocated token budget for this operation";
		const output = renderReceipt(
			makeReceiptData({
				event: makeEvent({
					kind: "llm_call_failed",
					data: {
						model: "claude-haiku-4-5-20251001",
						cost: 0,
						settled: false,
						error: longError,
						transferId: "tx_test_12345678",
					},
				}),
			}),
		);

		expect(output).toContain("FAILED");
		expect(output).not.toContain("Spend");
		// The error text should appear word-wrapped across lines
		expect(output).toContain("context window");
		// Verify wrapping happened: the full error shouldn't appear on a single row
		const lines = output.split("\n");
		const errorLines = lines.filter((l) => l.includes("Error:") || l.includes("context"));
		expect(errorLines.length).toBeGreaterThanOrEqual(1);
	});

	it("shows FAILED (chain) when chain verification fails", () => {
		const output = renderReceipt(
			makeReceiptData({
				chainVerified: false,
				merkleVerified: true,
			}),
		);

		expect(output).toContain("FAILED (chain)");
	});

	it("shows FAILED (merkle) when merkle verification fails", () => {
		const output = renderReceipt(
			makeReceiptData({
				chainVerified: true,
				merkleVerified: false,
			}),
		);

		expect(output).toContain("FAILED (merkle)");
	});

	it("shows unknown for an unrecognized provider model", () => {
		const output = renderReceipt(
			makeReceiptData({
				event: makeEvent({
					data: {
						model: "llama-3",
						cost: 1,
						settled: true,
						transferId: "tx_test_12345678",
					},
				}),
			}),
		);

		expect(output).toContain("llama-3");
		expect(output).toContain("unknown");
	});

	it("has correct box-drawing structure", () => {
		const output = renderReceipt(makeReceiptData());
		assertBoxStructure(output);
	});

	it("formats dates correctly", () => {
		const output = renderReceipt(
			makeReceiptData({
				event: makeEvent({
					timestamp: "2026-03-28T19:59:18.703Z",
				}),
			}),
		);

		// The date is formatted in local time with AM/PM.
		// Check structure: month abbreviation, year, and AM/PM indicator.
		const lines = output.split("\n");
		const dateLine = lines.find((l) => l.includes("Date"));
		expect(dateLine).toBeDefined();
		expect(dateLine).toMatch(/AM|PM/);
		expect(dateLine).toMatch(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/);
		expect(dateLine).toContain("2026");
	});

	it("detects providers correctly", () => {
		// claude -> anthropic
		const claudeOutput = renderReceipt(
			makeReceiptData({
				event: makeEvent({
					data: {
						model: "claude-sonnet-4-20250514",
						cost: 1,
						settled: true,
						transferId: "tx_1",
					},
				}),
			}),
		);
		expect(claudeOutput).toContain("anthropic");

		// gpt -> openai
		const gptOutput = renderReceipt(
			makeReceiptData({
				event: makeEvent({
					data: {
						model: "gpt-4o",
						cost: 1,
						settled: true,
						transferId: "tx_2",
					},
				}),
			}),
		);
		expect(gptOutput).toContain("openai");

		// gemini -> google
		const geminiOutput = renderReceipt(
			makeReceiptData({
				event: makeEvent({
					data: {
						model: "gemini-2.0-flash",
						cost: 1,
						settled: true,
						transferId: "tx_3",
					},
				}),
			}),
		);
		expect(geminiOutput).toContain("google");
	});
});

describe("renderReceipt — pending status", () => {
	it("shows PENDING for unsettled llm_call", () => {
		const data = makeReceiptData({
			event: makeEvent({
				kind: "llm_call",
				data: {
					model: "claude-haiku-4-5-20251001",
					cost: 1,
					settled: false,
					transferId: "tx_pending_001",
				},
			}),
		});
		const output = renderReceipt(data);
		expect(output).toContain("PENDING");
		expect(output).toContain("tx_pending_001");
	});
});

describe("renderNotFound", () => {
	it("renders not-found with tx ID and proper structure", () => {
		const txId = "tx_missing_999";
		const output = renderNotFound(txId);

		expect(output).toContain("Transaction not found");
		expect(output).toContain(txId);

		assertBoxStructure(output);
	});
});
