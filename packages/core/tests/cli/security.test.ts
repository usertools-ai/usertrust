import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock tigerbeetle-node (native module, never loaded in tests)
vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: {
		linked: 1,
		pending: 2,
		post_pending_transfer: 4,
		void_pending_transfer: 8,
	},
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

// ── Test helpers ──

function makeTmpDir(): string {
	const dir = join(tmpdir(), `trust-security-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ── Tests ──

describe("vault security", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	it("default config template contains no API key placeholders", async () => {
		// Run the init command to create the vault
		const { run } = await import("../../src/cli/init.js");
		await run(tmpDir);

		const configPath = join(tmpDir, ".usertrust", "usertrust.config.json");
		expect(existsSync(configPath)).toBe(true);

		const configContent = readFileSync(configPath, "utf-8");
		const configLower = configContent.toLowerCase();

		// Ensure no API key, secret, or token placeholder fields in config
		expect(configLower).not.toContain('"api_key"');
		expect(configLower).not.toContain('"apikey"');
		expect(configLower).not.toContain('"secret"');
		expect(configLower).not.toContain('"token"');
		expect(configLower).not.toContain("sk-");
		expect(configLower).not.toContain("sk_live");
		expect(configLower).not.toContain("sk_test");
		expect(configLower).not.toContain("pk_live");
		expect(configLower).not.toContain("pk_test");
	});

	it(".gitignore in vault excludes tigerbeetle/ but includes audit/", async () => {
		const { run } = await import("../../src/cli/init.js");
		await run(tmpDir);

		const gitignorePath = join(tmpDir, ".usertrust", ".gitignore");
		expect(existsSync(gitignorePath)).toBe(true);

		const gitignoreContent = readFileSync(gitignorePath, "utf-8");

		// tigerbeetle data must be excluded (contains binary ledger data)
		expect(gitignoreContent).toContain("tigerbeetle/");

		// audit/ should NOT be in .gitignore (audit chain is the source of truth)
		expect(gitignoreContent).not.toContain("audit/");
	});

	it(".gitignore excludes dead-letter queue", async () => {
		const { run } = await import("../../src/cli/init.js");
		await run(tmpDir);

		const gitignorePath = join(tmpDir, ".usertrust", ".gitignore");
		const gitignoreContent = readFileSync(gitignorePath, "utf-8");

		// DLQ contains error payloads — should be excluded
		expect(gitignoreContent).toContain("dlq/");
	});

	it("vault directory is created with 700 permissions (owner-only)", async () => {
		const { run } = await import("../../src/cli/init.js");
		await run(tmpDir);

		const vaultPath = join(tmpDir, ".usertrust");
		const { statSync } = await import("node:fs");
		const stats = statSync(vaultPath);

		// 0o700 = rwx------
		const mode = stats.mode & 0o777;
		expect(mode).toBe(0o700);
	});

	it("default policy file does not contain secrets", async () => {
		const { run } = await import("../../src/cli/init.js");
		await run(tmpDir);

		const policyPath = join(tmpDir, ".usertrust", "policies", "default.yml");
		expect(existsSync(policyPath)).toBe(true);

		const policyContent = readFileSync(policyPath, "utf-8");
		const policyLower = policyContent.toLowerCase();

		expect(policyLower).not.toContain("api_key");
		expect(policyLower).not.toContain("secret");
		expect(policyLower).not.toContain("password");
		expect(policyLower).not.toContain("sk-");
	});

	it("init does not overwrite existing vault", async () => {
		const { run } = await import("../../src/cli/init.js");

		// First init
		await run(tmpDir);

		// Modify the config to detect if it gets overwritten
		const configPath = join(tmpDir, ".usertrust", "usertrust.config.json");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(configPath, JSON.stringify({ budget: 99999, modified: true }));

		// Second init — should NOT overwrite
		await run(tmpDir);

		const content = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(content) as Record<string, unknown>;
		expect(parsed.modified).toBe(true);
		expect(parsed.budget).toBe(99999);
	});
});
