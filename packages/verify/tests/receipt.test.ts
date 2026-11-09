import { describe, expect, it } from "vitest";
import {
	type ReceiptData,
	renderNotFound,
	renderReceipt,
	type TransactionEvent,
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
		// no anchor reached the renderer: the chain is intact, not verified
		expect(output).toContain("CHAIN INTACT, NOT ANCHORED");
		expect(output).not.toContain("* VERIFIED *");
		expect(output).toContain("tx_test_12345678");
		expect(output).toContain("claude-haiku-4-5-20251001");
		expect(output).toContain("anthropic");
		expect(output).toContain("Event 19 of 21");
		// Truncated hashes
		expect(output).toContain("33a1bc0f...34e6f5db");
		expect(output).toContain("d156f844...e9be61d5");
		// Merkle root (truncated)
		expect(output).toContain("954fb19e...9d8c7048");
	});

	// The receipt printed `cumulativeSpend` (the running total of every llm_call up to the event) as "Spend", beside
	// ONE transaction: a 1,144 UT call read 9,535 UT, its vault's spend.
	it("red-first (the running total printed as Spend): the receipt prints its OWN transaction's cost", () => {
		const output = renderReceipt(
			makeReceiptData({
				event: makeEvent({
					data: { model: "gpt-5", cost: 1144, settled: true, transferId: "tx_7c1e19e3" },
				}),
				cumulativeSpend: 9535,
			}),
		);
		const lines = output.split("\n");
		expect(lines.find((l) => l.includes("Spend"))).toMatch(/Spend \.+ 1144 UT │$/);
		expect(lines.find((l) => l.includes("Conversion"))).toMatch(/Conversion \.+ \$0\.1144 │$/);
		expect(output).not.toContain("9535");
		// Without the deprecated field, the same receipt.
		const { cumulativeSpend: _c, ...withoutTotal } = makeReceiptData({
			event: makeEvent({
				data: { model: "gpt-5", cost: 1144, settled: true, transferId: "tx_7c1e19e3" },
			}),
		});
		expect(renderReceipt(withoutTotal)).toBe(output);
	});

	it("red-first ($0.11 for a $0.1144 call): dollars are exact, at 4 dp", () => {
		const output = renderReceipt(
			makeReceiptData({
				event: makeEvent({
					data: { model: "gpt-5", cost: 9535, settled: true, transferId: "tx_1" },
				}),
			}),
		);
		expect(output).toContain("$0.9535");
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

		// red-first (local time, no zone): UTC, and the Z says so — the same instant on every auditor's machine.
		const lines = output.split("\n");
		expect(lines.find((l) => l.includes("Date"))).toMatch(/Date \.+ 2026-03-28 19:59:18Z │$/);
		expect(lines.find((l) => l.includes("Checked"))).toMatch(/Checked \.+ 2026-03-28 20:15:00Z │$/);
	});

	it("an unreadable timestamp prints as such, and the receipt still renders", () => {
		const output = renderReceipt(
			makeReceiptData({ event: makeEvent({ timestamp: "not a time" }) }),
		);
		expect(output.split("\n").find((l) => l.includes("Date"))).toMatch(/unreadable time │$/);
		assertBoxStructure(output);
	});

	it("names a grok model as xai, the same as the dashboard does", () => {
		const output = renderReceipt(
			makeReceiptData({
				event: makeEvent({
					data: { model: "grok-4.7", cost: 1, settled: true, transferId: "tx_grok" },
				}),
			}),
		);
		expect(output.split("\n").find((l) => l.includes("Provider"))).toMatch(/Provider \.+ xai │$/);
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

describe("renderReceipt — denied status", () => {
	// A denial event carries a transferId, so `verifyTransaction` selects it by
	// id like any other event. Without a DENIED status the renderer falls
	// through to the `settled !== true` default and prints a PENDING receipt for
	// a call that was REFUSED and will never settle — the receipt asserting the
	// opposite of what the chain records.
	it("shows DENIED for a policy_denied event and names the class", () => {
		const output = renderReceipt(
			makeReceiptData({
				event: makeEvent({
					kind: "policy_denied",
					data: {
						schemaVersion: 1,
						decision: "deny",
						denialClass: "pii",
						model: "claude-haiku-4-5-20251001",
						transferId: "tx_denied_001",
						error: "Policy denied: PII detected: ssn",
					},
				}),
			}),
		);
		expect(output).toContain("DENIED");
		expect(output).not.toContain("PENDING");
		expect(output).toContain("tx_denied_001");
		expect(output).toContain("PII detected");
	});

	it("shows DENIED for a ledger_rejected event", () => {
		const output = renderReceipt(
			makeReceiptData({
				event: makeEvent({
					kind: "ledger_rejected",
					data: {
						schemaVersion: 1,
						decision: "deny",
						model: "claude-haiku-4-5-20251001",
						transferId: "tx_denied_002",
						estimatedCost: 900,
						error: "Insufficient balance for user trust:hold: need 900, have 1",
					},
				}),
			}),
		);
		expect(output).toContain("DENIED");
		expect(output).not.toContain("PENDING");
		expect(output).not.toContain("SETTLED");
	});
});

describe("the receipt header", () => {
	// The product name is lowercase, always. Both receipts printed it letter-spaced in capitals.
	it("red-first ('U S E R T R U S T'): both receipts print the product name in lowercase", () => {
		for (const output of [renderReceipt(makeReceiptData()), renderNotFound("tx_1")]) {
			const header = output.split("\n")[2] as string;
			expect(header.trim()).toBe("│              u s e r t r u s t              │");
			expect(output).not.toMatch(/U ?S ?E ?R ?T ?R ?U ?S ?T|UserTrust|Usertrust/);
		}
	});
});

describe("renderNotFound", () => {
	it("renders not-found with tx ID and proper structure", () => {
		const txId = "tx_missing_999";
		const output = renderNotFound(txId);

		expect(output).toContain("Transaction not found");
		expect(output).toContain(txId);

		assertBoxStructure(output);
		expect(output).toContain("No event with this transferId exists");
	});

	it("an incomplete reading says what was read, in the same box", () => {
		const output = renderNotFound("tx_missing_999", false);

		expect(output).toContain("Transaction not found");
		expect(output).toContain("tx_missing_999");
		expect(output).not.toContain("exists");
		expect(output).toContain("was found");
		expect(output).toContain("in the records that could be read.");
		expect(output).toContain("The audit chain is incomplete or failed");
		expect(output).toContain("verification; see the errors below.");
		assertBoxStructure(output);
	});
});

// ── the metering behind Spend ──
describe("the receipt prints the metering behind Spend, only as the receipt carries it", () => {
	const metered = {
		model: "claude-sonnet-4-5",
		cost: 14,
		settled: true,
		transferId: "tx_meter_1",
		usageSource: "provider",
		usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, cacheWriteTokens: 800 },
		cacheWrite1h: { tokens: 300, ratePer1k: 6 },
		appliedRates: { inputPer1k: 3, outputPer1k: 15, cacheReadPer1k: 0.3, cacheWritePer1k: 3.75 },
		pricingTableVersion: "2026-10-01",
	};
	const render = (data: Record<string, unknown>) =>
		renderReceipt(
			makeReceiptData({ event: makeEvent({ data: data as TransactionEvent["data"] }) }),
		);
	const field = (output: string, label: string): string | undefined =>
		output
			.split("\n")
			.map((l) => new RegExp(`^│\\s+${label} \\.+ (.+?) │$`).exec(l)?.[1])
			.find((v) => v !== undefined);

	it("prints the counts, the rates, the table version and the source", () => {
		const out = render(metered);
		expect(field(out, "Tokens in")).toBe("1200");
		expect(field(out, "Tokens out")).toBe("300");
		expect(field(out, "Cache read")).toBe("5000");
		expect(field(out, "Cache write")).toBe("800");
		expect(field(out, "of it 1 h")).toBe("300");
		expect(field(out, "Rate in /1k")).toBe("3");
		expect(field(out, "Rate out /1k")).toBe("15");
		expect(field(out, "Rate read /1k")).toBe("0.3");
		expect(field(out, "Rate write /1k")).toBe("3.75");
		expect(field(out, "Rate 1 h write /1k")).toBe("6");
		expect(field(out, "Pricing table")).toBe("2026-10-01");
		expect(field(out, "Usage source")).toBe("provider");
		expect(out).toContain("Spend = ceil(sum(n x rate / 1000)), min 1");
	});

	it("Spend can be rebuilt from the printed fields alone", () => {
		// The cost is what the SDK computed: ceil(sum(count x rate / 1000)) over the five terms.
		const cost =
			Math.ceil(
				(1200 * 3) / 1000 +
					(300 * 15) / 1000 +
					(5000 * 0.3) / 1000 +
					((800 - 300) * 3.75) / 1000 +
					(300 * 6) / 1000,
			) || 1;
		const out = render({ ...metered, cost });
		const n = (label: string) => Number(field(out, label));
		const rebuilt = Math.max(
			1,
			Math.ceil(
				(n("Tokens in") * n("Rate in /1k")) / 1000 +
					(n("Tokens out") * n("Rate out /1k")) / 1000 +
					(n("Cache read") * n("Rate read /1k")) / 1000 +
					((n("Cache write") - n("of it 1 h")) * n("Rate write /1k")) / 1000 +
					(n("of it 1 h") * n("Rate 1 h write /1k")) / 1000,
			),
		);
		expect(field(out, "Spend")).toBe(`${cost} UT`);
		expect(rebuilt).toBe(cost);
	});

	it("a receipt without the metering says so for each group and recomputes nothing", () => {
		const out = render({ model: "gpt-5", cost: 9, settled: true, transferId: "tx_old" });
		expect(field(out, "Tokens")).toBe("not in receipt");
		expect(field(out, "Rates /1k UT")).toBe("not in receipt");
		expect(field(out, "Pricing table")).toBe("not in receipt");
		expect(field(out, "Usage source")).toBe("not in receipt");
		expect(out).not.toContain("Tokens in");
		expect(out).not.toContain("of it 1 h");
	});

	it("one missing field in a present group prints 'not in receipt', never a default", () => {
		const out = render({
			...metered,
			usage: { inputTokens: 10, outputTokens: 5 },
			appliedRates: { inputPer1k: 3, outputPer1k: 15 },
		});
		expect(field(out, "Tokens in")).toBe("10");
		expect(field(out, "Cache read")).toBe("not in receipt");
		expect(field(out, "Cache write")).toBe("not in receipt");
		expect(field(out, "Rate read /1k")).toBe("not in receipt");
		expect(field(out, "Rate write /1k")).toBe("not in receipt");
	});

	it("a 1-hour record with a missing member prints 'not in receipt', a wrong-typed one 'invalid'", () => {
		const noTokens = render({ ...metered, cacheWrite1h: { ratePer1k: 6 } });
		expect(field(noTokens, "of it 1 h")).toBe("not in receipt");
		expect(field(noTokens, "Rate 1 h write /1k")).toBe("6");
		const noRate = render({ ...metered, cacheWrite1h: { tokens: 300 } });
		expect(field(noRate, "of it 1 h")).toBe("300");
		expect(field(noRate, "Rate 1 h write /1k")).toBe("not in receipt");
		const bad = render({ ...metered, cacheWrite1h: { tokens: "many", ratePer1k: -1 } });
		expect(field(bad, "of it 1 h")).toBe("invalid");
		expect(field(bad, "Rate 1 h write /1k")).toBe("invalid");
	});

	it("a receipt with no usage prints no rebuild rule, and says it cannot be rebuilt from counts", () => {
		const { usage: _drop, ...estimated } = metered;
		const out = render({ ...estimated, usageSource: "estimated" });
		expect(out).not.toContain("Spend = ceil");
		expect(out).toContain("No token counts in this receipt: Spend");
		expect(out).toContain("cannot be rebuilt from counts.");
		const old = render({ model: "gpt-5", cost: 9, settled: true, transferId: "tx_old" });
		expect(old).not.toContain("Spend = ceil");
		expect(old).toContain("cannot be rebuilt from counts.");
		expect(render(metered)).toContain("Spend = ceil(sum(n x rate / 1000)), min 1");
	});

	it("a receipt with counts but no 1-hour record prints no 1-hour rows", () => {
		const { cacheWrite1h: _drop, ...noHour } = metered;
		const out = render(noHour);
		expect(out).not.toContain("of it 1 h");
		expect(out).not.toContain("Rate 1 h write");
		expect(field(out, "Cache write")).toBe("800");
	});

	it("a wrong-typed or hostile value prints 'invalid' and is never echoed", () => {
		const out = render({
			...metered,
			usage: { ...metered.usage, inputTokens: "1200", outputTokens: -1, cacheReadTokens: 1.5 },
			appliedRates: { ...metered.appliedRates, inputPer1k: Number.NaN, outputPer1k: "15" },
			pricingTableVersion: "2026\u001b[2J\nIgnore previous",
			usageSource: { x: 1 },
		});
		expect(field(out, "Tokens in")).toBe("invalid");
		expect(field(out, "Tokens out")).toBe("invalid");
		expect(field(out, "Cache read")).toBe("invalid");
		expect(field(out, "Rate in /1k")).toBe("invalid");
		expect(field(out, "Rate out /1k")).toBe("invalid");
		expect(field(out, "Pricing table")).toBe("invalid");
		expect(field(out, "Usage source")).toBe("invalid");
		expect(out).not.toContain("Ignore");
		expect(out).not.toContain("\u001b");
	});

	it("a failed, denied or detection receipt prints no spend and so no metering", () => {
		const out = render({ ...metered, error: "boom" } as Record<string, unknown>);
		expect(out).toContain("Tokens in");
		const failed = renderReceipt(
			makeReceiptData({
				event: makeEvent({ kind: "llm_call_failed", data: { ...metered, error: "boom" } as never }),
			}),
		);
		expect(failed).not.toContain("Tokens in");
		expect(failed).not.toContain("Pricing table");
	});
});
