// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import {
	fromAnthropicUsage,
	fromGeminiUsage,
	fromOpenAICompletionsUsage,
	fromOpenAIResponsesUsage,
	implausibleUsageData,
	MAX_PLAUSIBLE_TOKENS_PER_TIER,
	mergeImplausible,
	type NormalizedUsage,
	sanitizeUsage,
	type UsageTier,
	withImplausible,
} from "../../src/ledger/usage.js";

/**
 * Spec D2 is a table keyed by SOURCE, not by provider, and every row below is
 * one row of that table. The two axes that matter:
 *
 *   - disjoint sources PASS THROUGH (subtracting again undercounts);
 *   - inclusive sources SUBTRACT with a clamp at 0.
 *
 * D5 adds the snapshot rule these functions exist to serve: cost and record
 * emission both derive from ONE sanitized object, so a raw provider value
 * never reaches `costFromRates` or the audit chain.
 */

/** Every NormalizedUsage this module hands out must satisfy these. */
function expectSafeSnapshot(u: NormalizedUsage): void {
	for (const key of [
		"inputTokens",
		"outputTokens",
		"cacheReadTokens",
		"cacheWriteTokens",
	] as const) {
		expect(Number.isFinite(u[key]), `${key} finite`).toBe(true);
		expect(Number.isInteger(u[key]), `${key} integer`).toBe(true);
		expect(u[key], `${key} >= 0`).toBeGreaterThanOrEqual(0);
	}
	expect(["provider", "estimated"]).toContain(u.source);
}

describe("sanitizeUsage", () => {
	it("clamps NaN, Infinity and negatives to 0 and downgrades the provider label", () => {
		// D5: "provider" requires provider-reported input AND output. All four
		// counts here are garbage, so the clamped zeros are fabricated, not
		// reported — labelling them "provider" would publish a usage record
		// claiming a zero-input call. That mislabel dies here (D5), not only
		// inside the extractors.
		const u = sanitizeUsage({
			inputTokens: Number.NaN,
			outputTokens: Number.POSITIVE_INFINITY,
			cacheReadTokens: -5,
			cacheWriteTokens: Number.NEGATIVE_INFINITY,
			source: "provider",
		});
		expect(u).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			source: "estimated",
		});
		expectSafeSnapshot(u);
	});

	it("downgrades a provider label when EITHER input or output is unusable", () => {
		// One half of the pair is enough: a half-provider snapshot is a mislabel.
		expect(
			sanitizeUsage({ inputTokens: Number.NaN, outputTokens: 50, source: "provider" }).source,
		).toBe("estimated");
		expect(
			sanitizeUsage({ inputTokens: 50, outputTokens: undefined, source: "provider" }).source,
		).toBe("estimated");
		expect(sanitizeUsage({ inputTokens: 50, outputTokens: -1, source: "provider" }).source).toBe(
			"estimated",
		);
		expect(
			sanitizeUsage({
				inputTokens: "500" as unknown as number,
				outputTokens: 5,
				source: "provider",
			}).source,
		).toBe("estimated");
	});

	it("keeps the provider label when both input and output are usable, zeros included", () => {
		// An explicit 0 IS data. And absent CACHE fields default to 0 without
		// downgrading — D5 says a provider reporting no cache use reports zero.
		expect(sanitizeUsage({ inputTokens: 0, outputTokens: 0, source: "provider" }).source).toBe(
			"provider",
		);
		expect(
			sanitizeUsage({
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: Number.NaN,
				source: "provider",
			}).source,
		).toBe("provider");
	});

	it("rounds fractional counts UP (understatement is the dangerous direction)", () => {
		const u = sanitizeUsage({ inputTokens: 10.2, outputTokens: 0.1, source: "provider" });
		expect(u.inputTokens).toBe(11);
		expect(u.outputTokens).toBe(1);
		expectSafeSnapshot(u);
	});

	it("normalizes a provider-reported -0 to +0 (Object.is discipline)", () => {
		// `-0 < 0` is false and `Math.ceil(-0) === -0`, so a naive guard lets a
		// negative-zero provider count through. `-0 >= 0` is true and `-0` is a
		// "finite integer" by every practical measure, but `Object.is(-0, 0)` is
		// false — the "finite ints >= 0" invariant is meant in that stricter
		// sense, and `-0` residue in a snapshot would (harmlessly, but
		// incorrectly) survive `JSON.stringify` only by accident. A real
		// provider payload reaches this shape through JSON decoding, not a
		// hand-written literal, so round-trip the value through JSON.parse.
		const raw = {
			inputTokens: JSON.parse("-0"),
			outputTokens: 5,
			cacheReadTokens: JSON.parse("-0"),
			cacheWriteTokens: JSON.parse("-0"),
			source: "provider" as const,
		};
		const u = sanitizeUsage(raw);
		expect(Object.is(u.inputTokens, 0)).toBe(true);
		expect(Object.is(u.cacheReadTokens, 0)).toBe(true);
		expect(Object.is(u.cacheWriteTokens, 0)).toBe(true);
		expectSafeSnapshot(u);
	});

	it("defaults every absent field to 0 and an absent source to estimated", () => {
		expect(sanitizeUsage({})).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			source: "estimated",
		});
		expect(sanitizeUsage(null).source).toBe("estimated");
		expect(sanitizeUsage(undefined).source).toBe("estimated");
	});

	it("ignores non-numeric junk (strings that look like numbers included)", () => {
		const u = sanitizeUsage({
			inputTokens: "500" as unknown as number,
			outputTokens: {} as unknown as number,
		});
		expect(u.inputTokens).toBe(0);
		expect(u.outputTokens).toBe(0);
	});
});

describe("D2 row: Anthropic SDK (core direct) — disjoint, pass through", () => {
	it("passes the three input counters through WITHOUT subtracting", () => {
		// Anthropic's three input counters are disjoint (SDK messages.ts:1139):
		// input_tokens is already fresh-only. Subtracting here would undercount.
		const u = fromAnthropicUsage({
			input_tokens: 100,
			output_tokens: 50,
			cache_read_input_tokens: 900,
			cache_creation_input_tokens: 200,
		});
		expect(u).toEqual({
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 900,
			cacheWriteTokens: 200,
			source: "provider",
		});
		expectSafeSnapshot(u);
	});

	it("sums the nested cache_creation TTL breakdown into cacheWriteTokens", () => {
		const u = fromAnthropicUsage({
			input_tokens: 10,
			output_tokens: 5,
			cache_creation: {
				ephemeral_5m_input_tokens: 120,
				ephemeral_1h_input_tokens: 80,
			},
		});
		expect(u.cacheWriteTokens).toBe(200);
	});

	it("prefers the nested breakdown over the flat field when both are present", () => {
		const u = fromAnthropicUsage({
			input_tokens: 10,
			output_tokens: 5,
			cache_creation_input_tokens: 999,
			cache_creation: { ephemeral_5m_input_tokens: 120, ephemeral_1h_input_tokens: 80 },
		});
		expect(u.cacheWriteTokens).toBe(200);
	});

	it("sums a partial breakdown that reports only one TTL", () => {
		expect(
			fromAnthropicUsage({
				input_tokens: 10,
				output_tokens: 5,
				cache_creation: { ephemeral_1h_input_tokens: 80 },
			}).cacheWriteTokens,
		).toBe(80);
		expect(
			fromAnthropicUsage({
				input_tokens: 10,
				output_tokens: 5,
				cache_creation: { ephemeral_5m_input_tokens: 120 },
			}).cacheWriteTokens,
		).toBe(120);
	});

	it("uses the flat field when the nested breakdown is absent or carries no counts", () => {
		expect(
			fromAnthropicUsage({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 64 })
				.cacheWriteTokens,
		).toBe(64);
		expect(
			fromAnthropicUsage({
				input_tokens: 1,
				output_tokens: 1,
				cache_creation_input_tokens: 64,
				cache_creation: {},
			}).cacheWriteTokens,
		).toBe(64);
	});

	it("marks explicit zeros as provider-reported (a zero IS data, not absence)", () => {
		const u = fromAnthropicUsage({ input_tokens: 0, output_tokens: 0 });
		expect(u.source).toBe("provider");
		expect(u.cacheReadTokens).toBe(0);
	});

	it("reports estimated when input or output is missing or unusable", () => {
		expect(fromAnthropicUsage({ output_tokens: 5 }).source).toBe("estimated");
		expect(fromAnthropicUsage({ input_tokens: 5 }).source).toBe("estimated");
		expect(fromAnthropicUsage({ input_tokens: Number.NaN, output_tokens: 5 }).source).toBe(
			"estimated",
		);
		expect(fromAnthropicUsage(null).source).toBe("estimated");
	});
});

describe("D2 row: OpenAI completions (core direct) — prompt_tokens is INCLUSIVE", () => {
	it("subtracts cached read and cache write from prompt_tokens", () => {
		const u = fromOpenAICompletionsUsage({
			prompt_tokens: 1000,
			completion_tokens: 40,
			prompt_tokens_details: { cached_tokens: 600 },
			cache_write_tokens: 100,
		});
		expect(u).toEqual({
			inputTokens: 300,
			outputTokens: 40,
			cacheReadTokens: 600,
			cacheWriteTokens: 100,
			source: "provider",
		});
		expectSafeSnapshot(u);
	});

	it("clamps the subtraction at 0 when the cached counters exceed prompt_tokens", () => {
		const u = fromOpenAICompletionsUsage({
			prompt_tokens: 1000,
			completion_tokens: 10,
			prompt_tokens_details: { cached_tokens: 1200 },
		});
		expect(u.inputTokens).toBe(0);
		expect(u.cacheReadTokens).toBe(1200);
		expectSafeSnapshot(u);
	});

	it("leaves input untouched when no cache counters are reported", () => {
		const u = fromOpenAICompletionsUsage({ prompt_tokens: 1000, completion_tokens: 40 });
		expect(u.inputTokens).toBe(1000);
		expect(u.cacheReadTokens).toBe(0);
		expect(u.cacheWriteTokens).toBe(0);
	});

	it("reports estimated when prompt_tokens or completion_tokens is absent", () => {
		expect(fromOpenAICompletionsUsage({ completion_tokens: 5 }).source).toBe("estimated");
		expect(fromOpenAICompletionsUsage({ prompt_tokens: 5 }).source).toBe("estimated");
	});
});

/**
 * Codex PR-85 [P2-5], investigated and REFUTED — pinned here so the question
 * does not get re-opened from first principles.
 *
 * The claim was that OpenRouter's `cached_tokens` is INCLUSIVE of
 * `cache_write_tokens`, so subtracting both double-counts the writes and
 * overstates the (cheap) read tier at the expense of the (expensive) fresh
 * tier. Three pieces of evidence say the counters are disjoint subsets of
 * `prompt_tokens`, which is exactly what `disjointInput` already assumes:
 *
 *  1. OpenRouter's usage-accounting example: `prompt_tokens: 194`,
 *     `cached_tokens: 0`, `cache_write_tokens: 100`, `completion_tokens: 2`,
 *     `total_tokens: 196`. `total = prompt + completion`, and the 100 written
 *     tokens are not added on top — so writes live INSIDE `prompt_tokens`.
 *  2. OpenRouter's prompt-caching guide: `prompt_tokens: 10_339`,
 *     `cached_tokens: 10_318`, `cache_write_tokens: 0`, described as "most of
 *     the prompt tokens came from cache" — reads live inside `prompt_tokens`
 *     too, and `prompt_tokens >= cached_tokens` throughout.
 *  3. Both OpenRouter and OpenAI define the pair as tokens "read from" vs
 *     "written to" the cache in the SAME request — different tokens, and they
 *     map from Anthropic's `cache_read_input_tokens` /
 *     `cache_creation_input_tokens`, which this codebase already relies on
 *     being disjoint for the Anthropic pass-through row.
 *
 * There is also no way to implement the proposed fix narrowly: OpenRouter and
 * native OpenAI gpt-5.6+ emit the SAME JSON shape
 * (`prompt_tokens_details.{cached_tokens, cache_write_tokens}`), so any
 * "both fields present" rule would silently reprice plain OpenAI traffic too —
 * which the finding itself says must not change.
 */
describe("both-cache-counter payloads: reads and writes are DISJOINT (Codex PR-85 P2-5)", () => {
	const cases: Array<{
		name: string;
		usage: Record<string, unknown>;
		expected: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
	}> = [
		{
			name: "OpenRouter usage-accounting example (write-only turn)",
			usage: {
				prompt_tokens: 194,
				completion_tokens: 2,
				prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 100, audio_tokens: 0 },
			},
			expected: { inputTokens: 94, cacheReadTokens: 0, cacheWriteTokens: 100 },
		},
		{
			name: "OpenRouter prompt-caching guide example (read-heavy turn)",
			usage: {
				prompt_tokens: 10_339,
				completion_tokens: 120,
				prompt_tokens_details: { cached_tokens: 10_318, cache_write_tokens: 0 },
			},
			expected: { inputTokens: 21, cacheReadTokens: 10_318, cacheWriteTokens: 0 },
		},
		{
			name: "OpenRouter both counters non-zero (read prefix + freshly written suffix)",
			usage: {
				prompt_tokens: 1000,
				completion_tokens: 40,
				prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
			},
			// NOT 600/300/100: nothing is removed from the read count.
			expected: { inputTokens: 500, cacheReadTokens: 400, cacheWriteTokens: 100 },
		},
		{
			name: "native OpenAI gpt-5.6 shape — identical JSON, and must price identically",
			usage: {
				prompt_tokens: 1000,
				completion_tokens: 40,
				prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
			},
			expected: { inputTokens: 500, cacheReadTokens: 400, cacheWriteTokens: 100 },
		},
		{
			name: "top-level cache_write_tokens (proxy variant) reads the same way",
			usage: {
				prompt_tokens: 1000,
				completion_tokens: 40,
				prompt_tokens_details: { cached_tokens: 400 },
				cache_write_tokens: 100,
			},
			expected: { inputTokens: 500, cacheReadTokens: 400, cacheWriteTokens: 100 },
		},
	];

	for (const { name, usage, expected } of cases) {
		it(name, () => {
			const u = fromOpenAICompletionsUsage(usage);
			expect(u.inputTokens).toBe(expected.inputTokens);
			expect(u.cacheReadTokens).toBe(expected.cacheReadTokens);
			expect(u.cacheWriteTokens).toBe(expected.cacheWriteTokens);
			expect(u.source).toBe("provider");
			expectSafeSnapshot(u);
		});
	}

	it("keeps the four tiers summing to the provider's own total_tokens", () => {
		// The disjointness claim, stated as arithmetic: if reads and writes are
		// disjoint subsets of prompt_tokens, the four tiers reconstruct the
		// provider's total exactly. Under the proposed "reads include writes"
		// reading they would overshoot it by cache_write_tokens.
		const u = fromOpenAICompletionsUsage({
			prompt_tokens: 194,
			completion_tokens: 2,
			total_tokens: 196,
			prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 100 },
		});
		expect(u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens).toBe(196);
	});
});

describe("D2 row: OpenAI Responses (core direct) — input_tokens_details subtraction", () => {
	it("subtracts input_tokens_details.cached_tokens from input_tokens", () => {
		const u = fromOpenAIResponsesUsage({
			input_tokens: 1000,
			output_tokens: 120,
			input_tokens_details: { cached_tokens: 800 },
		});
		expect(u).toEqual({
			inputTokens: 200,
			outputTokens: 120,
			cacheReadTokens: 800,
			cacheWriteTokens: 0,
			source: "provider",
		});
		expectSafeSnapshot(u);
	});

	it("clamps at 0 when cached_tokens exceeds input_tokens", () => {
		const u = fromOpenAIResponsesUsage({
			input_tokens: 100,
			output_tokens: 10,
			input_tokens_details: { cached_tokens: 500 },
		});
		expect(u.inputTokens).toBe(0);
		expect(u.cacheReadTokens).toBe(500);
	});

	it("does NOT double-count reasoning tokens (output_tokens already includes them)", () => {
		const u = fromOpenAIResponsesUsage({
			input_tokens: 10,
			output_tokens: 120,
			output_tokens_details: { reasoning_tokens: 100 },
		});
		expect(u.outputTokens).toBe(120);
	});

	it("reports estimated when input_tokens or output_tokens is absent", () => {
		expect(fromOpenAIResponsesUsage({ output_tokens: 5 }).source).toBe("estimated");
		expect(fromOpenAIResponsesUsage({ input_tokens: 5 }).source).toBe("estimated");
	});
});

describe("D2 row: Gemini (core direct) — inclusive prompt, thinking billed as output", () => {
	it("subtracts cachedContentTokenCount and adds thoughtsTokenCount to output", () => {
		const u = fromGeminiUsage({
			promptTokenCount: 1000,
			candidatesTokenCount: 50,
			cachedContentTokenCount: 400,
			thoughtsTokenCount: 30,
		});
		expect(u).toEqual({
			inputTokens: 600,
			outputTokens: 80,
			cacheReadTokens: 400,
			cacheWriteTokens: 0,
			source: "provider",
		});
		expectSafeSnapshot(u);
	});

	it("clamps at 0 when cachedContentTokenCount exceeds promptTokenCount", () => {
		const u = fromGeminiUsage({
			promptTokenCount: 100,
			candidatesTokenCount: 10,
			cachedContentTokenCount: 900,
		});
		expect(u.inputTokens).toBe(0);
		expect(u.cacheReadTokens).toBe(900);
	});

	it("counts a thinking-only response as provider-reported output", () => {
		const u = fromGeminiUsage({ promptTokenCount: 20, thoughtsTokenCount: 77 });
		expect(u.outputTokens).toBe(77);
		expect(u.source).toBe("provider");
	});

	it("reports estimated when the prompt or output counters are absent", () => {
		expect(fromGeminiUsage({ candidatesTokenCount: 5 }).source).toBe("estimated");
		expect(fromGeminiUsage({ promptTokenCount: 5 }).source).toBe("estimated");
	});

	// Codex PR-85 [P1-3]. @google/genai 1.52.0 documents
	// GenerateContentResponseUsageMetadata.totalTokenCount as "the sum of
	// prompt_token_count, candidates_token_count, tool_use_prompt_token_count, and
	// thoughts_token_count" — so toolUsePromptTokenCount is a SEPARATE summand, not
	// part of promptTokenCount, and its own doc calls it "the number of tokens in
	// the results from tool executions, which are provided back to the model as
	// input". Dropping it understates every tools-using Gemini call, which is the
	// one direction the money invariant forbids.
	it("adds toolUsePromptTokenCount into fresh input (it is billable input, separate from promptTokenCount)", () => {
		const u = fromGeminiUsage({
			promptTokenCount: 1000,
			candidatesTokenCount: 50,
			cachedContentTokenCount: 400,
			thoughtsTokenCount: 30,
			toolUsePromptTokenCount: 250,
		});
		expect(u).toEqual({
			inputTokens: 850, // (1000 - 400 cached) + 250 tool-use
			outputTokens: 80,
			cacheReadTokens: 400,
			cacheWriteTokens: 0,
			source: "provider",
		});
		expectSafeSnapshot(u);
	});

	it("keeps toolUsePromptTokenCount OUT of the cache subtraction (only the prompt is inclusive)", () => {
		// The clamp applies to promptTokenCount alone. Tool-use input is disjoint
		// from the cached prompt, so an over-large cachedContentTokenCount must not
		// eat it: 0 fresh prompt + 250 tool-use = 250, not 0.
		const u = fromGeminiUsage({
			promptTokenCount: 100,
			candidatesTokenCount: 10,
			cachedContentTokenCount: 900,
			toolUsePromptTokenCount: 250,
		});
		expect(u.inputTokens).toBe(250);
		expect(u.cacheReadTokens).toBe(900);
		expectSafeSnapshot(u);
	});

	it("refuses a garbage toolUsePromptTokenCount instead of reading it as absent; null stays absent", () => {
		// canonicalize() throws on non-finite, so a NaN reaching the snapshot would
		// fail the audit write for the whole settle (D5). Read as absent, a present
		// garbage figure would price its tier at 0 under a "provider" label, an
		// undercharge: it is refused, and the call settles at the estimate.
		const absent = fromGeminiUsage({
			promptTokenCount: 100,
			candidatesTokenCount: 10,
			toolUsePromptTokenCount: null,
		});
		expect(absent.inputTokens).toBe(100);
		expect(absent.source).toBe("provider");
		expect(absent.implausible).toBeUndefined();
		expectSafeSnapshot(absent);
		for (const [junk, figure] of [
			[Number.NaN, 1],
			[Number.POSITIVE_INFINITY, Number.MAX_VALUE],
			[-500, 1],
			["300", 1],
		] as const) {
			const u = fromGeminiUsage({
				promptTokenCount: 100,
				candidatesTokenCount: 10,
				toolUsePromptTokenCount: junk,
			});
			expect(u.source, String(junk)).toBe("estimated");
			expect(u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens).toBe(0);
			expect(u.implausible, String(junk)).toEqual({ inputTokens: figure });
			expect(u.implausibleBy, String(junk)).toEqual({ inputTokens: "refused" });
			expect(
				(JSON.parse(JSON.stringify(u)) as NormalizedUsage).implausible?.inputTokens,
				String(junk),
			).toBe(figure);
			expectSafeSnapshot(u);
		}
	});

	it("reconciles with the SDK's documented totalTokenCount identity", () => {
		// totalTokenCount = prompt + candidates + toolUsePrompt + thoughts. Our four
		// disjoint tiers must sum to the same number, or a tier is missing.
		const metadata = {
			promptTokenCount: 1000,
			candidatesTokenCount: 50,
			cachedContentTokenCount: 400,
			thoughtsTokenCount: 30,
			toolUsePromptTokenCount: 250,
			totalTokenCount: 1330,
		};
		const u = fromGeminiUsage(metadata);
		expect(u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens).toBe(
			metadata.totalTokenCount,
		);
	});
});

describe("each usage component is held to the ceiling BEFORE it is summed", () => {
	// The extractors add components into one tier (Gemini: prompt + tool-use prompt into input,
	// candidates + thoughts into output; Anthropic: the two cache-write TTLs into the write total).
	// Summed first, two finite components can pass the safe-integer range, or reach Infinity, before
	// any check sees them; and an absurd component is reported only inside a sum.

	it("Gemini: two components whose sum is Infinity are refused, not read as a missing count", () => {
		const u = fromGeminiUsage({
			promptTokenCount: 10,
			candidatesTokenCount: 1e308,
			thoughtsTokenCount: 1e308,
		});
		expect(u.source).toBe("estimated");
		expect(u.implausible?.outputTokens).toBe(1e308);
		expect(u.implausibleBy?.outputTokens).toBe("refused");
		expect(u.outputTokens).toBe(0);
		expectSafeSnapshot(u);
	});

	it("Gemini: components whose sum passes MAX_SAFE_INTEGER are refused by their own figures", () => {
		const u = fromGeminiUsage({
			promptTokenCount: 5e15,
			toolUsePromptTokenCount: 5e15,
			candidatesTokenCount: 10,
		});
		expect(u.source).toBe("estimated");
		expect(u.implausible?.inputTokens).toBe(5e15);
		expect(Number.isSafeInteger(u.implausible?.inputTokens)).toBe(true);
		expect(u.implausibleBy?.inputTokens).toBe("refused");
		expectSafeSnapshot(u);
	});

	it("Gemini: components each under the ceiling whose sum is over it are flagged as a sum", () => {
		const u = fromGeminiUsage({
			promptTokenCount: 10,
			candidatesTokenCount: 60_000_000,
			thoughtsTokenCount: 60_000_000,
		});
		expect(u.source).toBe("estimated");
		expect(u.implausible?.outputTokens).toBe(120_000_000);
		// No `implausibleBy` entry is the aggregate ("sum") check, as implausibleUsageData reads it.
		expect(u.implausibleBy?.outputTokens).toBeUndefined();
		expectSafeSnapshot(u);
	});

	it("Gemini: one component over the ceiling, beside small ones, is flagged on that component", () => {
		const u = fromGeminiUsage({
			promptTokenCount: 10,
			candidatesTokenCount: 10,
			thoughtsTokenCount: 200_000_000,
		});
		expect(u.implausible).toEqual({ outputTokens: 200_000_000 });
		expect(u.implausibleBy).toEqual({ outputTokens: "refused" });
		expectSafeSnapshot(u);
	});

	it("Gemini: an over-ceiling prompt is refused even when the cache leaves fresh input under it", () => {
		const u = fromGeminiUsage({
			promptTokenCount: 150_000_000,
			cachedContentTokenCount: 100_000_000,
			candidatesTokenCount: 10,
		});
		expect(u.source).toBe("estimated");
		expect(u.implausible?.inputTokens).toBe(150_000_000);
		expect(u.implausibleBy?.inputTokens).toBe("refused");
	});

	it("Gemini: a normal usage is unchanged", () => {
		expect(
			fromGeminiUsage({
				promptTokenCount: 1000,
				candidatesTokenCount: 50,
				cachedContentTokenCount: 400,
				thoughtsTokenCount: 30,
				toolUsePromptTokenCount: 7,
			}),
		).toEqual({
			inputTokens: 607,
			outputTokens: 80,
			cacheReadTokens: 400,
			cacheWriteTokens: 0,
			source: "provider",
		});
	});

	it("Anthropic: two cache-write TTLs whose sum is Infinity are refused, not dropped to 0", () => {
		const u = fromAnthropicUsage({
			input_tokens: 10,
			output_tokens: 10,
			cache_creation: { ephemeral_5m_input_tokens: 1e308, ephemeral_1h_input_tokens: 1e308 },
		});
		expect(u.source).toBe("estimated");
		expect(u.implausible?.cacheWriteTokens).toBe(1e308);
		expect(u.implausibleBy?.cacheWriteTokens).toBe("refused");
		// The 1-hour share is reported as its own tier too, as the stream paths expect.
		expect(u.implausible?.cacheWrite1hTokens).toBe(1e308);
		expectSafeSnapshot(u);
	});

	it("Anthropic: a normal breakdown is unchanged", () => {
		expect(
			fromAnthropicUsage({
				input_tokens: 10,
				output_tokens: 20,
				cache_read_input_tokens: 5,
				cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 },
			}),
		).toEqual({
			inputTokens: 10,
			outputTokens: 20,
			cacheReadTokens: 5,
			cacheWriteTokens: 7,
			cacheWrite1hTokens: 4,
			source: "provider",
		});
	});
});

describe("an infinite usage component is refused, not read as absent", () => {
	// JSON.parse reads a numeric literal past the double range (`1e400`) as Infinity. Read as "the
	// provider told us nothing", an absurd figure would drop out of a sum (an undercharge) or zero a
	// tier, still labelled "provider". It is refused like any figure above the ceiling, recorded under
	// the finite stand-in Number.MAX_VALUE because the raw figure is not representable.

	/** The provider payload as the wire delivers it: the Infinity comes from JSON, not from the test. */
	const wire = (json: string): unknown => JSON.parse(json);

	it("Anthropic: an infinite 1-hour TTL beside a small 5-minute one refuses the write and the 1-hour share", () => {
		const u = fromAnthropicUsage(
			wire(
				'{"input_tokens":10,"output_tokens":10,"cache_creation":{"ephemeral_5m_input_tokens":5,"ephemeral_1h_input_tokens":1e400}}',
			),
		);
		expect(u.source).toBe("estimated");
		expect(u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens).toBe(0);
		expect(u.cacheWrite1hTokens).toBeUndefined();
		expect(u.implausible?.cacheWriteTokens).toBe(Number.MAX_VALUE);
		expect(u.implausible?.cacheWrite1hTokens).toBe(Number.MAX_VALUE);
		expect(u.implausibleBy?.cacheWriteTokens).toBe("refused");
		expect(u.implausibleBy?.cacheWrite1hTokens).toBe("refused");
		expectSafeSnapshot(u);
		expect(() => canonicalize(u)).not.toThrow();
	});

	it("Anthropic: an infinite flat cache_creation_input_tokens is refused as the write tier", () => {
		const u = fromAnthropicUsage(
			wire('{"input_tokens":10,"output_tokens":10,"cache_creation_input_tokens":1e400}'),
		);
		expect(u.source).toBe("estimated");
		expect(u.implausible).toEqual({ cacheWriteTokens: Number.MAX_VALUE });
		expect(u.implausibleBy).toEqual({ cacheWriteTokens: "refused" });
		expectSafeSnapshot(u);
	});

	it("Anthropic: an infinite cache_read_input_tokens is refused as the read tier", () => {
		const u = fromAnthropicUsage(
			wire('{"input_tokens":10,"output_tokens":10,"cache_read_input_tokens":1e400}'),
		);
		expect(u.source).toBe("estimated");
		expect(u.implausible).toEqual({ cacheReadTokens: Number.MAX_VALUE });
		expect(u.implausibleBy).toEqual({ cacheReadTokens: "refused" });
		expectSafeSnapshot(u);
	});

	it("Anthropic: an infinite input_tokens is refused and recorded, not only estimated", () => {
		const u = fromAnthropicUsage(wire('{"input_tokens":1e400,"output_tokens":10}'));
		expect(u.source).toBe("estimated");
		expect(u.implausible).toEqual({ inputTokens: Number.MAX_VALUE });
		expect(u.implausibleBy).toEqual({ inputTokens: "refused" });
		expectSafeSnapshot(u);
	});

	it("Gemini: an infinite candidatesTokenCount beside a small thoughtsTokenCount is refused as output", () => {
		const u = fromGeminiUsage(
			wire('{"promptTokenCount":10,"candidatesTokenCount":1e400,"thoughtsTokenCount":5}'),
		);
		expect(u.source).toBe("estimated");
		expect(u.outputTokens).toBe(0);
		expect(u.implausible).toEqual({ outputTokens: Number.MAX_VALUE });
		expect(u.implausibleBy).toEqual({ outputTokens: "refused" });
		expectSafeSnapshot(u);
	});

	it("Gemini: an infinite cachedContentTokenCount is refused as the read tier", () => {
		const u = fromGeminiUsage(
			wire('{"promptTokenCount":10,"candidatesTokenCount":10,"cachedContentTokenCount":1e400}'),
		);
		expect(u.source).toBe("estimated");
		expect(u.implausible).toEqual({ cacheReadTokens: Number.MAX_VALUE });
		expect(u.implausibleBy).toEqual({ cacheReadTokens: "refused" });
		expectSafeSnapshot(u);
	});

	/** A refused tier's record is a finite number in the snapshot AND in the chain event, and survives JSON as one. */
	function expectFiniteRecord(u: NormalizedUsage, tier: UsageTier, label: string): void {
		expect(u.source, label).toBe("estimated");
		expect(u.implausibleBy?.[tier], label).toBe("refused");
		expect(Number.isFinite(u.implausible?.[tier]), label).toBe(true);
		const tiers = implausibleUsageData(u, { model: "m", transferId: "t" })?.tiers as Record<
			string,
			unknown
		>;
		expect(Number.isFinite(tiers[tier]), label).toBe(true);
		const rewritten = JSON.parse(JSON.stringify({ snapshot: u, tiers })) as {
			snapshot: NormalizedUsage;
			tiers: Record<string, unknown>;
		};
		expect(typeof rewritten.snapshot.implausible?.[tier], label).toBe("number");
		expect(typeof rewritten.tiers[tier], label).toBe("number");
		expectSafeSnapshot(u);
		expect(() => canonicalize(u), label).not.toThrow();
	}

	/** Every PRESENT value that is not a finite count >= 0. NaN is not JSON, so it is built directly. */
	const INVALID: Array<[string, unknown]> = [
		["-1e400", wire("-1e400")],
		["NaN", Number.NaN],
		["-1", -1],
		['"1e400"', "1e400"],
		['"100"', "100"],
		["true", true],
		["{}", {}],
	];

	it("Anthropic: every present invalid cache-read value is refused as the read tier, never read as absent", () => {
		for (const [label, value] of INVALID) {
			const u = fromAnthropicUsage({
				input_tokens: 10,
				output_tokens: 10,
				cache_read_input_tokens: value,
			});
			expect(u.implausible, label).toEqual({ cacheReadTokens: 1 });
			expectFiniteRecord(u, "cacheReadTokens", label);
		}
	});

	it("Gemini: every present invalid candidatesTokenCount is refused as output, never read as absent", () => {
		for (const [label, value] of INVALID) {
			const u = fromGeminiUsage({
				promptTokenCount: 10,
				candidatesTokenCount: value,
				thoughtsTokenCount: 5,
			});
			expect(u.implausible, label).toEqual({ outputTokens: 1 });
			expectFiniteRecord(u, "outputTokens", label);
		}
	});

	it("CONTROL: null and a missing field are ABSENT: provider, that tier 0, no record", () => {
		for (const [label, u] of [
			[
				"anthropic null",
				fromAnthropicUsage({ input_tokens: 10, output_tokens: 10, cache_read_input_tokens: null }),
			],
			["anthropic missing", fromAnthropicUsage({ input_tokens: 10, output_tokens: 10 })],
			[
				"gemini null",
				fromGeminiUsage({
					promptTokenCount: 10,
					candidatesTokenCount: null,
					thoughtsTokenCount: 5,
				}),
			],
			["gemini missing", fromGeminiUsage({ promptTokenCount: 10, thoughtsTokenCount: 5 })],
		] as const) {
			expect(u.source, label).toBe("provider");
			expect(u.implausible, label).toBeUndefined();
			expect(u.implausibleBy, label).toBeUndefined();
		}
		expect(
			fromAnthropicUsage({ input_tokens: 10, output_tokens: 10, cache_read_input_tokens: null })
				.cacheReadTokens,
		).toBe(0);
		// The missing candidates count is absent; thoughts alone are the output.
		expect(
			fromGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: null, thoughtsTokenCount: 5 })
				.outputTokens,
		).toBe(5);
	});

	it("CONTROL: a component of exactly the ceiling passes; one token more is refused", () => {
		const at = fromAnthropicUsage({
			input_tokens: 10,
			output_tokens: 10,
			cache_read_input_tokens: MAX_PLAUSIBLE_TOKENS_PER_TIER,
		});
		expect(at.source).toBe("provider");
		expect(at.cacheReadTokens).toBe(MAX_PLAUSIBLE_TOKENS_PER_TIER);
		expect(at.implausible).toBeUndefined();
		const over = fromAnthropicUsage({
			input_tokens: 10,
			output_tokens: 10,
			cache_read_input_tokens: MAX_PLAUSIBLE_TOKENS_PER_TIER + 1,
		});
		expect(over.source).toBe("estimated");
		expect(over.implausible).toEqual({ cacheReadTokens: MAX_PLAUSIBLE_TOKENS_PER_TIER + 1 });
	});

	it("sanitizeUsage: a refused tier is flagged by its PRESENCE, and its record is always finite", () => {
		for (const [label, value] of [
			["Infinity", Number.POSITIVE_INFINITY],
			["NaN", Number.NaN],
			["-5", -5],
			['"x"', "x" as unknown as number],
		] as const) {
			const u = sanitizeUsage(
				{ inputTokens: 10, outputTokens: 10, cacheWriteTokens: 5, source: "provider" },
				{ refused: { cacheWriteTokens: value } },
			);
			expect(u.implausible, label).toEqual({ cacheWriteTokens: Number.MAX_VALUE });
			expectFiniteRecord(u, "cacheWriteTokens", label);
		}
	});

	it("sanitizeUsage: a refused key whose value is undefined is NOT a flag", () => {
		const u = sanitizeUsage(
			{ inputTokens: 10, outputTokens: 10, cacheWriteTokens: 5, source: "provider" },
			{ refused: { cacheWriteTokens: undefined } },
		);
		expect(u.source).toBe("provider");
		expect(u.cacheWriteTokens).toBe(5);
		expect(u.implausible).toBeUndefined();
		expect(u.implausibleBy).toBeUndefined();
	});

	it("sanitizeUsage: a refused key whose value is null is NOT a flag (null is absent, as in a provider field)", () => {
		const u = sanitizeUsage(
			{ inputTokens: 10, outputTokens: 10, source: "provider" },
			{ refused: { inputTokens: null as unknown as number } },
		);
		expect(u.source).toBe("provider");
		expect(u.inputTokens).toBe(10);
		expect(u.implausible).toBeUndefined();
		expect(u.implausibleBy).toBeUndefined();
	});
});

describe("merging implausible readings keeps which check fired first", () => {
	it("the larger figure wins, but each tier keeps the label of the FIRST check that fired for it", () => {
		const first = mergeImplausible(
			undefined,
			undefined,
			{ outputTokens: 1 },
			{ outputTokens: "refused" },
		);
		const second = mergeImplausible(
			first.implausible,
			first.implausibleBy,
			{ outputTokens: 120_000_000, inputTokens: 150_000_000 },
			{ inputTokens: "refused" },
		);
		expect(second.implausible).toEqual({ outputTokens: 120_000_000, inputTokens: 150_000_000 });
		expect(second.implausibleBy).toEqual({ outputTokens: "refused", inputTokens: "refused" });
		// A tier first seen UNLABELLED (a sum) stays a sum when a later reading labels it.
		const sum = mergeImplausible(undefined, undefined, { outputTokens: 120_000_000 }, undefined);
		const later = mergeImplausible(
			sum.implausible,
			sum.implausibleBy,
			{ outputTokens: 1 },
			{
				outputTokens: "refused",
			},
		);
		expect(later.implausibleBy?.outputTokens).toBeUndefined();
	});

	it("withImplausible carries the labels of the readings it merges", () => {
		const settled = withImplausible(
			sanitizeUsage({ inputTokens: 10, outputTokens: 10, source: "provider" }),
			{ outputTokens: 1 },
			{ outputTokens: "refused" },
		);
		expect(settled.source).toBe("estimated");
		expect(implausibleUsageData(settled, { model: "m", transferId: "t" })?.checks).toEqual({
			outputTokens: "refused",
		});
	});
});

describe("D5: provider garbage never escapes the snapshot", () => {
	// `canonicalize` THROWS on NaN and Infinity ("canonicalize: NaN is not
	// allowed in audit data" / "...Infinity..."), so a raw provider count that
	// reached the audit chain would fail the settle write outright. The
	// snapshot is what makes recording safe: every extractor below feeds
	// garbage in and hands back finite ints.
	it("canonicalize would reject a raw non-finite count (why the snapshot exists)", () => {
		expect(() => canonicalize({ inputTokens: Number.NaN })).toThrow(/NaN/);
		expect(() => canonicalize({ inputTokens: Number.POSITIVE_INFINITY })).toThrow(/Infinity/);
	});

	it("every extractor sanitizes NaN / Infinity / negative garbage", () => {
		const garbage = {
			input_tokens: Number.NaN,
			output_tokens: Number.POSITIVE_INFINITY,
			cache_read_input_tokens: -900,
			cache_creation_input_tokens: Number.NaN,
			prompt_tokens: Number.NEGATIVE_INFINITY,
			completion_tokens: Number.NaN,
			prompt_tokens_details: { cached_tokens: Number.NaN },
			input_tokens_details: { cached_tokens: Number.POSITIVE_INFINITY },
			promptTokenCount: Number.NaN,
			candidatesTokenCount: -1,
			cachedContentTokenCount: Number.POSITIVE_INFINITY,
			thoughtsTokenCount: Number.NaN,
		};
		for (const snapshot of [
			fromAnthropicUsage(garbage),
			fromOpenAICompletionsUsage(garbage),
			fromOpenAIResponsesUsage(garbage),
			fromGeminiUsage(garbage),
		]) {
			expectSafeSnapshot(snapshot);
			expect(snapshot.source).toBe("estimated");
			expect(() => canonicalize(snapshot)).not.toThrow();
		}
	});

	it("survives non-object input from every extractor", () => {
		for (const snapshot of [
			fromAnthropicUsage(undefined),
			fromOpenAICompletionsUsage("nope"),
			fromOpenAIResponsesUsage(42),
			fromGeminiUsage(null),
		]) {
			expectSafeSnapshot(snapshot);
			expect(snapshot).toEqual({
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				source: "estimated",
			});
		}
	});
});

describe("the OpenAI raw prompt is held to the ceiling before the tiers are derived from it", () => {
	// Both OpenAI shapes report an INCLUSIVE prompt and subtract the cache tiers out of it. Checked
	// only through the derived tiers, an absurd prompt can hide behind a large cache: 150M prompt
	// tokens with 100M cached leaves 50M of fresh input, and every derived tier passes.

	it("completions: a 150M prompt with 100M cached is refused as input, not priced", () => {
		const u = fromOpenAICompletionsUsage({
			prompt_tokens: 150_000_000,
			completion_tokens: 10,
			prompt_tokens_details: { cached_tokens: 100_000_000 },
		});
		expect(u.source).toBe("estimated");
		expect(u.implausible?.inputTokens).toBe(150_000_000);
		expect(u.implausibleBy?.inputTokens).toBe("refused");
		expect(u.inputTokens).toBe(0);
		expectSafeSnapshot(u);
	});

	it("responses: a 150M input with 100M cached is refused as input, not priced", () => {
		const u = fromOpenAIResponsesUsage({
			input_tokens: 150_000_000,
			output_tokens: 10,
			input_tokens_details: { cached_tokens: 100_000_000 },
		});
		expect(u.source).toBe("estimated");
		expect(u.implausible?.inputTokens).toBe(150_000_000);
		expect(u.implausibleBy?.inputTokens).toBe("refused");
		expectSafeSnapshot(u);
	});

	it("a cache component over the ceiling is refused by its own figure", () => {
		const completions = fromOpenAICompletionsUsage({
			prompt_tokens: 10,
			completion_tokens: 10,
			cache_write_tokens: 200_000_000,
		});
		expect(completions.source).toBe("estimated");
		expect(completions.implausible?.cacheWriteTokens).toBe(200_000_000);
		expect(completions.implausibleBy?.cacheWriteTokens).toBe("refused");
		const responses = fromOpenAIResponsesUsage({
			input_tokens: 10,
			output_tokens: 10,
			input_tokens_details: { cached_tokens: 200_000_000 },
		});
		expect(responses.source).toBe("estimated");
		expect(responses.implausible?.cacheReadTokens).toBe(200_000_000);
		expect(responses.implausibleBy?.cacheReadTokens).toBe("refused");
	});

	it("a normal OpenAI usage is unchanged", () => {
		expect(
			fromOpenAICompletionsUsage({
				prompt_tokens: 1000,
				completion_tokens: 50,
				prompt_tokens_details: { cached_tokens: 400 },
			}),
		).toEqual({
			inputTokens: 600,
			outputTokens: 50,
			cacheReadTokens: 400,
			cacheWriteTokens: 0,
			source: "provider",
		});
		expect(
			fromOpenAIResponsesUsage({
				input_tokens: 1000,
				output_tokens: 50,
				input_tokens_details: { cached_tokens: 400, cache_creation_tokens: 100 },
			}),
		).toEqual({
			inputTokens: 500,
			outputTokens: 50,
			cacheReadTokens: 400,
			cacheWriteTokens: 100,
			source: "provider",
		});
	});
});

describe("every OpenAI tier figure is read raw: a present invalid value is refused, never read as absent", () => {
	// Read through readCount first, a present invalid figure became "the provider told us nothing": a cache
	// figure dropped out of the subtraction or its tier, priced at 0 under a "provider" label, an undercharge.

	type Extract = (value: unknown) => NormalizedUsage;
	const SITES: Array<[string, Extract, UsageTier]> = [
		[
			"completions prompt_tokens",
			(v) => fromOpenAICompletionsUsage({ prompt_tokens: v, completion_tokens: 10 }),
			"inputTokens",
		],
		[
			"completions completion_tokens",
			(v) => fromOpenAICompletionsUsage({ prompt_tokens: 10, completion_tokens: v }),
			"outputTokens",
		],
		[
			"completions prompt_tokens_details.cached_tokens",
			(v) =>
				fromOpenAICompletionsUsage({
					prompt_tokens: 100,
					completion_tokens: 10,
					prompt_tokens_details: { cached_tokens: v },
				}),
			"cacheReadTokens",
		],
		[
			"completions cache_write_tokens",
			(v) =>
				fromOpenAICompletionsUsage({
					prompt_tokens: 100,
					completion_tokens: 10,
					cache_write_tokens: v,
				}),
			"cacheWriteTokens",
		],
		[
			"completions prompt_tokens_details.cache_write_tokens",
			(v) =>
				fromOpenAICompletionsUsage({
					prompt_tokens: 100,
					completion_tokens: 10,
					prompt_tokens_details: { cache_write_tokens: v },
				}),
			"cacheWriteTokens",
		],
		[
			"responses input_tokens",
			(v) => fromOpenAIResponsesUsage({ input_tokens: v, output_tokens: 10 }),
			"inputTokens",
		],
		[
			"responses output_tokens",
			(v) => fromOpenAIResponsesUsage({ input_tokens: 10, output_tokens: v }),
			"outputTokens",
		],
		[
			"responses input_tokens_details.cached_tokens",
			(v) =>
				fromOpenAIResponsesUsage({
					input_tokens: 100,
					output_tokens: 10,
					input_tokens_details: { cached_tokens: v },
				}),
			"cacheReadTokens",
		],
		[
			"responses input_tokens_details.cache_creation_tokens",
			(v) =>
				fromOpenAIResponsesUsage({
					input_tokens: 100,
					output_tokens: 10,
					input_tokens_details: { cache_creation_tokens: v },
				}),
			"cacheWriteTokens",
		],
		[
			"responses input_tokens_details.cache_write_tokens",
			(v) =>
				fromOpenAIResponsesUsage({
					input_tokens: 100,
					output_tokens: 10,
					input_tokens_details: { cache_write_tokens: v },
				}),
			"cacheWriteTokens",
		],
	];

	/** Each present invalid value and the finite figure its refusal records. 1e400 comes from JSON, as on the wire. */
	const INVALID: Array<[string, unknown, number]> = [
		["1e400", JSON.parse("1e400"), Number.MAX_VALUE],
		["-1", -1, 1],
		["NaN", Number.NaN, 1],
		['"100"', "100", 1],
		["{}", {}, 1],
	];

	it.each(SITES)(
		"%s: each present invalid value is refused under its tier, at a finite figure",
		(site, extract, tier) => {
			for (const [label, value, figure] of INVALID) {
				const at = `${site} = ${label}`;
				const u = extract(value);
				expect(u.source, at).toBe("estimated");
				expect(u.implausible, at).toEqual({ [tier]: figure });
				expect(u.implausibleBy, at).toEqual({ [tier]: "refused" });
				const tiers = implausibleUsageData(u, { model: "m", transferId: "t" })?.tiers as Record<
					string,
					unknown
				>;
				expect(JSON.parse(JSON.stringify(tiers)), at).toEqual({ [tier]: figure });
				expectSafeSnapshot(u);
			}
		},
	);

	it("CONTROL: a null or missing cache figure is ABSENT: provider, that tier 0, no record", () => {
		for (const [site, extract, tier] of SITES) {
			if (tier === "inputTokens" || tier === "outputTokens") continue; // a missing headline count is estimated
			for (const value of [null, undefined]) {
				const u = extract(value);
				expect(u.source, `${site} = ${value}`).toBe("provider");
				expect(u[tier as "cacheReadTokens"], `${site} = ${value}`).toBe(0);
				expect(u.implausible, `${site} = ${value}`).toBeUndefined();
			}
		}
	});
});

describe("one ceiling rule across the inclusive-prompt providers", () => {
	// Gemini, chat.completions and Responses all report an INCLUSIVE prompt and subtract the cache from it, so the
	// same figures must be refused (or pass) identically in each shape.
	const SHAPES: Array<[string, (prompt: number, cached: number) => NormalizedUsage]> = [
		[
			"gemini",
			(p, c) =>
				fromGeminiUsage({
					promptTokenCount: p,
					candidatesTokenCount: 10,
					cachedContentTokenCount: c,
				}),
		],
		[
			"completions",
			(p, c) =>
				fromOpenAICompletionsUsage({
					prompt_tokens: p,
					completion_tokens: 10,
					prompt_tokens_details: { cached_tokens: c },
				}),
		],
		[
			"responses",
			(p, c) =>
				fromOpenAIResponsesUsage({
					input_tokens: p,
					output_tokens: 10,
					input_tokens_details: { cached_tokens: c },
				}),
		],
	];

	it("a 150M prompt with 100M cached is refused as input, by its own figure, in every shape", () => {
		for (const [shape, extract] of SHAPES) {
			const u = extract(150_000_000, 100_000_000);
			expect(u.source, shape).toBe("estimated");
			expect(u.implausible, shape).toEqual({ inputTokens: 150_000_000 });
			expect(u.implausibleBy, shape).toEqual({ inputTokens: "refused" });
		}
	});

	it("a 200M cache figure is refused under the cache tier in every shape", () => {
		for (const [shape, extract] of SHAPES) {
			const u = extract(10, 200_000_000);
			expect(u.source, shape).toBe("estimated");
			expect(u.implausible, shape).toEqual({ cacheReadTokens: 200_000_000 });
			expect(u.implausibleBy, shape).toEqual({ cacheReadTokens: "refused" });
		}
	});

	it("CONTROL: a prompt and a cache figure of exactly the ceiling pass in every shape", () => {
		for (const [shape, extract] of SHAPES) {
			const u = extract(MAX_PLAUSIBLE_TOKENS_PER_TIER, MAX_PLAUSIBLE_TOKENS_PER_TIER);
			expect(u.source, shape).toBe("provider");
			expect(u.implausible, shape).toBeUndefined();
			expect(u.cacheReadTokens, shape).toBe(MAX_PLAUSIBLE_TOKENS_PER_TIER);
		}
	});
});
