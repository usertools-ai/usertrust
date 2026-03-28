import { describe, expect, it } from "vitest";
import {
	FALLBACK_RATE,
	PRICING_TABLE,
	estimateCost,
	estimateInputTokens,
	getModelRates,
} from "../../src/ledger/pricing.js";

describe("PRICING_TABLE", () => {
	it("contains 20 models", () => {
		expect(Object.keys(PRICING_TABLE)).toHaveLength(20);
	});

	it("all rates are positive", () => {
		for (const [model, rates] of Object.entries(PRICING_TABLE)) {
			expect(rates.inputPer1k, `${model} inputPer1k`).toBeGreaterThan(0);
			expect(rates.outputPer1k, `${model} outputPer1k`).toBeGreaterThan(0);
		}
	});
});

describe("FALLBACK_RATE", () => {
	it("is sonnet-class pricing", () => {
		expect(FALLBACK_RATE.inputPer1k).toBe(30);
		expect(FALLBACK_RATE.outputPer1k).toBe(150);
	});
});

describe("getModelRates", () => {
	it("returns exact match for known models", () => {
		const rates = getModelRates("claude-sonnet-4-6");
		expect(rates.inputPer1k).toBe(30);
		expect(rates.outputPer1k).toBe(150);
	});

	it("returns prefix match for versioned model strings", () => {
		// "claude-haiku-4-5-20251001" should match "claude-haiku-4-5"
		const rates = getModelRates("claude-haiku-4-5-20251001");
		expect(rates.inputPer1k).toBe(10);
		expect(rates.outputPer1k).toBe(50);
	});

	it("returns FALLBACK_RATE for unknown model", () => {
		const rates = getModelRates("totally-unknown-model-xyz");
		expect(rates).toEqual(FALLBACK_RATE);
	});

	it("returns exact match for every model in the table", () => {
		for (const [model, expected] of Object.entries(PRICING_TABLE)) {
			const rates = getModelRates(model);
			expect(rates).toBe(expected);
		}
	});

	it("prefix matches longest key first to avoid partial collisions", () => {
		// "gpt-4o-mini" is a separate key from "gpt-4o"
		// "gpt-4o-mini-2025" should match "gpt-4o-mini", not "gpt-4o"
		const rates = getModelRates("gpt-4o-mini-2025");
		expect(rates.inputPer1k).toBe(1.5); // gpt-4o-mini rate
		expect(rates.outputPer1k).toBe(6);
	});

	it("prefix matches gpt-4o versioned string to gpt-4o (not gpt-4o-mini)", () => {
		const rates = getModelRates("gpt-4o-2025-01-01");
		expect(rates.inputPer1k).toBe(25); // gpt-4o rate
		expect(rates.outputPer1k).toBe(100);
	});

	it("handles empty string gracefully (falls back)", () => {
		const rates = getModelRates("");
		expect(rates).toEqual(FALLBACK_RATE);
	});
});

describe("estimateCost", () => {
	it("returns correct cost for claude-sonnet-4-6", () => {
		// 1000 input tokens * 30/1k + 500 output tokens * 150/1k = 30 + 75 = 105
		const cost = estimateCost("claude-sonnet-4-6", 1000, 500);
		expect(cost).toBe(105);
	});

	it("returns correct cost for gpt-4o-mini", () => {
		// 1000 input * 1.5/1k + 1000 output * 6/1k = 1.5 + 6 = 7.5 → ceil → 8
		const cost = estimateCost("gpt-4o-mini", 1000, 1000);
		expect(cost).toBe(8);
	});

	it("returns correct cost for deepseek-chat", () => {
		// 2000 input * 2.8/1k + 1000 output * 4.2/1k = 5.6 + 4.2 = 9.8 → ceil → 10
		const cost = estimateCost("deepseek-chat", 2000, 1000);
		expect(cost).toBe(10);
	});

	it("floors to 1 for very small requests", () => {
		const cost = estimateCost("gpt-4o-mini", 1, 0);
		expect(cost).toBe(1);
	});

	it("uses fallback rate for unknown model", () => {
		// fallback: 30 input, 150 output
		// 1000 input * 30/1k + 1000 output * 150/1k = 30 + 150 = 180
		const cost = estimateCost("unknown-model", 1000, 1000);
		expect(cost).toBe(180);
	});

	it("returns integer (ceiling)", () => {
		const cost = estimateCost("claude-sonnet-4-6", 100, 100);
		expect(Number.isInteger(cost)).toBe(true);
	});

	it("returns 1 for zero input and zero output tokens", () => {
		const cost = estimateCost("claude-sonnet-4-6", 0, 0);
		expect(cost).toBe(1); // Math.max(1, ...)
	});

	it("handles output-only cost correctly", () => {
		// 0 input + 1000 output * 150/1k = 150
		const cost = estimateCost("claude-sonnet-4-6", 0, 1000);
		expect(cost).toBe(150);
	});

	it("handles input-only cost correctly", () => {
		// 1000 input * 30/1k + 0 output = 30
		const cost = estimateCost("claude-sonnet-4-6", 1000, 0);
		expect(cost).toBe(30);
	});

	it("returns 1 for fractional cost that rounds down to zero", () => {
		// 1 input * 1.5/1k = 0.0015, 0 output → ceil(0.0015) = 1
		// But Math.max(1, 1) = 1
		const cost = estimateCost("gpt-4o-mini", 1, 0);
		expect(cost).toBe(1);
	});
});

describe("estimateInputTokens", () => {
	it("estimates ~4 chars/token with 1.5x safety margin", () => {
		const messages = [
			{ role: "user", content: "Hello world!" }, // 12 chars content + 16 overhead = 28 chars
		];
		// textChars = 12 + 16 = 28 → ceil(28/4) = 7 textTokens → raw = 7 → ceil(7 * 1.5) = 11
		const tokens = estimateInputTokens(messages);
		expect(tokens).toBe(11);
	});

	it("handles empty messages array", () => {
		const tokens = estimateInputTokens([]);
		expect(tokens).toBe(1); // floor of 1
	});

	it("handles array content blocks", () => {
		const messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Hello world!" }],
			},
		];
		// textChars = 12 (text) + 16 (overhead) = 28 → ceil(28/4) = 7 → raw = 7 → ceil(7*1.5) = 11
		const tokens = estimateInputTokens(messages);
		expect(tokens).toBe(11);
	});

	it("handles tool_call_id overhead", () => {
		const messages = [{ role: "tool", tool_call_id: "call_123", content: "result" }];
		// textChars = 6 (content) + 16 (overhead) = 22 → ceil(22/4) = 6 textTokens
		// blockTokens = 10 (tool_call_id) → raw = 16 → ceil(16*1.5) = 24
		const tokens = estimateInputTokens(messages);
		expect(tokens).toBe(24);
	});

	it("handles multi-message conversation", () => {
		const messages = [
			{ role: "system", content: "You are helpful." },
			{ role: "user", content: "What is 2+2?" },
			{ role: "assistant", content: "4" },
		];
		// Message 1: 16 + 16 = 32 chars
		// Message 2: 12 + 16 = 28 chars
		// Message 3: 1 + 16 = 17 chars
		// Total textChars = 77 → ceil(77/4) = 20 → raw = 20 → ceil(20*1.5) = 30
		const tokens = estimateInputTokens(messages);
		expect(tokens).toBe(30);
	});

	it("safety margin ensures estimate exceeds likely actual", () => {
		const longText = "a".repeat(4000); // ~1000 tokens of actual content
		const messages = [{ role: "user", content: longText }];
		const tokens = estimateInputTokens(messages);
		// Raw tokens ≈ (4000 + 16) / 4 = 1004 → with 1.5x ≈ 1506
		expect(tokens).toBeGreaterThan(1000);
		expect(tokens).toBeLessThan(2000);
	});

	it("returns 1 for non-array input", () => {
		// The function checks Array.isArray first
		const tokens = estimateInputTokens("not an array" as unknown as unknown[]);
		expect(tokens).toBe(1);
	});

	it("skips null/non-object messages", () => {
		const messages = [null, undefined, 42, "string", { role: "user", content: "hi" }];
		const tokens = estimateInputTokens(messages);
		// Only the last message contributes: textChars = 2 + 16 = 18
		// ceil(18/4) = 5 → ceil(5 * 1.5) = 8
		expect(tokens).toBe(8);
	});

	it("handles non-text content blocks (image_url, etc.) via estimateBlockTokens", () => {
		const messages = [
			{
				role: "user",
				content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }],
			},
		];
		// This block is not type "text", so it goes to estimateBlockTokens
		// estimateBlockTokens: no "text" or "content" string → chars=0 → JSON.stringify fallback
		// 16 (overhead) textChars + blockTokens from JSON.stringify
		const tokens = estimateInputTokens(messages);
		expect(tokens).toBeGreaterThan(1);
	});

	it("handles content blocks with 'text' property (non-text type)", () => {
		// A block that has type != "text" but has a "text" property
		// This tests estimateBlockTokens's text extraction
		const messages = [
			{
				role: "user",
				content: [{ type: "tool_result", text: "The answer is 42" }],
			},
		];
		// Goes to estimateBlockTokens since type != "text"
		// estimateBlockTokens: typeof block["text"] === "string" → chars += 16
		// Math.ceil(16 / 4) = 4 blockTokens
		// textChars = 16 (overhead) → ceil(16/4) = 4 textTokens
		// raw = 4 + 4 = 8 → ceil(8 * 1.5) = 12
		const tokens = estimateInputTokens(messages);
		expect(tokens).toBe(12);
	});

	it("handles content blocks with 'content' string property", () => {
		const messages = [
			{
				role: "user",
				content: [{ type: "tool_result", content: "Result data here" }],
			},
		];
		// estimateBlockTokens: typeof block["content"] === "string" → chars += 16
		// Math.ceil(16 / 4) = 4 blockTokens
		// textChars = 16 (overhead) → ceil(16/4) = 4 textTokens
		// raw = 4 + 4 = 8 → ceil(8 * 1.5) = 12
		const tokens = estimateInputTokens(messages);
		expect(tokens).toBe(12);
	});

	it("handles content blocks with nested array content (tool_result payloads)", () => {
		const messages = [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						content: ["string item", { type: "text", text: "nested text" }],
					},
				],
			},
		];
		// estimateBlockTokens:
		//   content is Array → iterate:
		//     "string item" (11 chars) → chars += 11
		//     { type: "text", text: "nested text" } → object → JSON.stringify → chars += length
		//   Total chars > 0 so no fallback
		const tokens = estimateInputTokens(messages);
		expect(tokens).toBeGreaterThan(1);
	});

	it("handles content blocks with nested array containing null", () => {
		const messages = [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						content: [null, undefined, "valid"],
					},
				],
			},
		];
		// null/undefined items are skipped (typeof null !== "string", null == null → skip)
		// "valid" → chars += 5
		const tokens = estimateInputTokens(messages);
		expect(tokens).toBeGreaterThan(1);
	});

	it("handles content blocks with both text and content properties", () => {
		const messages = [
			{
				role: "user",
				content: [
					{
						type: "custom",
						text: "some text",
						content: "some content",
					},
				],
			},
		];
		// estimateBlockTokens: text (9 chars) + content (12 chars) = 21
		// Math.ceil(21 / 4) = 6 blockTokens
		const tokens = estimateInputTokens(messages);
		expect(tokens).toBeGreaterThan(1);
	});

	it("skips null/non-object blocks in array content", () => {
		const messages = [
			{
				role: "user",
				content: [null, undefined, 42],
			},
		];
		// All blocks are skipped (null, undefined, number)
		// textChars = 16 (overhead only) → ceil(16/4) = 4 → ceil(4*1.5) = 6
		const tokens = estimateInputTokens(messages);
		expect(tokens).toBe(6);
	});

	it("handles message with no content property", () => {
		const messages = [{ role: "user" }];
		// content is undefined → neither string nor Array
		// textChars = 16 (overhead) → ceil(16/4) = 4 → ceil(4*1.5) = 6
		const tokens = estimateInputTokens(messages);
		expect(tokens).toBe(6);
	});

	it("handles empty array content", () => {
		const messages = [{ role: "user", content: [] }];
		// Array but no blocks → textChars = 16 (overhead) → 6
		const tokens = estimateInputTokens(messages);
		expect(tokens).toBe(6);
	});

	it("handles block with zero-length text (falls back to JSON.stringify)", () => {
		const messages = [
			{
				role: "user",
				content: [{ type: "empty_block" }],
			},
		];
		// estimateBlockTokens: no "text", no "content" → chars = 0
		// fallback: JSON.stringify({ type: "empty_block" }) → some chars
		const tokens = estimateInputTokens(messages);
		expect(tokens).toBeGreaterThan(1);
	});
});
