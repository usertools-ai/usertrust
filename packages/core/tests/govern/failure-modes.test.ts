import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import { type TrustEngine, trust } from "../../src/govern.js";
import { LedgerUnavailableError } from "../../src/shared/errors.js";
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
	const dir = join(tmpdir(), `trust-fm-test-${randomUUID()}`);
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

function makeMockEngine(overrides?: Partial<TrustEngine>): TrustEngine {
	return {
		spendPending: vi.fn(async (params: { transferId: string; amount: number }) => ({
			transferId: params.transferId,
		})),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async () => {}),
		destroy: vi.fn(),
		...overrides,
	};
}

function makeMockAudit(overrides?: Partial<AuditWriter>): AuditWriter {
	const events: AppendEventInput[] = [];
	return {
		appendEvent: vi.fn(async (input: AppendEventInput): Promise<AuditEvent> => {
			events.push(input);
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
		getWriteFailures: vi.fn(() => 0),
		isDegraded: vi.fn(() => false),
		flush: vi.fn(async () => {}),
		release: vi.fn(),
		...overrides,
	};
}

// ── Tests ──

describe("Failure mode 15.1: LLM succeeds, POST fails", () => {
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

	it("returns response with governance.settled = false", async () => {
		const engine = makeMockEngine({
			postPendingSpend: vi.fn(async () => {
				throw new Error("POST failed: TigerBeetle timeout");
			}),
		});

		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		// LLM call succeeded — response is returned
		expect(result.response).toBeDefined();
		expect(result.response.id).toBe("msg_123");

		// But settlement failed
		expect(result.governance.settled).toBe(false);

		// Engine was called: PENDING succeeded, POST failed
		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.postPendingSpend).toHaveBeenCalledOnce();

		await governed.destroy();
	});

	it("logs settlement_ambiguous to audit chain", async () => {
		const engine = makeMockEngine({
			postPendingSpend: vi.fn(async () => {
				throw new Error("POST failed: ledger timeout");
			}),
		});

		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		// Check that settlement_ambiguous was logged
		const appendCalls = (mockAudit.appendEvent as ReturnType<typeof vi.fn>).mock.calls;
		const ambiguousCall = appendCalls.find(
			(call: unknown[]) => (call[0] as AppendEventInput).kind === "settlement_ambiguous",
		);
		expect(ambiguousCall).toBeDefined();
		const ambiguousData = (ambiguousCall?.[0] as AppendEventInput).data;
		expect(ambiguousData.error).toContain("POST failed");

		await governed.destroy();
	});
});

describe("Failure mode 15.2: LLM fails with retryable error", () => {
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

	it("voids the pending hold", async () => {
		const engine = makeMockEngine();
		const mockAudit = makeMockAudit();

		const mockClient = makeAnthropicMock(undefined, async () => {
			throw new Error("API rate limit exceeded");
		});

		const governed = await trust(mockClient, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		await expect(
			governed.messages.create({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "Hello" }],
			}),
		).rejects.toThrow("API rate limit exceeded");

		// PENDING was created, then VOID was called
		expect(engine.spendPending).toHaveBeenCalledOnce();
		expect(engine.voidPendingSpend).toHaveBeenCalledOnce();
		// POST was never called
		expect(engine.postPendingSpend).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("does NOT retry — propagates original error", async () => {
		const engine = makeMockEngine();
		const mockAudit = makeMockAudit();
		const originalError = new Error("529 Overloaded");

		const mockClient = makeAnthropicMock(undefined, async () => {
			throw originalError;
		});

		const governed = await trust(mockClient, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
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

		// The error propagated is the original, unchanged
		expect(caughtError).toBe(originalError);
		expect(caughtError?.message).toBe("529 Overloaded");

		await governed.destroy();
	});
});

describe("Failure mode 15.3: Audit write fails after POST", () => {
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

	it("returns response (call succeeded)", async () => {
		const engine = makeMockEngine();

		// Audit that fails on every write
		const mockAudit = makeMockAudit({
			appendEvent: vi.fn(async () => {
				throw new Error("Audit disk full");
			}),
		});

		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		// Should NOT throw despite audit failure
		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(result.response).toBeDefined();
		expect(result.response.id).toBe("msg_123");
		// settled is still true because the POST succeeded
		expect(result.governance.settled).toBe(true);

		await governed.destroy();
	});

	it("writes warning to stderr when audit fails", async () => {
		const engine = makeMockEngine();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const mockAudit = makeMockAudit({
			appendEvent: vi.fn(async () => {
				throw new Error("Audit disk full");
			}),
		});

		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		// Check stderr was written to with audit degraded message
		const stderrCalls = stderrSpy.mock.calls;
		const degradedMsg = stderrCalls.find((call) => String(call[0]).includes("audit degraded"));
		expect(degradedMsg).toBeDefined();

		stderrSpy.mockRestore();
		await governed.destroy();
	});
});

describe("Failure mode 15.4: TigerBeetle unreachable", () => {
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

	it("throws LedgerUnavailableError and does NOT forward to provider", async () => {
		const engine = makeMockEngine({
			spendPending: vi.fn(async () => {
				throw new Error("ECONNREFUSED 127.0.0.1:3001");
			}),
		});

		const mockAudit = makeMockAudit();
		const createFn = vi.fn(async () => ({ id: "msg_should_not_reach" }));
		const mockClient = { messages: { create: createFn } };

		const governed = await trust(mockClient, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		await expect(
			governed.messages.create({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "Hello" }],
			}),
		).rejects.toThrow(LedgerUnavailableError);

		// The LLM was NEVER called
		expect(createFn).not.toHaveBeenCalled();

		await governed.destroy();
	});

	it("includes the original error message in LedgerUnavailableError", async () => {
		const engine = makeMockEngine({
			spendPending: vi.fn(async () => {
				throw new Error("Connection reset by peer");
			}),
		});

		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		let caughtError: LedgerUnavailableError | undefined;
		try {
			await governed.messages.create({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "Hello" }],
			});
		} catch (e) {
			caughtError = e as LedgerUnavailableError;
		}

		expect(caughtError).toBeInstanceOf(LedgerUnavailableError);
		expect(caughtError?.message).toContain("Connection reset by peer");

		await governed.destroy();
	});
});

describe("Failure mode 15.5: Multiple failures combine gracefully", () => {
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

	it("POST fails AND audit fails: still returns response", async () => {
		const engine = makeMockEngine({
			postPendingSpend: vi.fn(async () => {
				throw new Error("POST timeout");
			}),
		});

		// Both settlement_ambiguous AND llm_call audit writes will fail
		const mockAudit = makeMockAudit({
			appendEvent: vi.fn(async () => {
				throw new Error("Audit disk full");
			}),
		});

		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: false,
			budget: 50_000,
			vaultBase: tmpVault,
			_engine: engine,
			_audit: mockAudit,
		});

		// Should NOT throw — the LLM call succeeded
		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(result.response).toBeDefined();
		expect(result.governance.settled).toBe(false);

		await governed.destroy();
	});
});
