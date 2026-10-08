// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	type ModelRates,
	PRICING_TABLE,
	requestDeclares1hCache,
	supportsCacheWrite1h,
} from "../../src/ledger/pricing.js";
import {
	fromAnthropicUsage,
	fromOpenAICompletionsUsage,
	publishableUsageFields,
	sanitizeUsage,
	withSupported1hTier,
} from "../../src/ledger/usage.js";
import { TrustConfigSchema } from "../../src/shared/types.js";

const SONNET = PRICING_TABLE["claude-sonnet-4-6"] as ModelRates;

describe("1h share in usage extraction", () => {
	it("fromAnthropicUsage reads ephemeral_1h as a SUBSET of the write total", () => {
		const u = fromAnthropicUsage({
			input_tokens: 10,
			output_tokens: 5,
			cache_creation_input_tokens: 999, // ignored: the breakdown wins when usable
			cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 700 },
		});
		expect(u.cacheWriteTokens).toBe(1_000);
		expect(u.cacheWrite1hTokens).toBe(700);
	});

	it("a PARTIAL breakdown never drops the flat total: the write total is the dearer of the two", () => {
		const partial = fromAnthropicUsage({
			input_tokens: 1,
			output_tokens: 1,
			cache_creation_input_tokens: 1_000,
			cache_creation: { ephemeral_5m_input_tokens: 600 },
		});
		expect(partial.cacheWriteTokens).toBe(1_000);
		// The 400 the payload did not attribute are a real write: priced at the dearer 1-hour rate.
		expect(partial.cacheWrite1hTokens).toBe(400);
		// A partial breakdown naming only the 1-hour field keeps the rest of the flat total too.
		const only1h = fromAnthropicUsage({
			input_tokens: 1,
			output_tokens: 1,
			cache_creation_input_tokens: 1_000,
			cache_creation: { ephemeral_1h_input_tokens: 300 },
		});
		expect(only1h.cacheWriteTokens).toBe(1_000);
		expect(only1h.cacheWrite1hTokens).toBe(1_000);
		// A COMPLETE breakdown still wins over the flat field, in either direction.
		const bigger = fromAnthropicUsage({
			input_tokens: 1,
			output_tokens: 1,
			cache_creation_input_tokens: 100,
			cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 },
		});
		expect(bigger.cacheWriteTokens).toBe(1_000);
		expect(bigger.cacheWrite1hTokens).toBe(400);
		// Flat only, and nothing at all, are as before.
		expect(
			fromAnthropicUsage({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 40 })
				.cacheWriteTokens,
		).toBe(40);
		expect(fromAnthropicUsage({ input_tokens: 1, output_tokens: 1 }).cacheWriteTokens).toBe(0);
	});

	it("the key is ABSENT when there is no 1h share (the snapshot keeps its old shape)", () => {
		const flat = fromAnthropicUsage({
			input_tokens: 1,
			output_tokens: 1,
			cache_creation_input_tokens: 40,
		});
		expect(flat.cacheWriteTokens).toBe(40);
		expect("cacheWrite1hTokens" in flat).toBe(false);
		const zero = fromAnthropicUsage({
			input_tokens: 1,
			output_tokens: 1,
			cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 },
		});
		expect("cacheWrite1hTokens" in zero).toBe(false);
		expect(
			"cacheWrite1hTokens" in
				fromOpenAICompletionsUsage({ prompt_tokens: 5, completion_tokens: 1 }),
		).toBe(false);
	});

	it("sanitizeUsage clamps a 1h count to the write total and drops garbage", () => {
		const over = sanitizeUsage({
			inputTokens: 1,
			outputTokens: 1,
			cacheWriteTokens: 100,
			cacheWrite1hTokens: 500,
		});
		expect(over.cacheWrite1hTokens).toBe(100);
		for (const bad of [Number.NaN, -3, Number.POSITIVE_INFINITY, "7", null, undefined]) {
			const s = sanitizeUsage({
				inputTokens: 1,
				outputTokens: 1,
				cacheWriteTokens: 100,
				cacheWrite1hTokens: bad,
			});
			expect("cacheWrite1hTokens" in s, String(bad)).toBe(false);
		}
		// With no write total there is nothing for the 1h share to be a subset of.
		expect(
			"cacheWrite1hTokens" in
				sanitizeUsage({ inputTokens: 1, outputTokens: 1, cacheWrite1hTokens: 9 }),
		).toBe(false);
	});

	it("publishableUsageFields: usage always, cacheWrite1h only when 1h tokens were written", () => {
		const with1h = sanitizeUsage({
			inputTokens: 1,
			outputTokens: 1,
			cacheWriteTokens: 100,
			cacheWrite1hTokens: 40,
			source: "provider",
		});
		const f = publishableUsageFields(with1h, SONNET);
		expect(f.usage).toEqual({
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheWriteTokens: 100,
		});
		expect(f.cacheWrite1h).toEqual({ tokens: 40, ratePer1k: 60 });
		const without = publishableUsageFields(
			sanitizeUsage({ inputTokens: 1, outputTokens: 1, cacheWriteTokens: 100, source: "provider" }),
			SONNET,
		);
		expect(without.usage).toBeDefined();
		expect("cacheWrite1h" in without).toBe(false);
		// An ESTIMATED snapshot publishes nothing, 1h share or not.
		const est = publishableUsageFields(
			sanitizeUsage({ inputTokens: 1, cacheWriteTokens: 100, cacheWrite1hTokens: 40 }),
			SONNET,
		);
		expect(est).toEqual({});
	});
});

describe("requestDeclares1hCache", () => {
	const m = { type: "ephemeral", ttl: "1h" };

	it("finds a 1h marker on a content block, a system block, a tool, or the top level", () => {
		expect(
			requestDeclares1hCache({
				messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: m }] }],
			}),
		).toBe(true);
		expect(
			requestDeclares1hCache({ system: [{ type: "text", text: "x", cache_control: m }] }),
		).toBe(true);
		expect(requestDeclares1hCache({ tools: [{ name: "t", cache_control: m }] })).toBe(true);
		expect(requestDeclares1hCache({ cache_control: m })).toBe(true);
	});

	it("a request with no marker, a 5m marker, or a non-string ttl declares nothing", () => {
		expect(
			requestDeclares1hCache({ model: "x", messages: [{ role: "user", content: "hi" }] }),
		).toBe(false);
		expect(
			requestDeclares1hCache({
				system: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }],
			}),
		).toBe(false);
		expect(requestDeclares1hCache({ cache_control: { type: "ephemeral", ttl: "5m" } })).toBe(false);
		expect(requestDeclares1hCache({ cache_control: { ttl: 3600 } })).toBe(false);
		// The marker is the KEY `cache_control`, not text that mentions it.
		expect(
			requestDeclares1hCache({ messages: [{ role: "user", content: 'cache_control ttl "1h"' }] }),
		).toBe(false);
		for (const v of [null, undefined, 3, "x", []]) expect(requestDeclares1hCache(v)).toBe(false);
	});

	it("fails DEAREST: too deep, too large, or unreadable answers true, never false", () => {
		let deep: Record<string, unknown> = {};
		const root = deep;
		for (let i = 0; i < 100; i++) {
			const next: Record<string, unknown> = {};
			deep.child = next;
			deep = next;
		}
		expect(requestDeclares1hCache(root)).toBe(true);
		expect(requestDeclares1hCache({ items: Array.from({ length: 60_000 }, () => ({})) })).toBe(
			true,
		);
		const hostile = {
			get messages(): unknown {
				throw new Error("boom");
			},
		};
		expect(requestDeclares1hCache(hostile)).toBe(true);
		// An accessor can answer differently at serialization time than during the scan, so
		// the scan cannot vouch for the request: fail dearest.
		let reads = 0;
		const shifty = {
			system: [
				{
					type: "text",
					text: "x",
					get cache_control() {
						reads += 1;
						return { type: "ephemeral", ttl: reads === 1 ? "5m" : "1h" };
					},
				},
			],
		};
		expect(requestDeclares1hCache(shifty)).toBe(true);
		expect(
			requestDeclares1hCache({
				a: {
					get b() {
						return 1;
					},
				},
			}),
		).toBe(true);
		expect(requestDeclares1hCache({ a: { b: 1 } })).toBe(false); // plain data stays false
		// ...and an INDEXED accessor in an array (a content array) is one too.
		const indexed: unknown[] = [{ type: "text" }];
		Object.defineProperty(indexed, 1, {
			enumerable: true,
			get: () => ({ type: "text", cache_control: { type: "ephemeral", ttl: "5m" } }),
		});
		expect(requestDeclares1hCache({ messages: [{ role: "user", content: indexed }] })).toBe(true);
		expect(
			requestDeclares1hCache({
				messages: [{ role: "user", content: [{ type: "text" }, { type: "text" }] }],
			}),
		).toBe(false);
		// A callable toJSON (own, non-enumerable, or inherited) can serialize to a 1h block the
		// scan never saw: fail dearest. A Date or a binary view cannot, and stays false.
		class Sneaky {
			toJSON() {
				return { cache_control: { type: "ephemeral", ttl: "1h" } };
			}
		}
		expect(requestDeclares1hCache({ messages: [{ role: "user", content: [new Sneaky()] }] })).toBe(
			true,
		);
		// An accessor-backed toJSON (own non-enumerable, or inherited) is never evaluated: a getter
		// that answers undefined now could return a serializer later.
		const lazy = Object.create({
			get toJSON() {
				return undefined;
			},
		});
		expect(requestDeclares1hCache({ messages: [{ content: [lazy] }] })).toBe(true);
		const arr: unknown[] = [{ type: "text" }];
		Object.defineProperty(arr, "toJSON", { value: () => [{ cache_control: { ttl: "1h" } }] });
		expect(requestDeclares1hCache({ messages: [{ content: arr }] })).toBe(true);
		const hidden = { type: "text" };
		Object.defineProperty(hidden, "toJSON", { value: () => ({}), enumerable: false });
		expect(requestDeclares1hCache({ messages: [{ content: [hidden] }] })).toBe(true);
		expect(
			requestDeclares1hCache({
				when: new Date(0),
				bytes: new Uint8Array(4),
				buf: Buffer.from("x"),
			}),
		).toBe(false);
		// A cycle terminates (and is not itself evidence of a marker).
		const a: Record<string, unknown> = {};
		a.self = a;
		expect(requestDeclares1hCache(a)).toBe(false);
	});
});

describe("customRates keeps an operator's 1h write rate", () => {
	it("cacheWrite1hPer1k survives config parsing (a closed schema would strip it silently)", () => {
		const config = TrustConfigSchema.parse({
			budget: 1000,
			pricing: "custom",
			customRates: {
				"my-claude": {
					inputPer1k: 10,
					outputPer1k: 50,
					cacheWritePer1k: 12.5,
					cacheWrite1hPer1k: 17,
				},
			},
		});
		expect(config.customRates?.["my-claude"]?.cacheWrite1hPer1k).toBe(17);
		expect(() =>
			TrustConfigSchema.parse({
				budget: 1000,
				customRates: { m: { inputPer1k: 1, outputPer1k: 1, cacheWrite1hPer1k: -1 } },
			}),
		).toThrow();
	});
});

describe("a model with no 1-hour tier ignores a reported 1-hour share", () => {
	const gpt = PRICING_TABLE["gpt-4o"] as ModelRates;
	const snap = sanitizeUsage({
		inputTokens: 1,
		outputTokens: 1,
		cacheWriteTokens: 100,
		cacheWrite1hTokens: 60,
		source: "provider",
	});

	it("supportsCacheWrite1h: an explicit rate, or operator-owned rates; a built-in row without one is NO tier", () => {
		expect(supportsCacheWrite1h(SONNET, false)).toBe(true);
		expect(supportsCacheWrite1h(gpt, false)).toBe(false);
		expect(supportsCacheWrite1h(gpt, true)).toBe(true); // an operator row for it may be Anthropic-shaped
		expect(
			supportsCacheWrite1h({ inputPer1k: 1, outputPer1k: 1, cacheWrite1hPer1k: Number.NaN }, false),
		).toBe(false);
	});

	it("withSupported1hTier drops the share (keeping the write TOTAL) only when there is no tier", () => {
		const dropped = withSupported1hTier(snap, gpt, false);
		expect("cacheWrite1hTokens" in dropped).toBe(false);
		expect(dropped.cacheWriteTokens).toBe(100);
		expect(withSupported1hTier(snap, SONNET, false)).toBe(snap);
		expect(withSupported1hTier(snap, gpt, true)).toBe(snap);
		const none = sanitizeUsage({
			inputTokens: 1,
			outputTokens: 1,
			cacheWriteTokens: 100,
			source: "provider",
		});
		expect(withSupported1hTier(none, gpt, false)).toBe(none);
	});
});
