/**
 * End-to-end integration test for action governance.
 *
 * Exercises the governAction() method alongside LLM calls to verify that
 * both share the same budget, audit chain, policy engine, and circuit
 * breaker. Uses dryRun: true to avoid needing TigerBeetle.
 *
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Usertools, Inc.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trust } from "../../src/govern.js";
import { GENESIS_HASH, VAULT_DIR } from "../../src/shared/constants.js";
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

function makeTmpVault(): string {
	const dir = join(tmpdir(), `action-e2e-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeAnthropicMock(response?: Record<string, unknown>) {
	const defaultResponse = {
		id: "msg_e2e_act",
		type: "message",
		role: "assistant",
		content: [{ type: "text", text: "Hello from Claude" }],
		model: "claude-sonnet-4-6",
		usage: { input_tokens: 100, output_tokens: 50 },
	};
	return {
		messages: {
			create: vi.fn(async () => response ?? defaultResponse),
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

// ── E2E Test Suite ──

describe("Action governance — E2E integration", () => {
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
	// 1. Mixed LLM + action governance lifecycle
	// ─────────────────────────────────────────────────────────────────────

	describe("1. Mixed LLM + action governance lifecycle", () => {
		it("both LLM calls and governed actions return valid receipts sharing budget", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			// LLM call
			const llmResult = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Explain governance" }],
			});

			// Verify LLM receipt
			expect(llmResult.receipt.transferId).toMatch(/^tx_/);
			expect(llmResult.receipt.cost).toBeGreaterThan(0);
			expect(llmResult.receipt.settled).toBe(true);
			expect(llmResult.receipt.model).toBe("claude-sonnet-4-6");
			expect(llmResult.receipt.provider).toBe("anthropic");
			expect(llmResult.receipt.budgetRemaining).toBeLessThan(50_000);

			const budgetAfterLlm = llmResult.receipt.budgetRemaining;

			// Action call
			const actionResult = await governed.governAction(
				{
					kind: "tool_use",
					name: "file_read",
					cost: 50,
					params: { path: "/etc/hosts" },
				},
				async () => ({ content: "127.0.0.1 localhost" }),
			);

			// Verify action receipt
			expect(actionResult.receipt.transferId).toMatch(/^tx_/);
			expect(actionResult.receipt.cost).toBe(50);
			expect(actionResult.receipt.settled).toBe(true);
			expect(actionResult.receipt.actionKind).toBe("tool_use");
			expect(actionResult.receipt.model).toBe("file_read");
			expect(actionResult.receipt.provider).toBe("tool_use");

			// Budget is deducted by both
			expect(actionResult.receipt.budgetRemaining).toBeLessThan(budgetAfterLlm);
			expect(actionResult.receipt.budgetRemaining).toBe(budgetAfterLlm - 50);

			// Action result is returned
			expect(actionResult.result).toEqual({ content: "127.0.0.1 localhost" });

			// Audit chain has events for both
			const auditPath = join(tmpVault, VAULT_DIR, "audit", "events.jsonl");
			expect(existsSync(auditPath)).toBe(true);

			const events = readFileSync(auditPath, "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as AuditEvent);

			expect(events.length).toBe(2);
			expect(events[0]?.kind).toBe("llm_call");
			expect(events[1]?.kind).toBe("tool_use");

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 2. Shared budget enforcement
	// ─────────────────────────────────────────────────────────────────────

	describe("2. Shared budget enforcement", () => {
		it("action fails when LLM call exhausts the shared budget", async () => {
			// Write a policy with the budget-exhausted rule so the gate
			// denies when budget_remaining drops to zero or below.
			writePolicyFile(tmpVault, ".usertrust/policies/default.yml", [
				{
					name: "block-budget-exhausted",
					effect: "deny",
					enforcement: "hard",
					conditions: [{ field: "budget_remaining", operator: "lte", value: 0 }],
				},
			]);
			writeVaultConfig(tmpVault, {
				budget: 500,
				policies: "./policies/default.yml",
			});

			// Use a mock with high token usage so the LLM call costs >= budget.
			// Sonnet pricing: input 30/1k, output 150/1k.
			// 10000 input + 2000 output → (10000/1000)*30 + (2000/1000)*150 = 300 + 300 = 600.
			const expensiveMock = makeAnthropicMock({
				id: "msg_expensive",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "Expensive reply" }],
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 10_000, output_tokens: 2_000 },
			});

			const governed = await trust(expensiveMock, {
				dryRun: true,
				vaultBase: tmpVault,
			});

			// LLM call succeeds (budget_remaining = 500 > 0 at pre-call check)
			const llmResult = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 4096,
				messages: [{ role: "user", content: "Write a long essay" }],
			});

			// LLM cost should be 600, exhausting the budget of 500
			expect(llmResult.receipt.cost).toBe(600);
			expect(llmResult.receipt.budgetRemaining).toBeLessThan(0);

			// Governed action should fail — budget_remaining is now <= 0
			await expect(
				governed.governAction({ kind: "tool_use", name: "curl", cost: 300 }, async () => ({
					ok: true,
				})),
			).rejects.toThrow(PolicyDeniedError);

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 3. Audit chain integrity across mixed calls
	// ─────────────────────────────────────────────────────────────────────

	describe("3. Audit chain integrity across mixed calls", () => {
		it("produces an unbroken hash chain with all 4 events", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 100_000,
				vaultBase: tmpVault,
			});

			// Interleave: LLM, action, LLM, action
			await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 512,
				messages: [{ role: "user", content: "Call 1" }],
			});

			await governed.governAction(
				{ kind: "tool_use", name: "file_read", cost: 10, params: { path: "/tmp/a" } },
				async () => "file-content-a",
			);

			await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 512,
				messages: [{ role: "user", content: "Call 2" }],
			});

			await governed.governAction(
				{ kind: "shell_command", name: "ls", cost: 5, params: { args: ["-la"] } },
				async () => "total 42\ndrwxr-xr-x ...",
			);

			await governed.destroy();

			// Read the audit chain JSONL
			const auditPath = join(tmpVault, VAULT_DIR, "audit", "events.jsonl");
			expect(existsSync(auditPath)).toBe(true);

			const events = readFileSync(auditPath, "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as AuditEvent & { sequence: number });

			// (a) All 4 events are present
			expect(events.length).toBe(4);

			// (b) Hash chain is unbroken
			expect(events[0]?.previousHash).toBe(GENESIS_HASH);
			for (let i = 1; i < events.length; i++) {
				expect(events[i]?.previousHash).toBe(events[i - 1]?.hash);
			}

			// Every event has a unique, non-empty 64-char hex hash
			const hashes = events.map((e) => e.hash);
			expect(new Set(hashes).size).toBe(hashes.length);
			for (const h of hashes) {
				expect(h).toMatch(/^[a-f0-9]{64}$/);
			}

			// Sequences are monotonically increasing
			for (let i = 0; i < events.length; i++) {
				expect(events[i]?.sequence).toBe(i + 1);
			}

			// (c) Action events have actionName in data
			const kinds = events.map((e) => e.kind);
			expect(kinds).toEqual(["llm_call", "tool_use", "llm_call", "shell_command"]);

			const actionEvents = events.filter(
				(e) => e.kind === "tool_use" || e.kind === "shell_command",
			);
			for (const ae of actionEvents) {
				expect(ae.data.actionName).toBeDefined();
				expect(typeof ae.data.actionName).toBe("string");
			}

			// LLM events have model in data
			const llmEvents = events.filter((e) => e.kind === "llm_call");
			for (const le of llmEvents) {
				expect(le.data.model).toBe("claude-sonnet-4-6");
			}
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 4. Action receipt shape
	// ─────────────────────────────────────────────────────────────────────

	describe("4. Action receipt shape", () => {
		it("returns a well-formed receipt matching ActionDescriptor fields", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 10_000,
				vaultBase: tmpVault,
			});

			const actionResult = await governed.governAction(
				{
					kind: "file_access",
					name: "file_write",
					cost: 25,
					params: { path: "/tmp/output.txt", bytes: 1024 },
				},
				async () => ({ written: true, bytes: 1024 }),
			);

			const receipt = actionResult.receipt;

			// transferId starts with "tx_"
			expect(receipt.transferId).toMatch(/^tx_/);

			// cost matches input
			expect(receipt.cost).toBe(25);

			// settled is true
			expect(receipt.settled).toBe(true);

			// actionKind equals action.kind
			expect(receipt.actionKind).toBe("file_access");

			// model equals action.name
			expect(receipt.model).toBe("file_write");

			// provider equals action.kind
			expect(receipt.provider).toBe("file_access");

			// auditHash is 64-char hex
			expect(receipt.auditHash).toMatch(/^[a-f0-9]{64}$/);

			// budgetRemaining is correct
			expect(receipt.budgetRemaining).toBe(10_000 - 25);

			// timestamp is valid ISO
			expect(receipt.timestamp).toBeTruthy();
			expect(new Date(receipt.timestamp).getTime()).not.toBeNaN();

			// receiptUrl is null in local mode (no proxy)
			expect(receipt.receiptUrl).toBeNull();

			// Result is passed through
			expect(actionResult.result).toEqual({ written: true, bytes: 1024 });

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 5. Destroy cleans up mixed state
	// ─────────────────────────────────────────────────────────────────────

	describe("5. Destroy cleans up mixed state", () => {
		it("completes without timeout after mixed LLM + action usage", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			// LLM call
			await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});

			// Action call
			await governed.governAction(
				{ kind: "api_request", name: "fetch_weather", cost: 15 },
				async () => ({ temp: 72, unit: "F" }),
			);

			// Destroy should complete without hanging
			await governed.destroy();

			// Further calls should throw after destroy
			await expect(
				governed.governAction({ kind: "tool_use", name: "noop", cost: 1 }, async () => null),
			).rejects.toThrow("TrustedClient has been destroyed");
		});
	});
});
