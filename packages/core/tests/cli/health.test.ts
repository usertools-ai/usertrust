import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { run } from "../../src/cli/health.js";

describe("usertrust health", () => {
	let tempDir: string;
	let logOutput: string[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-health-"));
		logOutput = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map(String).join(" "));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("prints missing vault message when no vault exists", async () => {
		await run(tempDir);

		expect(logOutput.some((l) => l.includes("usertrust init"))).toBe(true);
	});

	it("prints entropy score header", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		await run(tempDir);

		const combined = logOutput.join("\n");
		expect(combined).toContain("Entropy score:");
		expect(combined).toContain("/100");
	});

	it("shows all 6 signal labels", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		await run(tempDir);

		const combined = logOutput.join("\n");
		expect(combined).toContain("Policy violations");
		expect(combined).toContain("Budget utilization");
		expect(combined).toContain("Chain integrity");
		expect(combined).toContain("PII detections");
		expect(combined).toContain("Circuit breaker trips");
		expect(combined).toContain("Pattern memory hits");
	});

	it("shows healthy status for empty vault", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		await run(tempDir);

		const combined = logOutput.join("\n");
		expect(combined).toContain("healthy");
		expect(combined).toContain("verified");
	});

	it("reports chain integrity as verified for valid chain", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({
			kind: "llm.call",
			actor: "test",
			data: { model: "claude-sonnet", cost: 100 },
		});
		writer.release();

		await run(tempDir);

		const combined = logOutput.join("\n");
		expect(combined).toContain("verified");
		expect(combined).toContain("[ok]");
	});

	it("computes budget utilization percentage", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({
			kind: "llm_call",
			actor: "test",
			data: { cost: 150 },
		});
		writer.release();

		await run(tempDir);

		const combined = logOutput.join("\n");
		// 150/50000 = 0.3%
		expect(combined).toContain("0.3%");
	});

	it("shows [ok] tags for zero-hit signals", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		await run(tempDir);

		const combined = logOutput.join("\n");
		// All signals should show [ok] for empty vault
		const okCount = (combined.match(/\[ok\]/g) ?? []).length;
		expect(okCount).toBeGreaterThanOrEqual(5);
	});
});
