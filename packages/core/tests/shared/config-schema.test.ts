import { describe, expect, it } from "vitest";
import { TrustConfigSchema } from "../../src/shared/types.js";

describe("TrustConfigSchema — new onboarding fields", () => {
	it("accepts providers array", () => {
		const config = TrustConfigSchema.parse({
			budget: 1_000_000,
			providers: [{ name: "anthropic" }, { name: "openai" }],
		});
		expect(config.providers).toHaveLength(2);
		expect(config.providers[0]?.name).toBe("anthropic");
	});

	it("defaults providers to empty array", () => {
		const config = TrustConfigSchema.parse({ budget: 50_000 });
		expect(config.providers).toEqual([]);
	});

	it("accepts pricing mode", () => {
		const config = TrustConfigSchema.parse({
			budget: 50_000,
			pricing: "custom",
		});
		expect(config.pricing).toBe("custom");
	});

	it("defaults pricing to recommended", () => {
		const config = TrustConfigSchema.parse({ budget: 50_000 });
		expect(config.pricing).toBe("recommended");
	});

	it("accepts customRates", () => {
		const config = TrustConfigSchema.parse({
			budget: 50_000,
			pricing: "custom",
			customRates: {
				"claude-sonnet-4-6": { inputPer1k: 25, outputPer1k: 120 },
			},
		});
		expect(config.customRates?.["claude-sonnet-4-6"]?.inputPer1k).toBe(25);
	});

	it("defaults customRates to undefined when not provided", () => {
		const config = TrustConfigSchema.parse({ budget: 50_000 });
		expect(config.customRates).toBeUndefined();
	});

	it("round-trips all four rate tiers through customRates (D1)", () => {
		// RateSchema is a closed z.object: a field it does not declare is STRIPPED,
		// silently, at parse time. Before this test, an operator who wrote cache
		// rates into usertrust.config.json got them deleted before pricing ever saw
		// them — and because absence is meaningful (D1), the deletion did not throw
		// or warn, it just re-priced every cache token at inputPer1k.
		const config = TrustConfigSchema.parse({
			budget: 50_000,
			pricing: "custom",
			customRates: {
				"my-model": {
					inputPer1k: 10,
					outputPer1k: 50,
					cacheReadPer1k: 1,
					cacheWritePer1k: 12.5,
				},
			},
		});
		expect(config.customRates?.["my-model"]).toStrictEqual({
			inputPer1k: 10,
			outputPer1k: 50,
			cacheReadPer1k: 1,
			cacheWritePer1k: 12.5,
		});
	});

	it("keeps absence absent — an omitted cache tier materialises no key (D1)", () => {
		// The D1 contract is "absent means unpublished, resolved to inputPer1k".
		// A schema default of 0 would silently zero-bill; a default of `undefined`
		// key would break the toStrictEqual pins in the rates audit. Neither key
		// may appear.
		const config = TrustConfigSchema.parse({
			budget: 50_000,
			pricing: "custom",
			customRates: { "my-model": { inputPer1k: 10, outputPer1k: 50 } },
		});
		const rates = config.customRates?.["my-model"] as Record<string, unknown>;
		expect(Object.hasOwn(rates, "cacheReadPer1k")).toBe(false);
		expect(Object.hasOwn(rates, "cacheWritePer1k")).toBe(false);
	});

	it("honours an explicit cache rate of 0 (operator override, not absence)", () => {
		const config = TrustConfigSchema.parse({
			budget: 50_000,
			pricing: "custom",
			customRates: {
				"self-hosted": { inputPer1k: 0, outputPer1k: 0, cacheReadPer1k: 0, cacheWritePer1k: 0 },
			},
		});
		expect(config.customRates?.["self-hosted"]?.cacheReadPer1k).toBe(0);
		expect(config.customRates?.["self-hosted"]?.cacheWritePer1k).toBe(0);
	});

	it("rejects negative and non-finite cache rates", () => {
		const base = { inputPer1k: 10, outputPer1k: 50 };
		for (const bad of [
			{ ...base, cacheReadPer1k: -1 },
			{ ...base, cacheWritePer1k: -1 },
			{ ...base, cacheReadPer1k: Number.POSITIVE_INFINITY },
			{ ...base, cacheWritePer1k: Number.NaN },
		]) {
			expect(() =>
				TrustConfigSchema.parse({ budget: 50_000, pricing: "custom", customRates: { m: bad } }),
			).toThrow();
		}
	});

	it("round-trips cache tiers through local.defaultRate and local.models", () => {
		// RateSchema is shared by customRates AND the local.* rates, so the same
		// strip hit the local-model path; both need pinning or a future refactor
		// can fix one and regress the other.
		const config = TrustConfigSchema.parse({
			budget: 50_000,
			local: {
				defaultRate: { inputPer1k: 1, outputPer1k: 2, cacheReadPer1k: 0, cacheWritePer1k: 1 },
				models: {
					"llama3.3*": { inputPer1k: 3, outputPer1k: 4, cacheReadPer1k: 0.5, cacheWritePer1k: 3 },
				},
			},
		});
		expect(config.local.defaultRate).toStrictEqual({
			inputPer1k: 1,
			outputPer1k: 2,
			cacheReadPer1k: 0,
			cacheWritePer1k: 1,
		});
		expect(config.local.models["llama3.3*"]).toStrictEqual({
			inputPer1k: 3,
			outputPer1k: 4,
			cacheReadPer1k: 0.5,
			cacheWritePer1k: 3,
		});
	});

	it("existing configs without new fields still parse (backwards compat)", () => {
		const config = TrustConfigSchema.parse({
			budget: 50_000,
			tier: "mini",
			policies: "./policies/default.yml",
			pii: "warn",
		});
		expect(config.budget).toBe(50_000);
		expect(config.providers).toEqual([]);
		expect(config.pricing).toBe("recommended");
	});
});

describe("TrustConfigSchema — scope", () => {
	it("accepts a path-like host scope", () => {
		const config = TrustConfigSchema.parse({
			budget: 50_000,
			scope: ["production/api", "staging"],
		});
		expect(config.scope).toEqual(["production/api", "staging"]);
	});

	it("leaves configs that never mention it byte-identical", () => {
		const config = TrustConfigSchema.parse({ budget: 50_000, tier: "pro" });
		expect(config.scope).toBeUndefined();
		// The optional field must not materialise a key — a config round-tripped
		// through the schema is what an operator diffs against their file.
		expect(Object.hasOwn(config, "scope")).toBe(false);
	});

	it("refuses an empty entry, control characters, spaces, and glob metacharacters", () => {
		expect(() => TrustConfigSchema.parse({ budget: 50_000, scope: [""] })).toThrow();
		expect(() => TrustConfigSchema.parse({ budget: 50_000, scope: ["prod uction"] })).toThrow();
		expect(() => TrustConfigSchema.parse({ budget: 50_000, scope: ["prod\u0000"] })).toThrow();
		expect(() => TrustConfigSchema.parse({ budget: 50_000, scope: ["production/*"] })).toThrow();
	});
});
