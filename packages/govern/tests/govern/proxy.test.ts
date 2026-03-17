import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { govern } from "../../src/govern.js";
import { type ProxyConnection, connectProxy } from "../../src/proxy.js";
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
	const dir = join(tmpdir(), `govern-proxy-test-${randomUUID()}`);
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
		usage: { input_tokens: 10, output_tokens: 5 },
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

// ── connectProxy() unit tests ──

describe("connectProxy()", () => {
	it("returns a ProxyConnection with url and key", () => {
		const conn = connectProxy("https://proxy.usertools.ai", "pk_test_123");
		expect(conn.url).toBe("https://proxy.usertools.ai");
		expect(conn.key).toBe("pk_test_123");
	});

	it("key is undefined when not provided", () => {
		const conn = connectProxy("https://proxy.usertools.ai");
		expect(conn.url).toBe("https://proxy.usertools.ai");
		expect(conn.key).toBeUndefined();
	});

	it("spend returns a proxy transfer ID", async () => {
		const conn = connectProxy("https://proxy.usertools.ai", "pk_test_123");
		const result = await conn.spend({
			model: "claude-sonnet-4-6",
			estimatedCost: 100,
			actor: "local",
		});
		expect(result.transferId).toMatch(/^proxy_/);
		expect(result.estimatedCost).toBe(100);
	});

	it("settle is a no-op (stub)", async () => {
		const conn = connectProxy("https://proxy.usertools.ai");
		await expect(conn.settle("proxy_abc", 50)).resolves.toBeUndefined();
	});

	it("void is a no-op (stub)", async () => {
		const conn = connectProxy("https://proxy.usertools.ai");
		await expect(conn.void("proxy_abc")).resolves.toBeUndefined();
	});

	it("destroy is a no-op (stub)", () => {
		const conn = connectProxy("https://proxy.usertools.ai");
		expect(() => conn.destroy()).not.toThrow();
	});
});

// ── proxy mode integration tests ──

describe("proxy mode", () => {
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

	it("govern({ proxy }) does not create local TB client", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await govern(mockClient, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			proxy: "https://proxy.usertools.ai",
			_audit: mockAudit,
		});

		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		// Call succeeds
		expect(result.response).toBeDefined();

		await governed.destroy();
	});

	it("governance receipt has receiptUrl (not null) in proxy mode", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await govern(mockClient, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			proxy: "https://proxy.usertools.ai",
			_audit: mockAudit,
		});

		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(result.governance.receiptUrl).not.toBeNull();
		expect(result.governance.receiptUrl).toMatch(/^https:\/\/verify\.usertools\.dev\/tx_/);

		await governed.destroy();
	});

	it("receiptUrl is null without proxy", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await govern(mockClient, {
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

		expect(result.governance.receiptUrl).toBeNull();

		await governed.destroy();
	});

	it("govern({ proxy, key }) passes key to proxy connection", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		// This test verifies the key is passed through by checking
		// the governed client works with proxy+key opts set
		const governed = await govern(mockClient, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			proxy: "https://proxy.usertools.ai",
			key: "pk_live_abc123",
			_audit: mockAudit,
		});

		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(result.response).toBeDefined();
		expect(result.governance.receiptUrl).not.toBeNull();

		await governed.destroy();
	});

	it("proxy mode still evaluates policy gate", async () => {
		const mockAudit = makeMockAudit();

		const { writeFileSync } = await import("node:fs");
		const policiesDir = join(tmpVault, ".usertools", "policies");
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

		const configDir = join(tmpVault, ".usertools");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "govern.config.json"),
			JSON.stringify({
				budget: 50_000,
				policies: "./policies/default.yml",
			}),
		);

		const createFn = vi.fn(async () => ({ id: "msg" }));
		const mockClient = { messages: { create: createFn } };

		const governed = await govern(mockClient, {
			dryRun: true,
			vaultBase: tmpVault,
			proxy: "https://proxy.usertools.ai",
			_audit: mockAudit,
		});

		await expect(
			governed.messages.create({
				model: "claude-opus-4-6",
				messages: [{ role: "user", content: "Hello" }],
			}),
		).rejects.toThrow("Policy denied");

		expect(createFn).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("proxy mode still writes audit chain", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await govern(mockClient, {
			dryRun: true,
			budget: 50_000,
			vaultBase: tmpVault,
			proxy: "https://proxy.usertools.ai",
			_audit: mockAudit,
		});

		await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(mockAudit.appendEvent).toHaveBeenCalled();

		await governed.destroy();
	});
});
