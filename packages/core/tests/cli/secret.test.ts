// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Tests for the `usertrust secret` CLI subcommand — add, rm, ls, get, rotate.
 *
 * Each test gets a fresh temp directory with a valid vault config so
 * the encrypted credential store can initialise cleanly.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

	// -----------------------------------------------------------------
	// 14. an audit log whose last event has no sequence is refused
	// -----------------------------------------------------------------

	describe("an audit log whose last line is not an event with a sequence", () => {
		const logPath = () => join(tmpDir, ".usertrust", "audit", "events.jsonl");
		const credPath = () => join(tmpDir, ".usertrust", "credentials.enc");
		let before: Buffer;

		beforeEach(() => {
			mkdirSync(join(tmpDir, ".usertrust", "audit"), { recursive: true });
			writeFileSync(logPath(), '{"id":"a","hash":"h1"}\n{"id":"b","hash":"h2"}\n');
			before = readFileSync(logPath());
		});

		it("secret add exits 1 with the reason, and nothing is stored", async () => {
			setArgv("secret", "add", "REFUSED_KEY", "never-stored");
			await run();

			expect(process.exitCode).toBe(1);
			const combined = [...logOutput, ...errorOutput].join("\n");
			expect(combined).toContain("not an event with a sequence (line 2)");
			expect(combined).toContain("events.jsonl");
			expect(combined).not.toContain("stored.");
			expect(existsSync(credPath())).toBe(false);
			expect(readFileSync(logPath()).equals(before)).toBe(true);
		});

		it("secret add --json reports success: false with the reason", async () => {
			setArgv("secret", "add", "REFUSED_KEY", "never-stored", "--json");
			await run(undefined, { json: true });

			expect(process.exitCode).toBe(1);
			const parsed = JSON.parse(logOutput.join("\n")) as {
				command: string;
				success: boolean;
				data: { error?: unknown };
			};
			expect(parsed.command).toBe("secret add");
			expect(parsed.success).toBe(false);
			expect(String(parsed.data.error)).toContain("not an event with a sequence (line 2)");
			expect(existsSync(credPath())).toBe(false);
			expect(readFileSync(logPath()).equals(before)).toBe(true);
		});

		/** A credential put in the store directly, with no audit writer. */
		async function storeDirectly(name: string, value: string): Promise<void> {
			const { loadConfig } = await import("../../src/config.js");
			const { createVaultStore } = await import("../../src/vault/store.js");
			const config = await loadConfig(undefined, tmpDir);
			const vault = await createVaultStore({ vaultBase: tmpDir, config });
			await vault.add(name, value);
			vault.destroy();
		}

		/** The value the store holds for `name`, read directly, with no audit writer. */
		async function storedValue(name: string): Promise<string | undefined> {
			const { loadConfig } = await import("../../src/config.js");
			const { createVaultStore } = await import("../../src/vault/store.js");
			const config = await loadConfig(undefined, tmpDir);
			const vault = await createVaultStore({ vaultBase: tmpDir, config });
			const result = await vault.get(name, { agent: "cli", action: "tool_use" });
			vault.destroy();
			return result.granted ? result.value : undefined;
		}

		it("secret ls lists the credentials and exits 0: listing never appends to the audit log", async () => {
			await storeDirectly("LISTED_KEY", "listed-value");

			setArgv("secret", "ls");
			await run();

			expect(process.exitCode).toBeUndefined();
			const combined = [...logOutput, ...errorOutput].join("\n");
			expect(combined).toContain("LISTED_KEY");
			expect(combined).not.toContain("not an event with a sequence");
			expect(readFileSync(logPath()).equals(before)).toBe(true);
			expect(existsSync(join(tmpDir, ".usertrust", "audit", ".audit-writer.lock"))).toBe(false);
		});

		it("secret ls --json lists the credentials with success: true", async () => {
			await storeDirectly("LISTED_KEY", "listed-value");

			setArgv("secret", "ls", "--json");
			await run(undefined, { json: true });

			expect(process.exitCode).toBeUndefined();
			const parsed = JSON.parse(logOutput.join("\n")) as {
				command: string;
				success: boolean;
				data: Array<{ name?: unknown }>;
			};
			expect(parsed.command).toBe("secret ls");
			expect(parsed.success).toBe(true);
			expect(parsed.data.map((e) => e.name)).toEqual(["LISTED_KEY"]);
			expect(readFileSync(logPath()).equals(before)).toBe(true);
		});

		for (const [sub, args] of [
			["rm", ["KEPT_KEY"]],
			["rotate", ["KEPT_KEY", "new-value"]],
			["get", ["KEPT_KEY"]],
		] as const) {
			it(`secret ${sub} still refuses, exits 1, and the stored credential is unchanged`, async () => {
				await storeDirectly("KEPT_KEY", "kept-value");
				const stdoutChunks: string[] = [];
				vi.spyOn(process.stdout, "write").mockImplementation(
					(...a: Parameters<typeof process.stdout.write>): boolean => {
						stdoutChunks.push(String(a[0]));
						return true;
					},
				);

				setArgv("secret", sub, ...args);
				await run();

				expect(process.exitCode).toBe(1);
				const combined = [...logOutput, ...errorOutput].join("\n");
				expect(combined).toContain("not an event with a sequence (line 2)");
				expect(stdoutChunks.join("")).not.toContain("kept-value");
				expect(await storedValue("KEPT_KEY")).toBe("kept-value");
				expect(readFileSync(logPath()).equals(before)).toBe(true);
			});
		}
	});
});
