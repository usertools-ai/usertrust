// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	type ModelRates,
	PRICING_TABLE,
	requestDeclares1hCache,
	serializeRequest,
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
		expect(requestDeclares1hCache({ a: { b: 1 } })).toBe(false);
	});

	it("fails DEAREST: a request that cannot be serialized to a JSON object answers true", () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(requestDeclares1hCache(cycle)).toBe(true);
		expect(requestDeclares1hCache({ n: 10n })).toBe(true);
		expect(
			requestDeclares1hCache({
				get messages(): unknown {
					throw new Error("boom");
				},
			}),
		).toBe(true);
		expect(
			requestDeclares1hCache({
				toJSON() {
					throw new Error("boom");
				},
			}),
		).toBe(true);
		// Too large to vouch for within the node bound.
		expect(requestDeclares1hCache({ items: Array.from({ length: 250_000 }, () => ({})) })).toBe(
			true,
		);
		// Not a request object at all.
		for (const v of [null, undefined, 3, "x", []]) expect(requestDeclares1hCache(v)).toBe(true);
	});

	// Every shape the property walk needed its own branch for now goes through ONE path: the
	// serialization the SDK itself would produce. Each declares a 1-hour TTL only through a
	// hook or accessor, and each must be seen.
	describe("every serialization shape is decided on the serialized text", () => {
		// [text, <hole>, text]: index 1 is absent, so a read falls through to the prototype.
		const withHole = (): unknown[] => {
			const a: unknown[] = [{ type: "text" }];
			a.length = 3;
			a[2] = { type: "text" };
			return a;
		};
		const oneHour = { type: "ephemeral", ttl: "1h" };
		const cases: Array<[string, () => unknown]> = [
			[
				"accessor property",
				() => ({
					system: [
						{
							get cache_control() {
								return oneHour;
							},
						},
					],
				}),
			],
			[
				"indexed array accessor",
				() => {
					const content: unknown[] = [{ type: "text" }];
					Object.defineProperty(content, 1, {
						enumerable: true,
						get: () => ({ cache_control: oneHour }),
					});
					return { messages: [{ content }] };
				},
			],
			[
				"callable toJSON on a class instance",
				() => ({
					messages: [
						{
							content: [
								new (class {
									toJSON() {
										return { cache_control: oneHour };
									}
								})(),
							],
						},
					],
				}),
			],
			[
				"toJSON on an array",
				() => {
					const arr: unknown[] = [{ type: "text" }];
					Object.defineProperty(arr, "toJSON", { value: () => [{ cache_control: oneHour }] });
					return { messages: [{ content: arr }] };
				},
			],
			[
				"accessor-backed toJSON",
				() => ({
					messages: [
						{
							content: [
								Object.create({
									get toJSON() {
										return () => ({ cache_control: oneHour });
									},
								}),
							],
						},
					],
				}),
			],
			[
				"non-enumerable toJSON",
				() => {
					const block = { type: "text" };
					Object.defineProperty(block, "toJSON", {
						value: () => ({ cache_control: oneHour }),
						enumerable: false,
					});
					return { messages: [{ content: [block] }] };
				},
			],
			[
				"overridden toJSON on a Date",
				() => {
					const when = new Date(0);
					Object.defineProperty(when, "toJSON", { value: () => ({ cache_control: oneHour }) });
					return { messages: [{ content: [when] }] };
				},
			],
			[
				"overridden toJSON on a binary view",
				() => {
					const bytes = new Uint8Array(2);
					Object.defineProperty(bytes, "toJSON", { value: () => ({ cache_control: oneHour }) });
					return { messages: [{ content: [bytes] }] };
				},
			],
			[
				"sparse array inheriting an entry from its prototype",
				() => {
					const proto = Object.create(Array.prototype);
					proto[1] = { cache_control: oneHour };
					const content = Object.setPrototypeOf(withHole(), proto);
					return { messages: [{ content }] };
				},
			],
			[
				"sparse array inheriting a getter from its prototype",
				() => {
					const proto = Object.create(Array.prototype);
					Object.defineProperty(proto, 1, { get: () => ({ cache_control: oneHour }) });
					const content = Object.setPrototypeOf(withHole(), proto);
					return { messages: [{ content }] };
				},
			],
		];
		for (const [name, build] of cases) {
			it(`${name}: what JSON.stringify emits is what is scanned`, () => {
				const emitted = JSON.stringify(build());
				const scanned = serializeRequest(build());
				// Positive control: the serialization really does carry the marker (a case that
				// stopped emitting it would pass vacuously), and the scan agrees with it.
				expect(emitted).toContain('"ttl":"1h"');
				expect(scanned?.declares1h).toBe(true);
				expect(JSON.stringify(scanned?.body)).toBe(emitted);
			});
		}

		it("a Date and a binary view with their own serializers stay unmarked", () => {
			expect(
				requestDeclares1hCache({
					when: new Date(0),
					bytes: new Uint8Array(4),
					buf: Buffer.from("x"),
				}),
			).toBe(false);
		});
	});

	it("a getter or toJSON that flips between reads cannot evade: the scanned body IS the sent body", () => {
		let reads = 0;
		const flipping = {
			system: [
				{
					type: "text",
					get cache_control() {
						reads += 1;
						return { type: "ephemeral", ttl: reads === 1 ? "5m" : "1h" };
					},
				},
			],
		};
		const scanned = serializeRequest(flipping);
		// The one read the serialization made decided both the verdict and the body; whatever the
		// original answers afterwards cannot reach the SDK, which is handed `body`.
		expect(scanned?.declares1h).toBe(false);
		expect(JSON.stringify(scanned?.body)).toContain('"ttl":"5m"');
		expect(reads).toBe(1);
		// The body is plain data: nothing is left to answer differently.
		const desc = Object.getOwnPropertyDescriptor(
			(scanned?.body.system as Array<Record<string, unknown>> | undefined)?.[0] ?? {},
			"cache_control",
		);
		expect(desc?.get).toBeUndefined();
		let flips = 0;
		const hook = {
			toJSON() {
				flips += 1;
				return { cache_control: { ttl: flips === 1 ? "5m" : "1h" } };
			},
		};
		const viaHook = serializeRequest({ messages: [hook] });
		expect(viaHook?.declares1h).toBe(false);
		expect(JSON.stringify(viaHook?.body)).toBe('{"messages":[{"cache_control":{"ttl":"5m"}}]}');
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
