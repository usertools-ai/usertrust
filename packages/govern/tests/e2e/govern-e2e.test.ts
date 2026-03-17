/**
 * End-to-end integration test for @usertools/govern SDK.
 *
 * Exercises the full governance lifecycle with mocked LLM clients.
 * Uses dryRun: true to avoid needing TigerBeetle. Verifies that all
 * subsystems (policy gate, PII detector, audit chain, budget tracking,
 * circuit breaker, pattern memory, destroy lifecycle) wire together
 * correctly through the govern() entry point.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditWriter } from "../../src/audit/chain.js";
import { govern } from "../../src/govern.js";
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
	const dir = join(tmpdir(), `govern-e2e-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeAnthropicMock(
	response?: Record<string, unknown>,
	createFn?: (...args: unknown[]) => unknown,
) {
	const defaultResponse = {
		id: "msg_e2e_001",
		type: "message",
		role: "assistant",
		content: [{ type: "text", text: "Hello from Claude" }],
		model: "claude-sonnet-4-6",
		usage: { input_tokens: 100, output_tokens: 50 },
	};
	return {
		messages: {
			create: createFn ?? vi.fn(async () => response ?? defaultResponse),
		},
	};
}

function makeOpenAIMock(response?: Record<string, unknown>) {
	const defaultResponse = {
		id: "chatcmpl-e2e-001",
		choices: [{ message: { role: "assistant", content: "Hello from GPT" } }],
		model: "gpt-4o",
		usage: { prompt_tokens: 80, completion_tokens: 40 },
	};
	return {
		chat: {
			completions: {
				create: vi.fn(async () => response ?? defaultResponse),
			},
		},
	};
}

function writeVaultConfig(vaultBase: string, config: Record<string, unknown>): void {
	const configDir = join(vaultBase, VAULT_DIR);
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "govern.config.json"), JSON.stringify(config));
}

function writePolicyFile(vaultBase: string, relativePath: string, rules: unknown[]): void {
	const fullDir = join(vaultBase, relativePath.replace(/\/[^/]+$/, ""));
	mkdirSync(fullDir, { recursive: true });
	writeFileSync(join(vaultBase, relativePath), JSON.stringify({ rules }));
}

// ── E2E Test Suite ──

describe("govern() — end-to-end integration", () => {
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
	// 1. Full lifecycle — Anthropic client
	// ─────────────────────────────────────────────────────────────────────

	describe("1. Full lifecycle — Anthropic client", () => {
		it("wraps, calls, returns GovernedResponse, and destroys cleanly", async () => {
			const mockClient = makeAnthropicMock();
			const governed = await govern(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Explain governance" }],
			});

			// Verify GovernedResponse shape
			expect(result).toHaveProperty("response");
			expect(result).toHaveProperty("governance");

			// Verify response
			expect(result.response.id).toBe("msg_e2e_001");
			expect(result.response.content).toBeDefined();

			// Verify governance receipt
			const g = result.governance;
			expect(g.transferId).toMatch(/^tx_/);
			expect(g.cost).toBeGreaterThan(0);
			expect(g.model).toBe("claude-sonnet-4-6");
			expect(g.provider).toBe("anthropic");
			expect(g.settled).toBe(true);
			expect(g.auditHash).toMatch(/^[a-f0-9]{64}$/);
			expect(g.timestamp).toBeTruthy();
			expect(new Date(g.timestamp).getTime()).not.toBeNaN();
			expect(g.budgetRemaining).toBeLessThan(50_000);
			expect(g.receiptUrl).toBeNull(); // local mode

			// Destroy cleanly
			await governed.destroy();
		});

		it("computes cost from actual usage tokens", async () => {
			const mockClient = makeAnthropicMock({
				id: "msg_cost_check",
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 100, output_tokens: 200 },
			});

			const governed = await govern(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});

			// sonnet: input 30/1k, output 150/1k
			// (100/1000)*30 + (200/1000)*150 = 3 + 30 = 33
			expect(result.governance.cost).toBe(33);

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 2. Full lifecycle — OpenAI client
	// ─────────────────────────────────────────────────────────────────────

	describe("2. Full lifecycle — OpenAI client", () => {
		it("wraps OpenAI-shaped client and returns GovernedResponse", async () => {
			const mockClient = makeOpenAIMock();
			const governed = await govern(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const result = await governed.chat.completions.create({
				model: "gpt-4o",
				messages: [{ role: "user", content: "Explain governance" }],
			});

			expect(result.response.id).toBe("chatcmpl-e2e-001");
			expect(result.governance.provider).toBe("openai");
			expect(result.governance.model).toBe("gpt-4o");
			expect(result.governance.settled).toBe(true);
			expect(result.governance.transferId).toMatch(/^tx_/);
			expect(result.governance.cost).toBeGreaterThan(0);

			await governed.destroy();
		});

		it("extracts prompt_tokens/completion_tokens from OpenAI usage", async () => {
			const mockClient = makeOpenAIMock({
				id: "chatcmpl-usage",
				choices: [{ message: { role: "assistant", content: "Hi" } }],
				model: "gpt-4o",
				usage: { prompt_tokens: 200, completion_tokens: 100 },
			});

			const governed = await govern(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const result = await governed.chat.completions.create({
				model: "gpt-4o",
				messages: [{ role: "user", content: "Hello" }],
			});

			// gpt-4o: input 25/1k, output 100/1k
			// (200/1000)*25 + (100/1000)*100 = 5 + 10 = 15
			expect(result.governance.cost).toBe(15);

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 3. Multiple calls — budget decrement
	// ─────────────────────────────────────────────────────────────────────

	describe("3. Multiple calls — budget decrement", () => {
		it("budget decreases monotonically with each call", async () => {
			const governed = await govern(makeAnthropicMock(), {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const r1 = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "First call" }],
			});

			const r2 = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Second call" }],
			});

			const r3 = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Third call" }],
			});

			// Budget decreases with each call
			expect(r1.governance.budgetRemaining).toBeLessThan(50_000);
			expect(r2.governance.budgetRemaining).toBeLessThan(r1.governance.budgetRemaining);
			expect(r3.governance.budgetRemaining).toBeLessThan(r2.governance.budgetRemaining);

			// Budget math is exact
			const totalCost = r1.governance.cost + r2.governance.cost + r3.governance.cost;
			expect(r3.governance.budgetRemaining).toBe(50_000 - totalCost);

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 4. Policy denial blocks LLM call
	// ─────────────────────────────────────────────────────────────────────

	describe("4. Policy denial blocks LLM call", () => {
		it("throws PolicyDeniedError and never calls the LLM", async () => {
			// Set up vault with policy that blocks claude-opus-4-6
			writePolicyFile(tmpVault, "policies/default.yml", [
				{
					name: "block-opus",
					effect: "deny",
					enforcement: "hard",
					conditions: [{ field: "model", operator: "eq", value: "claude-opus-4-6" }],
				},
			]);
			writeVaultConfig(tmpVault, {
				budget: 50_000,
				policies: "./policies/default.yml",
			});

			const createFn = vi.fn(async () => ({ id: "msg_should_not_reach" }));
			const mockClient = { messages: { create: createFn } };

			const governed = await govern(mockClient, {
				dryRun: true,
				vaultBase: tmpVault,
			});

			await expect(
				governed.messages.create({
					model: "claude-opus-4-6",
					messages: [{ role: "user", content: "Hello" }],
				}),
			).rejects.toThrow(PolicyDeniedError);

			// Verify LLM was never called
			expect(createFn).not.toHaveBeenCalled();

			// But allowed model should work
			const allowedClient = makeAnthropicMock();
			const governed2 = await govern(allowedClient, {
				dryRun: true,
				vaultBase: tmpVault,
			});

			const result = await governed2.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});
			expect(result.response).toBeDefined();

			await governed.destroy();
			await governed2.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 5. PII detection in block mode
	// ─────────────────────────────────────────────────────────────────────

	describe("5. PII detection in block mode", () => {
		it("blocks messages containing email addresses", async () => {
			writeVaultConfig(tmpVault, { budget: 50_000, pii: "block" });

			const createFn = vi.fn(async () => ({ id: "msg_pii" }));
			const mockClient = { messages: { create: createFn } };

			const governed = await govern(mockClient, {
				dryRun: true,
				vaultBase: tmpVault,
			});

			await expect(
				governed.messages.create({
					model: "claude-sonnet-4-6",
					messages: [
						{
							role: "user",
							content: "Send a message to john.doe@example.com about the project",
						},
					],
				}),
			).rejects.toThrow("PII detected");

			expect(createFn).not.toHaveBeenCalled();

			await governed.destroy();
		});

		it("blocks messages containing SSNs", async () => {
			writeVaultConfig(tmpVault, { budget: 50_000, pii: "block" });

			const createFn = vi.fn(async () => ({ id: "msg_pii" }));
			const mockClient = { messages: { create: createFn } };

			const governed = await govern(mockClient, {
				dryRun: true,
				vaultBase: tmpVault,
			});

			await expect(
				governed.messages.create({
					model: "claude-sonnet-4-6",
					messages: [
						{
							role: "user",
							content: "My social security number is 123-45-6789",
						},
					],
				}),
			).rejects.toThrow("PII detected");

			expect(createFn).not.toHaveBeenCalled();

			await governed.destroy();
		});

		it("allows clean messages in block mode", async () => {
			writeVaultConfig(tmpVault, { budget: 50_000, pii: "block" });

			const governed = await govern(makeAnthropicMock(), {
				dryRun: true,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "What is governance?" }],
			});

			expect(result.response).toBeDefined();
			expect(result.governance.settled).toBe(true);

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 6. LLM failure — error propagation
	// ─────────────────────────────────────────────────────────────────────

	describe("6. LLM failure — error propagation", () => {
		it("propagates the original error unchanged", async () => {
			const originalError = new Error("API 500: Internal Server Error");
			const mockClient = makeAnthropicMock(undefined, async () => {
				throw originalError;
			});

			const governed = await govern(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			let caughtError: Error | undefined;
			try {
				await governed.messages.create({
					model: "claude-sonnet-4-6",
					messages: [{ role: "user", content: "Hello" }],
				});
			} catch (e) {
				caughtError = e as Error;
			}

			// The original error is propagated, not wrapped
			expect(caughtError).toBe(originalError);
			expect(caughtError?.message).toBe("API 500: Internal Server Error");

			await governed.destroy();
		});

		it("records the failure in the audit chain", async () => {
			const mockClient = makeAnthropicMock(undefined, async () => {
				throw new Error("Rate limited");
			});

			const governed = await govern(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			try {
				await governed.messages.create({
					model: "claude-sonnet-4-6",
					messages: [{ role: "user", content: "Hello" }],
				});
			} catch {
				// expected
			}

			// The audit chain JSONL should exist and have the failure event
			const auditPath = join(tmpVault, VAULT_DIR, "audit", "events.jsonl");
			expect(existsSync(auditPath)).toBe(true);

			const lines = readFileSync(auditPath, "utf-8").trim().split("\n");
			expect(lines.length).toBeGreaterThanOrEqual(1);

			const events = lines.map((line) => JSON.parse(line) as AuditEvent);
			const failureEvent = events.find((e) => e.kind === "llm_call_failed");
			expect(failureEvent).toBeDefined();
			expect(failureEvent?.data.error).toContain("Rate limited");

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 7. Audit chain integrity after multiple calls
	// ─────────────────────────────────────────────────────────────────────

	describe("7. Audit chain integrity after multiple calls", () => {
		it("produces a valid hash-linked JSONL chain", async () => {
			const governed = await govern(makeAnthropicMock(), {
				dryRun: true,
				budget: 100_000,
				vaultBase: tmpVault,
			});

			// Make several calls to build up the chain
			await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 512,
				messages: [{ role: "user", content: "Call 1" }],
			});

			await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 512,
				messages: [{ role: "user", content: "Call 2" }],
			});

			await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 512,
				messages: [{ role: "user", content: "Call 3" }],
			});

			await governed.destroy();

			// Read the audit chain JSONL
			const auditPath = join(tmpVault, VAULT_DIR, "audit", "events.jsonl");
			expect(existsSync(auditPath)).toBe(true);

			const lines = readFileSync(auditPath, "utf-8").trim().split("\n");
			expect(lines.length).toBe(3);

			const events = lines.map((line) => JSON.parse(line) as AuditEvent & { sequence: number });

			// First event chains from GENESIS_HASH
			expect(events[0]?.previousHash).toBe(GENESIS_HASH);

			// Each subsequent event's previousHash matches the prior event's hash
			for (let i = 1; i < events.length; i++) {
				const prev = events[i - 1];
				const curr = events[i];
				expect(curr?.previousHash).toBe(prev?.hash);
			}

			// Every event has a unique, non-empty hash
			const hashes = events.map((e) => e.hash);
			expect(new Set(hashes).size).toBe(hashes.length);
			for (const h of hashes) {
				expect(h).toMatch(/^[a-f0-9]{64}$/);
			}

			// Sequences are monotonically increasing
			for (let i = 0; i < events.length; i++) {
				expect(events[i]?.sequence).toBe(i + 1);
			}

			// All events are llm_call kind
			for (const event of events) {
				expect(event.kind).toBe("llm_call");
				expect(event.actor).toBe("local");
				expect(event.data.model).toBe("claude-sonnet-4-6");
				expect(event.data.transferId).toMatch(/^tx_/);
				expect(event.data.cost).toBeGreaterThan(0);
			}
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 8. Destroy lifecycle
	// ─────────────────────────────────────────────────────────────────────

	describe("8. Destroy lifecycle", () => {
		it("rejects calls after destroy with clear error", async () => {
			const governed = await govern(makeAnthropicMock(), {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			// Make a successful call first
			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});
			expect(result.response).toBeDefined();

			// Destroy
			await governed.destroy();

			// Further calls should throw
			await expect(
				governed.messages.create({
					model: "claude-sonnet-4-6",
					messages: [{ role: "user", content: "After destroy" }],
				}),
			).rejects.toThrow("GovernedClient has been destroyed");
		});

		it("destroy is idempotent — calling twice does not throw", async () => {
			const governed = await govern(makeAnthropicMock(), {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			await governed.destroy();
			await governed.destroy(); // second call is safe
		});

		it("releases the audit lock so a new writer can acquire it", async () => {
			// First client
			const governed1 = await govern(makeAnthropicMock(), {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			await governed1.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 512,
				messages: [{ role: "user", content: "From client 1" }],
			});

			await governed1.destroy();

			// Second client on the same vault — should not fail due to lock
			const governed2 = await govern(makeAnthropicMock(), {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const result = await governed2.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 512,
				messages: [{ role: "user", content: "From client 2" }],
			});

			expect(result.response).toBeDefined();
			expect(result.governance.settled).toBe(true);

			await governed2.destroy();

			// Verify audit chain has events from both sessions
			const auditPath = join(tmpVault, VAULT_DIR, "audit", "events.jsonl");
			const lines = readFileSync(auditPath, "utf-8").trim().split("\n");
			expect(lines.length).toBe(2);
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 9. Config loading from vault
	// ─────────────────────────────────────────────────────────────────────

	describe("9. Config loading from vault", () => {
		it("loads budget from govern.config.json", async () => {
			writeVaultConfig(tmpVault, { budget: 10_000 });

			const governed = await govern(makeAnthropicMock(), {
				dryRun: true,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});

			// Budget is from config, not default
			expect(result.governance.budgetRemaining).toBeLessThan(10_000);

			await governed.destroy();
		});

		it("opts budget override takes precedence over config file", async () => {
			writeVaultConfig(tmpVault, { budget: 10_000 });

			const governed = await govern(makeAnthropicMock(), {
				dryRun: true,
				budget: 99_000,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});

			// Budget override wins
			expect(result.governance.budgetRemaining).toBeGreaterThan(10_000);
			expect(result.governance.budgetRemaining).toBeLessThan(99_000);

			await governed.destroy();
		});

		it("loads tier from config", async () => {
			writeVaultConfig(tmpVault, { budget: 50_000, tier: "pro" });

			// Policy that allows only pro tier
			writePolicyFile(tmpVault, "policies/default.yml", [
				{
					name: "require-pro",
					effect: "deny",
					enforcement: "hard",
					conditions: [{ field: "tier", operator: "eq", value: "free" }],
				},
			]);
			writeVaultConfig(tmpVault, {
				budget: 50_000,
				tier: "pro",
				policies: "./policies/default.yml",
			});

			const governed = await govern(makeAnthropicMock(), {
				dryRun: true,
				vaultBase: tmpVault,
			});

			// Should succeed because tier is "pro", not "free"
			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});

			expect(result.response).toBeDefined();

			await governed.destroy();
		});

		it("falls back to defaults when no config file exists", async () => {
			const governed = await govern(makeAnthropicMock(), {
				dryRun: true,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});

			// Default budget is 50,000
			expect(result.governance.budgetRemaining).toBeLessThan(50_000);

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 10. Streaming mock
	// ─────────────────────────────────────────────────────────────────────

	describe("10. Streaming support — wrapStream unit integration", () => {
		// Note: govern() does not natively intercept stream: true at the proxy
		// level (streaming is handled via wrapStream/createGovernedStream
		// separately). This test verifies the streaming module can be used
		// alongside the governed client.

		it("wrapStream accumulates tokens from Anthropic chunks", async () => {
			// Import streaming module dynamically to avoid hoisting issues
			const { wrapStream } = await import("../../src/streaming.js");

			async function* mockStream() {
				yield {
					type: "message_start",
					message: { usage: { input_tokens: 100 } },
				};
				yield {
					type: "content_block_delta",
					delta: { text: "Hello" },
				};
				yield {
					type: "content_block_delta",
					delta: { text: " world" },
				};
				yield {
					type: "message_delta",
					usage: { output_tokens: 25 },
				};
			}

			const onComplete = vi.fn();
			const onError = vi.fn();
			const wrapped = wrapStream(mockStream(), "anthropic", onComplete, onError);

			const chunks: unknown[] = [];
			for await (const chunk of wrapped) {
				chunks.push(chunk);
			}

			expect(chunks).toHaveLength(4);
			expect(onComplete).toHaveBeenCalledOnce();
			expect(onComplete).toHaveBeenCalledWith({
				inputTokens: 100,
				outputTokens: 25,
			});
			expect(onError).not.toHaveBeenCalled();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 11. Cross-provider in same test — verify isolation
	// ─────────────────────────────────────────────────────────────────────

	describe("11. Cross-provider isolation", () => {
		it("governs Anthropic and OpenAI clients independently", async () => {
			const anthropicClient = makeAnthropicMock();
			const openaiClient = makeOpenAIMock();

			const governedAnthropic = await govern(anthropicClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			// Use a separate vault for OpenAI to avoid audit lock contention
			const tmpVault2 = makeTmpVault();
			const governedOpenAI = await govern(openaiClient, {
				dryRun: true,
				budget: 30_000,
				vaultBase: tmpVault2,
			});

			const rAnthropic = await governedAnthropic.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello Claude" }],
			});

			const rOpenAI = await governedOpenAI.chat.completions.create({
				model: "gpt-4o",
				messages: [{ role: "user", content: "Hello GPT" }],
			});

			// Different providers, different budgets, different transfer IDs
			expect(rAnthropic.governance.provider).toBe("anthropic");
			expect(rOpenAI.governance.provider).toBe("openai");
			expect(rAnthropic.governance.transferId).not.toBe(rOpenAI.governance.transferId);
			expect(rAnthropic.governance.budgetRemaining).toBeLessThan(50_000);
			expect(rOpenAI.governance.budgetRemaining).toBeLessThan(30_000);

			await governedAnthropic.destroy();
			await governedOpenAI.destroy();

			try {
				rmSync(tmpVault2, { recursive: true, force: true });
			} catch {
				// cleanup
			}
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 12. Policy + PII combined
	// ─────────────────────────────────────────────────────────────────────

	describe("12. Policy + PII combined enforcement", () => {
		it("policy denial takes precedence (evaluated first)", async () => {
			writePolicyFile(tmpVault, "policies/default.yml", [
				{
					name: "block-opus",
					effect: "deny",
					enforcement: "hard",
					conditions: [{ field: "model", operator: "eq", value: "claude-opus-4-6" }],
				},
			]);
			writeVaultConfig(tmpVault, {
				budget: 50_000,
				pii: "block",
				policies: "./policies/default.yml",
			});

			const createFn = vi.fn(async () => ({ id: "msg" }));
			const mockClient = { messages: { create: createFn } };

			const governed = await govern(mockClient, {
				dryRun: true,
				vaultBase: tmpVault,
			});

			// Message has PII AND uses blocked model. Policy runs first.
			await expect(
				governed.messages.create({
					model: "claude-opus-4-6",
					messages: [
						{
							role: "user",
							content: "Email me at test@example.com",
						},
					],
				}),
			).rejects.toThrow("Policy denied");

			expect(createFn).not.toHaveBeenCalled();

			await governed.destroy();
		});

		it("PII blocks even when policy allows the model", async () => {
			writeVaultConfig(tmpVault, { budget: 50_000, pii: "block" });

			const createFn = vi.fn(async () => ({ id: "msg" }));
			const mockClient = { messages: { create: createFn } };

			const governed = await govern(mockClient, {
				dryRun: true,
				vaultBase: tmpVault,
			});

			await expect(
				governed.messages.create({
					model: "claude-sonnet-4-6",
					messages: [
						{
							role: "user",
							content: "My SSN is 123-45-6789",
						},
					],
				}),
			).rejects.toThrow("PII detected");

			expect(createFn).not.toHaveBeenCalled();

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 13. Audit chain verification with hash recomputation
	// ─────────────────────────────────────────────────────────────────────

	describe("13. Audit chain — hash recomputation verification", () => {
		it("each event hash is correctly computed from its canonical form", async () => {
			const governed = await govern(makeAnthropicMock(), {
				dryRun: true,
				budget: 100_000,
				vaultBase: tmpVault,
			});

			await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 512,
				messages: [{ role: "user", content: "Audit me" }],
			});

			await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 512,
				messages: [{ role: "user", content: "Audit me too" }],
			});

			await governed.destroy();

			// Import the canonicalize function used by the audit writer
			const { canonicalize } = await import("../../src/audit/canonical.js");

			const auditPath = join(tmpVault, VAULT_DIR, "audit", "events.jsonl");
			const lines = readFileSync(auditPath, "utf-8").trim().split("\n");
			expect(lines.length).toBe(2);

			for (const line of lines) {
				const event = JSON.parse(line) as AuditEvent & {
					sequence: number;
				};
				const storedHash = event.hash;

				// Recompute hash without the hash field
				const { hash: _hash, ...eventWithoutHash } = event;
				const recomputedCanonical = canonicalize(eventWithoutHash);
				const recomputedHash = createHash("sha256").update(recomputedCanonical).digest("hex");

				expect(recomputedHash).toBe(storedHash);
			}
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 14. Budget from config is enforced across session
	// ─────────────────────────────────────────────────────────────────────

	describe("14. End-to-end governance receipt completeness", () => {
		it("every field of GovernanceReceipt is populated correctly", async () => {
			const governed = await govern(makeAnthropicMock(), {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Full receipt check" }],
			});

			const g = result.governance;

			// transferId — format: tx_<base36timestamp>_<hex>
			expect(g.transferId).toMatch(/^tx_[a-z0-9]+_[a-f0-9]+$/);

			// cost — positive integer
			expect(Number.isInteger(g.cost)).toBe(true);
			expect(g.cost).toBeGreaterThanOrEqual(1);

			// budgetRemaining — integer, less than budget
			expect(Number.isInteger(g.budgetRemaining)).toBe(true);
			expect(g.budgetRemaining).toBe(50_000 - g.cost);

			// auditHash — 64 hex chars (SHA-256)
			expect(g.auditHash).toMatch(/^[a-f0-9]{64}$/);

			// chainPath — points to audit directory
			expect(g.chainPath).toBe(join(VAULT_DIR, "audit"));

			// receiptUrl — null in local mode
			expect(g.receiptUrl).toBeNull();

			// settled — true in dry-run
			expect(g.settled).toBe(true);

			// model — as passed
			expect(g.model).toBe("claude-sonnet-4-6");

			// provider — detected from client shape
			expect(g.provider).toBe("anthropic");

			// timestamp — ISO 8601
			expect(g.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 15. PII warn mode passes through but still calls LLM
	// ─────────────────────────────────────────────────────────────────────

	describe("15. PII warn mode passes through", () => {
		it("calls LLM and returns response when PII is present in warn mode", async () => {
			writeVaultConfig(tmpVault, { budget: 50_000, pii: "warn" });

			const governed = await govern(makeAnthropicMock(), {
				dryRun: true,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [
					{
						role: "user",
						content: "My email is test@example.com and SSN is 123-45-6789",
					},
				],
			});

			// Should succeed despite PII
			expect(result.response).toBeDefined();
			expect(result.governance.settled).toBe(true);

			await governed.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// 16. Multiple providers — audit chain continuity
	// ─────────────────────────────────────────────────────────────────────

	describe("16. Sequential governed clients share audit chain", () => {
		it("second client continues the hash chain from the first", async () => {
			// First client session
			const governed1 = await govern(makeAnthropicMock(), {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			await governed1.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 512,
				messages: [{ role: "user", content: "Session 1" }],
			});

			await governed1.destroy();

			// Second client session on same vault
			const governed2 = await govern(makeAnthropicMock(), {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			await governed2.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 512,
				messages: [{ role: "user", content: "Session 2" }],
			});

			await governed2.destroy();

			// Verify chain continuity
			const auditPath = join(tmpVault, VAULT_DIR, "audit", "events.jsonl");
			const lines = readFileSync(auditPath, "utf-8").trim().split("\n");
			expect(lines.length).toBe(2);

			const events = lines.map((line) => JSON.parse(line) as AuditEvent);

			// Event 1 chains from genesis
			expect(events[0]?.previousHash).toBe(GENESIS_HASH);

			// Event 2 chains from event 1
			expect(events[1]?.previousHash).toBe(events[0]?.hash);
		});
	});
});
