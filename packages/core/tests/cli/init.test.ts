import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/init.js";

describe("usertrust init", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-init-"));
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates the .usertrust directory structure", async () => {
		await run(tempDir);

		const vaultPath = join(tempDir, ".usertrust");
		expect(existsSync(vaultPath)).toBe(true);
		expect(existsSync(join(vaultPath, "audit"))).toBe(true);
		expect(existsSync(join(vaultPath, "policies"))).toBe(true);
		expect(existsSync(join(vaultPath, "patterns"))).toBe(true);
		expect(existsSync(join(vaultPath, "snapshots"))).toBe(true);
		expect(existsSync(join(vaultPath, "board"))).toBe(true);
		expect(existsSync(join(vaultPath, "dlq"))).toBe(true);
	});

	it("writes default usertrust.config.json", async () => {
		await run(tempDir);

		const configPath = join(tempDir, ".usertrust", "usertrust.config.json");
		expect(existsSync(configPath)).toBe(true);

		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.budget).toBe(50000);
		expect(config.tier).toBe("mini");
		expect(config.pii).toBe("warn");
		expect(config.board.enabled).toBe(false);
		expect(config.board.vetoThreshold).toBe("high");
		expect(config.circuitBreaker.failureThreshold).toBe(5);
		expect(config.circuitBreaker.resetTimeout).toBe(60000);
		expect(config.patterns.enabled).toBe(true);
		expect(config.patterns.feedProxy).toBe(false);
		expect(config.audit.rotation).toBe("daily");
		expect(config.audit.indexLimit).toBe(10000);
	});

	it("writes default policies/default.yml", async () => {
		await run(tempDir);

		const policyPath = join(tempDir, ".usertrust", "policies", "default.yml");
		expect(existsSync(policyPath)).toBe(true);

		const content = readFileSync(policyPath, "utf-8");
		expect(content).toContain("block-zero-budget");
		expect(content).toContain("warn-high-cost");
		expect(content).toContain("effect: deny");
		expect(content).toContain("effect: warn");
		expect(content).toContain("budget_remaining");
		expect(content).toContain("estimated_cost");
	});

	it("writes .gitignore", async () => {
		await run(tempDir);

		const gitignorePath = join(tempDir, ".usertrust", ".gitignore");
		expect(existsSync(gitignorePath)).toBe(true);

		const content = readFileSync(gitignorePath, "utf-8");
		expect(content).toContain("tigerbeetle/");
		expect(content).toContain("*.tigerbeetle");
		expect(content).toContain("dlq/");
	});

	it("sets vault permissions to 700", async () => {
		await run(tempDir);

		const vaultPath = join(tempDir, ".usertrust");
		const stats = statSync(vaultPath);
		// 0o700 = owner read/write/execute only
		const mode = stats.mode & 0o777;
		expect(mode).toBe(0o700);
	});

	it("prints success message", async () => {
		await run(tempDir);

		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Initialized trust vault"));
	});

	it("does not overwrite existing vault", async () => {
		await run(tempDir);
		vi.mocked(console.log).mockClear();

		// Run again — should detect existing vault
		await run(tempDir);

		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("already exists"));
	});
});
