import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

import { defineConfig, loadConfig } from "../../src/config.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

// ── Test helpers ──

function makeTmpDir(): string {
	const dir = join(tmpdir(), `trust-config-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ── Tests ──

describe("loadConfig()", () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		originalCwd = process.cwd();
		process.chdir(tmpDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	it("loads config from existing usertrust.config.json", async () => {
		const vaultDir = join(tmpDir, VAULT_DIR);
		mkdirSync(vaultDir, { recursive: true });
		writeFileSync(
			join(vaultDir, "usertrust.config.json"),
			JSON.stringify({ budget: 25_000, tier: "pro" }),
		);

		const config = await loadConfig();

		expect(config.budget).toBe(25_000);
		expect(config.tier).toBe("pro");
		// Defaults should be filled in
		expect(config.pii).toBe("warn");
		expect(config.patterns.enabled).toBe(true);
		expect(config.circuitBreaker.failureThreshold).toBe(5);
		expect(config.audit.rotation).toBe("daily");
	});

	it("uses defaults when no config file exists", async () => {
		// No config file — should use Zod defaults
		// loadConfig requires at least `budget` to be provided via overrides
		// when no file exists, so we pass budget
		const config = await loadConfig({ budget: 50_000 });

		expect(config.budget).toBe(50_000);
		expect(config.tier).toBe("mini");
		expect(config.pii).toBe("warn");
		expect(config.policies).toBe("./policies/default.yml");
		expect(config.board.enabled).toBe(false);
		expect(config.board.vetoThreshold).toBe("high");
		expect(config.circuitBreaker.failureThreshold).toBe(5);
		expect(config.circuitBreaker.resetTimeout).toBe(60_000);
		expect(config.patterns.enabled).toBe(true);
		expect(config.patterns.feedProxy).toBe(false);
		expect(config.audit.rotation).toBe("daily");
		expect(config.audit.indexLimit).toBe(10_000);
	});

	it("merges overrides with config file values", async () => {
		const vaultDir = join(tmpDir, VAULT_DIR);
		mkdirSync(vaultDir, { recursive: true });
		writeFileSync(
			join(vaultDir, "usertrust.config.json"),
			JSON.stringify({ budget: 10_000, tier: "free", pii: "block" }),
		);

		const config = await loadConfig({ budget: 99_000, tier: "ultra" });

		// Overrides win
		expect(config.budget).toBe(99_000);
		expect(config.tier).toBe("ultra");
		// File value preserved when no override
		expect(config.pii).toBe("block");
	});

	it("ignores undefined override values", async () => {
		const vaultDir = join(tmpDir, VAULT_DIR);
		mkdirSync(vaultDir, { recursive: true });
		writeFileSync(
			join(vaultDir, "usertrust.config.json"),
			JSON.stringify({ budget: 10_000, tier: "pro" }),
		);

		const config = await loadConfig({ budget: undefined, tier: undefined });

		// Original values preserved since overrides are undefined
		expect(config.budget).toBe(10_000);
		expect(config.tier).toBe("pro");
	});

	it("throws ZodError for invalid config", async () => {
		const vaultDir = join(tmpDir, VAULT_DIR);
		mkdirSync(vaultDir, { recursive: true });
		writeFileSync(
			join(vaultDir, "usertrust.config.json"),
			JSON.stringify({ budget: -100 }), // budget must be positive int
		);

		await expect(loadConfig()).rejects.toThrow();
	});

	it("throws ZodError for invalid budget type", async () => {
		const vaultDir = join(tmpDir, VAULT_DIR);
		mkdirSync(vaultDir, { recursive: true });
		writeFileSync(
			join(vaultDir, "usertrust.config.json"),
			JSON.stringify({ budget: "not-a-number" }),
		);

		await expect(loadConfig()).rejects.toThrow();
	});

	it("throws ZodError for invalid tier value", async () => {
		const vaultDir = join(tmpDir, VAULT_DIR);
		mkdirSync(vaultDir, { recursive: true });
		writeFileSync(
			join(vaultDir, "usertrust.config.json"),
			JSON.stringify({ budget: 1000, tier: "invalid-tier" }),
		);

		await expect(loadConfig()).rejects.toThrow();
	});

	it("throws ZodError for non-integer budget", async () => {
		const vaultDir = join(tmpDir, VAULT_DIR);
		mkdirSync(vaultDir, { recursive: true });
		writeFileSync(join(vaultDir, "usertrust.config.json"), JSON.stringify({ budget: 100.5 }));

		await expect(loadConfig()).rejects.toThrow();
	});

	it("handles config with all fields populated", async () => {
		const vaultDir = join(tmpDir, VAULT_DIR);
		mkdirSync(vaultDir, { recursive: true });
		writeFileSync(
			join(vaultDir, "usertrust.config.json"),
			JSON.stringify({
				budget: 100_000,
				tier: "mega",
				pii: "redact",
				policies: "./custom-policies.yml",
				board: { enabled: true, vetoThreshold: "critical" },
				circuitBreaker: { failureThreshold: 10, resetTimeout: 120_000 },
				patterns: { enabled: false, feedProxy: true },
				audit: { rotation: "weekly", indexLimit: 50_000 },
			}),
		);

		const config = await loadConfig();

		expect(config.budget).toBe(100_000);
		expect(config.tier).toBe("mega");
		expect(config.pii).toBe("redact");
		expect(config.policies).toBe("./custom-policies.yml");
		expect(config.board.enabled).toBe(true);
		expect(config.board.vetoThreshold).toBe("critical");
		expect(config.circuitBreaker.failureThreshold).toBe(10);
		expect(config.circuitBreaker.resetTimeout).toBe(120_000);
		expect(config.patterns.enabled).toBe(false);
		expect(config.patterns.feedProxy).toBe(true);
		expect(config.audit.rotation).toBe("weekly");
		expect(config.audit.indexLimit).toBe(50_000);
	});

	it("handles malformed JSON gracefully (throws)", async () => {
		const vaultDir = join(tmpDir, VAULT_DIR);
		mkdirSync(vaultDir, { recursive: true });
		writeFileSync(join(vaultDir, "usertrust.config.json"), "{ not valid json }");

		await expect(loadConfig()).rejects.toThrow();
	});
});

describe("defineConfig()", () => {
	it("returns a parsed config with defaults filled in", () => {
		const config = defineConfig({
			budget: 50_000,
			tier: "mini",
			pii: "warn",
			policies: "./policies/default.yml",
			board: { enabled: false, vetoThreshold: "high" },
			circuitBreaker: { failureThreshold: 5, resetTimeout: 60_000 },
			patterns: { enabled: true, feedProxy: false },
			audit: { rotation: "daily", indexLimit: 10_000 },
		});

		expect(config.budget).toBe(50_000);
		expect(config.tier).toBe("mini");
		expect(config.pii).toBe("warn");
	});

	it("validates and returns a full config", () => {
		const input = {
			budget: 100,
			tier: "ultra" as const,
			pii: "block" as const,
			policies: "./p.yml",
			board: { enabled: true, vetoThreshold: "low" as const },
			circuitBreaker: { failureThreshold: 3, resetTimeout: 30_000 },
			patterns: { enabled: false, feedProxy: true },
			audit: { rotation: "none" as const, indexLimit: 500 },
		};

		const config = defineConfig(input);

		expect(config.budget).toBe(100);
		expect(config.tier).toBe("ultra");
		expect(config.pii).toBe("block");
		expect(config.board.enabled).toBe(true);
	});

	it("throws for invalid config input", () => {
		expect(() =>
			defineConfig({
				budget: -1,
			} as never),
		).toThrow();
	});
});
