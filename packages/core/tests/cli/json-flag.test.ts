// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Tests for --json flag across all CLI commands.
 * Verifies JSON output is valid, follows the contract, and contains no ANSI escape codes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";

// Detect ANSI escape codes in output (built dynamically to avoid Biome control-char lint)
const ESC = String.fromCodePoint(0x1b);
function hasAnsiCodes(s: string): boolean {
	return s.includes(ESC);
}

function parseJsonOutput(lines: string[]): unknown {
	const jsonLine = lines.find((l) => l.startsWith("{"));
	expect(jsonLine).toBeDefined();
	// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
	return JSON.parse(jsonLine!);
}

describe("CLI --json flag", () => {
	let tempDir: string;
	let logOutput: string[];
	let originalArgv: string[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-json-"));
		logOutput = [];
		originalArgv = [...process.argv];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map(String).join(" "));
		});
	});

	afterEach(() => {
		process.argv = originalArgv;
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	// ── init ──

	describe("init --json", () => {
		it("outputs valid JSON on success", async () => {
			const { run } = await import("../../src/cli/init.js");
			await run(tempDir, { json: true });

			const result = parseJsonOutput(logOutput) as {
				command: string;
				success: boolean;
				data: { path: string };
			};
			expect(result.command).toBe("init");
			expect(result.success).toBe(true);
			expect(result.data.path).toContain(".usertrust");
		});

		it("outputs valid JSON when vault already exists", async () => {
			const { run } = await import("../../src/cli/init.js");
			await run(tempDir, { json: true });
			logOutput = [];
			await run(tempDir, { json: true });

			const result = parseJsonOutput(logOutput) as {
				command: string;
				success: boolean;
			};
			expect(result.command).toBe("init");
			expect(result.success).toBe(false);
		});

		it("contains no ANSI escape codes in JSON output", async () => {
			const { run } = await import("../../src/cli/init.js");
			await run(tempDir, { json: true });

			for (const line of logOutput) {
				expect(hasAnsiCodes(line)).toBe(false);
			}
		});
	});

	// ── inspect ──

	describe("inspect --json", () => {
		it("outputs valid JSON for empty vault", async () => {
			const vaultPath = join(tempDir, ".usertrust");
			mkdirSync(join(vaultPath, "audit"), { recursive: true });
			writeFileSync(
				join(vaultPath, "usertrust.config.json"),
				JSON.stringify({ budget: 50000 }),
				"utf-8",
			);

			const { run } = await import("../../src/cli/inspect.js");
			await run(tempDir, { json: true });

			const result = parseJsonOutput(logOutput) as {
				command: string;
				success: boolean;
				data: { budget: number; remaining: number; transactions: unknown[] };
			};
			expect(result.command).toBe("inspect");
			expect(result.success).toBe(true);
			expect(result.data.budget).toBe(50000);
			expect(result.data.remaining).toBe(50000);
			expect(result.data.transactions).toEqual([]);
		});

		it("includes transaction data in JSON", async () => {
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

			const { run } = await import("../../src/cli/inspect.js");
			await run(tempDir, { json: true });

			const result = parseJsonOutput(logOutput) as {
				data: {
					spent: number;
					remaining: number;
					chain: { events: number; valid: boolean };
					transactions: Array<{ model: string; cost: number }>;
				};
			};
			expect(result.data.spent).toBe(142);
			expect(result.data.remaining).toBe(50000 - 142);
			expect(result.data.chain.valid).toBe(true);
			expect(result.data.transactions.length).toBe(1);
			expect(result.data.transactions[0]?.model).toBe("claude-sonnet");
		});

		it("contains no ANSI escape codes in JSON output", async () => {
			const vaultPath = join(tempDir, ".usertrust");
			mkdirSync(join(vaultPath, "audit"), { recursive: true });
			writeFileSync(
				join(vaultPath, "usertrust.config.json"),
				JSON.stringify({ budget: 50000 }),
				"utf-8",
			);

			const { run } = await import("../../src/cli/inspect.js");
			await run(tempDir, { json: true });

			for (const line of logOutput) {
				expect(hasAnsiCodes(line)).toBe(false);
			}
		});

		it("outputs JSON error when no vault", async () => {
			const { run } = await import("../../src/cli/inspect.js");
			await run(tempDir, { json: true });

			const result = parseJsonOutput(logOutput) as {
				command: string;
				success: boolean;
			};
			expect(result.command).toBe("inspect");
			expect(result.success).toBe(false);
		});
	});

	// ── health ──

	describe("health --json", () => {
		it("outputs valid JSON with score and signals", async () => {
			const vaultPath = join(tempDir, ".usertrust");
			mkdirSync(join(vaultPath, "audit"), { recursive: true });
			writeFileSync(
				join(vaultPath, "usertrust.config.json"),
				JSON.stringify({ budget: 50000 }),
				"utf-8",
			);

			const { run } = await import("../../src/cli/health.js");
			await run(tempDir, { json: true });

			const result = parseJsonOutput(logOutput) as {
				command: string;
				success: boolean;
				data: {
					score: number;
					level: string;
					signals: {
						policyViolations: number;
						budgetUtilization: number;
						chainIntegrity: boolean;
						piiDetections: number;
						circuitBreakerTrips: number;
						patternMemoryHits: number;
					};
				};
			};
			expect(result.command).toBe("health");
			expect(result.success).toBe(true);
			expect(typeof result.data.score).toBe("number");
			expect(result.data.level).toBe("healthy");
			expect(result.data.signals.chainIntegrity).toBe(true);
		});

		it("contains no ANSI escape codes in JSON output", async () => {
			const vaultPath = join(tempDir, ".usertrust");
			mkdirSync(join(vaultPath, "audit"), { recursive: true });
			writeFileSync(
				join(vaultPath, "usertrust.config.json"),
				JSON.stringify({ budget: 50000 }),
				"utf-8",
			);

			const { run } = await import("../../src/cli/health.js");
			await run(tempDir, { json: true });

			for (const line of logOutput) {
				expect(hasAnsiCodes(line)).toBe(false);
			}
		});
	});

	// ── verify ──

	describe("verify --json", () => {
		it("outputs valid JSON for empty chain", async () => {
			const vaultPath = join(tempDir, ".usertrust");
			mkdirSync(join(vaultPath, "audit"), { recursive: true });

			const { run } = await import("../../src/cli/verify.js");
			await run(tempDir, { json: true });

			const result = parseJsonOutput(logOutput) as {
				command: string;
				success: boolean;
				data: { valid: boolean; eventsVerified: number; latestHash: string };
			};
			expect(result.command).toBe("verify");
			expect(result.success).toBe(true);
			expect(result.data.valid).toBe(true);
			expect(result.data.eventsVerified).toBe(0);
		});

		it("outputs JSON with events after writing to chain", async () => {
			const vaultPath = join(tempDir, ".usertrust");
			mkdirSync(join(vaultPath, "audit"), { recursive: true });

			const writer = createAuditWriter(tempDir);
			await writer.appendEvent({ kind: "test.a", actor: "sys", data: { n: 1 } });
			await writer.appendEvent({ kind: "test.b", actor: "sys", data: { n: 2 } });
			writer.release();

			const { run } = await import("../../src/cli/verify.js");
			await run(tempDir, { json: true });

			const result = parseJsonOutput(logOutput) as {
				data: { valid: boolean; eventsVerified: number };
			};
			expect(result.data.valid).toBe(true);
			expect(result.data.eventsVerified).toBe(2);
		});

		it("contains no ANSI escape codes in JSON output", async () => {
			const vaultPath = join(tempDir, ".usertrust");
			mkdirSync(join(vaultPath, "audit"), { recursive: true });

			const { run } = await import("../../src/cli/verify.js");
			await run(tempDir, { json: true });

			for (const line of logOutput) {
				expect(hasAnsiCodes(line)).toBe(false);
			}
		});
	});

	// ── snapshot ──

	describe("snapshot --json", () => {
		it("outputs JSON for snapshot create", async () => {
			const vaultPath = join(tempDir, ".usertrust");
			mkdirSync(join(vaultPath, "audit"), { recursive: true });
			mkdirSync(join(vaultPath, "policies"), { recursive: true });
			writeFileSync(
				join(vaultPath, "usertrust.config.json"),
				JSON.stringify({ budget: 50000 }),
				"utf-8",
			);
			writeFileSync(join(vaultPath, "policies", "default.yml"), "rules: []", "utf-8");

			process.argv = ["node", "usertrust", "snapshot", "create", "test-snap"];

			const { run } = await import("../../src/cli/snapshot.js");
			await run(tempDir, { json: true });

			const result = parseJsonOutput(logOutput) as {
				command: string;
				success: boolean;
				data: { action: string; name: string; files: number };
			};
			expect(result.command).toBe("snapshot");
			expect(result.success).toBe(true);
			expect(result.data.action).toBe("create");
			expect(result.data.name).toBe("test-snap");
		});

		it("outputs JSON for snapshot list", async () => {
			const vaultPath = join(tempDir, ".usertrust");
			mkdirSync(join(vaultPath, "audit"), { recursive: true });
			mkdirSync(join(vaultPath, "policies"), { recursive: true });
			writeFileSync(
				join(vaultPath, "usertrust.config.json"),
				JSON.stringify({ budget: 50000 }),
				"utf-8",
			);
			writeFileSync(join(vaultPath, "policies", "default.yml"), "rules: []", "utf-8");

			process.argv = ["node", "usertrust", "snapshot", "create", "snap-a"];
			const { run } = await import("../../src/cli/snapshot.js");
			await run(tempDir, { json: true });

			logOutput = [];
			process.argv = ["node", "usertrust", "snapshot", "list"];
			await run(tempDir, { json: true });

			const result = parseJsonOutput(logOutput) as {
				data: { action: string; snapshots: Array<{ name: string }> };
			};
			expect(result.data.action).toBe("list");
			expect(result.data.snapshots.length).toBe(1);
			expect(result.data.snapshots[0]?.name).toBe("snap-a");
		});

		it("contains no ANSI escape codes in JSON output", async () => {
			const vaultPath = join(tempDir, ".usertrust");
			mkdirSync(vaultPath, { recursive: true });
			process.argv = ["node", "usertrust", "snapshot"];

			const { run } = await import("../../src/cli/snapshot.js");
			await run(tempDir, { json: true });

			for (const line of logOutput) {
				expect(hasAnsiCodes(line)).toBe(false);
			}
		});
	});

	// ── tb ──

	describe("tb --json", () => {
		it("outputs JSON for status", async () => {
			process.argv = ["node", "usertrust", "tb", "status"];

			const { run } = await import("../../src/cli/tb.js");
			await run({ json: true });

			const result = parseJsonOutput(logOutput) as {
				command: string;
				success: boolean;
				data: { action: string; running: boolean };
			};
			expect(result.command).toBe("tb");
			expect(result.success).toBe(true);
			expect(result.data.action).toBe("status");
			expect(typeof result.data.running).toBe("boolean");
		});

		it("outputs JSON for start stub", async () => {
			process.argv = ["node", "usertrust", "tb", "start"];

			const { run } = await import("../../src/cli/tb.js");
			await run({ json: true });

			const result = parseJsonOutput(logOutput) as {
				command: string;
				success: boolean;
				data: { action: string; message: string };
			};
			expect(result.command).toBe("tb");
			expect(result.success).toBe(false);
			expect(result.data.message).toContain("Not yet implemented");
		});

		it("contains no ANSI escape codes in JSON output", async () => {
			process.argv = ["node", "usertrust", "tb", "status"];

			const { run } = await import("../../src/cli/tb.js");
			await run({ json: true });

			for (const line of logOutput) {
				expect(hasAnsiCodes(line)).toBe(false);
			}
		});
	});
});
