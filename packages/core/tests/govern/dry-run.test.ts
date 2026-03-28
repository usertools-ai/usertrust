import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { trust } from "../../src/govern.js";
import type { AuditEvent } from "../../src/shared/types.js";

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
	const dir = join(tmpdir(), `trust-dryrun-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeAnthropicMock(response?: Record<string, unknown>) {
	const defaultResponse = {
		id: "msg_123",
		type: "message",
		role: "assistant",
		content: [{ type: "text", text: "Hello" }],
		model: "claude-sonnet-4-6",
		usage: { input_tokens: 100, output_tokens: 50 },
	};
	return {
		messages: {
			create: vi.fn(async () => response ?? defaultResponse),
		},
	};
}

function makeMockAudit(): AuditWriter {
	return {
		appendEvent: vi.fn(
			async (input: AppendEventInput): Promise<AuditEvent> => ({
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				previousHash: "0".repeat(64),
				hash: "a".repeat(64),
				kind: input.kind,
				actor: input.actor,
				data: input.data,
			}),
		),
		getWriteFailures: vi.fn(() => 0),
		isDegraded: vi.fn(() => false),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
	};
}

// ── Tests ──

describe("USERTRUST_DRY_RUN=true", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = makeTmpVault();
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	it("does not connect to TigerBeetle (engine is null in dry-run)", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		// In dry-run, no engine is created. We do NOT pass _engine —
		// the code path should skip all engine operations.
		const governed = await trust(mockClient, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			_audit: mockAudit,
		});

		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		// Call succeeds without engine
		expect(result.response).toBeDefined();
		expect(result.governance.settled).toBe(true);

		await governed.destroy();
	});

	it("still evaluates policy gate", async () => {
		const mockAudit = makeMockAudit();

		// Create a policy file that blocks the model
		const policiesDir = join(tmpVault, ".usertrust", "policies");
		mkdirSync(policiesDir, { recursive: true });
		const { writeFileSync } = await import("node:fs");
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

		const configDir = join(tmpVault, ".usertrust");
		mkdirSync(configDir, { recursive: true });
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
			_audit: mockAudit,
		});

		await expect(
			governed.messages.create({
				model: "claude-opus-4-6",
				messages: [{ role: "user", content: "Hello" }],
			}),
		).rejects.toThrow("Policy denied");

		// LLM was never called
		expect(createFn).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("still writes audit chain", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			_audit: mockAudit,
		});

		await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		// audit.appendEvent was called with llm_call
		expect(mockAudit.appendEvent).toHaveBeenCalled();
		const appendCalls = (mockAudit.appendEvent as ReturnType<typeof vi.fn>).mock.calls;
		const llmCallEvent = appendCalls.find(
			(call: unknown[]) => (call[0] as AppendEventInput).kind === "llm_call",
		);
		expect(llmCallEvent).toBeDefined();

		await governed.destroy();
	});

	it("returns governance receipt with settled: true and calculated cost", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock({
			id: "msg_456",
			model: "claude-sonnet-4-6",
			usage: { input_tokens: 100, output_tokens: 200 },
		});

		const governed = await trust(mockClient, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			_audit: mockAudit,
		});

		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(result.governance.settled).toBe(true);
		// Cost should be calculated: (100/1000)*30 + (200/1000)*150 = 3 + 30 = 33
		expect(result.governance.cost).toBe(33);
		expect(result.governance.cost).toBeGreaterThan(0);
		expect(result.governance.budgetRemaining).toBeLessThan(50_000);

		await governed.destroy();
	});

	it("destroy() succeeds without TB cleanup", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			_audit: mockAudit,
		});

		// Make a call so there's audit state
		await governed.messages.create({
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "Hello" }],
		});

		// destroy() should succeed cleanly without engine
		await governed.destroy();

		expect(mockAudit.flush).toHaveBeenCalledOnce();
		expect(mockAudit.release).toHaveBeenCalledOnce();
	});

	it("USERTRUST_DRY_RUN env var activates dry-run mode", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		vi.stubEnv("USERTRUST_DRY_RUN", "true");

		try {
			const governed = await trust(mockClient, {
				// dryRun not passed explicitly — env var should activate it
				budget: 50_000,
				vaultBase: tmpVault,
				_audit: mockAudit,
			});

			const result = await governed.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 1024,
				messages: [{ role: "user", content: "Hello" }],
			});

			// Should succeed as dry-run (no engine)
			expect(result.governance.settled).toBe(true);
			expect(result.governance.cost).toBeGreaterThan(0);

			await governed.destroy();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("tracks budget across multiple dry-run calls", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			_audit: mockAudit,
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

		expect(r2.governance.budgetRemaining).toBeLessThan(r1.governance.budgetRemaining);
		expect(r2.governance.budgetRemaining).toBe(50_000 - r1.governance.cost - r2.governance.cost);

		await governed.destroy();
	});
});
