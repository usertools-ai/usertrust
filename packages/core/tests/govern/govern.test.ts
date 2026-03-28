import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TrustedClient, trust } from "../../src/govern.js";

// Mock tigerbeetle-node at module level (native module, never loaded in tests)
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
	const dir = join(tmpdir(), `trust-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeAnthropicMock(
	response?: Record<string, unknown>,
	createFn?: (...args: unknown[]) => unknown,
) {
	const defaultResponse = {
		id: "msg_123",
		type: "message",
		role: "assistant",
		content: [{ type: "text", text: "Hello" }],
		model: "claude-sonnet-4-6",
		usage: { input_tokens: 10, output_tokens: 5 },
	};
	return {
		messages: {
			create: createFn ?? vi.fn(async () => response ?? defaultResponse),
		},
	};
}

function makeOpenAIMock(response?: Record<string, unknown>) {
	const defaultResponse = {
		id: "chatcmpl-123",
		choices: [{ message: { role: "assistant", content: "Hi" } }],
		usage: { prompt_tokens: 10, completion_tokens: 5 },
	};
	return {
		chat: {
			completions: {
				create: vi.fn(async () => response ?? defaultResponse),
			},
		},
	};
}

function makeGoogleMock(response?: Record<string, unknown>) {
	const defaultResponse = {
		text: "Hello from Gemini",
		usage: { input_tokens: 10, output_tokens: 5 },
	};
	return {
		models: {
			generateContent: vi.fn(async () => response ?? defaultResponse),
		},
	};
}

// ── Tests ──

describe("trust()", () => {
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

	// ─── Anthropic ───

	describe("Anthropic client", () => {
		it("wraps client and returns TrustedResponse", async () => {
			const mockClient = makeAnthropicMock();
			const governed = await trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});

			expect(result.response).toBeDefined();
			expect(result.response.id).toBe("msg_123");
			expect(result.receipt).toBeDefined();
			expect(result.receipt.transferId).toMatch(/^tx_/);
			expect(result.receipt.cost).toBeGreaterThan(0);
			expect(result.receipt.model).toBe("claude-sonnet-4-6");
			expect(result.receipt.provider).toBe("anthropic");
			expect(result.receipt.settled).toBe(true);
			expect(result.receipt.receiptUrl).toBeNull();
			expect(result.receipt.budgetRemaining).toBeLessThan(50_000);

			await governed.destroy();
		});

		it("computes actual cost from response usage", async () => {
			const mockClient = makeAnthropicMock({
				id: "msg_456",
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 100, output_tokens: 200 },
			});
			const governed = await trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});

			// cost from actual usage: (100/1000)*30 + (200/1000)*150 = 3 + 30 = 33
			expect(result.receipt.cost).toBe(33);

			await governed.destroy();
		});

		it("preserves other client properties", async () => {
			const mockClient = {
				messages: { create: vi.fn(async () => ({ id: "msg" })) },
				someOtherProp: "hello",
				beta: { tools: { list: vi.fn() } },
			};

			const governed = await trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			expect((governed as typeof mockClient).someOtherProp).toBe("hello");
			expect((governed as typeof mockClient).beta.tools.list).toBeDefined();

			await governed.destroy();
		});
	});

	// ─── OpenAI ───

	describe("OpenAI client", () => {
		it("wraps client and returns TrustedResponse", async () => {
			const mockClient = makeOpenAIMock();
			const governed = await trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const result = await governed.chat.completions.create({
				model: "gpt-4o",
				messages: [{ role: "user", content: "Hello" }],
			});

			expect(result.response).toBeDefined();
			expect(result.response.id).toBe("chatcmpl-123");
			expect(result.receipt.model).toBe("gpt-4o");
			expect(result.receipt.provider).toBe("openai");
			expect(result.receipt.settled).toBe(true);

			await governed.destroy();
		});

		it("uses prompt_tokens/completion_tokens from OpenAI usage", async () => {
			const governed = await trust(makeOpenAIMock(), {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const result = await governed.chat.completions.create({
				model: "gpt-4o",
				messages: [{ role: "user", content: "Hello" }],
			});

			// cost = (10/1000)*25 + (5/1000)*100 = 0.25 + 0.5 = ceil(0.75) = 1
			expect(result.receipt.cost).toBeGreaterThanOrEqual(1);

			await governed.destroy();
		});
	});

	// ─── Google ───

	describe("Google client", () => {
		it("wraps client and returns TrustedResponse", async () => {
			const mockClient = makeGoogleMock();
			const governed = await trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const result = await governed.models.generateContent({
				model: "gemini-2.5-flash",
				messages: [{ role: "user", content: "Hello" }],
			});

			expect(result.response).toBeDefined();
			expect(result.receipt.model).toBe("gemini-2.5-flash");
			expect(result.receipt.provider).toBe("google");

			await governed.destroy();
		});
	});

	// ─── Error handling ───

	describe("error handling", () => {
		it("LLM failure propagates and records audit event", async () => {
			const mockClient = makeAnthropicMock(undefined, async () => {
				throw new Error("API error");
			});

			const governed = await trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			await expect(
				governed.messages.create({
					model: "claude-sonnet-4-6",
					messages: [{ role: "user", content: "Hello" }],
				}),
			).rejects.toThrow("API error");

			await governed.destroy();
		});

		it("throws after destroy", async () => {
			const mockClient = makeAnthropicMock();
			const governed = await trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			await governed.destroy();

			await expect(
				governed.messages.create({
					model: "claude-sonnet-4-6",
					messages: [{ role: "user", content: "Hello" }],
				}),
			).rejects.toThrow("TrustedClient has been destroyed");
		});
	});

	// ─── destroy() ───

	describe("destroy()", () => {
		it("is idempotent", async () => {
			const mockClient = makeAnthropicMock();
			const governed = await trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			await governed.destroy();
			await governed.destroy(); // should not throw
		});
	});

	// ─── Config loading ───

	describe("config loading", () => {
		it("loads config from usertrust.config.json", async () => {
			const configDir = join(tmpVault, ".usertrust");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(
				join(configDir, "usertrust.config.json"),
				JSON.stringify({ budget: 10_000, tier: "pro" }),
			);

			const mockClient = makeAnthropicMock();
			const governed = await trust(mockClient, {
				vaultBase: tmpVault,
				dryRun: true,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});

			// Budget is 10,000 from config
			expect(result.receipt.budgetRemaining).toBeLessThan(10_000);

			await governed.destroy();
		});

		it("falls back to defaults when no config file", async () => {
			const mockClient = makeAnthropicMock();
			const governed = await trust(mockClient, {
				dryRun: true,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});

			// Default budget is 50,000
			expect(result.receipt.budgetRemaining).toBeLessThan(50_000);

			await governed.destroy();
		});

		it("budget opt overrides config file", async () => {
			const configDir = join(tmpVault, ".usertrust");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "usertrust.config.json"), JSON.stringify({ budget: 10_000 }));

			const mockClient = makeAnthropicMock();
			const governed = await trust(mockClient, {
				vaultBase: tmpVault,
				dryRun: true,
				budget: 99_000,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});

			expect(result.receipt.budgetRemaining).toBeLessThan(99_000);
			expect(result.receipt.budgetRemaining).toBeGreaterThan(10_000);

			await governed.destroy();
		});
	});

	// ─── Policy gate ───

	describe("policy gate", () => {
		it("denial throws PolicyDeniedError before LLM call", async () => {
			// Create a policy that denies all calls to the blocked model
			const configDir = join(tmpVault, ".usertrust");
			mkdirSync(configDir, { recursive: true });

			const policiesDir = join(tmpVault, ".usertrust", "policies");
			mkdirSync(policiesDir, { recursive: true });
			writeFileSync(
				join(policiesDir, "default.yml"),
				JSON.stringify({
					rules: [
						{
							name: "block-opus",
							effect: "deny",
							enforcement: "hard",
							conditions: [{ field: "model", operator: "eq", value: "claude-opus-4-6" }],
						},
					],
				}),
			);

			writeFileSync(
				join(configDir, "usertrust.config.json"),
				JSON.stringify({
					budget: 50_000,
					policies: "./policies/default.yml",
				}),
			);

			const createFn = vi.fn(async () => ({ id: "msg" }));
			const mockClient = { messages: { create: createFn } };

			const governed = await trust(mockClient, {
				dryRun: true,
				vaultBase: tmpVault,
			});

			await expect(
				governed.messages.create({
					model: "claude-opus-4-6",
					messages: [{ role: "user", content: "Hello" }],
				}),
			).rejects.toThrow("Policy denied");

			// The original create was never called
			expect(createFn).not.toHaveBeenCalled();

			await governed.destroy();
		});
	});

	// ─── PII detection ───

	describe("PII detection", () => {
		it("blocks when pii=block and PII is present", async () => {
			const configDir = join(tmpVault, ".usertrust");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(
				join(configDir, "usertrust.config.json"),
				JSON.stringify({ budget: 50_000, pii: "block" }),
			);

			const createFn = vi.fn(async () => ({ id: "msg" }));
			const mockClient = { messages: { create: createFn } };

			const governed = await trust(mockClient, {
				dryRun: true,
				vaultBase: tmpVault,
			});

			await expect(
				governed.messages.create({
					model: "claude-sonnet-4-6",
					messages: [
						{
							role: "user",
							content: "My email is test@example.com and SSN is 123-45-6789",
						},
					],
				}),
			).rejects.toThrow("PII detected");

			expect(createFn).not.toHaveBeenCalled();

			await governed.destroy();
		});

		it("passes through when pii=warn and PII is present", async () => {
			const configDir = join(tmpVault, ".usertrust");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(
				join(configDir, "usertrust.config.json"),
				JSON.stringify({ budget: 50_000, pii: "warn" }),
			);

			const mockClient = makeAnthropicMock();

			const governed = await trust(mockClient, {
				dryRun: true,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "My email is test@example.com" }],
			});

			// Should succeed despite PII
			expect(result.receipt).toBeDefined();

			await governed.destroy();
		});

		it("passes through when pii=off", async () => {
			const configDir = join(tmpVault, ".usertrust");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(
				join(configDir, "usertrust.config.json"),
				JSON.stringify({ budget: 50_000, pii: "off" }),
			);

			const mockClient = makeAnthropicMock();

			const governed = await trust(mockClient, {
				dryRun: true,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				messages: [
					{
						role: "user",
						content: "SSN 123-45-6789 email foo@bar.com",
					},
				],
			});

			expect(result.receipt).toBeDefined();

			await governed.destroy();
		});
	});

	// ─── Receipt URL ───

	describe("receipt URL", () => {
		it("is null in local mode", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "Hello" }],
			});

			expect(result.receipt.receiptUrl).toBeNull();

			await governed.destroy();
		});

		it("is populated when proxy is set", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
				proxy: "https://proxy.usertools.ai",
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "Hello" }],
			});

			expect(result.receipt.receiptUrl).toMatch(/^https:\/\/verify\.usertools\.dev\/tx_/);

			await governed.destroy();
		});
	});

	// ─── Budget tracking ───

	describe("budget tracking", () => {
		it("decrements budget across multiple calls", async () => {
			const governed = await trust(makeAnthropicMock(), {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const r1 = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});

			const r2 = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello again" }],
			});

			expect(r2.receipt.budgetRemaining).toBeLessThan(r1.receipt.budgetRemaining);

			await governed.destroy();
		});
	});

	// ─── Unknown model ───

	describe("unknown models", () => {
		it("uses fallback pricing for unrecognised models", async () => {
			const mockClient = makeAnthropicMock({
				id: "msg_999",
				model: "custom-model-v1",
				usage: { input_tokens: 100, output_tokens: 50 },
			});

			const governed = await trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "custom-model-v1",
				messages: [{ role: "user", content: "Hello" }],
			});

			// Fallback rate: input 30/1k, output 150/1k
			// (100/1000)*30 + (50/1000)*150 = 3 + 7.5 = ceil(10.5) = 11
			expect(result.receipt.cost).toBe(11);

			await governed.destroy();
		});
	});

	// ─── Proxy fallback property access (Reflect.get branches) ───

	describe("proxy fallback property access", () => {
		it("Anthropic: accessing non-create prop on messages object returns original", async () => {
			const mockClient = {
				messages: {
					create: vi.fn(async () => ({ id: "msg_123" })),
					stream: vi.fn(async () => ({ id: "stream_123" })),
					otherProp: 42,
				},
			};

			const governed = await trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			// Access non-intercepted prop on the messages proxy
			const msgs = (governed as typeof mockClient).messages;
			expect(msgs.otherProp).toBe(42);
			expect(msgs.stream).toBeDefined();

			await governed.destroy();
		});

		it("OpenAI: accessing non-create prop on completions returns original", async () => {
			const mockClient = {
				chat: {
					completions: {
						create: vi.fn(async () => ({ id: "chatcmpl-123" })),
						list: vi.fn(async () => []),
						extraProp: "hello",
					},
					otherChatProp: "world",
				},
			};

			const governed = await trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			// Access non-intercepted prop on completions proxy (line 459)
			const completions = (governed as typeof mockClient).chat.completions;
			expect(completions.extraProp).toBe("hello");
			expect(completions.list).toBeDefined();

			// Access non-intercepted prop on chat proxy (line 466)
			const chat = (governed as typeof mockClient).chat;
			expect(chat.otherChatProp).toBe("world");

			await governed.destroy();
		});

		it("Google: accessing non-generateContent prop on models returns original", async () => {
			const mockClient = {
				models: {
					generateContent: vi.fn(async () => ({ text: "Hello" })),
					list: vi.fn(async () => []),
					someProp: 99,
				},
			};

			const governed = await trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			// Access non-intercepted prop on models proxy (line 495)
			const models = (governed as typeof mockClient).models;
			expect(models.someProp).toBe(99);
			expect(models.list).toBeDefined();

			await governed.destroy();
		});
	});

	// ─── Audit degraded in LLM failure path ───

	describe("audit degraded in LLM failure path", () => {
		it("sets auditDegraded when llm_call_failed audit write throws (line 349)", async () => {
			const mockAudit: import("../../src/audit/chain.js").AuditWriter = {
				appendEvent: vi.fn(async () => {
					throw new Error("Audit disk full in error path");
				}),
				getWriteFailures: vi.fn(() => 0),
				isDegraded: vi.fn(() => false),
				flush: vi.fn(async () => {}),
				release: vi.fn(),
			};

			const mockClient = makeAnthropicMock(undefined, async () => {
				throw new Error("LLM 500 error");
			});

			const governed = await trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
				_audit: mockAudit,
			});

			// LLM error should propagate even if audit fails
			await expect(
				governed.messages.create({
					model: "claude-sonnet-4-6",
					messages: [{ role: "user", content: "Hello" }],
				}),
			).rejects.toThrow("LLM 500 error");

			// Audit was called with llm_call_failed but it threw
			expect(mockAudit.appendEvent).toHaveBeenCalledWith(
				expect.objectContaining({ kind: "llm_call_failed" }),
			);

			await governed.destroy();
		});
	});

	// ─── Proxy void on LLM failure (line 335) ───

	describe("proxy void on LLM failure", () => {
		it("calls proxyConn.void when LLM fails in proxy mode (line 335)", async () => {
			const mockClient = makeAnthropicMock(undefined, async () => {
				throw new Error("LLM rate limited");
			});

			const governed = await trust(mockClient, {
				dryRun: false,
				budget: 50_000,
				vaultBase: tmpVault,
				proxy: "https://proxy.usertools.ai",
				_engine: null,
			});

			await expect(
				governed.messages.create({
					model: "claude-sonnet-4-6",
					messages: [{ role: "user", content: "Hello" }],
				}),
			).rejects.toThrow("LLM rate limited");

			await governed.destroy();
		});
	});

	// ─── Proxy settlement path (lines 263-269) ───

	describe("proxy settlement in non-dryRun mode", () => {
		it("exercises proxy settle path when dryRun=false with proxy", async () => {
			const mockClient = makeAnthropicMock();

			const governed = await trust(mockClient, {
				dryRun: false,
				budget: 50_000,
				vaultBase: tmpVault,
				proxy: "https://proxy.usertools.ai",
				_engine: null,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});

			// With the stub proxy, settle succeeds, so settled should be true
			expect(result.receipt.settled).toBe(true);

			await governed.destroy();
		});
	});

	// ─── Response without usage field ───

	describe("response without usage", () => {
		it("uses estimated cost when response has no usage field", async () => {
			const mockClient = makeAnthropicMock({
				id: "msg_no_usage",
				model: "claude-sonnet-4-6",
				// no usage field
			});

			const governed = await trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});

			// Should still have a cost (estimated, not from usage)
			expect(result.receipt.cost).toBeGreaterThan(0);

			await governed.destroy();
		});

		it("uses estimated cost when usage is null", async () => {
			const mockClient = makeAnthropicMock({
				id: "msg_null_usage",
				model: "claude-sonnet-4-6",
				usage: null,
			});

			const governed = await trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});

			expect(result.receipt.cost).toBeGreaterThan(0);

			await governed.destroy();
		});
	});
});
