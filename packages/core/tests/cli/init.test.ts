import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @clack/prompts before importing init
vi.mock("@clack/prompts", () => ({
	intro: vi.fn(),
	outro: vi.fn(),
	text: vi.fn(),
	confirm: vi.fn(),
	log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), message: vi.fn() },
	spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
	isCancel: vi.fn(() => false),
}));

// Mock key validation to avoid network calls
vi.mock("../../src/cli/validate-key.js", () => ({
	detectProvider: vi.fn((key: string) => {
		if (key.startsWith("sk-ant-")) return "anthropic";
		if (key.startsWith("sk-")) return "openai";
		return null;
	}),
	validateKey: vi.fn().mockResolvedValue({ valid: true }),
	maskKey: vi.fn((key: string) => `${key.slice(0, 8)}••••••••`),
}));

import * as clack from "@clack/prompts";
import { run } from "../../src/cli/init.js";

describe("usertrust init (interactive)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-init-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates vault with one API key and recommended rates", async () => {
		vi.mocked(clack.text)
			.mockResolvedValueOnce("sk-ant-api03-testkey123") // first key
			.mockResolvedValueOnce("")                         // empty = done
			.mockResolvedValueOnce("50");                      // budget
		vi.mocked(clack.confirm).mockResolvedValueOnce(true);  // recommended rates

		await run(tempDir);

		const configPath = join(tempDir, ".usertrust", "usertrust.config.json");
		expect(existsSync(configPath)).toBe(true);

		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.budget).toBe(500_000); // $50 × 10,000
		expect(config.providers).toHaveLength(1);
		expect(config.providers[0].name).toBe("anthropic");
		expect(config.pricing).toBe("recommended");
	});

	it("creates .env with API keys", async () => {
		vi.mocked(clack.text)
			.mockResolvedValueOnce("sk-ant-api03-testkey123")
			.mockResolvedValueOnce("sk-proj-openai-key456")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("100");
		vi.mocked(clack.confirm).mockResolvedValueOnce(true);

		await run(tempDir);

		const envPath = join(tempDir, ".usertrust", ".env");
		expect(existsSync(envPath)).toBe(true);

		const envContent = readFileSync(envPath, "utf-8");
		expect(envContent).toContain("ANTHROPIC_API_KEY=sk-ant-api03-testkey123");
		expect(envContent).toContain("OPENAI_API_KEY=sk-proj-openai-key456");
	});

	it("writes .gitignore with .env entry", async () => {
		vi.mocked(clack.text)
			.mockResolvedValueOnce("sk-ant-api03-testkey123")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("50");
		vi.mocked(clack.confirm).mockResolvedValueOnce(true);

		await run(tempDir);

		const gitignore = readFileSync(join(tempDir, ".usertrust", ".gitignore"), "utf-8");
		expect(gitignore).toContain(".env");
	});

	it("sets vault permissions to 700", async () => {
		vi.mocked(clack.text)
			.mockResolvedValueOnce("sk-ant-api03-testkey123")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("50");
		vi.mocked(clack.confirm).mockResolvedValueOnce(true);

		await run(tempDir);

		const stats = statSync(join(tempDir, ".usertrust"));
		expect(stats.mode & 0o777).toBe(0o700);
	});

	it("does not overwrite existing vault without --reconfigure", async () => {
		vi.mocked(clack.text)
			.mockResolvedValueOnce("sk-ant-api03-testkey123")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("50");
		vi.mocked(clack.confirm).mockResolvedValueOnce(true);
		await run(tempDir);

		// Second init — should warn
		await run(tempDir);
		expect(clack.log.warn).toHaveBeenCalled();
	});

	it("converts dollar budget to usertokens", async () => {
		vi.mocked(clack.text)
			.mockResolvedValueOnce("sk-ant-api03-testkey123")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("100.50"); // $100.50
		vi.mocked(clack.confirm).mockResolvedValueOnce(true);

		await run(tempDir);

		const config = JSON.parse(
			readFileSync(join(tempDir, ".usertrust", "usertrust.config.json"), "utf-8"),
		);
		expect(config.budget).toBe(1_005_000); // $100.50 × 10,000
	});

	it("--json flag produces non-interactive output with defaults", async () => {
		await run(tempDir, { json: true });

		const configPath = join(tempDir, ".usertrust", "usertrust.config.json");
		expect(existsSync(configPath)).toBe(true);

		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.budget).toBe(50_000); // default
		expect(config.providers).toEqual([]);
		expect(config.pricing).toBe("recommended");
	});
});
