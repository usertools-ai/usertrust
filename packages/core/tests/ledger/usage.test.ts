// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import {
	fromAnthropicUsage,
	fromGeminiUsage,
	fromOpenAICompletionsUsage,
	fromOpenAIResponsesUsage,
	type NormalizedUsage,
	sanitizeUsage,
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
