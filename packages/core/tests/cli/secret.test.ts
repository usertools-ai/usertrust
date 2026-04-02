// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Tests for the `usertrust secret` CLI subcommand — add, rm, ls, get, rotate.
 *
 * Each test gets a fresh temp directory with a valid vault config so
 * the encrypted credential store can initialise cleanly.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/secret.js";

// ── Helpers ──

const TEST_VAULT_KEY = "test-cli-vault-key-2026";

function makeTmpDir(): string {
	const dir = join(tmpdir(), `trust-secret-cli-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Create the minimal vault config required by createVaultStore. */
function writeVaultConfig(dir: string): void {
	const vaultDir = join(dir, ".usertrust");
	mkdirSync(vaultDir, { recursive: true });
	writeFileSync(
		join(vaultDir, "usertrust.config.json"),
		JSON.stringify({
			budget: 10_000,
			vault: { enabled: true, auditAccess: false },
		}),
		"utf-8",
	);
}

/**
 * Set process.argv so parseFlags() sees the given CLI tokens.
 * The first two entries (`node` + `script`) are stripped by parseFlags
 * via `process.argv.slice(2)`.
 */
function setArgv(...tokens: string[]): void {
	process.argv = ["node", "usertrust", ...tokens];
}

// ── Test suite ──

describe("usertrust secret", () => {
	let tmpDir: string;
	let origCwd: string;
	let origArgv: string[];
	let origVaultKey: string | undefined;
	let logOutput: string[];
	let errorOutput: string[];

	beforeEach(() => {
		tmpDir = makeTmpDir();
		writeVaultConfig(tmpDir);

		origCwd = process.cwd();
		process.chdir(tmpDir);

		origArgv = process.argv;
		origVaultKey = process.env.USERTRUST_VAULT_KEY;
		process.env.USERTRUST_VAULT_KEY = TEST_VAULT_KEY;
		process.exitCode = undefined;

		logOutput = [];
		errorOutput = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errorOutput.push(args.map(String).join(" "));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.argv = origArgv;
		process.chdir(origCwd);
		process.exitCode = undefined;

		if (origVaultKey === undefined) {
			// biome-ignore lint/performance/noDelete: must remove env var
			delete process.env.USERTRUST_VAULT_KEY;
		} else {
			process.env.USERTRUST_VAULT_KEY = origVaultKey;
		}

		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	// ─────────────────────────────────────────────────────────────────
	// 1. prints usage for unknown subcommand
	// ─────────────────────────────────────────────────────────────────

	it("prints usage for unknown subcommand", async () => {
		setArgv("secret", "bogus");
		await run();

		const combined = logOutput.join("\n");
		expect(combined).toContain("Usage: usertrust secret");
		expect(combined).toContain("<add|rm|ls|get|rotate>");
	});

	// ─────────────────────────────────────────────────────────────────
	// 2. prints usage when no subcommand given
	// ─────────────────────────────────────────────────────────────────

	it("prints usage when no subcommand given", async () => {
		setArgv("secret");
		await run();

		const combined = logOutput.join("\n");
		expect(combined).toContain("Usage: usertrust secret");
	});

	// ─────────────────────────────────────────────────────────────────
	// 3. add + ls shows credential
	// ─────────────────────────────────────────────────────────────────

	it("add + ls shows credential", async () => {
		setArgv("secret", "add", "MY_API_KEY", "sk-test-123");
		await run();
		expect(logOutput.some((l) => l.includes("stored"))).toBe(true);

		logOutput = [];
		setArgv("secret", "ls");
		await run();

		const combined = logOutput.join("\n");
		expect(combined).toContain("MY_API_KEY");
	});

	// ─────────────────────────────────────────────────────────────────
	// 4. add + get with correct scope returns value
	// ─────────────────────────────────────────────────────────────────

	it("add + get with correct scope returns value", async () => {
		setArgv("secret", "add", "GET_KEY", "secret-value-42");
		await run();

		const stdoutChunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(
			(...args: Parameters<typeof process.stdout.write>): boolean => {
				const chunk = args[0];
				if (typeof chunk === "string") stdoutChunks.push(chunk);
				else stdoutChunks.push(chunk.toString());
				return true;
			},
		);

		logOutput = [];
		setArgv("secret", "get", "GET_KEY");
		await run();

		// In non-JSON mode, granted get uses process.stdout.write
		const combined = stdoutChunks.join("");
		expect(combined).toContain("secret-value-42");
	});

	// ─────────────────────────────────────────────────────────────────
	// 5. get with wrong agent denied
	// ─────────────────────────────────────────────────────────────────

	it("get with wrong agent denied", async () => {
		// Add credential scoped to a specific agent (not "cli")
		// We go through the vault store directly since CLI add doesn't expose scope flags.
		const { loadConfig } = await import("../../src/config.js");
		const { createAuditWriter } = await import("../../src/audit/chain.js");
		const { createVaultStore } = await import("../../src/vault/store.js");

		const config = await loadConfig(undefined, tmpDir);
		const audit = createAuditWriter(tmpDir);
		const vault = await createVaultStore({ vaultBase: tmpDir, config, audit });
		await vault.add("SCOPED_AGENT_KEY", "agent-secret", { agents: ["special-agent"] });
		vault.destroy();
		audit.release();

		logOutput = [];
		setArgv("secret", "get", "SCOPED_AGENT_KEY");
		await run();

		// CLI get uses agent="cli" which is not in scope
		const combined = logOutput.join("\n");
		expect(combined).toContain("not in the allowed agents list");
	});

	// ─────────────────────────────────────────────────────────────────
	// 6. get with wrong action denied
	// ─────────────────────────────────────────────────────────────────

	it("get with wrong action denied", async () => {
		// Add credential scoped to actions that don't include "tool_use"
		const { loadConfig } = await import("../../src/config.js");
		const { createAuditWriter } = await import("../../src/audit/chain.js");
		const { createVaultStore } = await import("../../src/vault/store.js");

		const config = await loadConfig(undefined, tmpDir);
		const audit = createAuditWriter(tmpDir);
		const vault = await createVaultStore({ vaultBase: tmpDir, config, audit });
		await vault.add("SCOPED_ACTION_KEY", "action-secret", { actions: ["llm_call"] });
		vault.destroy();
		audit.release();

		logOutput = [];
		setArgv("secret", "get", "SCOPED_ACTION_KEY");
		await run();

		// CLI get uses action="tool_use" which is not in scope
		const combined = logOutput.join("\n");
		expect(combined).toContain("not in the allowed actions list");
	});

	// ─────────────────────────────────────────────────────────────────
	// 7. rm + ls shows credential removed
	// ─────────────────────────────────────────────────────────────────

	it("rm + ls shows credential removed", async () => {
		setArgv("secret", "add", "RM_KEY", "to-be-removed");
		await run();

		logOutput = [];
		setArgv("secret", "rm", "RM_KEY");
		await run();
		expect(logOutput.some((l) => l.includes("removed"))).toBe(true);

		logOutput = [];
		setArgv("secret", "ls");
		await run();

		const combined = logOutput.join("\n");
		expect(combined).not.toContain("RM_KEY");
		expect(combined).toContain("No credentials stored");
	});

	// ─────────────────────────────────────────────────────────────────
	// 8. rotate + get returns new value
	// ─────────────────────────────────────────────────────────────────

	it("rotate + get returns new value", async () => {
		setArgv("secret", "add", "ROT_KEY", "old-value");
		await run();

		logOutput = [];
		setArgv("secret", "rotate", "ROT_KEY", "new-value");
		await run();
		expect(logOutput.some((l) => l.includes("rotated"))).toBe(true);

		const stdoutChunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(
			(...args: Parameters<typeof process.stdout.write>): boolean => {
				const chunk = args[0];
				if (typeof chunk === "string") stdoutChunks.push(chunk);
				else stdoutChunks.push(chunk.toString());
				return true;
			},
		);

		logOutput = [];
		setArgv("secret", "get", "ROT_KEY");
		await run();

		const combined = stdoutChunks.join("");
		expect(combined).toContain("new-value");
		expect(combined).not.toContain("old-value");
	});

	// ─────────────────────────────────────────────────────────────────
	// 9. ls --json returns valid JSON array
	// ─────────────────────────────────────────────────────────────────

	it("ls --json returns valid JSON array", async () => {
		setArgv("secret", "add", "JSON_KEY", "json-val");
		await run();

		logOutput = [];
		setArgv("secret", "ls", "--json");
		await run(undefined, { json: true });

		const raw = logOutput.join("\n");
		const parsed = JSON.parse(raw) as { command: string; success: boolean; data: unknown[] };
		expect(parsed.command).toBe("secret ls");
		expect(parsed.success).toBe(true);
		expect(Array.isArray(parsed.data)).toBe(true);
		expect(parsed.data).toHaveLength(1);
		expect((parsed.data[0] as Record<string, unknown>).name).toBe("JSON_KEY");
	});

	// ─────────────────────────────────────────────────────────────────
	// 10. get --json returns value in JSON
	// ─────────────────────────────────────────────────────────────────

	it("get --json returns value in JSON", async () => {
		setArgv("secret", "add", "JGET_KEY", "json-secret");
		await run();

		const stdoutChunks: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		vi.spyOn(process.stdout, "write").mockImplementation(
			(...args: Parameters<typeof process.stdout.write>): boolean => {
				const chunk = args[0];
				if (typeof chunk === "string") stdoutChunks.push(chunk);
				else stdoutChunks.push(chunk.toString());
				return true;
			},
		);

		logOutput = [];
		setArgv("secret", "get", "JGET_KEY", "--json");
		await run(undefined, { json: true });

		const raw = stdoutChunks.join("");
		const parsed = JSON.parse(raw) as {
			command: string;
			success: boolean;
			data: Record<string, unknown>;
		};
		expect(parsed.command).toBe("secret get");
		expect(parsed.success).toBe(true);
		expect(parsed.data.name).toBe("JGET_KEY");
		expect(parsed.data.value).toBe("json-secret");
	});

	// ─────────────────────────────────────────────────────────────────
	// 11. add with --expires sets expiration (via vault store directly)
	// ─────────────────────────────────────────────────────────────────

	it("add with expiration scope is visible in ls --json", async () => {
		// The CLI add subcommand does not expose --expires, so we add via
		// the vault store directly and verify ls renders the scope.
		const { loadConfig } = await import("../../src/config.js");
		const { createAuditWriter } = await import("../../src/audit/chain.js");
		const { createVaultStore } = await import("../../src/vault/store.js");

		const futureDate = new Date(Date.now() + 3_600_000).toISOString();
		const config = await loadConfig(undefined, tmpDir);
		const audit = createAuditWriter(tmpDir);
		const vault = await createVaultStore({ vaultBase: tmpDir, config, audit });
		await vault.add("EXPIRING_KEY", "will-expire", { expiresAt: futureDate });
		vault.destroy();
		audit.release();

		logOutput = [];
		setArgv("secret", "ls", "--json");
		await run(undefined, { json: true });

		const raw = logOutput.join("\n");
		const envelope = JSON.parse(raw) as {
			command: string;
			success: boolean;
			data: Array<Record<string, unknown>>;
		};
		expect(envelope.command).toBe("secret ls");
		expect(envelope.success).toBe(true);
		expect(envelope.data).toHaveLength(1);
		const scope = envelope.data[0].scope as Record<string, unknown>;
		expect(scope.expiresAt).toBe(futureDate);
	});

	// ─────────────────────────────────────────────────────────────────
	// 12. missing vault key prints error
	// ─────────────────────────────────────────────────────────────────

	it("missing vault key prints error", async () => {
		// biome-ignore lint/performance/noDelete: must remove env var
		delete process.env.USERTRUST_VAULT_KEY;

		setArgv("secret", "ls");
		await expect(run()).rejects.toThrow("USERTRUST_VAULT_KEY");
	});

	// ─────────────────────────────────────────────────────────────────
	// 13. missing name on get prints usage
	// ─────────────────────────────────────────────────────────────────

	it("missing name on get prints usage", async () => {
		setArgv("secret", "get");
		await run();

		const combined = logOutput.join("\n");
		expect(combined).toContain("Usage: usertrust secret get");
	});
});
