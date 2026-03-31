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
