import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
