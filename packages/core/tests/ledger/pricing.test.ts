import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	canonicalModelId,
	costFromRates,
	costFromRatesUnfloored,
	effectiveCacheWrite1hRate,
	estimateCost,
	estimateInputTokens,
	FALLBACK_RATE,
	getModelRates,
	holdCacheWriteRate,
	holdInputRate,
	isModelPriced,
	type ModelRates,
	modelsForProvider,
	PRICING_TABLE,
	PRICING_TABLE_VERSION,
	resolveCacheWrite1h,
	resolveRates,
	warnCacheRateMigration,
} from "../../src/ledger/pricing.js";
import { type TrustConfig, TrustConfigSchema } from "../../src/shared/types.js";

function makeCloudConfig(): TrustConfig {
	return TrustConfigSchema.parse({ budget: 1000 });
}

describe("PRICING_TABLE", () => {
	it("contains 42 models", () => {
		expect(Object.keys(PRICING_TABLE)).toHaveLength(42);
	});

	it("all rates are positive", () => {
		for (const [model, rates] of Object.entries(PRICING_TABLE)) {
			expect(rates.inputPer1k, `${model} inputPer1k`).toBeGreaterThan(0);
			expect(rates.outputPer1k, `${model} outputPer1k`).toBeGreaterThan(0);
		}
	});
});

describe("FALLBACK_RATE", () => {
	// Fail dearest: an unknown id over-counts visibly instead of under-counting
	// silently. The maxima are COMPUTED from the table, so a dearer row added later
	// fails here until the fallback is raised with it.
	it("FALLBACK_RATE equals the table maximum on every tier it carries", () => {
		const rows = Object.values(PRICING_TABLE);
		const maxIn = Math.max(...rows.map((r) => r.inputPer1k));
		const maxOut = Math.max(...rows.map((r) => r.outputPer1k));
		const maxWrite = Math.max(...rows.map((r) => r.cacheWritePer1k ?? r.inputPer1k));
		expect(FALLBACK_RATE.inputPer1k).toBe(maxIn);
		expect(FALLBACK_RATE.outputPer1k).toBe(maxOut);
		expect(FALLBACK_RATE.cacheWritePer1k).toBe(maxWrite);
	});

	it("pins the literal fallback (250 / 1250 / write 312.5)", () => {
		expect(FALLBACK_RATE).toStrictEqual({
			inputPer1k: 250,
			outputPer1k: 1250,
			cacheWritePer1k: 312.5,
		});
	});
});

describe("getModelRates", () => {
	it("returns exact match for known models", () => {
		const rates = getModelRates("claude-sonnet-4-6");
		expect(rates.inputPer1k).toBe(30);
		expect(rates.outputPer1k).toBe(150);
	});

	it("resolves a dated snapshot (-YYYYMMDD) to its base row", () => {
		const rates = getModelRates("claude-haiku-4-5-20251001");
		expect(rates).toBe(PRICING_TABLE["claude-haiku-4-5"]);
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

	it("does NOT prefix match: a longer id is a different model (#143)", () => {
		// Not a date suffix, and prefix matching is gone, so these fall to the
		// dearest-known fallback instead of a base row.
		expect(getModelRates("gpt-4o-mini-2025")).toBe(FALLBACK_RATE);
		expect(getModelRates("gpt-4o-2025-01")).toBe(FALLBACK_RATE);
		expect(getModelRates("o3-pro")).toBe(FALLBACK_RATE);
		expect(getModelRates("gemini-2.5-pro-preview-06-05")).toBe(FALLBACK_RATE);
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
		// fallback (dearest known): 250 input, 1250 output
		// 1000 input * 250/1k + 1000 output * 1250/1k = 250 + 1250 = 1500
		const cost = estimateCost("unknown-model", 1000, 1000);
		expect(cost).toBe(1500);
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
		// 2026-08-09: the three frontier entries (fable-5 / gpt-5.6-sol / kimi-k3).
		// 2026-08-10: the three fleet-ledger Anthropic entries (opus-5 / sonnet-5 /
		// opus-4-8).
		// 2026-10-07: Sonnet 5 corrected to $2/$10; exact rows for the 5.5 / 5.1
		// generation, Mythos, Haiku 5.5 and the older Opus/Sonnet/Haiku ids.
		expect(PRICING_TABLE_VERSION).toBe("2026-10-07");
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
// The three frontier entries (claude-fable-5, gpt-5.6-sol, kimi-k3) were added on
// 2026-08-09 from the same kind of primary source — the vendors' own published
// price tables, retrieved that day. Their per-entry provenance is in the pricing
// table's own comments.
//
// The three fleet-ledger Anthropic entries (claude-opus-5, claude-sonnet-5,
// claude-opus-4-8) were added on 2026-08-10, re-derived that day from Anthropic's
// published model-pricing table (platform.claude.com/docs/en/about-claude/pricing).
// On 2026-10-07 every Anthropic row was re-verified against the same page
// (retrieved that day). sonnet-5 is $2/$10: page footnote 3 says the introductory
// price is now the standard price and the 2026-09-01 increase to $3/$15 will not
// occur. The 5.5 / 5.1 generation publishes cache reads at 0.05x / 0.025x.
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
	// $10 in / $50 out / $1 cache hit / $12.50 5m cache write per MTok.
	"claude-fable-5": {
		inputPer1k: 100,
		outputPer1k: 500,
		cacheReadPer1k: 10,
		cacheWritePer1k: 125,
	},
	// $5 in / $25 out / $0.50 cache hit / $6.25 5m cache write per MTok
	// (standard tier — fast mode's $10/$50 is a separate speed tier this table
	// does not price). Retrieved 2026-08-10.
	"claude-opus-5": {
		inputPer1k: 50,
		outputPer1k: 250,
		cacheReadPer1k: 5,
		cacheWritePer1k: 62.5,
	},
	// Retrieved 2026-10-07. $2 in / $10 out / $0.20 hit / $2.50 5m write per MTok.
	"claude-sonnet-5": { inputPer1k: 20, outputPer1k: 100, cacheReadPer1k: 2, cacheWritePer1k: 25 },
	// $2 / $10 / $0.10 hit (0.05x, footnote 2) / $2.50 5m write.
	"claude-sonnet-5-5": { inputPer1k: 20, outputPer1k: 100, cacheReadPer1k: 1, cacheWritePer1k: 25 },
	// $4 / $20 / $0.20 hit (0.05x) / $5 5m write.
	"claude-opus-5-5": { inputPer1k: 40, outputPer1k: 200, cacheReadPer1k: 2, cacheWritePer1k: 50 },
	// $10 / $50 / $0.25 hit (0.025x, footnote 1) / $12.50 5m write.
	"claude-fable-5-1": {
		inputPer1k: 100,
		outputPer1k: 500,
		cacheReadPer1k: 2.5,
		cacheWritePer1k: 125,
	},
	// Limited availability. Mythos 5: $10 / $50 / $1 hit / $12.50; Mythos 5.1: hit $0.25.
	"claude-mythos-5": {
		inputPer1k: 100,
		outputPer1k: 500,
		cacheReadPer1k: 10,
		cacheWritePer1k: 125,
	},
	"claude-mythos-5-1": {
		inputPer1k: 100,
		outputPer1k: 500,
		cacheReadPer1k: 2.5,
		cacheWritePer1k: 125,
	},
	// OVER-100k-prompt tier of a length-tiered model: $0.50 / $2.50 / $0.05 hit /
	// $0.625 write. The up-to-100k tier ($0.10 / $0.50) is overstated 5x.
	"claude-haiku-5-5": {
		inputPer1k: 5,
		outputPer1k: 25,
		cacheReadPer1k: 0.5,
		cacheWritePer1k: 6.25,
	},
	// Deprecated but callable. $25 / $125 per MTok for Project Glasswing participants
	// (anthropic.com/project/glasswing; status per the model-deprecations page; both
	// retrieved 2026-10-07). Cache tiers: the pricing page's multipliers for models
	// without an exception (read 0.1x, 5m write 1.25x).
	"claude-mythos-preview": {
		inputPer1k: 250,
		outputPer1k: 1250,
		cacheReadPer1k: 25,
		cacheWritePer1k: 312.5,
	},
	"claude-3-5-haiku": { inputPer1k: 8, outputPer1k: 40, cacheReadPer1k: 0.8, cacheWritePer1k: 10 },
	"claude-opus-4-7": { inputPer1k: 50, outputPer1k: 250, cacheReadPer1k: 5, cacheWritePer1k: 62.5 },
	"claude-opus-4-5": { inputPer1k: 50, outputPer1k: 250, cacheReadPer1k: 5, cacheWritePer1k: 62.5 },
	"claude-opus-4-1": {
		inputPer1k: 150,
		outputPer1k: 750,
		cacheReadPer1k: 15,
		cacheWritePer1k: 187.5,
	},
	"claude-opus-4": {
		inputPer1k: 150,
		outputPer1k: 750,
		cacheReadPer1k: 15,
		cacheWritePer1k: 187.5,
	},
	"claude-sonnet-4-5": {
		inputPer1k: 30,
		outputPer1k: 150,
		cacheReadPer1k: 3,
		cacheWritePer1k: 37.5,
	},
	"claude-sonnet-4": { inputPer1k: 30, outputPer1k: 150, cacheReadPer1k: 3, cacheWritePer1k: 37.5 },
	// $5 in / $25 out / $0.50 cache hit / $6.25 5m cache write per MTok —
	// identical to the opus-4-6 row, as published. Retrieved 2026-08-10.
	"claude-opus-4-8": {
		inputPer1k: 50,
		outputPer1k: 250,
		cacheReadPer1k: 5,
		cacheWritePer1k: 62.5,
	},

	// OpenAI — cached-input reads are published per model; there is no separate
	// cache-WRITE rate (writes bill at standard input), so cacheWritePer1k is omitted
	// and the D1 fallback reproduces the published behaviour exactly.
	"gpt-4o": { inputPer1k: 25, outputPer1k: 100, cacheReadPer1k: 12.5 },
	// Dated snapshot priced differently from its alias: $5 / $15 per MTok, no cached
	// input. developers.openai.com/api/docs/pricing, retrieved 2026-10-07.
	"gpt-4o-2024-05-13": { inputPer1k: 50, outputPer1k: 150 },
	"gpt-4o-mini": { inputPer1k: 1.5, outputPer1k: 6, cacheReadPer1k: 0.75 },
	"gpt-5.4": { inputPer1k: 25, outputPer1k: 150, cacheReadPer1k: 2.5 },
	o3: { inputPer1k: 20, outputPer1k: 80, cacheReadPer1k: 5 },
	"o4-mini": { inputPer1k: 11, outputPer1k: 44, cacheReadPer1k: 2.75 },
	// gpt-5.6+ DOES publish a cache-write rate (1.25x uncached input), so this
	// entry carries one where every older OpenAI row above omits it.
	// $5 in / $30 out / $0.50 cached input / $6.25 cache write per MTok.
	"gpt-5.6-sol": { inputPer1k: 50, outputPer1k: 300, cacheReadPer1k: 5, cacheWritePer1k: 62.5 },

	// Moonshot AI — $3 cache-miss input / $0.30 cache hit / $15 out per MTok.
	// No cache-CREATION rate is published (the price list has two input columns,
	// hit and miss, and no write column) — omitted, never guessed.
	"kimi-k3": { inputPer1k: 30, outputPer1k: 150, cacheReadPer1k: 3 },

	// Google — context-cache reads are 0.1x base input. Cache creation bills as
	// ordinary input plus an hourly STORAGE charge, which this model does not carry
	// (D6), so cacheWritePer1k is omitted rather than guessed.
	"gemini-2.5-flash": { inputPer1k: 3, outputPer1k: 25, cacheReadPer1k: 0.3 },
	"gemini-2.5-pro": { inputPer1k: 12.5, outputPer1k: 100, cacheReadPer1k: 1.25 },
	"gemini-3.1-pro": { inputPer1k: 20, outputPer1k: 120, cacheReadPer1k: 2 },

	// No published cache pricing for these models — both cache fields omitted.
	"mistral-large": { inputPer1k: 5, outputPer1k: 15 },
	"mistral-large-latest": { inputPer1k: 5, outputPer1k: 15 },
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

	// The frontier ids are metered from their OWN published rates, never from
	// FALLBACK_RATE and never from a shorter sibling key's prefix match. A
	// regression here is silent mispricing, not a failed lookup, so it is pinned
	// as its own assertion rather than left to the per-entry checks above.
	// (Before 2026-08-10, "claude-opus-5" matched no table key at all and fell to
	// FALLBACK_RATE — sonnet-class 30/150 — a silent 40% understatement of every
	// opus-5 call. That is the mispricing the fleet-ledger rows kill.)
	for (const model of [
		"claude-fable-5",
		"gpt-5.6-sol",
		"kimi-k3",
		"claude-opus-5",
		"claude-sonnet-5",
		"claude-sonnet-5-5",
		"claude-opus-5-5",
		"claude-fable-5-1",
		"claude-mythos-5",
		"claude-mythos-5-1",
		"claude-haiku-5-5",
		"claude-mythos-preview",
		"claude-opus-4-8",
	]) {
		it(`resolves ${model} to a table entry, not the fallback`, () => {
			const rates = getModelRates(model);
			expect(rates).toBe(PRICING_TABLE[model]);
			expect(rates).not.toBe(FALLBACK_RATE);
		});
	}

	for (const [model, expected] of Object.entries(AUDITED_RATES)) {
		it(`pins all four tiers for ${model}`, () => {
			// toStrictEqual so an accidentally-present `cacheWritePer1k: undefined`
			// fails too — presence/absence of a cache field is load-bearing under D1.
			// Anthropic rows also carry the explicit 1-hour write rate, pinned against the
			// page in "1-hour cache-write tier" below.
			const oneHour = PAGE_1H_WRITE_PER_1K[model];
			expect(PRICING_TABLE[model]).toStrictEqual(
				oneHour === undefined ? expected : { ...expected, cacheWrite1hPer1k: oneHour },
			);
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

	// sonnet-5-is-not-3-15. The row held $3/$15 from 2026-08-10 until 2026-10-07 on
	// the strength of a scheduled increase that Anthropic then cancelled (page
	// footnote 3), overstating every Sonnet 5 call by 50%. Named for the consequence
	// so reverting the row fails with the reason attached.
	it("sonnet-5-is-not-3-15: sonnet-5 and sonnet-5-5 price at the published $2/$10", () => {
		for (const id of ["claude-sonnet-5", "claude-sonnet-5-5"]) {
			expect(PRICING_TABLE[id]?.inputPer1k, id).toBe(20);
			expect(PRICING_TABLE[id]?.outputPer1k, id).toBe(100);
		}
	});

	// The 5.5 / 5.1 generation reads cache at 0.05x / 0.025x, NOT the 0.1x every
	// older row uses. A 0.1x row overstates reads 2x-4x on exactly the traffic
	// (cache-read-dominated sessions) that dominates a Claude Code bill.
	it("cache-read-multiplier: 0.05x on opus-5-5 / sonnet-5-5, 0.025x on fable-5-1 / mythos-5-1, 0.1x elsewhere", () => {
		const mult: Record<string, number> = {
			"claude-opus-5-5": 0.05,
			"claude-sonnet-5-5": 0.05,
			"claude-fable-5-1": 0.025,
			"claude-mythos-5-1": 0.025,
		};
		for (const [id, rates] of Object.entries(PRICING_TABLE)) {
			if (!id.startsWith("claude-")) continue;
			const expected = mult[id] ?? 0.1;
			expect((rates.cacheReadPer1k ?? NaN) / rates.inputPer1k, id).toBeCloseTo(expected, 10);
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

	it("keeps FALLBACK_RATE cache-READ absent so unknown models read at the input rate", () => {
		// An unknown model is not known to be Anthropic-shaped; attaching a cache
		// discount here would silently under-bill every unrecognised model. The read
		// tier stays absent (D1 prices it at inputPer1k, dearer than any published
		// read rate); the write tier carries the dearest published write rate.
		expect(FALLBACK_RATE.cacheReadPer1k).toBeUndefined();
		expect(FALLBACK_RATE.cacheWritePer1k).toBe(312.5);
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

// Codex PR-85 [P2-4]. The recompute pin is this ship's headline claim, and it is
// published in three places as ONE formula — receipt.v2.schema.json, types.mdx and
// the reconciliation integration test all write `ceil(sum(counts x rates / 1000))`,
// i.e. MULTIPLY THEN DIVIDE. Implementing it as `(count / 1000) * rate` is a
// different computation in IEEE-754: 560/1000 is not representable, so the division
// carries a 1-ulp error that `Math.ceil` then amplifies to a whole usertoken.
// An auditor running the documented formula would get 7 where usertrust charged 8,
// and "exactly recomputable" would be false on real, unremarkable inputs.
describe("costFromRates matches the PUBLISHED auditor formula exactly (Codex PR-85 P2-4)", () => {
	/** The documented reconciliation formula, verbatim from receipt.v2.schema.json. */
	const publishedFormula = (
		rates: Required<Pick<ModelRates, "inputPer1k" | "outputPer1k">> & {
			cacheReadPer1k: number;
			cacheWritePer1k: number;
		},
		counts: { input: number; output: number; cacheRead: number; cacheWrite: number },
	): number =>
		Math.max(
			1,
			Math.ceil(
				(counts.input * rates.inputPer1k) / 1000 +
					(counts.output * rates.outputPer1k) / 1000 +
					(counts.cacheRead * rates.cacheReadPer1k) / 1000 +
					(counts.cacheWrite * rates.cacheWritePer1k) / 1000,
			),
		);

	it("prices 560 cache-write tokens at 12.5/1k as 7, not 8 (the exact divergence case)", () => {
		// claude-haiku-4-5's shipped cacheWritePer1k. (560 * 12.5) / 1000 === 7 exactly;
		// (560 / 1000) * 12.5 === 7.000000000000001, which ceils to 8.
		const haiku: ModelRates = {
			inputPer1k: 10,
			outputPer1k: 50,
			cacheReadPer1k: 1,
			cacheWritePer1k: 12.5,
		};
		expect((560 / 1000) * 12.5).toBe(7.000000000000001); // the trap, pinned
		expect((560 * 12.5) / 1000).toBe(7); // the published order
		expect(costFromRates(haiku, 0, 0, 0, 560)).toBe(7);
	});

	it("agrees with the published formula across a divergence-hunting table", () => {
		const rates = {
			inputPer1k: 12.5,
			outputPer1k: 37.5,
			cacheReadPer1k: 12.5,
			cacheWritePer1k: 37.5,
		};
		// Counts chosen so that `n / 1000` is inexact in binary and the product
		// lands within 1 ulp of an integer — exactly where ceil() flips.
		for (const n of [560, 1120, 2240, 4480, 560_000, 28, 56, 112, 224, 448]) {
			for (const tier of ["input", "output", "cacheRead", "cacheWrite"] as const) {
				const counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, [tier]: n };
				expect(
					costFromRates(rates, counts.input, counts.output, counts.cacheRead, counts.cacheWrite),
					`${tier}=${n}`,
				).toBe(publishedFormula(rates, counts));
			}
		}
	});

	it("agrees with the published formula on a mixed four-tier settle", () => {
		const rates = {
			inputPer1k: 30,
			outputPer1k: 150,
			cacheReadPer1k: 3,
			cacheWritePer1k: 37.5,
		};
		const counts = { input: 560, output: 1120, cacheRead: 2240, cacheWrite: 560 };
		expect(
			costFromRates(rates, counts.input, counts.output, counts.cacheRead, counts.cacheWrite),
		).toBe(publishedFormula(rates, counts));
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

// D8: the migration warning is a process-lifetime singleton (fires at most
// once, ever, in this module instance) — vitest isolates modules per test
// FILE by default, so these tests share that one lifetime. The "does not
// warn" cases run first, before anything trips the flag; the final test both
// trips it and proves the dedup, so ordering here is load-bearing.
describe("warnCacheRateMigration (D8 migration warning)", () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
	});

	it("does not warn when customRates is undefined", () => {
		warnCacheRateMigration(undefined);
		expect(stderrSpy).not.toHaveBeenCalled();
	});

	it("does not warn when the custom entry carries both cache fields", () => {
		warnCacheRateMigration({
			"claude-haiku-4-5": {
				inputPer1k: 10,
				outputPer1k: 50,
				cacheReadPer1k: 1,
				cacheWritePer1k: 12.5,
			},
		});
		expect(stderrSpy).not.toHaveBeenCalled();
	});

	it("does not warn when the table entry itself has no cache fields", () => {
		// mistral-large is two-tier in PRICING_TABLE — nothing to migrate away from.
		expect(PRICING_TABLE["mistral-large"]?.cacheReadPer1k).toBeUndefined();
		warnCacheRateMigration({ "mistral-large": { inputPer1k: 6, outputPer1k: 16 } });
		expect(stderrSpy).not.toHaveBeenCalled();
	});

	it("does not warn for a model absent from the table (nothing to compare against)", () => {
		warnCacheRateMigration({ "totally-custom-model": { inputPer1k: 1, outputPer1k: 2 } });
		expect(stderrSpy).not.toHaveBeenCalled();
	});

	it("warns once naming every affected model and the conservative consequence, then stays silent", () => {
		// Both claude-haiku-4-5 and claude-opus-4-6 publish both cache tiers in
		// PRICING_TABLE; this pre-D1-shaped config omits them on both — one call
		// with two affected models exercises the plural wording too.
		warnCacheRateMigration({
			"claude-haiku-4-5": { inputPer1k: 11, outputPer1k: 55 },
			"claude-opus-4-6": { inputPer1k: 55, outputPer1k: 275 },
		});

		expect(stderrSpy).toHaveBeenCalledTimes(1);
		const [msg] = stderrSpy.mock.calls[0] as [string];
		expect(msg).toContain("claude-haiku-4-5");
		expect(msg).toContain("claude-opus-4-6");
		expect(msg).toContain("cache reads will price at full input rate");

		// Once per PROCESS, not once per call: a second call — even with a
		// different affected model — must not fire again.
		warnCacheRateMigration({ "claude-sonnet-4-6": { inputPer1k: 30, outputPer1k: 150 } });
		expect(stderrSpy).toHaveBeenCalledTimes(1);
	});
});

describe("isModelPriced (a caller that must refuse what it cannot price exactly)", () => {
	it("is true for an exact table model and a custom rate; false for an unknown model", async () => {
		const { isModelPriced } = await import("../../src/ledger/pricing.js");
		expect(isModelPriced("claude-sonnet-4-6")).toBe(true);
		expect(isModelPriced("my-model", { "my-model": { inputPer1k: 1, outputPer1k: 2 } })).toBe(true);
		expect(isModelPriced("totally-unknown-model-xyz")).toBe(false);
		expect(isModelPriced("constructor")).toBe(false); // inherited keys are not rates
		expect(isModelPriced("__proto__")).toBe(false);
	});

	it("a PREFIX variant is NOT priced (o3-pro is not o3; -fast is not standard speed)", async () => {
		const { isModelPriced } = await import("../../src/ledger/pricing.js");
		expect(isModelPriced("claude-sonnet-4-6-20991231")).toBe(false);
		expect(isModelPriced("claude-opus-4-6-fast")).toBe(false);
		expect(isModelPriced("o3-pro-variant")).toBe(false);
		// …until the operator prices it exactly.
		expect(
			isModelPriced("claude-opus-4-6-fast", {
				"claude-opus-4-6-fast": { inputPer1k: 1, outputPer1k: 2 },
			}),
		).toBe(true);
	});

	it("over the whole table: priced iff an exact key; every variant unpriced and metered at the fallback", async () => {
		const { FALLBACK_RATE, PRICING_TABLE, getModelRates, isModelPriced } = await import(
			"../../src/ledger/pricing.js"
		);
		const keys = Object.keys(PRICING_TABLE);
		for (const k of keys) {
			expect(isModelPriced(k), k).toBe(true);
			const v = `${k}-variant`;
			if (keys.includes(v)) continue;
			expect(isModelPriced(v), v).toBe(false);
			// And the public lookup does not prefix match either: the variant is
			// metered at the dearest-known fallback, never at its base row.
			expect(getModelRates(v), v).toBe(FALLBACK_RATE);
		}
		for (const m of ["", "x", "gpt", "claude", "toString", "hasOwnProperty", "unknown-model"]) {
			expect(isModelPriced(m), m).toBe(false);
		}
	});
});

describe("dated-snapshot canonicalization (F2)", () => {
	it("strips exactly one trailing -YYYY-MM-DD and nothing else", () => {
		expect(canonicalModelId("gpt-4o-2024-08-06")).toBe("gpt-4o");
		expect(canonicalModelId("o3-2025-04-16")).toBe("o3");
		expect(canonicalModelId("gpt-4o-2024-08-06-2024-08-06")).toBe("gpt-4o-2024-08-06");
		expect(canonicalModelId("gpt-4o-2024-8-06")).toBe("gpt-4o-2024-8-06");
		expect(canonicalModelId("gemini-2.5-pro-preview-06-05")).toBe("gemini-2.5-pro-preview-06-05");
	});

	it("a hyphenated-date snapshot resolves to its alias row", () => {
		expect(getModelRates("gpt-4o-2024-08-06")).toBe(PRICING_TABLE["gpt-4o"]);
		expect(getModelRates("gpt-4o-mini-2024-07-18")).toBe(PRICING_TABLE["gpt-4o-mini"]);
		expect(getModelRates("o3-2025-04-16")).toBe(PRICING_TABLE.o3);
		expect(getModelRates("o4-mini-2025-04-16")).toBe(PRICING_TABLE["o4-mini"]);
		const r = resolveRates("gpt-4o-2024-08-06", "cloud", makeCloudConfig());
		expect(r.rateSource).toBe("table");
		expect(r.unknown).toBe(false);
	});

	// EXACT FIRST. gpt-4o-2024-05-13 is $5/$15 against gpt-4o's $2.50/$10, so reducing
	// it to its alias would under-price every call 2x, silently, as a table hit.
	it("exact-first: a snapshot with its own row is NOT reduced to its cheaper alias", () => {
		const snap = getModelRates("gpt-4o-2024-05-13");
		expect(snap).toBe(PRICING_TABLE["gpt-4o-2024-05-13"]);
		expect(snap).not.toBe(PRICING_TABLE["gpt-4o"]);
		expect(snap.inputPer1k).toBe(50);
		expect(snap.outputPer1k).toBe(150);
		expect(resolveRates("gpt-4o-2024-05-13", "cloud", makeCloudConfig()).rates).toBe(snap);
	});

	it("strips exactly one trailing -YYYYMMDD and nothing else", () => {
		expect(canonicalModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
		expect(canonicalModelId("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
		expect(canonicalModelId("claude-opus-5-20260101-20260102")).toBe("claude-opus-5-20260101");
		expect(canonicalModelId("claude-opus-5-2026010")).toBe("claude-opus-5-2026010");
		expect(canonicalModelId("claude-opus-5-fast")).toBe("claude-opus-5-fast");
	});

	it("a dated id resolves to its base row, table-sourced and not unknown", () => {
		const r = resolveRates("claude-haiku-4-5-20251001", "cloud", makeCloudConfig());
		expect(r.rates).toBe(PRICING_TABLE["claude-haiku-4-5"]);
		expect(r.rateSource).toBe("table");
		expect(r.unknown).toBe(false);
	});

	it("claude-sonnet-5-5 is NOT claude-sonnet-5 (no prefix match; #143)", () => {
		expect(getModelRates("claude-sonnet-5-5")).toBe(PRICING_TABLE["claude-sonnet-5-5"]);
		expect(getModelRates("claude-sonnet-5-5")).not.toBe(PRICING_TABLE["claude-sonnet-5"]);
		expect(getModelRates("claude-opus-5-5")).not.toBe(PRICING_TABLE["claude-opus-5"]);
		expect(getModelRates("claude-fable-5-1")).not.toBe(PRICING_TABLE["claude-fable-5"]);
	});

	it("a 7-digit, non-numeric or -fast suffix falls to the flagged fallback", () => {
		for (const id of [
			"claude-opus-5-2026010",
			"claude-opus-5-2026010x",
			"claude-opus-5-fast",
			"claude-opus-4-6-fast",
			"anthropic.claude-opus-5-v1:0",
			"claude-opus-5@20260101",
		]) {
			const r = resolveRates(id, "cloud", makeCloudConfig());
			expect(r.rates, id).toBe(FALLBACK_RATE);
			expect(r.rateSource, id).toBe("fallback");
			expect(r.unknown, id).toBe(true);
		}
	});

	// The CHECK fails closed for enforcement; the PRICE canonicalizes for metering.
	// Pinned together on ONE id so neither half can drift alone.
	it("divergence: isModelPriced refuses a dated id that getModelRates meters at its base row", () => {
		const id = "claude-sonnet-4-6-20991231";
		expect(isModelPriced(id)).toBe(false);
		expect(getModelRates(id)).toBe(PRICING_TABLE["claude-sonnet-4-6"]);
		const r = resolveRates(id, "cloud", makeCloudConfig());
		expect(r.rateSource).toBe("table");
		expect(r.unknown).toBe(false);
	});
});

describe("claude-mythos-preview (deprecated, still callable)", () => {
	// Project Glasswing participants still call it; without its own row it fell to the
	// fallback and, before the fallback tracked the table maximum, to a rate 40% BELOW
	// its published $25/$125.
	it("has its own exact row at the published $25 / $125", () => {
		const r = resolveRates("claude-mythos-preview", "cloud", makeCloudConfig());
		expect(r.rates).toBe(PRICING_TABLE["claude-mythos-preview"]);
		expect(r.rateSource).toBe("table");
		expect(r.unknown).toBe(false);
		expect(r.rates.inputPer1k).toBe(250);
		expect(r.rates.outputPer1k).toBe(1250);
	});

	it("carries the page's standard cache multipliers: read 0.1x, 5m write 1.25x", () => {
		const preview = PRICING_TABLE["claude-mythos-preview"];
		expect(preview?.cacheReadPer1k).toBe(25);
		expect(preview?.cacheWritePer1k).toBe(312.5);
	});

	it("is the dearest row, so it sets the fallback", () => {
		const preview = PRICING_TABLE["claude-mythos-preview"];
		expect(FALLBACK_RATE.inputPer1k).toBe(preview?.inputPer1k);
		expect(FALLBACK_RATE.outputPer1k).toBe(preview?.outputPer1k);
	});
});

// ── 1-hour cache writes (#203) ──────────────────────────────────────────────

// The "1h cache writes" column of Anthropic's model-pricing table, $/MTok x 10 =
// usertokens per 1k (https://platform.claude.com/docs/en/about-claude/pricing,
// retrieved 2026-10-07). Read from the page, not derived from 2x input here, so a
// row that drifts off its published rate fails against the source and not against
// itself. claude-mythos-preview is not on the page: its entry is 2x its $25 input
// (the page's published 1-hour multiple for a model without an exception).
const PAGE_1H_WRITE_PER_1K: Record<string, number> = {
	"claude-fable-5-1": 200,
	"claude-fable-5": 200,
	"claude-mythos-5-1": 200,
	"claude-mythos-5": 200,
	"claude-mythos-preview": 500,
	"claude-opus-5-5": 80,
	"claude-opus-5": 100,
	"claude-opus-4-8": 100,
	"claude-opus-4-7": 100,
	"claude-opus-4-6": 100,
	"claude-opus-4-5": 100,
	"claude-opus-4-1": 300,
	"claude-opus-4": 300,
	"claude-sonnet-5-5": 40,
	"claude-sonnet-5": 40,
	"claude-sonnet-4-6": 60,
	"claude-sonnet-4-5": 60,
	"claude-sonnet-4": 60,
	"claude-haiku-5-5": 10,
	"claude-haiku-4-5": 20,
	"claude-3-5-haiku": 16,
};

describe("1-hour cache-write tier", () => {
	for (const [model, per1k] of Object.entries(PAGE_1H_WRITE_PER_1K)) {
		it(`${model} publishes an explicit 1h write rate of ${per1k}`, () => {
			expect(PRICING_TABLE[model]?.cacheWrite1hPer1k).toBe(per1k);
		});
	}

	it("every Anthropic row carries an explicit 1h rate, and the pin list covers exactly them", () => {
		const anthropic = Object.keys(PRICING_TABLE).filter((m) => m.startsWith("claude-"));
		expect(anthropic.sort()).toEqual(Object.keys(PAGE_1H_WRITE_PER_1K).sort());
		for (const m of anthropic) {
			const r = PRICING_TABLE[m];
			expect(r?.cacheWrite1hPer1k, m).toBeDefined();
			expect(r?.cacheWrite1hPer1k, `${m} 1h >= 5m write`).toBeGreaterThanOrEqual(
				r?.cacheWritePer1k ?? 0,
			);
		}
	});

	it("an absent 1h rate resolves to the dearer of the 5m write and 2x input (one site)", () => {
		expect(effectiveCacheWrite1hRate({ inputPer1k: 30, outputPer1k: 150 })).toBe(60);
		expect(
			effectiveCacheWrite1hRate({ inputPer1k: 30, outputPer1k: 150, cacheWritePer1k: 90 }),
		).toBe(90);
		expect(
			effectiveCacheWrite1hRate({ inputPer1k: 30, outputPer1k: 150, cacheWrite1hPer1k: 45 }),
		).toBe(45);
		// A garbage explicit value is an absence, not a discount.
		for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
			expect(
				effectiveCacheWrite1hRate({ inputPer1k: 30, outputPer1k: 150, cacheWrite1hPer1k: bad }),
			).toBe(60);
		}
		// An operator's explicit 0 is honoured, like every other cache tier.
		expect(
			effectiveCacheWrite1hRate({ inputPer1k: 30, outputPer1k: 150, cacheWrite1hPer1k: 0 }),
		).toBe(0);
	});

	const SONNET = PRICING_TABLE["claude-sonnet-4-6"] as ModelRates; // 30 / 150 / 3 / 37.5 / 1h 60

	it("prices the 1h SUBSET at the 1h rate and the remainder at the 5m rate", () => {
		// 4000 written, 1000 of them 1h: 3000 x 37.5/1k + 1000 x 60/1k = 112.5 + 60 = 172.5 -> 173
		expect(costFromRates(SONNET, 0, 0, 0, 4000, 1000)).toBe(173);
		// All 1h: 4000 x 60/1k = 240. All 5m: 4000 x 37.5/1k = 150.
		expect(costFromRates(SONNET, 0, 0, 0, 4000, 4000)).toBe(240);
		expect(costFromRates(SONNET, 0, 0, 0, 4000, 0)).toBe(150);
		expect(costFromRatesUnfloored(SONNET, 0, 0, 0, 4000, 1000)).toBe(172.5);
	});

	it("the 1h count is clamped to the write total and sanitized", () => {
		// 1h larger than the total can never price more than the total at the 1h rate.
		expect(costFromRates(SONNET, 0, 0, 0, 1000, 9999)).toBe(60);
		for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
			expect(costFromRates(SONNET, 0, 0, 0, 1000, bad)).toBe(
				costFromRates(SONNET, 0, 0, 0, 1000, 0),
			);
		}
		// 1h tokens with NO write total are not billed on their own.
		expect(costFromRates(SONNET, 0, 0, 0, 0, 500)).toBe(1);
	});

	it("omitting the 1h argument leaves every existing cost unchanged", () => {
		expect(costFromRates(SONNET, 1000, 500, 2000, 700)).toBe(
			costFromRates(SONNET, 1000, 500, 2000, 700, 0),
		);
	});

	it("holdInputRate reserves the dearest of input, 5m write and 1h write", () => {
		expect(holdInputRate(SONNET)).toBe(60); // 1h write, not the 37.5 5m write
		expect(holdInputRate(SONNET, false)).toBe(37.5); // a request with no 1h marker
		// A row that publishes no 1h tier derives nothing from silence: held as before.
		expect(holdInputRate({ inputPer1k: 25, outputPer1k: 100, cacheReadPer1k: 12.5 })).toBe(25);
		expect(holdInputRate({ inputPer1k: 5, outputPer1k: 5, cacheWritePer1k: 9 })).toBe(9);
		expect(holdCacheWriteRate(SONNET)).toBe(60);
		expect(holdCacheWriteRate({ inputPer1k: 5, outputPer1k: 5, cacheWritePer1k: 9 })).toBe(9);
	});

	it("resolveCacheWrite1h: absent when no 1h tokens, frozen record when some", () => {
		expect(resolveCacheWrite1h(SONNET, 0, 4000)).toBeUndefined();
		expect(resolveCacheWrite1h(SONNET, 500, 0)).toBeUndefined();
		const rec = resolveCacheWrite1h(SONNET, 1000, 4000);
		expect(rec).toEqual({ tokens: 1000, ratePer1k: 60 });
		expect(Object.isFrozen(rec)).toBe(true);
		expect(resolveCacheWrite1h(SONNET, 9999, 4000)?.tokens).toBe(4000);
	});
});

describe("1-hour write arithmetic matches the auditor's recompute exactly", () => {
	// The documented recompute is ceil(sum(counts x rates / 1000)): each term multiplies THEN
	// divides on its own, and the terms sum in the order input, output, read, 5-minute write,
	// 1-hour write. Settlement must group identically, or an honest receipt fails to reproduce.
	const audit = (
		r: { in: number; out: number; read: number; w5: number; w1: number },
		n: { in: number; out: number; read: number; w: number; h: number },
	) =>
		Math.max(
			1,
			Math.ceil(
				(n.in * r.in) / 1000 +
					(n.out * r.out) / 1000 +
					(n.read * r.read) / 1000 +
					((n.w - n.h) * r.w5) / 1000 +
					(n.h * r.w1) / 1000,
			),
		);
	const SONNET_RATES = { in: 30, out: 150, read: 3, w5: 37.5, w1: 60 };

	it("the counts that exposed a numerator-grouping drift (321 vs 322) reproduce", () => {
		const n = { in: 607, out: 1062, read: 2800, w: 2367, h: 2059 };
		const cost = costFromRates(
			PRICING_TABLE["claude-sonnet-4-6"] as ModelRates,
			n.in,
			n.out,
			n.read,
			n.w,
			n.h,
		);
		expect(cost).toBe(audit(SONNET_RATES, n));
	});

	it("2,000 seeded random call shapes: cost equals the per-term recompute on every one", () => {
		let seed = 0x9e3779b9;
		const next = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed / 2 ** 32;
		};
		const rates = PRICING_TABLE["claude-sonnet-4-6"] as ModelRates;
		for (let i = 0; i < 2_000; i++) {
			const w = Math.floor(next() * 5_000);
			const n = {
				in: Math.floor(next() * 3_000),
				out: Math.floor(next() * 3_000),
				read: Math.floor(next() * 6_000),
				w,
				h: Math.floor(next() * (w + 1)),
			};
			expect(costFromRates(rates, n.in, n.out, n.read, n.w, n.h), JSON.stringify(n)).toBe(
				audit(SONNET_RATES, n),
			);
		}
	});
});

describe("holds for an operator's custom row (legacy rows with no 1-hour rate)", () => {
	const legacy: ModelRates = { inputPer1k: 30, outputPer1k: 150, cacheWritePer1k: 37.5 };
	it("a custom row that publishes a write tier but no 1h rate holds the derived 2x input", () => {
		expect(holdInputRate(legacy, true, true)).toBe(60);
		expect(holdCacheWriteRate(legacy, true)).toBe(60);
	});
	it("the same row from the TABLE (no 1-hour tier) holds as before; so does a custom row with no write tier", () => {
		expect(holdInputRate(legacy, true, false)).toBe(37.5);
		expect(holdCacheWriteRate(legacy, false)).toBe(37.5);
		expect(holdInputRate({ inputPer1k: 5, outputPer1k: 5 }, true, true)).toBe(5);
	});
	it("an explicit rate wins on a custom row too", () => {
		expect(holdInputRate({ ...legacy, cacheWrite1hPer1k: 45 }, true, true)).toBe(45);
	});
});
