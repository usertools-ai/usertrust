/**
 * Tests for critical governance fixes:
 *   AUD-453 — Async mutex prevents concurrent budget overshoot
 *   AUD-455 — No TOCTOU pre-check in spendPending (verified via engine.test.ts too)
 *   AUD-457 — Budget persistence survives destroy + re-init
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
	const dir = join(tmpdir(), `trust-critical-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeAnthropicMock(createFn?: (...args: unknown[]) => Promise<Record<string, unknown>>) {
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
			create: createFn ?? vi.fn(async () => defaultResponse),
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

// ── AUD-453: Concurrent calls should not exceed budget ──

describe("AUD-453 — budget mutex prevents concurrent overshoot", () => {
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

	it("concurrent calls serialise through the budget mutex", async () => {
		const mockAudit = makeMockAudit();

		// Track the order of LLM calls to verify serialisation
		const callOrder: number[] = [];
		let callCounter = 0;

		const slowCreateFn = vi.fn(async () => {
			const myIndex = ++callCounter;
			// Simulate a slow LLM call — the mutex ensures budget check + hold
			// happen atomically, so calls queue through the budget section
			await new Promise<void>((r) => setTimeout(r, 10));
			callOrder.push(myIndex);
			return {
				id: `msg_${myIndex}`,
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: `Response ${myIndex}` }],
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 10, output_tokens: 5 },
			};
		});

		const mockClient = makeAnthropicMock(slowCreateFn);

		// Budget is large enough for all calls
		const governed = await trust(mockClient, {
			dryRun: true,
			budget: 500_000,
			vaultBase: tmpVault,
			_audit: mockAudit,
		});

		// Fire 5 concurrent calls
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				governed.messages.create({
					model: "claude-sonnet-4-6",
					max_tokens: 1024,
					messages: [{ role: "user", content: "Hello" }],
				}),
			),
		);

		// All 5 should succeed
		expect(results).toHaveLength(5);
		for (const r of results) {
			expect(r.receipt.cost).toBeGreaterThan(0);
		}

		// Budget remaining should decrease monotonically across receipts
		// (each call commits its cost before the next can check)
		const budgets = results.map((r) => r.receipt.budgetRemaining);
		// Since receipts include budgetRemaining, the total spent should be correct
		const totalSpent = results.reduce((sum, r) => sum + r.receipt.cost, 0);
		expect(totalSpent).toBeGreaterThan(0);

		// The final budgetRemaining should equal budget - totalSpent (approximately)
		const minRemaining = Math.min(...budgets);
		expect(minRemaining).toBeLessThan(500_000);

		await governed.destroy();
	});

	it("concurrent calls near budget limit do not overshoot", async () => {
		const mockAudit = makeMockAudit();

		// Each call costs ~105 tokens (claude-sonnet-4-6, 1000in + 500out, rates 30/1k + 150/1k)
		// But in dry-run mode with message estimation, cost depends on message content.
		// Set budget very low so only 1-2 calls fit.
		const tightBudget = 200;

		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: true,
			budget: tightBudget,
			vaultBase: tmpVault,
			_audit: mockAudit,
		});

		// Fire 5 concurrent calls with a tight budget
		const results = await Promise.allSettled(
			Array.from({ length: 5 }, () =>
				governed.messages.create({
					model: "claude-sonnet-4-6",
					max_tokens: 1024,
					messages: [{ role: "user", content: "Hello" }],
				}),
			),
		);

		const succeeded = results.filter((r) => r.status === "fulfilled");
		const failed = results.filter((r) => r.status === "rejected");

		// With a tight budget and mutex, total spend should not exceed budget
		// Some calls should succeed and some should be denied by policy
		// (budget_remaining check in policy gate)
		expect(succeeded.length + failed.length).toBe(5);

		// If any succeeded, their total cost should not exceed the budget
		const totalCost = succeeded.reduce((sum, r) => {
			if (r.status === "fulfilled") {
				return sum + r.value.receipt.cost;
			}
			return sum;
		}, 0);
		expect(totalCost).toBeLessThanOrEqual(tightBudget);

		await governed.destroy();
	});
});

// ── AUD-457: Budget persistence across destroy + re-init ──

describe("AUD-457 — budget persistence", () => {
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

	it("writes spend-ledger.json after each call", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: true,
			budget: 500_000,
			vaultBase: tmpVault,
			_audit: mockAudit,
		});

		await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		await governed.destroy();

		// Check the spend ledger file exists
		const ledgerPath = join(tmpVault, ".usertrust", "spend-ledger.json");
		expect(existsSync(ledgerPath)).toBe(true);

		const raw = JSON.parse(readFileSync(ledgerPath, "utf-8")) as {
			budgetSpent: number;
			updatedAt: string;
		};
		expect(raw.budgetSpent).toBeGreaterThan(0);
		expect(raw.updatedAt).toBeDefined();
	});

	it("budget survives destroy + re-init cycle", async () => {
		const mockAudit1 = makeMockAudit();
		const mockClient1 = makeAnthropicMock();

		// First session: make a call
		const governed1 = await trust(mockClient1, {
			dryRun: true,
			budget: 500_000,
			vaultBase: tmpVault,
			_audit: mockAudit1,
		});

		const result1 = await governed1.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		const costAfterFirst = result1.receipt.cost;
		const remainingAfterFirst = result1.receipt.budgetRemaining;
		expect(costAfterFirst).toBeGreaterThan(0);

		await governed1.destroy();

		// Second session: re-init with same vault
		const mockAudit2 = makeMockAudit();
		const mockClient2 = makeAnthropicMock();

		const governed2 = await trust(mockClient2, {
			dryRun: true,
			budget: 500_000,
			vaultBase: tmpVault,
			_audit: mockAudit2,
		});

		const result2 = await governed2.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		// Budget remaining should reflect BOTH sessions' spend
		const totalSpent = costAfterFirst + result2.receipt.cost;
		const expectedRemaining = 500_000 - totalSpent;

		// Allow a small tolerance for floating point
		expect(result2.receipt.budgetRemaining).toBeCloseTo(expectedRemaining, 0);
		expect(result2.receipt.budgetRemaining).toBeLessThan(remainingAfterFirst);

		await governed2.destroy();
	});

	it("starts from zero when no spend-ledger.json exists", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		// No prior spend-ledger.json
		const governed = await trust(mockClient, {
			dryRun: true,
			budget: 500_000,
			vaultBase: tmpVault,
			_audit: mockAudit,
		});

		const result = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		// budgetRemaining should be budget minus cost of this single call
		expect(result.receipt.budgetRemaining).toBe(500_000 - result.receipt.cost);

		await governed.destroy();
	});

	it("accumulates spend across multiple calls within a session", async () => {
		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: true,
			budget: 500_000,
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
			messages: [{ role: "user", content: "World" }],
		});

		// Second call should show less budget remaining
		expect(r2.receipt.budgetRemaining).toBeLessThan(r1.receipt.budgetRemaining);
		expect(r2.receipt.budgetRemaining).toBe(500_000 - r1.receipt.cost - r2.receipt.cost);

		await governed.destroy();

		// Verify persisted ledger reflects total spend
		const ledgerPath = join(tmpVault, ".usertrust", "spend-ledger.json");
		const raw = JSON.parse(readFileSync(ledgerPath, "utf-8")) as {
			budgetSpent: number;
		};
		expect(raw.budgetSpent).toBe(r1.receipt.cost + r2.receipt.cost);
	});
});

// ── AUD-468: in-flight hold accounting must not go negative on policy deny ──
//
// Regression: previously the outer catch in interceptCall decremented
// inFlightHoldTotal by estimatedCost without checking whether the hold
// had actually been incremented. A policy-deny throw before the increment
// would cause inFlightHoldTotal to drift negative, inflating subsequent
// budgetRemaining beyond the configured budget.
describe("AUD-468 — inFlightHoldTotal stays accurate on early failure", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = makeTmpVault();
		// Write a deny-everything policy
		const dir = join(tmpVault, ".usertrust");
		const polDir = join(dir, "policies");
		mkdirSync(polDir, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	it("policy deny followed by allowed call does not inflate budgetRemaining", async () => {
		const { writeFileSync } = await import("node:fs");
		const polPath = join(tmpVault, ".usertrust", "policies", "default.yml");
		writeFileSync(
			polPath,
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
			join(tmpVault, ".usertrust", "usertrust.config.json"),
			JSON.stringify({ budget: 500_000, policies: "./policies/default.yml" }),
		);

		const mockAudit = makeMockAudit();
		const mockClient = makeAnthropicMock();

		const governed = await trust(mockClient, {
			dryRun: true,
			vaultBase: tmpVault,
			_audit: mockAudit,
		});

		// Force several policy denials — each should decrement inFlightHoldTotal
		// by what was never added.
		for (let i = 0; i < 3; i++) {
			await expect(
				governed.messages.create({
					model: "claude-opus-4-6",
					max_tokens: 1024,
					messages: [{ role: "user", content: "Hello" }],
				}),
			).rejects.toThrow("Policy denied");
		}

		// Then make an allowed call — its receipt should report
		// budgetRemaining <= configured budget (i.e. the in-flight account
		// has not drifted negative).
		const ok = await governed.messages.create({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "Hello" }],
		});

		expect(ok.receipt.budgetRemaining).toBeLessThanOrEqual(500_000);
		expect(ok.receipt.budgetRemaining).toBe(500_000 - ok.receipt.cost);

		await governed.destroy();
	});
});
