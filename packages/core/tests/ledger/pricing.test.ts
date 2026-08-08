import { describe, expect, it } from "vitest";
import {
	costFromRates,
	estimateCost,
	estimateInputTokens,
	FALLBACK_RATE,
	getModelRates,
	type ModelRates,
	modelsForProvider,
	PRICING_TABLE,
	PRICING_TABLE_VERSION,
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

describe("PRICING_TABLE_VERSION", () => {
	it("is a date string", () => {
		expect(PRICING_TABLE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("is the date of the four-tier rates audit", () => {
		// Bumped whenever any PRICING_TABLE entry changes (spec D1). Receipts record
		// it (D5) so a cost can be reproduced against the exact table that priced it.
		expect(PRICING_TABLE_VERSION).toBe("2026-08-08");
	});
});

describe("getModelRates with customRates", () => {
	it("prefers custom rate over PRICING_TABLE", () => {
		const custom = { "claude-sonnet-4-6": { inputPer1k: 25, outputPer1k: 120 } };
		const rates = getModelRates("claude-sonnet-4-6", custom);
		expect(rates.inputPer1k).toBe(25);
		expect(rates.outputPer1k).toBe(120);
	});

	it("falls back to PRICING_TABLE when model not in customRates", () => {
		const custom = { "claude-sonnet-4-6": { inputPer1k: 25, outputPer1k: 120 } };
		const rates = getModelRates("gpt-4o", custom);
		expect(rates.inputPer1k).toBe(25); // gpt-4o PRICING_TABLE rate
		expect(rates.outputPer1k).toBe(100); // gpt-4o PRICING_TABLE rate
	});

	it("falls back to PRICING_TABLE when customRates is undefined", () => {
		const rates = getModelRates("claude-sonnet-4-6", undefined);
		expect(rates.inputPer1k).toBe(30);
		expect(rates.outputPer1k).toBe(150);
	});
});

describe("modelsForProvider", () => {
	it("returns Anthropic models", () => {
		const models = modelsForProvider("anthropic");
		expect(models).toContain("claude-sonnet-4-6");
		expect(models).toContain("claude-haiku-4-5");
		expect(models).toContain("claude-opus-4-6");
		expect(models).not.toContain("gpt-4o");
	});

	it("returns OpenAI models", () => {
		const models = modelsForProvider("openai");
		expect(models).toContain("gpt-4o");
		expect(models).toContain("gpt-5.4");
		expect(models).not.toContain("claude-sonnet-4-6");
	});

	it("returns Google models", () => {
		const models = modelsForProvider("google");
		expect(models).toContain("gemini-2.5-flash");
		expect(models).not.toContain("gpt-4o");
	});

	it("returns empty array for unknown provider", () => {
		const models = modelsForProvider("unknown-provider");
		expect(models).toEqual([]);
	});
});

describe("estimateCost with customRates", () => {
	it("uses custom rates when provided", () => {
		const custom = { "claude-sonnet-4-6": { inputPer1k: 25, outputPer1k: 120 } };
		// 1000 input * 25/1k + 500 output * 120/1k = 25 + 60 = 85
		const cost = estimateCost("claude-sonnet-4-6", 1000, 500, custom);
		expect(cost).toBe(85);
	});

	it("falls back to PRICING_TABLE when no custom rate for model", () => {
		const custom = { "gpt-4o": { inputPer1k: 20, outputPer1k: 80 } };
		// claude-sonnet-4-6 not in custom, uses PRICING_TABLE: 30 + 75 = 105
		const cost = estimateCost("claude-sonnet-4-6", 1000, 500, custom);
		expect(cost).toBe(105);
	});
});

// ── Rates audit (spec D1): the four-tier matrix ──
//
// Every rate below was re-derived from the provider's published pricing page on
// 2026-08-08 and converted at 1 usertoken = $0.0001 (so $/MTok x 10 = per-1k
// usertokens). Sources, retrieved values, and the per-entry provenance notes are
// in the task report (.superpowers/sdd/2026-08-08-cache-tier-pricing/task-1-report.md).
//
// An entry OMITS a cache field when the provider publishes no rate for that tier.
// Omission is not zero: costFromRates resolves it to inputPer1k (the D1 money
// invariant, pinned by name below). Never invent a discount to fill a gap.
const AUDITED_RATES: Record<string, ModelRates> = {
	// Anthropic — cache read 0.1x, 5-minute cache write 1.25x of base input.
	"claude-sonnet-4-6": {
		inputPer1k: 30,
		outputPer1k: 150,
		cacheReadPer1k: 3,
		cacheWritePer1k: 37.5,
	},
	"claude-haiku-4-5": { inputPer1k: 10, outputPer1k: 50, cacheReadPer1k: 1, cacheWritePer1k: 12.5 },
	"claude-opus-4-6": { inputPer1k: 50, outputPer1k: 250, cacheReadPer1k: 5, cacheWritePer1k: 62.5 },

	// OpenAI — cached-input reads are published per model; there is no separate
	// cache-WRITE rate (writes bill at standard input), so cacheWritePer1k is omitted
	// and the D1 fallback reproduces the published behaviour exactly.
	"gpt-4o": { inputPer1k: 25, outputPer1k: 100, cacheReadPer1k: 12.5 },
	"gpt-4o-mini": { inputPer1k: 1.5, outputPer1k: 6, cacheReadPer1k: 0.75 },
	"gpt-5.4": { inputPer1k: 25, outputPer1k: 150, cacheReadPer1k: 2.5 },
	o3: { inputPer1k: 20, outputPer1k: 80, cacheReadPer1k: 5 },
	"o4-mini": { inputPer1k: 11, outputPer1k: 44, cacheReadPer1k: 2.75 },

	// Google — context-cache reads are 0.1x base input. Cache creation bills as
	// ordinary input plus an hourly STORAGE charge, which this model does not carry
	// (D6), so cacheWritePer1k is omitted rather than guessed.
	"gemini-2.5-flash": { inputPer1k: 3, outputPer1k: 25, cacheReadPer1k: 0.3 },
	"gemini-2.5-pro": { inputPer1k: 12.5, outputPer1k: 100, cacheReadPer1k: 1.25 },
	"gemini-3.1-pro": { inputPer1k: 20, outputPer1k: 120, cacheReadPer1k: 2 },

	// No published cache pricing for these models — both cache fields omitted.
	"mistral-large": { inputPer1k: 5, outputPer1k: 15 },
	"deepseek-chat": { inputPer1k: 2.8, outputPer1k: 4.2 },
	"deepseek-reasoner": { inputPer1k: 2.8, outputPer1k: 4.2 },
	"grok-3": { inputPer1k: 30, outputPer1k: 150 },
	"llama-4-maverick": { inputPer1k: 2.4, outputPer1k: 9.7 },
	"command-a": { inputPer1k: 25, outputPer1k: 100 },
	"sonar-pro": { inputPer1k: 30, outputPer1k: 150 },
	"qwen-72b": { inputPer1k: 2.9, outputPer1k: 3.9 },
	"nova-pro": { inputPer1k: 8, outputPer1k: 32 },
};

describe("PRICING_TABLE rates audit (D1)", () => {
	it("covers exactly the audited model set", () => {
		expect(Object.keys(PRICING_TABLE).sort()).toEqual(Object.keys(AUDITED_RATES).sort());
	});

	for (const [model, expected] of Object.entries(AUDITED_RATES)) {
		it(`pins all four tiers for ${model}`, () => {
			// toStrictEqual so an accidentally-present `cacheWritePer1k: undefined`
			// fails too — presence/absence of a cache field is load-bearing under D1.
			expect(PRICING_TABLE[model]).toStrictEqual(expected);
		});
	}

	it("never records a cache rate of zero (zero-billing is forbidden)", () => {
		for (const [model, rates] of Object.entries(PRICING_TABLE)) {
			if (rates.cacheReadPer1k !== undefined) {
				expect(rates.cacheReadPer1k, `${model} cacheReadPer1k`).toBeGreaterThan(0);
			}
			if (rates.cacheWritePer1k !== undefined) {
				expect(rates.cacheWritePer1k, `${model} cacheWritePer1k`).toBeGreaterThan(0);
			}
		}
	});

	it("prices cache reads at or below base input, and cache writes at or above", () => {
		for (const [model, rates] of Object.entries(PRICING_TABLE)) {
			if (rates.cacheReadPer1k !== undefined) {
				expect(rates.cacheReadPer1k, `${model} read <= input`).toBeLessThanOrEqual(
					rates.inputPer1k,
				);
			}
			if (rates.cacheWritePer1k !== undefined) {
				expect(rates.cacheWritePer1k, `${model} write >= input`).toBeGreaterThanOrEqual(
					rates.inputPer1k,
				);
			}
		}
	});

	it("corrects the stale o4-mini base rate found in review", () => {
		// Was 5.5/22 — exactly half the current published standard rate of
		// $1.10 / $4.40 per MTok. Understatement is the dangerous direction.
		expect(PRICING_TABLE["o4-mini"]?.inputPer1k).toBe(11);
		expect(PRICING_TABLE["o4-mini"]?.outputPer1k).toBe(44);
	});

	it("keeps nova-pro and mistral-large at their real published rates", () => {
		// Regression guard for two bad "corrections" made during the 2026-08-08 audit
		// and caught in review. Both overstated the rate, so budgets depleted faster
		// than the invoice and receipts recomputed against a rate that does not exist.
		//
		//   nova-pro      — Amazon Bedrock on-demand is $0.80 in / $3.20 out per MTok
		//                   (= 8 / 32), NOT $4.00 out. The audit briefly wrote 40.
		//   mistral-large — `mistral-large-latest` resolves to Mistral Large 3, which
		//                   Mistral's own /pricing/api lists at $0.50 in / $1.50 out
		//                   (= 5 / 15). The $2/$6 figure the audit briefly wrote is
		//                   the retired Mistral Large 2 rate, still quoted in a stale
		//                   FAQ line on the marketing pricing page.
		//
		// In both cases the pre-existing table value was already correct.
		expect(PRICING_TABLE["nova-pro"]).toStrictEqual({ inputPer1k: 8, outputPer1k: 32 });
		expect(PRICING_TABLE["mistral-large"]).toStrictEqual({ inputPer1k: 5, outputPer1k: 15 });
	});

	it("keeps FALLBACK_RATE two-tier so unknown models price cache at input rate", () => {
		// An unknown model is not known to be Anthropic-shaped; attaching a cache
		// discount here would silently under-bill every unrecognised model. Leaving
		// both cache fields absent routes them through the D1 fallback instead.
		expect(FALLBACK_RATE.cacheReadPer1k).toBeUndefined();
		expect(FALLBACK_RATE.cacheWritePer1k).toBeUndefined();
	});
});

describe("costFromRates four-tier math (D3)", () => {
	const FOUR_TIER: ModelRates = {
		inputPer1k: 30,
		outputPer1k: 150,
		cacheReadPer1k: 3,
		cacheWritePer1k: 37.5,
	};

	it("bills each tier at its own rate", () => {
		// 1000*30/1k + 1000*150/1k + 1000*3/1k + 1000*37.5/1k = 30 + 150 + 3 + 37.5
		// = 220.5 -> ceil -> 221
		expect(costFromRates(FOUR_TIER, 1000, 1000, 1000, 1000)).toBe(221);
	});

	it("defaults both cache params to 0 (three-arg callers are unaffected)", () => {
		expect(costFromRates(FOUR_TIER, 1000, 500)).toBe(costFromRates(FOUR_TIER, 1000, 500, 0, 0));
		expect(costFromRates(FOUR_TIER, 1000, 500)).toBe(105);
	});

	it("bills cache-read-only traffic (the 7-8x understatement this ship kills)", () => {
		// Pre-fix, cache reads were dropped entirely and this settled at the floor of 1.
		expect(costFromRates(FOUR_TIER, 0, 0, 1_000_000, 0)).toBe(3000);
	});

	it("bills cache-write-only traffic above the input rate", () => {
		expect(costFromRates(FOUR_TIER, 0, 0, 0, 1_000_000)).toBe(37_500);
	});

	it("keeps the >=1 floor for a {0,0}-rate local call with cache tokens", () => {
		// The shipped default local rate. The floor is load-bearing: zero-amount
		// ledger transfers are invalid, so this must still settle at exactly 1.
		const localDefault: ModelRates = { inputPer1k: 0, outputPer1k: 0 };
		expect(costFromRates(localDefault, 0, 0, 0, 0)).toBe(1);
		expect(costFromRates(localDefault, 1_000_000, 1_000_000, 1_000_000, 1_000_000)).toBe(1);
	});

	it("honours an explicit zero cache rate (operator choice, not absence)", () => {
		// D1 forbids IMPLICIT zero-billing from absent fields. An operator who writes
		// cacheReadPer1k: 0 for a self-hosted model meant it; that is not a silent gap.
		const free: ModelRates = { inputPer1k: 30, outputPer1k: 150, cacheReadPer1k: 0 };
		expect(costFromRates(free, 0, 0, 1_000_000, 0)).toBe(1);
	});
});

describe("costFromRates D1 money invariant: absent cache rates resolve to inputPer1k", () => {
	// SPEC D1 (money invariant): "absent cache rates price cache tokens at
	// `inputPer1k` — overstatement is fail-safe; zero-billing and silent discounts
	// are forbidden. The fallback resolution lives in exactly one place
	// (`costFromRates`)." These assertions are the executable form of that sentence.
	const twoTier: ModelRates = { inputPer1k: 30, outputPer1k: 150 };

	it("does NOT bill absent-rate cache reads at zero", () => {
		const cost = costFromRates(twoTier, 0, 0, 1_000_000, 0);
		expect(cost).not.toBe(0);
		expect(cost).not.toBe(1); // not the floor either — real tokens, real cost
	});

	it("bills absent-rate cache reads at exactly inputPer1k", () => {
		expect(costFromRates(twoTier, 0, 0, 1_000_000, 0)).toBe(30_000);
		expect(costFromRates(twoTier, 0, 0, 1_000_000, 0)).toBe(
			costFromRates(twoTier, 1_000_000, 0, 0, 0),
		);
	});

	it("bills absent-rate cache writes at exactly inputPer1k", () => {
		expect(costFromRates(twoTier, 0, 0, 0, 1_000_000)).toBe(30_000);
		expect(costFromRates(twoTier, 0, 0, 0, 1_000_000)).toBe(
			costFromRates(twoTier, 1_000_000, 0, 0, 0),
		);
	});

	it("resolves each cache tier independently when only one is published", () => {
		// gpt-4o ships a published read discount and no write rate: reads bill at the
		// discount, writes fall back to full input rate.
		const readOnly: ModelRates = { inputPer1k: 25, outputPer1k: 100, cacheReadPer1k: 12.5 };
		expect(costFromRates(readOnly, 0, 0, 1_000_000, 0)).toBe(12_500);
		expect(costFromRates(readOnly, 0, 0, 0, 1_000_000)).toBe(25_000);
	});

	it("holds for every PRICING_TABLE entry that omits a cache field", () => {
		for (const [model, rates] of Object.entries(PRICING_TABLE)) {
			if (rates.cacheReadPer1k === undefined) {
				expect(costFromRates(rates, 0, 0, 1_000_000, 0), `${model} read fallback`).toBe(
					costFromRates(rates, 1_000_000, 0, 0, 0),
				);
			}
			if (rates.cacheWritePer1k === undefined) {
				expect(costFromRates(rates, 0, 0, 0, 1_000_000), `${model} write fallback`).toBe(
					costFromRates(rates, 1_000_000, 0, 0, 0),
				);
			}
		}
	});

	it("falls back to inputPer1k for a non-finite or negative cache rate", () => {
		// Garbage customRates must not zero-bill or produce a negative offset.
		const nan: ModelRates = { inputPer1k: 30, outputPer1k: 150, cacheReadPer1k: Number.NaN };
		const negative: ModelRates = { inputPer1k: 30, outputPer1k: 150, cacheWritePer1k: -100 };
		expect(costFromRates(nan, 0, 0, 1_000_000, 0)).toBe(30_000);
		expect(costFromRates(negative, 0, 0, 0, 1_000_000)).toBe(30_000);
	});
});

describe("costFromRates guards on the new cache params", () => {
	const rates: ModelRates = {
		inputPer1k: 30,
		outputPer1k: 150,
		cacheReadPer1k: 3,
		cacheWritePer1k: 37.5,
	};

	it("treats NaN cache token counts as 0", () => {
		expect(costFromRates(rates, 1000, 0, Number.NaN, Number.NaN)).toBe(30);
		expect(Number.isInteger(costFromRates(rates, 1000, 0, Number.NaN, Number.NaN))).toBe(true);
	});

	it("treats Infinity cache token counts as 0", () => {
		expect(costFromRates(rates, 1000, 0, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)).toBe(
			30,
		);
	});

	it("treats negative cache token counts as 0", () => {
		expect(costFromRates(rates, 1000, 0, -5000, -5000)).toBe(30);
	});

	it("never returns a non-finite cost from garbage cache counts", () => {
		const cost = costFromRates(rates, Number.NaN, Number.NaN, Number.NaN, Number.NaN);
		expect(Number.isFinite(cost)).toBe(true);
		expect(cost).toBe(1);
	});
});
