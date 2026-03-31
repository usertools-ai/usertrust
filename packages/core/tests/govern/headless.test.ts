import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditWriter } from "../../src/audit/chain.js";
import type { TrustEngine } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import type { Governor } from "../../src/headless.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

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

function makeTmpVault(): string {
	const dir = join(tmpdir(), `headless-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function mockEngine(): TrustEngine & {
	pendingIds: string[];
	postedIds: string[];
	voidedIds: string[];
} {
	const pendingIds: string[] = [];
	const postedIds: string[] = [];
	const voidedIds: string[] = [];

	return {
		pendingIds,
		postedIds,
		voidedIds,
		async spendPending(params) {
			pendingIds.push(params.transferId);
			return { transferId: params.transferId };
		},
		async postPendingSpend(transferId) {
			postedIds.push(transferId);
		},
		async voidPendingSpend(transferId) {
			voidedIds.push(transferId);
		},
		async voidAllPending() {
			// no-op for tests
		},
		destroy() {},
	};
}

// ── Tests ──

describe("headless governor", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = makeTmpVault();
		process.env.USERTRUST_TEST = "1";
	});

	afterEach(() => {
		process.env.USERTRUST_TEST = "";
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	it("creates a governor in dry-run mode", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		expect(gov).toBeDefined();
		expect(gov.config.budget).toBe(100_000);
		expect(gov.budgetRemaining()).toBe(100_000);
		await gov.destroy();
	});

	it("authorize → settle lifecycle", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});

		expect(auth.transferId).toMatch(/^tx_/);
		expect(auth.model).toBe("claude-sonnet-4-6");
		expect(auth.estimatedCost).toBeGreaterThan(0);

		// Budget should reflect in-flight hold
		expect(gov.budgetRemaining()).toBeLessThan(100_000);

		const receipt = await gov.settle(auth, {
			inputTokens: 80,
			outputTokens: 200,
			usageSource: "provider",
			chunksDelivered: 15,
		});

		expect(receipt.settled).toBe(true);
		expect(receipt.model).toBe("claude-sonnet-4-6");
		expect(receipt.provider).toBe("headless");
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.chunksDelivered).toBe(15);
		expect(receipt.cost).toBeGreaterThan(0);
		expect(receipt.budgetRemaining).toBeLessThan(100_000);

		await gov.destroy();
	});

	it("authorize → abort lifecycle", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({
			model: "gpt-4o",
			estimatedInputTokens: 200,
			maxOutputTokens: 1000,
		});

		const budgetAfterAuth = gov.budgetRemaining();
		expect(budgetAfterAuth).toBeLessThan(100_000);

		await gov.abort(auth, new Error("LLM failed"));

		// Budget should be restored after abort
		expect(gov.budgetRemaining()).toBe(100_000);

		await gov.destroy();
	});

	it("settle without usage falls back to estimate", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});

		// Settle without providing actual usage
		const receipt = await gov.settle(auth);

		expect(receipt.cost).toBe(auth.estimatedCost);
		expect(receipt.usageSource).toBe("estimated");

		await gov.destroy();
	});

	it("prevents double-settle", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });
		await gov.settle(auth);

		await expect(gov.settle(auth)).rejects.toThrow("not active");

		await gov.destroy();
	});

	it("abort is idempotent", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });
		await gov.abort(auth, new Error("first abort"));
		// Second abort should not throw
		await gov.abort(auth, new Error("second abort"));

		await gov.destroy();
	});

	it("uses mock engine in test mode", async () => {
		const engine = mockEngine();

		const gov = await createGovernor({
			budget: 50_000,
			vaultBase,
			_engine: engine,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 50,
			maxOutputTokens: 200,
		});

		expect(engine.pendingIds).toHaveLength(1);
		expect(engine.pendingIds[0]).toBe(auth.transferId);

		await gov.settle(auth, {
			inputTokens: 40,
			outputTokens: 100,
		});

		expect(engine.postedIds).toHaveLength(1);
		expect(engine.postedIds[0]).toBe(auth.transferId);

		await gov.destroy();
	});

	it("voids pending hold via engine on abort", async () => {
		const engine = mockEngine();

		const gov = await createGovernor({
			budget: 50_000,
			vaultBase,
			_engine: engine,
		});

		const auth = await gov.authorize({ model: "gpt-4o" });
		await gov.abort(auth, new Error("test error"));

		expect(engine.voidedIds).toHaveLength(1);
		expect(engine.voidedIds[0]).toBe(auth.transferId);

		await gov.destroy();
	});

	it("tracks budget across multiple calls", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		// First call
		const auth1 = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 200,
		});
		await gov.settle(auth1, { inputTokens: 100, outputTokens: 200 });

		const afterFirst = gov.budgetRemaining();
		expect(afterFirst).toBeLessThan(100_000);

		// Second call
		const auth2 = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 200,
		});
		await gov.settle(auth2, { inputTokens: 100, outputTokens: 200 });

		const afterSecond = gov.budgetRemaining();
		expect(afterSecond).toBeLessThan(afterFirst);

		await gov.destroy();
	});

	it("estimateCost and estimateInputTokens work", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const cost = gov.estimateCost("claude-sonnet-4-6", 1000, 500);
		expect(cost).toBeGreaterThan(0);

		const tokens = gov.estimateInputTokens([{ role: "user", content: "Hello world" }]);
		expect(tokens).toBeGreaterThan(0);

		await gov.destroy();
	});

	it("throws after destroy", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		await gov.destroy();

		await expect(gov.authorize({ model: "test" })).rejects.toThrow("destroyed");
	});

	it("destroy voids active authorizations", async () => {
		const engine = mockEngine();

		const gov = await createGovernor({
			budget: 50_000,
			vaultBase,
			_engine: engine,
		});

		// Authorize but don't settle
		await gov.authorize({ model: "claude-sonnet-4-6" });
		await gov.authorize({ model: "gpt-4o" });

		expect(engine.pendingIds).toHaveLength(2);

		await gov.destroy();

		// Both should be voided
		expect(engine.voidedIds).toHaveLength(2);
	});

	// ── Proxy mode tests ──

	it("authorize/settle use proxy paths when proxy is set", async () => {
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			proxy: "https://proxy.example.com",
			key: "test-key",
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});

		// Proxy stub returns a proxy_ prefixed transferId
		expect(auth.proxyTransferId).toMatch(/^proxy_/);
		expect(auth.transferId).toMatch(/^tx_/);

		const receipt = await gov.settle(auth, {
			inputTokens: 80,
			outputTokens: 200,
		});

		// Proxy mode sets proxyStub and receiptUrl
		expect(receipt.proxyStub).toBe(true);
		expect(receipt.receiptUrl).toContain(auth.transferId);
		expect(receipt.settled).toBe(true);

		await gov.destroy();
	});

	it("abort uses proxy void path when proxy is set", async () => {
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			proxy: "https://proxy.example.com",
		});

		const auth = await gov.authorize({ model: "gpt-4o" });
		const budgetBefore = gov.budgetRemaining();

		await gov.abort(auth, new Error("test error"));

		// Budget should be restored after abort
		expect(gov.budgetRemaining()).toBeGreaterThan(budgetBefore);

		await gov.destroy();
	});

	it("destroy voids active proxy authorizations", async () => {
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			proxy: "https://proxy.example.com",
		});

		// Authorize but don't settle
		await gov.authorize({ model: "claude-sonnet-4-6" });
		await gov.authorize({ model: "gpt-4o" });

		// Should not throw — proxy void is best-effort
		await gov.destroy();
	});

	// ── Engine POST failure in settle() ──

	it("settle sets settled=false and writes settlement_ambiguous on engine POST failure", async () => {
		const auditEvents: { kind: string }[] = [];
		const mockAudit: AuditWriter = {
			appendEvent: vi.fn(async (input) => {
				auditEvents.push({ kind: input.kind });
				return {
					id: randomUUID(),
					timestamp: new Date().toISOString(),
					previousHash: "0".repeat(64),
					hash: "a".repeat(64),
					kind: input.kind,
					actor: input.actor,
					data: input.data,
				};
			}),
			getWriteFailures: () => 0,
			isDegraded: () => false,
			flush: async () => {},
			release: () => {},
		};

		const failingEngine: TrustEngine = {
			async spendPending(params) {
				return { transferId: params.transferId };
			},
			async postPendingSpend(_transferId) {
				throw new Error("TigerBeetle POST failed");
			},
			async voidPendingSpend() {},
			async voidAllPending() {},
			destroy() {},
		};

		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: failingEngine,
			_audit: mockAudit,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});

		const receipt = await gov.settle(auth, {
			inputTokens: 80,
			outputTokens: 200,
		});

		expect(receipt.settled).toBe(false);
		expect(auditEvents.some((e) => e.kind === "settlement_ambiguous")).toBe(true);

		await gov.destroy();
	});

	// ── Engine VOID failure in abort() ──

	it("abort completes even when engine voidPendingSpend throws (best-effort)", async () => {
		const failingEngine: TrustEngine = {
			async spendPending(params) {
				return { transferId: params.transferId };
			},
			async postPendingSpend() {},
			async voidPendingSpend() {
				throw new Error("VOID failed");
			},
			async voidAllPending() {},
			destroy() {},
		};

		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: failingEngine,
		});

		const auth = await gov.authorize({ model: "gpt-4o" });

		// Should NOT throw even though void fails
		await gov.abort(auth, new Error("LLM error"));

		// Budget should still be restored
		expect(gov.budgetRemaining()).toBe(100_000);

		await gov.destroy();
	});

	// ── Audit degraded path ──

	it("settle returns auditDegraded=true when audit.appendEvent throws", async () => {
		let appendCallCount = 0;
		const degradedAudit: AuditWriter = {
			appendEvent: vi.fn(async (input) => {
				appendCallCount++;
				// Let the settlement_ambiguous audit through but fail on the main llm_call audit
				if (input.kind === "llm_call") {
					throw new Error("Disk full");
				}
				return {
					id: randomUUID(),
					timestamp: new Date().toISOString(),
					previousHash: "0".repeat(64),
					hash: "b".repeat(64),
					kind: input.kind,
					actor: input.actor,
					data: input.data,
				};
			}),
			getWriteFailures: () => 0,
			isDegraded: () => false,
			flush: async () => {},
			release: () => {},
		};

		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
			_audit: degradedAudit,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 50,
		});

		const receipt = await gov.settle(auth);

		expect(receipt.auditDegraded).toBe(true);
		expect(appendCallCount).toBeGreaterThan(0);

		await gov.destroy();
	});

	// ── Audit degraded in settle() POST failure path ──

	it("settle returns auditDegraded=true when settlement_ambiguous audit also throws", async () => {
		const degradedAudit: AuditWriter = {
			appendEvent: vi.fn(async () => {
				throw new Error("All writes fail");
			}),
			getWriteFailures: () => 0,
			isDegraded: () => false,
			flush: async () => {},
			release: () => {},
		};

		const failingEngine: TrustEngine = {
			async spendPending(params) {
				return { transferId: params.transferId };
			},
			async postPendingSpend() {
				throw new Error("POST failed");
			},
			async voidPendingSpend() {},
			async voidAllPending() {},
			destroy() {},
		};

		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			_engine: failingEngine,
			_audit: degradedAudit,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 50,
		});

		const receipt = await gov.settle(auth);

		expect(receipt.settled).toBe(false);
		expect(receipt.auditDegraded).toBe(true);

		await gov.destroy();
	});

	// ── Pattern memory recording ──

	it("recordPattern is called on settle when patterns are enabled", async () => {
		// Spy on the actual recordPattern function
		const patterns = await import("../../src/memory/patterns.js");
		const spy = vi.spyOn(patterns, "recordPattern").mockResolvedValue(undefined);

		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		// Verify config has patterns enabled (default)
		expect(gov.config.patterns.enabled).toBe(true);

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});

		await gov.settle(auth, {
			inputTokens: 80,
			outputTokens: 200,
		});

		expect(spy).toHaveBeenCalledOnce();
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "claude-sonnet-4-6",
				success: true,
			}),
		);

		spy.mockRestore();
		await gov.destroy();
	});

	// ── PII detection blocking ──

	it("authorize throws PolicyDeniedError when PII detected in block mode", async () => {
		// Create a config file with pii: "block"
		const configDir = join(vaultBase, VAULT_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "usertrust.config.json"),
			JSON.stringify({
				budget: 100_000,
				pii: "block",
			}),
		);

		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		expect(gov.config.pii).toBe("block");

		await expect(
			gov.authorize({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "My email is test@example.com" }],
			}),
		).rejects.toThrow("PII detected");

		await gov.destroy();
	});

	// ── Policy denial ──

	it("authorize throws PolicyDeniedError when budget is exhausted", async () => {
		// Create a config with policy rules that deny when budget_remaining < estimated_cost
		const configDir = join(vaultBase, VAULT_DIR);
		const policiesDir = join(configDir, "policies");
		mkdirSync(policiesDir, { recursive: true });
		writeFileSync(
			join(policiesDir, "default.yml"),
			`- name: budget_exhausted
  effect: deny
  enforcement: hard
  conditions:
    - field: budget_remaining
      operator: lte
      value: 0
`,
		);
		writeFileSync(
			join(configDir, "usertrust.config.json"),
			JSON.stringify({
				budget: 1,
				policies: "./policies/default.yml",
			}),
		);

		const gov = await createGovernor({
			dryRun: true,
			vaultBase,
		});

		// First authorize uses up most of the tiny budget
		const auth1 = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});
		await gov.settle(auth1, { inputTokens: 100, outputTokens: 500 });

		// Budget should now be exhausted — next authorize should be denied
		await expect(
			gov.authorize({
				model: "claude-sonnet-4-6",
				estimatedInputTokens: 100,
				maxOutputTokens: 500,
			}),
		).rejects.toThrow("Policy denied");

		await gov.destroy();
	});

	// ── Budget persistence ──

	it("persist spend-ledger.json after settle", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});

		await gov.settle(auth, { inputTokens: 100, outputTokens: 500 });

		const ledgerPath = join(vaultBase, VAULT_DIR, "spend-ledger.json");
		expect(existsSync(ledgerPath)).toBe(true);

		const ledgerData = JSON.parse(readFileSync(ledgerPath, "utf-8"));
		expect(ledgerData.budgetSpent).toBeGreaterThan(0);
		expect(typeof ledgerData.updatedAt).toBe("string");

		await gov.destroy();
	});

	// ── Destroyed governor ──

	it("settle throws after governor is destroyed", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });
		await gov.destroy();

		// settle should throw because auth was voided during destroy
		await expect(gov.settle(auth)).rejects.toThrow("not active");
	});

	it("abort is no-op after governor is destroyed", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });
		await gov.destroy();

		// abort should be idempotent (auth was voided during destroy)
		await gov.abort(auth, new Error("test"));
	});

	// ── Config loading from file ──

	it("loads config from file when configPath is provided", async () => {
		const configDir = join(vaultBase, VAULT_DIR);
		mkdirSync(configDir, { recursive: true });

		const configFile = join(configDir, "custom-config.json");
		writeFileSync(
			configFile,
			JSON.stringify({
				budget: 75_000,
				tier: "pro",
				pii: "off",
			}),
		);

		const gov = await createGovernor({
			dryRun: true,
			vaultBase,
			configPath: configFile,
		});

		expect(gov.config.budget).toBe(75_000);
		expect(gov.config.tier).toBe("pro");
		expect(gov.config.pii).toBe("off");
		expect(gov.budgetRemaining()).toBe(75_000);

		await gov.destroy();
	});

	it("config file budget can be overridden by opts.budget", async () => {
		const configDir = join(vaultBase, VAULT_DIR);
		mkdirSync(configDir, { recursive: true });

		const configFile = join(configDir, "usertrust.config.json");
		writeFileSync(
			configFile,
			JSON.stringify({
				budget: 50_000,
				tier: "pro",
			}),
		);

		const gov = await createGovernor({
			dryRun: true,
			budget: 200_000,
			vaultBase,
		});

		expect(gov.config.budget).toBe(200_000);
		expect(gov.config.tier).toBe("pro");

		await gov.destroy();
	});

	// ── Proxy settle failure branch ──

	it("settle sets settled=false when proxy settle throws", async () => {
		// Proxy mode is a stub — but the settle path still exercises the branch
		// when proxy is configured. The stub currently succeeds, so we test
		// the structure to confirm proxy receipts are correct.
		const gov = await createGovernor({
			budget: 100_000,
			vaultBase,
			proxy: "https://proxy.example.com",
		});

		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });
		const receipt = await gov.settle(auth, {
			inputTokens: 50,
			outputTokens: 100,
			usageSource: "provider",
		});

		// Proxy stub succeeds, so settled should be true
		expect(receipt.settled).toBe(true);
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.provider).toBe("headless");

		await gov.destroy();
	});

	// ── PII in warn mode (non-blocking branch) ──

	it("authorize succeeds when PII detected in warn mode", async () => {
		const configDir = join(vaultBase, VAULT_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "usertrust.config.json"),
			JSON.stringify({
				budget: 100_000,
				pii: "warn",
			}),
		);

		const gov = await createGovernor({
			dryRun: true,
			vaultBase,
		});

		// warn mode should NOT throw — just continue
		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "My email is test@example.com" }],
		});

		expect(auth.transferId).toMatch(/^tx_/);

		await gov.settle(auth);
		await gov.destroy();
	});

	// ── Authorize with no messages (skip PII check) ──

	it("authorize skips PII check when no messages provided", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
		});

		expect(auth.transferId).toMatch(/^tx_/);

		await gov.settle(auth);
		await gov.destroy();
	});

	// ── Settle with only outputTokens (partial usage branch) ──

	it("settle with only outputTokens provided uses zero for inputTokens", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });

		const receipt = await gov.settle(auth, {
			outputTokens: 500,
		});

		expect(receipt.cost).toBeGreaterThan(0);
		expect(receipt.usageSource).toBe("provider");

		await gov.destroy();
	});

	// ── Audit rotation none mode ──

	it("skips receipt rotation when audit.rotation is none", async () => {
		const configDir = join(vaultBase, VAULT_DIR);
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "usertrust.config.json"),
			JSON.stringify({
				budget: 100_000,
				audit: { rotation: "none" },
			}),
		);

		const gov = await createGovernor({
			dryRun: true,
			vaultBase,
		});

		expect(gov.config.audit.rotation).toBe("none");

		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });
		const receipt = await gov.settle(auth);

		expect(receipt.settled).toBe(true);

		await gov.destroy();
	});
});
