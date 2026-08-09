// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import {
	costFromRates,
	estimateCost,
	FALLBACK_RATE,
	getModelRates,
	matchModelPattern,
	PRICING_TABLE,
	resolveRates,
} from "../../src/ledger/pricing.js";
import { type TrustConfig, TrustConfigSchema } from "../../src/shared/types.js";

function makeConfig(overrides: Record<string, unknown> = {}): TrustConfig {
	return TrustConfigSchema.parse({ budget: 1000, ...overrides });
}

describe("matchModelPattern", () => {
	it("returns exact match with its pattern key", () => {
		const m = matchModelPattern("llama3.3:70b", { "llama3.3:70b": 1, "llama3.3*": 2 });
		expect(m).toEqual({ pattern: "llama3.3:70b", value: 1 });
	});

	it("exact match beats a longer glob", () => {
		const m = matchModelPattern("llama3.3:70b", {
			"llama3.3:70b*": 2, // longer glob prefix than the exact key
			"llama3.3:70b": 1,
		});
		expect(m?.value).toBe(1);
	});

	it("longest glob prefix wins among globs", () => {
		const patterns = { "llama3.3*": 1, "llama*": 2, "*": 3 };
		expect(matchModelPattern("llama3.3:70b", patterns)?.value).toBe(1);
		expect(matchModelPattern("llama2:7b", patterns)?.value).toBe(2);
		expect(matchModelPattern("qwen2.5:7b", patterns)?.value).toBe(3);
	});

	it('"*" matches everything', () => {
		expect(matchModelPattern("anything-at-all", { "*": 42 })).toEqual({
			pattern: "*",
			value: 42,
		});
		expect(matchModelPattern("", { "*": 42 })?.value).toBe(42);
	});

	it("returns undefined when nothing matches", () => {
		expect(matchModelPattern("qwen2.5:7b", { "llama*": 1 })).toBeUndefined();
		expect(matchModelPattern("qwen2.5:7b", {})).toBeUndefined();
	});

	it("only trailing-star patterns are globs (A2)", () => {
		// "llama*3" is not a trailing-star glob and must only match exactly.
		expect(matchModelPattern("llama2:7b", { "llama*3": 1 })).toBeUndefined();
		expect(matchModelPattern("llama*3", { "llama*3": 1 })?.value).toBe(1);
	});

	it("does not resolve inherited Object.prototype keys as exact matches", () => {
		expect(matchModelPattern("constructor", {})).toBeUndefined();
		expect(matchModelPattern("toString", { "llama*": 1 })).toBeUndefined();
	});
});

describe("resolveRates — local scope", () => {
	it("never returns FALLBACK_RATE, even for unknown models", () => {
		const config = makeConfig();
		const r = resolveRates("totally-unknown-model-xyz", "local", config);
		expect(r.rates).not.toEqual(FALLBACK_RATE);
		expect(r.rates).toEqual({ inputPer1k: 0, outputPer1k: 0 });
		expect(r.scope).toBe("local");
		expect(r.rateSource).toBe("local-default");
		expect(r.unknown).toBe(false);
	});

	it("local misses are never unknown and never 'fallback' (A5)", () => {
		const config = makeConfig();
		// Same model misses the cloud table entirely — cloud says unknown, local never does.
		const cloud = resolveRates("does-not-exist-anywhere", "cloud", config);
		const local = resolveRates("does-not-exist-anywhere", "local", config);
		expect(cloud.unknown).toBe(true);
		expect(local.unknown).toBe(false);
		expect(local.rateSource).toBe("local-default");
	});

	it("local.models exact match beats glob", () => {
		const config = makeConfig({
			local: {
				models: {
					"llama3.3:70b": { inputPer1k: 1, outputPer1k: 2 },
					"llama3.3*": { inputPer1k: 5, outputPer1k: 10 },
				},
			},
		});
		const r = resolveRates("llama3.3:70b", "local", config);
		expect(r.rates).toEqual({ inputPer1k: 1, outputPer1k: 2 });
		expect(r.rateSource).toBe("local-model");
	});

	it("longest glob wins in local.models", () => {
		const config = makeConfig({
			local: {
				models: {
					"llama3.3*": { inputPer1k: 1, outputPer1k: 1 },
					"llama*": { inputPer1k: 2, outputPer1k: 2 },
					"*": { inputPer1k: 3, outputPer1k: 3 },
				},
			},
		});
		expect(resolveRates("llama3.3:70b-q4_K_M", "local", config).rates.inputPer1k).toBe(1);
		expect(resolveRates("llama2:7b", "local", config).rates.inputPer1k).toBe(2);
		expect(resolveRates("qwen2.5:7b", "local", config).rates.inputPer1k).toBe(3);
	});

	it('"*" catch-all in local.models resolves as local-model, not local-default', () => {
		const config = makeConfig({
			local: { models: { "*": { inputPer1k: 0.5, outputPer1k: 0.5 } } },
		});
		const r = resolveRates("anything", "local", config);
		expect(r.rateSource).toBe("local-model");
		expect(r.rates).toEqual({ inputPer1k: 0.5, outputPer1k: 0.5 });
	});

	it("default local rates {0,0} + the >=1 floor cost exactly 1 for any token counts", () => {
		const config = makeConfig();
		const r = resolveRates("llama3.3:70b", "local", config);
		expect(costFromRates(r.rates, 0, 0)).toBe(1);
		expect(costFromRates(r.rates, 1, 1)).toBe(1);
		expect(costFromRates(r.rates, 1_000_000, 1_000_000)).toBe(1);
		expect(costFromRates(r.rates, Number.NaN, -50)).toBe(1);
	});

	it('costBasis is "nominal" by default and "usd-proxy" under rateClass "amortized-usd"', () => {
		const nominal = resolveRates("llama3.3:70b", "local", makeConfig());
		expect(nominal.costBasis).toBe("nominal");

		const amortized = resolveRates(
			"llama3.3:70b",
			"local",
			makeConfig({ local: { rateClass: "amortized-usd" } }),
		);
		expect(amortized.costBasis).toBe("usd-proxy");
		expect(amortized.rateSource).toBe("local-default");
	});
});

describe("resolveRates — cloud scope", () => {
	it('table hit resolves rateSource "table", unknown false, costBasis "usd-proxy"', () => {
		const r = resolveRates("claude-sonnet-4-6", "cloud", makeConfig());
		// Identity against the table, not a literal: the rates matrix is audited and
		// re-pinned in pricing.test.ts, so duplicating values here only creates drift.
		expect(r.rates).toBe(PRICING_TABLE["claude-sonnet-4-6"]);
		expect(r.scope).toBe("cloud");
		expect(r.rateSource).toBe("table");
		expect(r.costBasis).toBe("usd-proxy");
		expect(r.unknown).toBe(false);
	});

	it('prefix hit resolves rateSource "table"', () => {
		const r = resolveRates("claude-haiku-4-5-20251001", "cloud", makeConfig());
		expect(r.rates).toBe(PRICING_TABLE["claude-haiku-4-5"]);
		expect(r.rateSource).toBe("table");
		expect(r.unknown).toBe(false);
	});

	it('customRates hit resolves rateSource "custom" when pricing is "custom"', () => {
		const config = makeConfig({
			pricing: "custom",
			customRates: { "my-fine-tune": { inputPer1k: 7, outputPer1k: 9 } },
		});
		const r = resolveRates("my-fine-tune", "cloud", config);
		expect(r.rates).toEqual({ inputPer1k: 7, outputPer1k: 9 });
		expect(r.rateSource).toBe("custom");
		expect(r.unknown).toBe(false);
	});

	it('customRates are ignored when pricing is "recommended" (existing caller gate preserved)', () => {
		const config = makeConfig({
			// pricing defaults to "recommended" — same gate as govern.ts/headless.ts call sites.
			customRates: { "claude-sonnet-4-6": { inputPer1k: 1, outputPer1k: 1 } },
		});
		const r = resolveRates("claude-sonnet-4-6", "cloud", config);
		expect(r.rates).toBe(PRICING_TABLE["claude-sonnet-4-6"]);
		expect(r.rateSource).toBe("table");
	});

	it('miss resolves FALLBACK_RATE with rateSource "fallback" and unknown true', () => {
		const r = resolveRates("totally-unknown-model-xyz", "cloud", makeConfig());
		expect(r.rates).toEqual(FALLBACK_RATE);
		expect(r.rateSource).toBe("fallback");
		expect(r.unknown).toBe(true);
		expect(r.costBasis).toBe("usd-proxy");
	});

	it("matches getModelRates for the same inputs (delegation regression)", () => {
		const config = makeConfig({
			pricing: "custom",
			customRates: { "gpt-4o": { inputPer1k: 20, outputPer1k: 80 } },
		});
		for (const model of ["gpt-4o", "claude-sonnet-4-6", "gpt-4o-mini-2025", "no-such-model"]) {
			const r = resolveRates(model, "cloud", config);
			expect(r.rates).toEqual(getModelRates(model, config.customRates));
		}
	});
});

describe("config-declared cache rates survive parsing and reach the money path (D1)", () => {
	// The end-to-end proof for the RateSchema fix. Schema-level round-trip is
	// pinned in tests/shared/config-schema.test.ts; this pins the consequence that
	// actually costs money: an operator's declared cache-read discount must be the
	// rate costFromRates bills at, not inputPer1k.
	it("prices a custom entry's cache tokens at the operator's declared rates", () => {
		const config = makeConfig({
			pricing: "custom",
			customRates: {
				"my-fine-tune": {
					inputPer1k: 100,
					outputPer1k: 200,
					cacheReadPer1k: 10,
					cacheWritePer1k: 125,
				},
			},
		});
		const { rates } = resolveRates("my-fine-tune", "cloud", config);
		expect(rates.cacheReadPer1k).toBe(10);
		expect(rates.cacheWritePer1k).toBe(125);

		// 1k input @100 + 1k output @200 + 1k read @10 + 1k write @125 = 435.
		expect(costFromRates(rates, 1000, 1000, 1000, 1000)).toBe(435);
		// If the fields were stripped, both cache tiers would fall back to
		// inputPer1k (D1) and the call would bill 100 + 200 + 100 + 100 = 500.
		expect(costFromRates(rates, 1000, 1000, 1000, 1000)).not.toBe(500);
	});

	it("an explicit 0 in config zero-rates that tier (override, not absence)", () => {
		const config = makeConfig({
			pricing: "custom",
			customRates: {
				"free-cache": { inputPer1k: 100, outputPer1k: 100, cacheReadPer1k: 0 },
			},
		});
		const { rates } = resolveRates("free-cache", "cloud", config);
		// 1k input @100 only; the 1k cache-read tokens bill at the declared 0.
		expect(costFromRates(rates, 1000, 0, 1000, 0)).toBe(100);
	});

	it("local.models cache rates reach costFromRates too (shared RateSchema)", () => {
		const config = makeConfig({
			local: {
				models: {
					"llama3.3*": { inputPer1k: 10, outputPer1k: 20, cacheReadPer1k: 1, cacheWritePer1k: 5 },
				},
			},
		});
		const { rates } = resolveRates("llama3.3:70b", "local", config);
		expect(rates.cacheReadPer1k).toBe(1);
		// 1k read @1 + 1k write @5 = 6, not 2 x inputPer1k = 20.
		expect(costFromRates(rates, 0, 0, 1000, 1000)).toBe(6);
	});
});

describe("costFromRates", () => {
	it("agrees with estimateCost for table models (refactor regression)", () => {
		expect(costFromRates(getModelRates("claude-sonnet-4-6"), 1000, 500)).toBe(
			estimateCost("claude-sonnet-4-6", 1000, 500),
		);
		expect(costFromRates(getModelRates("gpt-4o-mini"), 1000, 1000)).toBe(
			estimateCost("gpt-4o-mini", 1000, 1000),
		);
	});

	it("floors at 1 and clamps non-finite/negative token counts", () => {
		const rates = { inputPer1k: 30, outputPer1k: 150 };
		expect(costFromRates(rates, 0, 0)).toBe(1);
		expect(costFromRates(rates, -1000, Number.NaN)).toBe(1);
		expect(costFromRates(rates, 1000, 500)).toBe(105);
	});
});

describe("prototype-safe rate lookups (F4)", () => {
	it("getModelRates ignores inherited Object.prototype keys and falls back", () => {
		for (const evil of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
			const rates = getModelRates(evil);
			// FALLBACK_RATE, not a Function/object whose .inputPer1k is undefined → NaN.
			expect(rates).toEqual(FALLBACK_RATE);
			expect(Number.isNaN(rates.inputPer1k)).toBe(false);
			expect(Number.isNaN(rates.outputPer1k)).toBe(false);
		}
	});

	it("getModelRates ignores inherited keys in customRates too", () => {
		// customRates has no OWN "constructor" key — the inherited Function must not
		// resolve; the lookup falls through to table/fallback.
		const rates = getModelRates("constructor", { "my-model": { inputPer1k: 1, outputPer1k: 2 } });
		expect(rates).toEqual(FALLBACK_RATE);
	});

	it("resolveRates cloud scope returns FALLBACK_RATE (unknown) for prototype keys", () => {
		const config = makeConfig();
		for (const evil of ["__proto__", "constructor", "toString"]) {
			const r = resolveRates(evil, "cloud", config);
			expect(r.rates).toEqual(FALLBACK_RATE);
			expect(r.unknown).toBe(true);
			expect(r.rateSource).toBe("fallback");
		}
	});

	it("estimateCost for a prototype-key model is a finite number >= 1 (no NaN poison)", () => {
		const cost = estimateCost("constructor", 1000, 500);
		expect(Number.isFinite(cost)).toBe(true);
		expect(cost).toBeGreaterThanOrEqual(1);
		// Identical to any unknown model — FALLBACK_RATE all the way through.
		expect(cost).toBe(estimateCost("some-unknown-model", 1000, 500));
	});
});

describe("TrustConfigSchema — pre-M2 config regression", () => {
	it("parses a minimal pre-M2 config unchanged and populates all M2 defaults", () => {
		const config = TrustConfigSchema.parse({ budget: 1000 });

		expect(config.endpoints).toEqual([]);
		expect(config.local).toEqual({
			autoDetectLoopback: true,
			defaultRate: { inputPer1k: 0, outputPer1k: 0 },
			rateClass: "nominal",
			models: {},
			injectUsageOptions: true,
		});
		expect(config.unknownModelPolicy).toBe("warn");

		// New anomaly keys defaulted; legacy anomaly keys untouched.
		expect(config.anomaly.tokenRate.localThresholdTokPerSec).toBe(5000);
		expect(config.anomaly.tokenRate.perModel).toEqual({});
		expect(config.anomaly.tokenRate.thresholdTokPerSec).toBe(500);
		expect(config.anomaly.spendVelocity.localThresholdUsertokensPerMin).toBe(10_000);
		expect(config.anomaly.spendVelocity.thresholdDollarsPerMin).toBe(1.0);
	});

	it("parses a typical pre-M2 config with existing keys set", () => {
		const config = TrustConfigSchema.parse({
			budget: 5000,
			tier: "pro",
			pii: "block",
			anomaly: { enabled: true, tokenRate: { thresholdTokPerSec: 800 } },
			customRates: { "gpt-4o": { inputPer1k: 20, outputPer1k: 80 } },
		});
		expect(config.anomaly.enabled).toBe(true);
		expect(config.anomaly.tokenRate.thresholdTokPerSec).toBe(800);
		expect(config.anomaly.tokenRate.localThresholdTokPerSec).toBe(5000);
		expect(config.local.autoDetectLoopback).toBe(true);
		expect(config.unknownModelPolicy).toBe("warn");
	});

	it("accepts explicit M2 config values", () => {
		const config = TrustConfigSchema.parse({
			budget: 1000,
			endpoints: [{ match: "*.gpu.internal", class: "local", runtime: "vllm" }],
			local: {
				defaultRate: { inputPer1k: 0.1, outputPer1k: 0.2 },
				rateClass: "amortized-usd",
				models: { "llama3.3*": { inputPer1k: 1, outputPer1k: 2 } },
			},
			unknownModelPolicy: "deny",
		});
		expect(config.endpoints[0]?.runtime).toBe("vllm");
		expect(config.endpoints[0]?.class).toBe("local");
		expect(config.local.rateClass).toBe("amortized-usd");
		expect(config.unknownModelPolicy).toBe("deny");
	});

	it("defaults endpoints[].class to local and runtime to unknown", () => {
		const config = TrustConfigSchema.parse({
			budget: 1000,
			endpoints: [{ match: "http://gpu-box:8000" }],
		});
		expect(config.endpoints[0]).toEqual({
			match: "http://gpu-box:8000",
			class: "local",
			runtime: "unknown",
		});
	});
});
