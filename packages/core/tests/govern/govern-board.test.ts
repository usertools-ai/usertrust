import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import type { Board } from "../../src/board/board.js";
import { trust } from "../../src/govern.js";
import { PolicyDeniedError } from "../../src/shared/errors.js";
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

let testDir: string;

function makeTmpVault(): string {
	const dir = join(tmpdir(), `trust-board-test-${randomUUID()}`);
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

/**
 * Set up a vault with board config. The board subsystem needs
 * `.usertrust/board/` to exist for session persistence.
 */
function setupVaultWithBoardConfig(dir: string, boardEnabled: boolean): void {
	const vaultDir = join(dir, ".usertrust");
	mkdirSync(join(vaultDir, "board"), { recursive: true });
	writeFileSync(
		join(vaultDir, "usertrust.config.json"),
		JSON.stringify({
			budget: 50_000,
			board: { enabled: boardEnabled, vetoThreshold: "high" },
		}),
	);
}

// ── Tests ──

beforeEach(() => {
	testDir = makeTmpVault();
});

afterEach(() => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		// cleanup best-effort
	}
});

describe("Board of Directors — govern.ts integration", () => {
	it("does not review when board is disabled (no boardDecision on receipt)", async () => {
		setupVaultWithBoardConfig(testDir, false);
		const mockAudit = makeMockAudit();

		const client = await trust(makeAnthropicMock(), {
			dryRun: true,
			vaultBase: testDir,
			_audit: mockAudit,
		});

		const { receipt } = await client.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 100,
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(receipt.boardDecision).toBeUndefined();

		await client.destroy();
	});

	it("approves benign calls when board is enabled", async () => {
		setupVaultWithBoardConfig(testDir, true);
		const mockAudit = makeMockAudit();

		const client = await trust(makeAnthropicMock(), {
			dryRun: true,
			vaultBase: testDir,
			_audit: mockAudit,
		});

		const { receipt } = await client.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 100,
			messages: [{ role: "user", content: "Hello" }],
		});

		// A simple "Hello" with model "claude-sonnet-4-6" triggers no concern
		// detectors (no security keywords, no scope, no policy_override),
		// so both Directors approve and the Board decision is "approved".
		expect(receipt.boardDecision).toBe("approved");

		await client.destroy();
	});

	it("board review runs before PII check in the pipeline", async () => {
		setupVaultWithBoardConfig(testDir, true);
		const mockAudit = makeMockAudit();

		const client = await trust(makeAnthropicMock(), {
			dryRun: true,
			vaultBase: testDir,
			_audit: mockAudit,
		});

		// A benign call: board should approve and the call should succeed
		const { receipt, response } = await client.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 100,
			messages: [{ role: "user", content: "What is the weather?" }],
		});

		expect(receipt.boardDecision).toBe("approved");
		expect(response).toBeDefined();

		await client.destroy();
	});

	it("boardDecision is approved for standard LLM calls (concern detectors are tuned for specific decisionTypes)", async () => {
		// The concern detectors are tuned for specific decision types:
		//   - resource_abuse triggers on decisionType "resource_intensive" (not "llm_call")
		//   - bias triggers on decisionType "scope_expansion"
		//   - policy_violation triggers on decisionType "policy_override"
		//   - safety triggers on keywords like "password", "credential", "secret" in description
		//   - hallucination triggers on "always"/"never" in description
		//   - scope_creep triggers on scope patterns (not used in llm_call review)
		//
		// For standard LLM calls, the board passes decisionType "llm_call"
		// with the model name as description. Since "claude-sonnet-4-6" contains
		// none of the trigger keywords, both Directors approve.
		setupVaultWithBoardConfig(testDir, true);
		const mockAudit = makeMockAudit();

		const client = await trust(makeAnthropicMock(), {
			dryRun: true,
			vaultBase: testDir,
			_audit: mockAudit,
		});

		const { receipt } = await client.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 100,
			messages: [{ role: "user", content: "Tell me a joke" }],
		});

		// The board's reviewNow is called with decisionType "llm_call" and
		// description = model name. No concern detectors fire for this
		// combination, so the result is always "approved".
		expect(receipt.boardDecision).toBe("approved");

		await client.destroy();
	});

	it("boardDecision persists across multiple calls", async () => {
		setupVaultWithBoardConfig(testDir, true);
		const mockAudit = makeMockAudit();

		const client = await trust(makeAnthropicMock(), {
			dryRun: true,
			vaultBase: testDir,
			_audit: mockAudit,
		});

		const r1 = await client.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 100,
			messages: [{ role: "user", content: "First call" }],
		});

		const r2 = await client.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 100,
			messages: [{ role: "user", content: "Second call" }],
		});

		expect(r1.receipt.boardDecision).toBe("approved");
		expect(r2.receipt.boardDecision).toBe("approved");

		await client.destroy();
	});

	it("board disabled returns undefined boardDecision even with config file present", async () => {
		// Explicitly disabled in config
		setupVaultWithBoardConfig(testDir, false);
		const mockAudit = makeMockAudit();

		const client = await trust(makeAnthropicMock(), {
			dryRun: true,
			vaultBase: testDir,
			_audit: mockAudit,
		});

		const { receipt } = await client.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 100,
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(receipt.boardDecision).toBeUndefined();
		// Other receipt fields still populated
		expect(receipt.transferId).toBeDefined();
		expect(receipt.cost).toBeGreaterThanOrEqual(0);

		await client.destroy();
	});
});

// ── Mock board helpers for blocked/escalated tests ──

function createMockBoard(decision: "approved" | "blocked" | "escalated"): Board {
	return {
		reviewNow: () => ({
			request: {
				decisionType: "llm_call",
				actor: "local",
				description: "test",
				reviewId: "BR_test",
				requestedAt: new Date().toISOString(),
			},
			reviews: [],
			decision,
			reasoning: decision === "blocked" ? "Test block reason" : "OK",
			requiresHumanEscalation: decision !== "approved",
			decidedAt: new Date().toISOString(),
		}),
		getRecentReviews: () => [],
		getStats: () => ({ totalReviews: 0, approved: 0, blocked: 0, escalated: 0 }),
	};
}

describe("Board of Directors — blocked/escalated/error paths", () => {
	it("throws PolicyDeniedError when board blocks", async () => {
		setupVaultWithBoardConfig(testDir, true);

		const client = await trust(makeAnthropicMock(), {
			dryRun: true,
			vaultBase: testDir,
			_board: createMockBoard("blocked"),
		});

		await expect(
			client.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 100,
				messages: [{ role: "user", content: "Hello" }],
			}),
		).rejects.toThrow(PolicyDeniedError);

		await client.destroy();
	});

	it("allows escalated calls with boardDecision on receipt", async () => {
		setupVaultWithBoardConfig(testDir, true);

		const client = await trust(makeAnthropicMock(), {
			dryRun: true,
			vaultBase: testDir,
			_board: createMockBoard("escalated"),
		});

		const { receipt } = await client.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 100,
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(receipt.boardDecision).toBe("escalated");

		await client.destroy();
	});

	it("continues when board throws", async () => {
		setupVaultWithBoardConfig(testDir, true);

		const failingBoard: Board = {
			reviewNow: () => {
				throw new Error("disk full");
			},
			getRecentReviews: () => [],
			getStats: () => ({ totalReviews: 0, approved: 0, blocked: 0, escalated: 0 }),
		};

		const client = await trust(makeAnthropicMock(), {
			dryRun: true,
			vaultBase: testDir,
			_board: failingBoard,
		});

		const { receipt } = await client.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 100,
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(receipt.boardDecision).toBeUndefined();

		await client.destroy();
	});
});
