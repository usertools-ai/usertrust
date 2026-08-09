import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/pricing.js";

describe("usertrust pricing", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-pricing-"));
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("displays recommended rates when no vault exists", async () => {
		await run(tempDir, { json: false });

		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("recommended"));
	});

	it("displays custom rates when configured", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(vaultPath, { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({
				budget: 50_000,
				pricing: "custom",
				customRates: {
					"claude-sonnet-4-6": { inputPer1k: 25, outputPer1k: 120 },
				},
				providers: [{ name: "anthropic", models: ["claude-sonnet-4-6"] }],
			}),
			"utf-8",
		);

		await run(tempDir, { json: false });

		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("custom"));
	});

	it("outputs JSON with --json flag", async () => {
		await run(tempDir, { json: true });

		const calls = vi.mocked(console.log).mock.calls;
		const jsonCall = calls.find((c) => {
			try {
				JSON.parse(c[0] as string);
				return true;
			} catch {
				return false;
			}
		});
		expect(jsonCall).toBeDefined();
	});

	// D8: `usertrust pricing` displays and exports all four tiers.
	it("displays all four tiers in text output", async () => {
		await run(tempDir, { json: false });

		const calls = vi.mocked(console.log).mock.calls;
		// claude-sonnet-4-6 publishes all four tiers in PRICING_TABLE.
		const line = calls.find((c) => String(c[0]).includes("claude-sonnet-4-6"));
		expect(line).toBeDefined();
		expect(String(line?.[0])).toContain("cache-read");
		expect(String(line?.[0])).toContain("cache-write");
	});

	it("exports all four tiers in --json output", async () => {
		await run(tempDir, { json: true });

		const calls = vi.mocked(console.log).mock.calls;
		const jsonCall = calls.find((c) => {
			try {
				JSON.parse(c[0] as string);
				return true;
			} catch {
				return false;
			}
		});
		const parsed = JSON.parse(jsonCall?.[0] as string);
		const sonnet = parsed.rates["claude-sonnet-4-6"];
		expect(sonnet).toBeDefined();
		expect(sonnet.inputPerM).toBeGreaterThan(0);
		expect(sonnet.outputPerM).toBeGreaterThan(0);
		expect(sonnet.cacheReadPerM).toBeGreaterThan(0);
		expect(sonnet.cacheWritePerM).toBeGreaterThan(0);
	});

	it("resolves an absent cache tier to the input rate (D1), not zero, in --json output", async () => {
		// mistral-large is two-tier in PRICING_TABLE: no published cache rates.
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(vaultPath, { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({
				budget: 50_000,
				pricing: "recommended",
				providers: [{ name: "mistral", models: ["mistral-large"] }],
			}),
			"utf-8",
		);

		await run(tempDir, { json: true });

		const calls = vi.mocked(console.log).mock.calls;
		const jsonCall = calls.find((c) => {
			try {
				JSON.parse(c[0] as string);
				return true;
			} catch {
				return false;
			}
		});
		const parsed = JSON.parse(jsonCall?.[0] as string);
		const mistral = parsed.rates["mistral-large"];
		expect(mistral.cacheReadPerM).toBe(mistral.inputPerM);
		expect(mistral.cacheWritePerM).toBe(mistral.inputPerM);
		expect(mistral.cacheReadPerM).toBeGreaterThan(0);
	});
});
