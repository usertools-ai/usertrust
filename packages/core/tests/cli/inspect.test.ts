import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { run } from "../../src/cli/inspect.js";

describe("usertrust inspect", () => {
	let tempDir: string;
	let logOutput: string[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-inspect-"));
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

	it("prints header with budget info", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		await run(tempDir);

		const combined = logOutput.join("\n");
		expect(combined).toContain("usertrust governance vault");
		expect(combined).toContain("Budget:");
		expect(combined).toContain("50,000");
	});

	it("shows chain stats after writing events", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		// Write some audit events
		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({
			kind: "llm.call",
			actor: "test",
			data: { model: "claude-sonnet", cost: 142, transferId: "tx_m4k7r2_a1b2c3" },
		});
		await writer.appendEvent({
			kind: "llm.call",
			actor: "test",
			data: { model: "gpt-4o", cost: 200, transferId: "tx_x9y8z7_d4e5f6" },
		});
		writer.release();

		await run(tempDir);

		const combined = logOutput.join("\n");
		expect(combined).toContain("2 events");
		expect(combined).toContain("SHA-256 verified");
		expect(combined).toContain("claude-sonne"); // truncated to 12-char column
		expect(combined).toContain("142 UT");
	});

	it("displays table headers", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		await run(tempDir);

		const combined = logOutput.join("\n");
		expect(combined).toContain("Time");
		expect(combined).toContain("Model");
		expect(combined).toContain("Cost");
		expect(combined).toContain("Receipt");
	});

	it("shows 'no transactions' when audit log is empty", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		await run(tempDir);

		const combined = logOutput.join("\n");
		expect(combined).toContain("No transactions recorded");
	});

	it("computes remaining budget from costs in events", async () => {
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
			data: { model: "claude-sonnet", cost: 142 },
		});
		writer.release();

		await run(tempDir);

		const combined = logOutput.join("\n");
		// 50000 - 142 = 49858
		expect(combined).toContain("49,858");
	});
});
