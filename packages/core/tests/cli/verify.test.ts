import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { run } from "../../src/cli/verify.js";
import type { AuditEvent } from "../../src/shared/types.js";

describe("usertrust verify", () => {
	let tempDir: string;
	let logOutput: string[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-verify-cli-"));
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

	it("verifies empty chain successfully", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });

		await run(tempDir);

		const combined = logOutput.join("\n");
		expect(combined).toContain("Chain verified");
		expect(combined).toContain("0 events");
	});

	it("verifies valid chain with events", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });

		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({ kind: "test.a", actor: "sys", data: { n: 1 } });
		await writer.appendEvent({ kind: "test.b", actor: "sys", data: { n: 2 } });
		await writer.appendEvent({ kind: "test.c", actor: "sys", data: { n: 3 } });
		writer.release();

		await run(tempDir);

		const combined = logOutput.join("\n");
		expect(combined).toContain("Chain verified");
		expect(combined).toContain("3 events");
		expect(combined).toContain("Latest hash:");
	});

	it("reports failure for tampered chain", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });

		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({ kind: "test.a", actor: "sys", data: { n: 1 } });
		await writer.appendEvent({ kind: "test.b", actor: "sys", data: { n: 2 } });
		writer.release();

		// Tamper with data
		const logPath = join(vaultPath, "audit", "events.jsonl");
		const content = readFileSync(logPath, "utf-8").trim();
		const lines = content.split("\n");
		const firstLine = lines[0];
		if (!firstLine) throw new Error("Expected at least one line");
		const event = JSON.parse(firstLine) as AuditEvent;
		(event.data as Record<string, unknown>).n = 999;
		lines[0] = JSON.stringify(event);
		writeFileSync(logPath, `${lines.join("\n")}\n`);

		await run(tempDir);

		const combined = logOutput.join("\n");
		expect(combined).toContain("FAILED");
		expect(combined).toContain("error");
	});
});
