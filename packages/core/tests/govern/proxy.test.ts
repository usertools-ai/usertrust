import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { trust } from "../../src/govern.js";
import { connectProxy } from "../../src/proxy.js";
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
	const dir = join(tmpdir(), `trust-proxy-test-${randomUUID()}`);
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

// ── AUD-456: connectProxy() throws ──

describe("connectProxy() — AUD-456", () => {
	it("throws 'proxy mode not yet implemented'", () => {
		expect(() => connectProxy("https://proxy.usertools.ai", "pk_test_123")).toThrow(
			"proxy mode is not yet implemented",
		);
	});

	it("throws without a key too", () => {
		expect(() => connectProxy("https://proxy.usertools.ai")).toThrow("AUD-456");
	});

	it("error message mentions dryRun as an alternative", () => {
		expect(() => connectProxy("https://proxy.usertools.ai")).toThrow("dryRun");
	});
});

// ── AUD-456: trust({ proxy }) throws ──

describe("trust({ proxy }) — AUD-456", () => {
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

	it("trust() throws when proxy option is provided", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		await expect(
			trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
				proxy: "https://proxy.usertools.ai",
				_audit: mockAudit,
			}),
		).rejects.toThrow("proxy mode is not yet implemented");
	});

	it("trust() throws when proxy and key options are provided", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		await expect(
			trust(mockClient, {
				dryRun: true,
				budget: 50_000,
				vaultBase: tmpVault,
				proxy: "https://proxy.usertools.ai",
				key: "pk_live_abc123",
				_audit: mockAudit,
			}),
		).rejects.toThrow("AUD-456");
	});

	it("trust() works normally without proxy option", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

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

		expect(result.response).toBeDefined();
		expect(result.receipt.receiptUrl).toBeNull();

		await governed.destroy();
	});

	it("receiptUrl is null without proxy", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

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

		expect(result.receipt.receiptUrl).toBeNull();

		await governed.destroy();
	});
});
