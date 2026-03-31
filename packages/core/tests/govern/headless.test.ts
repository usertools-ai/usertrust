import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrustEngine } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import type { Governor } from "../../src/headless.js";

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
	const dir = join(tmpdir(), `headless-test-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function mockEngine(): TrustEngine & {
	pendingIds: string[];
	postedIds: string[];
	voidedIds: string[];
} {
	const pendingIds: string[] = [];
	const postedIds: string[] = [];
	const voidedIds: string[] = [];

	return {
		pendingIds,
		postedIds,
		voidedIds,
		async spendPending(params) {
			pendingIds.push(params.transferId);
			return { transferId: params.transferId };
		},
		async postPendingSpend(transferId) {
			postedIds.push(transferId);
		},
		async voidPendingSpend(transferId) {
			voidedIds.push(transferId);
		},
		async voidAllPending() {
			// no-op for tests
		},
		destroy() {},
	};
}

// ── Tests ──

describe("headless governor", () => {
	let vaultBase: string;

	beforeEach(() => {
		vaultBase = makeTmpVault();
		process.env.USERTRUST_TEST = "1";
	});

	afterEach(() => {
		delete process.env.USERTRUST_TEST; // biome-ignore lint/performance/noDelete: env cleanup requires delete
		try {
			rmSync(vaultBase, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	it("creates a governor in dry-run mode", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		expect(gov).toBeDefined();
		expect(gov.config.budget).toBe(100_000);
		expect(gov.budgetRemaining()).toBe(100_000);
		await gov.destroy();
	});

	it("authorize → settle lifecycle", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});

		expect(auth.transferId).toMatch(/^tx_/);
		expect(auth.model).toBe("claude-sonnet-4-6");
		expect(auth.estimatedCost).toBeGreaterThan(0);

		// Budget should reflect in-flight hold
		expect(gov.budgetRemaining()).toBeLessThan(100_000);

		const receipt = await gov.settle(auth, {
			inputTokens: 80,
			outputTokens: 200,
			usageSource: "provider",
			chunksDelivered: 15,
		});

		expect(receipt.settled).toBe(true);
		expect(receipt.model).toBe("claude-sonnet-4-6");
		expect(receipt.provider).toBe("headless");
		expect(receipt.usageSource).toBe("provider");
		expect(receipt.chunksDelivered).toBe(15);
		expect(receipt.cost).toBeGreaterThan(0);
		expect(receipt.budgetRemaining).toBeLessThan(100_000);

		await gov.destroy();
	});

	it("authorize → abort lifecycle", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({
			model: "gpt-4o",
			estimatedInputTokens: 200,
			maxOutputTokens: 1000,
		});

		const budgetAfterAuth = gov.budgetRemaining();
		expect(budgetAfterAuth).toBeLessThan(100_000);

		await gov.abort(auth, new Error("LLM failed"));

		// Budget should be restored after abort
		expect(gov.budgetRemaining()).toBe(100_000);

		await gov.destroy();
	});

	it("settle without usage falls back to estimate", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 500,
		});

		// Settle without providing actual usage
		const receipt = await gov.settle(auth);

		expect(receipt.cost).toBe(auth.estimatedCost);
		expect(receipt.usageSource).toBe("estimated");

		await gov.destroy();
	});

	it("prevents double-settle", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });
		await gov.settle(auth);

		await expect(gov.settle(auth)).rejects.toThrow("not active");

		await gov.destroy();
	});

	it("abort is idempotent", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const auth = await gov.authorize({ model: "claude-sonnet-4-6" });
		await gov.abort(auth, new Error("first abort"));
		// Second abort should not throw
		await gov.abort(auth, new Error("second abort"));

		await gov.destroy();
	});

	it("uses mock engine in test mode", async () => {
		const engine = mockEngine();

		const gov = await createGovernor({
			budget: 50_000,
			vaultBase,
			_engine: engine,
		});

		const auth = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 50,
			maxOutputTokens: 200,
		});

		expect(engine.pendingIds).toHaveLength(1);
		expect(engine.pendingIds[0]).toBe(auth.transferId);

		await gov.settle(auth, {
			inputTokens: 40,
			outputTokens: 100,
		});

		expect(engine.postedIds).toHaveLength(1);
		expect(engine.postedIds[0]).toBe(auth.transferId);

		await gov.destroy();
	});

	it("voids pending hold via engine on abort", async () => {
		const engine = mockEngine();

		const gov = await createGovernor({
			budget: 50_000,
			vaultBase,
			_engine: engine,
		});

		const auth = await gov.authorize({ model: "gpt-4o" });
		await gov.abort(auth, new Error("test error"));

		expect(engine.voidedIds).toHaveLength(1);
		expect(engine.voidedIds[0]).toBe(auth.transferId);

		await gov.destroy();
	});

	it("tracks budget across multiple calls", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		// First call
		const auth1 = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 200,
		});
		await gov.settle(auth1, { inputTokens: 100, outputTokens: 200 });

		const afterFirst = gov.budgetRemaining();
		expect(afterFirst).toBeLessThan(100_000);

		// Second call
		const auth2 = await gov.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 200,
		});
		await gov.settle(auth2, { inputTokens: 100, outputTokens: 200 });

		const afterSecond = gov.budgetRemaining();
		expect(afterSecond).toBeLessThan(afterFirst);

		await gov.destroy();
	});

	it("estimateCost and estimateInputTokens work", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		const cost = gov.estimateCost("claude-sonnet-4-6", 1000, 500);
		expect(cost).toBeGreaterThan(0);

		const tokens = gov.estimateInputTokens([{ role: "user", content: "Hello world" }]);
		expect(tokens).toBeGreaterThan(0);

		await gov.destroy();
	});

	it("throws after destroy", async () => {
		const gov = await createGovernor({
			dryRun: true,
			budget: 100_000,
			vaultBase,
		});

		await gov.destroy();

		await expect(gov.authorize({ model: "test" })).rejects.toThrow("destroyed");
	});

	it("destroy voids active authorizations", async () => {
		const engine = mockEngine();

		const gov = await createGovernor({
			budget: 50_000,
			vaultBase,
			_engine: engine,
		});

		// Authorize but don't settle
		await gov.authorize({ model: "claude-sonnet-4-6" });
		await gov.authorize({ model: "gpt-4o" });

		expect(engine.pendingIds).toHaveLength(2);

		await gov.destroy();

		// Both should be voided
		expect(engine.voidedIds).toHaveLength(2);
	});
});
