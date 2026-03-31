// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Tests for governAction() — the action governance pipeline.
 *
 * Exercises: successful governance, policy denial, budget enforcement,
 * PII detection, execution failure, audit trail, multiple action kinds,
 * budget tracking across calls, custom actor, and destroyed-client rejection.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trust } from "../../src/govern.js";
import { PolicyDeniedError } from "../../src/shared/errors.js";
import type { AuditEvent } from "../../src/shared/types.js";

// ── Mock tigerbeetle-node at module level (native module, never loaded in tests) ──

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

// ── Shared helpers ──

const VAULT_DIR = ".usertrust";

function makeTmpVault(): string {
	const dir = join(tmpdir(), `action-gov-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeAnthropicMock() {
	return {
		messages: {
			create: vi.fn(async () => ({
				id: "msg_test",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "Hello" }],
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 10, output_tokens: 5 },
			})),
		},
	};
}

function writeVaultConfig(vaultBase: string, config: Record<string, unknown>): void {
	const configDir = join(vaultBase, VAULT_DIR);
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "usertrust.config.json"), JSON.stringify(config));
}

function writePolicyFile(vaultBase: string, relativePath: string, rules: unknown[]): void {
	const fullDir = join(vaultBase, relativePath.replace(/\/[^/]+$/, ""));
	mkdirSync(fullDir, { recursive: true });
	writeFileSync(join(vaultBase, relativePath), JSON.stringify({ rules }));
}

function readAuditEvents(vaultBase: string): AuditEvent[] {
	const auditPath = join(vaultBase, VAULT_DIR, "audit", "events.jsonl");
	if (!existsSync(auditPath)) return [];
	const lines = readFileSync(auditPath, "utf-8").trim().split("\n");
	return lines.filter((l) => l.length > 0).map((line) => JSON.parse(line) as AuditEvent);
}

// ── Test Suite ──

describe("governAction() — action governance pipeline", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = makeTmpVault();
	});

	afterEach(async () => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// Cleanup best-effort
		}
	});

	// ─────────────────────────────────────────────────────────────────────
	// 1. Successful tool_use governance
	// ─────────────────────────────────────────────────────────────────────

	describe("1. Successful tool_use governance", () => {
		it("returns result and receipt with correct shape", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 10_000,
				vaultBase: tmpVault,
			});

			const { result, receipt } = await governed.governAction(
				{ kind: "tool_use", name: "file_read", cost: 50 },
				async () => "file contents here",
			);

			// Verify result
			expect(result).toBe("file contents here");

			// Verify receipt shape
			expect(receipt.transferId).toMatch(/^tx_/);
			expect(receipt.cost).toBe(50);
			expect(receipt.settled).toBe(true);
			expect(receipt.actionKind).toBe("tool_use");
			expect(receipt.model).toBe("file_read");
			expect(receipt.provider).toBe("tool_use");
			expect(receipt.auditHash).toMatch(/^[a-f0-9]{64}$/);
			expect(receipt.timestamp).toBeTruthy();
			expect(new Date(receipt.timestamp).getTime()).not.toBeNaN();
			expect(receipt.budgetRemaining).toBeLessThan(10_000);
			expect(receipt.receiptUrl).toBeNull(); // local mode

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 2. Policy denial on action
	// ─────────────────────────────────────────────────────────────────────

	describe("2. Policy denial on action", () => {
		it("denies shell_command when policy rule matches action_kind", async () => {
			writePolicyFile(tmpVault, ".usertrust/policies/default.yml", [
				{
					name: "block-shell",
					effect: "deny",
					enforcement: "hard",
					conditions: [{ field: "action_kind", operator: "eq", value: "shell_command" }],
				},
			]);
			writeVaultConfig(tmpVault, {
				budget: 10_000,
				policies: "./policies/default.yml",
			});

			const executeFn = vi.fn(async () => "should not run");
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				vaultBase: tmpVault,
			});

			await expect(
				governed.governAction({ kind: "shell_command", name: "rm -rf", cost: 10 }, executeFn),
			).rejects.toThrow(PolicyDeniedError);

			expect(executeFn).not.toHaveBeenCalled();

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 3. Budget enforcement
	// ─────────────────────────────────────────────────────────────────────

	describe("3. Budget enforcement", () => {
		it("rejects action when budget is exhausted", async () => {
			// Write a policy with the budget-exhausted rule
			writePolicyFile(tmpVault, ".usertrust/policies/default.yml", [
				{
					name: "block-budget-exhausted",
					effect: "deny",
					enforcement: "hard",
					conditions: [{ field: "budget_remaining", operator: "lte", value: 0 }],
				},
			]);
			writeVaultConfig(tmpVault, {
				budget: 100,
				policies: "./policies/default.yml",
			});

			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				vaultBase: tmpVault,
			});

			// First call — exhausts entire budget (budget_remaining becomes 0)
			await governed.governAction({ kind: "tool_use", name: "first", cost: 100 }, async () => "ok");

			// Second call — budget_remaining is 0, rule denies
			await expect(
				governed.governAction(
					{ kind: "tool_use", name: "second", cost: 50 },
					async () => "should not run",
				),
			).rejects.toThrow(PolicyDeniedError);

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 4. PII detection in action params
	// ─────────────────────────────────────────────────────────────────────

	describe("4. PII detection in action params", () => {
		it("blocks action with SSN in params when pii is block", async () => {
			writeVaultConfig(tmpVault, { budget: 10_000, pii: "block" });

			const executeFn = vi.fn(async () => "should not run");
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				vaultBase: tmpVault,
			});

			await expect(
				governed.governAction(
					{
						kind: "tool_use",
						name: "send_data",
						cost: 10,
						params: { ssn: "My social security number is 123-45-6789" },
					},
					executeFn,
				),
			).rejects.toThrow("PII detected");

			expect(executeFn).not.toHaveBeenCalled();

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 5. Action execution failure
	// ─────────────────────────────────────────────────────────────────────

	describe("5. Action execution failure", () => {
		it("propagates error from execute function without returning a receipt", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 10_000,
				vaultBase: tmpVault,
			});

			const execError = new Error("Tool crashed unexpectedly");
			await expect(
				governed.governAction({ kind: "tool_use", name: "broken_tool", cost: 50 }, async () => {
					throw execError;
				}),
			).rejects.toThrow("Tool crashed unexpectedly");

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 6. Audit trail includes action events
	// ─────────────────────────────────────────────────────────────────────

	describe("6. Audit trail includes action events", () => {
		it("writes audit event with correct kind and data", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 10_000,
				vaultBase: tmpVault,
			});

			await governed.governAction(
				{ kind: "tool_use", name: "search_db", cost: 25, params: { query: "users" } },
				async () => ({ rows: 42 }),
			);

			await governed.destroy();

			const events = readAuditEvents(tmpVault);
			expect(events.length).toBeGreaterThanOrEqual(1);

			const actionEvent = events.find((e) => e.kind === "tool_use");
			expect(actionEvent).toBeDefined();
			const ae = actionEvent as AuditEvent;
			expect(ae.data.actionName).toBe("search_db");
			expect(ae.data.cost).toBe(25);
			expect(ae.data.settled).toBe(true);
			expect(ae.data.transferId).toMatch(/^tx_/);
			expect(ae.data.params).toEqual({ query: "users" });
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 7. Multiple action kinds
	// ─────────────────────────────────────────────────────────────────────

	describe("7. Multiple action kinds", () => {
		it("governs tool_use, file_access, and api_request in sequence", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const r1 = await governed.governAction(
				{ kind: "tool_use", name: "grep", cost: 10 },
				async () => "match found",
			);

			const r2 = await governed.governAction(
				{ kind: "file_access", name: "read_config", cost: 20 },
				async () => ({ key: "value" }),
			);

			const r3 = await governed.governAction(
				{ kind: "api_request", name: "fetch_users", cost: 30 },
				async () => [{ id: 1 }],
			);

			// All succeed with correct results
			expect(r1.result).toBe("match found");
			expect(r2.result).toEqual({ key: "value" });
			expect(r3.result).toEqual([{ id: 1 }]);

			// Receipts have correct action kinds
			expect(r1.receipt.actionKind).toBe("tool_use");
			expect(r2.receipt.actionKind).toBe("file_access");
			expect(r3.receipt.actionKind).toBe("api_request");

			// Provider maps to action kind
			expect(r1.receipt.provider).toBe("tool_use");
			expect(r2.receipt.provider).toBe("file_access");
			expect(r3.receipt.provider).toBe("api_request");

			// Model maps to action name
			expect(r1.receipt.model).toBe("grep");
			expect(r2.receipt.model).toBe("read_config");
			expect(r3.receipt.model).toBe("fetch_users");

			// Budget decreases with each call
			expect(r1.receipt.budgetRemaining).toBeLessThan(50_000);
			expect(r2.receipt.budgetRemaining).toBeLessThan(r1.receipt.budgetRemaining);
			expect(r3.receipt.budgetRemaining).toBeLessThan(r2.receipt.budgetRemaining);

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 8. Budget tracking across multiple actions
	// ─────────────────────────────────────────────────────────────────────

	describe("8. Budget tracking across multiple actions", () => {
		it("allows first two actions but rejects when budget exhausted", async () => {
			// Write a policy with the budget-exhausted rule
			writePolicyFile(tmpVault, ".usertrust/policies/default.yml", [
				{
					name: "block-budget-exhausted",
					effect: "deny",
					enforcement: "hard",
					conditions: [{ field: "budget_remaining", operator: "lte", value: 0 }],
				},
			]);
			writeVaultConfig(tmpVault, {
				budget: 250,
				policies: "./policies/default.yml",
			});

			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				vaultBase: tmpVault,
			});

			// First action: cost 100, remaining 150
			const r1 = await governed.governAction(
				{ kind: "tool_use", name: "action_1", cost: 100 },
				async () => "a",
			);
			expect(r1.receipt.budgetRemaining).toBe(150);

			// Second action: cost 100, remaining 50
			const r2 = await governed.governAction(
				{ kind: "tool_use", name: "action_2", cost: 100 },
				async () => "b",
			);
			expect(r2.receipt.budgetRemaining).toBe(50);

			// Third action: cost 50, remaining 0 (exactly exhausted)
			const r3 = await governed.governAction(
				{ kind: "tool_use", name: "action_3", cost: 50 },
				async () => "c",
			);
			expect(r3.receipt.budgetRemaining).toBe(0);

			// Fourth action — budget_remaining is 0, rule denies
			await expect(
				governed.governAction(
					{ kind: "tool_use", name: "action_4", cost: 100 },
					async () => "should not run",
				),
			).rejects.toThrow(PolicyDeniedError);

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 9. Custom actor
	// ─────────────────────────────────────────────────────────────────────

	describe("9. Custom actor", () => {
		it("records the specified actor in the audit event", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 10_000,
				vaultBase: tmpVault,
			});

			await governed.governAction(
				{ kind: "tool_use", name: "custom_tool", cost: 10, actor: "agent-1" },
				async () => "done",
			);

			await governed.destroy();

			const events = readAuditEvents(tmpVault);
			const actionEvent = events.find((e) => e.kind === "tool_use");
			expect(actionEvent).toBeDefined();
			expect((actionEvent as AuditEvent).actor).toBe("agent-1");
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 10. Destroyed client rejects actions
	// ─────────────────────────────────────────────────────────────────────

	describe("10. Destroyed client rejects actions", () => {
		it("throws after destroy() is called", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 10_000,
				vaultBase: tmpVault,
			});

			await governed.destroy();

			await expect(
				governed.governAction(
					{ kind: "tool_use", name: "late_call", cost: 10 },
					async () => "should not run",
				),
			).rejects.toThrow("TrustedClient has been destroyed");
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 11. AUD-466: Negative cost validation
	// ─────────────────────────────────────────────────────────────────────

	describe("11. Negative cost validation (AUD-466)", () => {
		it("rejects negative cost to prevent budget inflation", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 10_000,
				vaultBase: tmpVault,
			});

			await expect(
				governed.governAction(
					{ kind: "tool_use", name: "exploit", cost: -500 },
					async () => "should not run",
				),
			).rejects.toThrow("action.cost must be a non-negative finite number");

			await governed.destroy();
		});

		it("rejects NaN cost", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 10_000,
				vaultBase: tmpVault,
			});

			await expect(
				governed.governAction(
					{ kind: "tool_use", name: "exploit", cost: Number.NaN },
					async () => "should not run",
				),
			).rejects.toThrow("action.cost must be a non-negative finite number");

			await governed.destroy();
		});

		it("rejects Infinity cost", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 10_000,
				vaultBase: tmpVault,
			});

			await expect(
				governed.governAction(
					{ kind: "tool_use", name: "exploit", cost: Number.POSITIVE_INFINITY },
					async () => "should not run",
				),
			).rejects.toThrow("action.cost must be a non-negative finite number");

			await governed.destroy();
		});

		it("allows zero cost", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 10_000,
				vaultBase: tmpVault,
			});

			const { result, receipt } = await governed.governAction(
				{ kind: "tool_use", name: "free_action", cost: 0 },
				async () => "free",
			);

			expect(result).toBe("free");
			expect(receipt.cost).toBe(0);
			expect(receipt.budgetRemaining).toBe(10_000);

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 12. AUD-467: Policy context field shadowing prevention
	// ─────────────────────────────────────────────────────────────────────

	describe("12. Policy context field shadowing (AUD-467)", () => {
		it("governance fields cannot be overridden by action.params", async () => {
			writePolicyFile(tmpVault, ".usertrust/policies/default.yml", [
				{
					name: "block-budget-exhausted",
					effect: "deny",
					enforcement: "hard",
					conditions: [{ field: "budget_remaining", operator: "lte", value: 0 }],
				},
			]);
			writeVaultConfig(tmpVault, {
				budget: 100,
				policies: "./policies/default.yml",
			});

			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 100,
				vaultBase: tmpVault,
			});

			// First call exhausts budget
			await governed.governAction(
				{ kind: "tool_use", name: "normal", cost: 100 },
				async () => "ok",
			);

			// Second call tries to shadow budget_remaining with a large value
			await expect(
				governed.governAction(
					{
						kind: "tool_use",
						name: "exploit",
						cost: 50,
						params: { budget_remaining: 999999 },
					},
					async () => "should not run",
				),
			).rejects.toThrow("Policy denied");

			await governed.destroy();
		});
	});
});
