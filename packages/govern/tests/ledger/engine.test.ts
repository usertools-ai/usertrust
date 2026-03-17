import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mock variables so they're available inside vi.mock factories
const { mockExistsSync, mockMkdirSync, mockWriteFileSync } = vi.hoisted(() => {
	return {
		mockExistsSync: vi.fn(() => true),
		mockMkdirSync: vi.fn(),
		mockWriteFileSync: vi.fn(),
	};
});

// Mock tigerbeetle-node (needed because engine.ts imports CreateTransferError)
vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(),
	AccountFlags: { debits_must_not_exceed_credits: 1 << 2, history: 1 << 5 },
	TransferFlags: { pending: 1, post_pending_transfer: 2, void_pending_transfer: 4 },
	CreateAccountError: { exists: 1 },
	CreateTransferError: {
		exceeds_credits: 22,
		overflows_debits: 30,
		overflows_debits_pending: 31,
	},
	amount_max: (1n << 128n) - 1n,
}));

// Mock fs for DLQ writes
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: mockExistsSync,
		mkdirSync: mockMkdirSync,
		writeFileSync: mockWriteFileSync,
	};
});

import { XFER_SPEND } from "../../src/ledger/client.js";
import type { GovernTBClient } from "../../src/ledger/client.js";
import { GovernEngine } from "../../src/ledger/engine.js";
import type { SpendAction } from "../../src/ledger/engine.js";
import { InsufficientBalanceError } from "../../src/shared/errors.js";

/** Create a mock GovernTBClient with vi.fn() methods. */
function createMockTBClient() {
	return {
		getAccountId: vi.fn((userId: string) => BigInt(userId.length) * 1000n),
		getTreasuryId: vi.fn(() => 1n),
		lookupBalance: vi.fn(),
		createPendingTransfer: vi.fn(),
		postTransfer: vi.fn(),
		voidTransfer: vi.fn(),
		immediateTransfer: vi.fn(),
		lookupTransfer: vi.fn(),
		lookupAccounts: vi.fn(),
		createUserWallet: vi.fn(),
		createTreasury: vi.fn(),
		setTreasuryId: vi.fn(),
		setAccountMapping: vi.fn(),
		ping: vi.fn(),
		destroy: vi.fn(),
	};
}

const DEFAULT_ACTION: SpendAction = {
	type: "ai_compute",
	model: "claude-sonnet-4-6",
	inputTokens: 1000,
	outputTokens: 500,
};

describe("GovernEngine", () => {
	let mockTB: ReturnType<typeof createMockTBClient>;
	let engine: GovernEngine;

	beforeEach(() => {
		vi.clearAllMocks();
		mockExistsSync.mockReturnValue(true);
		mockTB = createMockTBClient();
		engine = new GovernEngine({
			tbClient: mockTB as unknown as GovernTBClient,
			dlqPath: "/tmp/test-dlq",
		});
	});

	describe("spendPending", () => {
		it("creates a PENDING transfer", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});
			mockTB.createPendingTransfer.mockResolvedValueOnce(42n);

			const result = await engine.spendPending({
				userId: "user_1",
				action: DEFAULT_ACTION,
			});

			expect(result.pending).toBe(true);
			expect(result.transferId).toBe("42");
			expect(mockTB.createPendingTransfer).toHaveBeenCalledOnce();

			// Verify the transfer was created with correct code
			const call = mockTB.createPendingTransfer.mock.calls[0]?.[0];
			expect(call.code).toBe(XFER_SPEND);
		});

		it("calculates cost using pricing table", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});
			mockTB.createPendingTransfer.mockResolvedValueOnce(42n);

			const result = await engine.spendPending({
				userId: "user_1",
				action: DEFAULT_ACTION,
			});

			// claude-sonnet-4-6: 1000 input * 30/1k + 500 output * 150/1k = 30 + 75 = 105
			expect(result.amount).toBe(105);
		});

		it("throws InsufficientBalanceError when balance too low", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 10,
				pending: 0,
				total: 10,
			});

			await expect(
				engine.spendPending({ userId: "user_1", action: DEFAULT_ACTION }),
			).rejects.toThrow(InsufficientBalanceError);
		});

		it("catches TB insufficient balance error and wraps it", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});

			// Simulate TB rejecting due to concurrent depletion
			const tbErr = new Error("Pending transfer failed: exceeds_credits");
			Object.assign(tbErr, { name: "TBTransferError", code: 22 });
			mockTB.createPendingTransfer.mockRejectedValueOnce(tbErr);

			await expect(
				engine.spendPending({ userId: "user_1", action: DEFAULT_ACTION }),
			).rejects.toThrow(InsufficientBalanceError);
		});

		it("catches TB overflows_debits error and wraps it", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});

			const tbErr = new Error("Pending transfer failed: overflows_debits");
			Object.assign(tbErr, { name: "TBTransferError", code: 30 });
			mockTB.createPendingTransfer.mockRejectedValueOnce(tbErr);

			await expect(
				engine.spendPending({ userId: "user_1", action: DEFAULT_ACTION }),
			).rejects.toThrow(InsufficientBalanceError);
		});

		it("catches TB overflows_debits_pending error and wraps it", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});

			const tbErr = new Error("Pending transfer failed: overflows_debits_pending");
			Object.assign(tbErr, { name: "TBTransferError", code: 31 });
			mockTB.createPendingTransfer.mockRejectedValueOnce(tbErr);

			await expect(
				engine.spendPending({ userId: "user_1", action: DEFAULT_ACTION }),
			).rejects.toThrow(InsufficientBalanceError);
		});

		it("includes agentRef as userData32 when provided", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});
			mockTB.createPendingTransfer.mockResolvedValueOnce(42n);

			await engine.spendPending({
				userId: "user_1",
				action: DEFAULT_ACTION,
				metadata: { agentRef: "agent_abc" },
			});

			const call = mockTB.createPendingTransfer.mock.calls[0]?.[0];
			expect(call.userData32).toBeDefined();
			expect(typeof call.userData32).toBe("number");
		});

		it("does not include userData32 when no agentRef", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});
			mockTB.createPendingTransfer.mockResolvedValueOnce(42n);

			await engine.spendPending({
				userId: "user_1",
				action: DEFAULT_ACTION,
			});

			const call = mockTB.createPendingTransfer.mock.calls[0]?.[0];
			expect(call.userData32).toBeUndefined();
		});

		it("propagates non-balance errors from TB", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});

			const tbErr = new Error("Connection refused");
			mockTB.createPendingTransfer.mockRejectedValueOnce(tbErr);

			await expect(
				engine.spendPending({ userId: "user_1", action: DEFAULT_ACTION }),
			).rejects.toThrow("Connection refused");
		});

		it("does not treat non-object errors as balance errors", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});

			mockTB.createPendingTransfer.mockRejectedValueOnce(null);

			await expect(
				engine.spendPending({ userId: "user_1", action: DEFAULT_ACTION }),
			).rejects.toBeNull();
		});

		it("does not treat errors without code property as balance errors", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});

			const err = new Error("some error");
			// Has name but no code
			Object.assign(err, { name: "TBTransferError" });
			mockTB.createPendingTransfer.mockRejectedValueOnce(err);

			await expect(
				engine.spendPending({ userId: "user_1", action: DEFAULT_ACTION }),
			).rejects.toThrow("some error");
		});

		it("does not treat errors with wrong name as balance errors", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});

			const err = new Error("some error");
			Object.assign(err, { name: "SomeOtherError", code: 22 });
			mockTB.createPendingTransfer.mockRejectedValueOnce(err);

			await expect(
				engine.spendPending({ userId: "user_1", action: DEFAULT_ACTION }),
			).rejects.toThrow("some error");
		});

		it("returns correct result shape", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});
			mockTB.createPendingTransfer.mockResolvedValueOnce(42n);

			const result = await engine.spendPending({
				userId: "user_1",
				action: DEFAULT_ACTION,
			});

			expect(result).toEqual(
				expect.objectContaining({
					transferId: "42",
					debitAccountId: expect.any(String),
					creditAccountId: "1",
					amount: 105,
					pending: true,
					timestamp: expect.any(String),
				}),
			);
			// Verify timestamp is a valid ISO string
			expect(() => new Date(result.timestamp)).not.toThrow();
		});
	});

	describe("postPendingSpend", () => {
		it("settles a pending transfer", async () => {
			mockTB.postTransfer.mockResolvedValueOnce(100n);
			await engine.postPendingSpend("42");
			expect(mockTB.postTransfer).toHaveBeenCalledWith(42n, undefined);
		});

		it("settles with actual amount when provided", async () => {
			mockTB.postTransfer.mockResolvedValueOnce(100n);
			await engine.postPendingSpend("42", 50);
			expect(mockTB.postTransfer).toHaveBeenCalledWith(42n, 50);
		});

		it("attempts void on post failure, then throws", async () => {
			mockTB.postTransfer.mockRejectedValueOnce(new Error("post failed"));
			mockTB.voidTransfer.mockResolvedValueOnce(101n);

			await expect(engine.postPendingSpend("42")).rejects.toThrow(
				"pending transfer voided after post failure",
			);
			expect(mockTB.voidTransfer).toHaveBeenCalledWith(42n);
		});

		it("writes to DLQ when both post and void fail", async () => {
			mockTB.postTransfer.mockRejectedValueOnce(new Error("post failed"));
			mockTB.voidTransfer.mockRejectedValueOnce(new Error("void failed"));

			await expect(engine.postPendingSpend("42")).rejects.toThrow("Spend settlement ambiguous");

			expect(mockWriteFileSync).toHaveBeenCalled();
			// Verify the DLQ entry contains proper data
			const writtenData = mockWriteFileSync.mock.calls[0]?.[1] as string;
			const dlqEntry = JSON.parse(writtenData.trim());
			expect(dlqEntry.source).toBe("engine.postPendingSpend.ambiguous");
			expect(dlqEntry.transferId).toBe("42");
		});

		it("creates DLQ directory if it does not exist", async () => {
			mockExistsSync.mockReturnValue(false);
			mockTB.postTransfer.mockRejectedValueOnce(new Error("post failed"));
			mockTB.voidTransfer.mockRejectedValueOnce(new Error("void failed"));

			await expect(engine.postPendingSpend("42")).rejects.toThrow("Spend settlement ambiguous");

			expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/test-dlq", { recursive: true });
		});

		it("does not throw when DLQ write itself fails (line 63/69)", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			mockTB.postTransfer.mockRejectedValueOnce(new Error("post failed"));
			mockTB.voidTransfer.mockRejectedValueOnce(new Error("void failed"));

			// Make the DLQ write throw
			mockWriteFileSync.mockImplementationOnce(() => {
				throw new Error("disk full");
			});

			// The ambiguous error should still be thrown even when DLQ fails
			await expect(engine.postPendingSpend("42")).rejects.toThrow("Spend settlement ambiguous");

			// The DLQ failure should be logged to console.error
			expect(errorSpy).toHaveBeenCalledWith(
				"[govern] Failed to write dead letter:",
				expect.any(Error),
			);

			errorSpy.mockRestore();
		});

		it("does not throw when mkdirSync fails in DLQ (line 63/69)", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			mockExistsSync.mockReturnValue(false);
			mockTB.postTransfer.mockRejectedValueOnce(new Error("post failed"));
			mockTB.voidTransfer.mockRejectedValueOnce(new Error("void failed"));

			// Make mkdirSync throw
			mockMkdirSync.mockImplementationOnce(() => {
				throw new Error("permission denied");
			});

			await expect(engine.postPendingSpend("42")).rejects.toThrow("Spend settlement ambiguous");

			expect(errorSpy).toHaveBeenCalledWith(
				"[govern] Failed to write dead letter:",
				expect.any(Error),
			);

			errorSpy.mockRestore();
		});
	});

	describe("voidPendingSpend", () => {
		it("releases a pending hold", async () => {
			mockTB.voidTransfer.mockResolvedValueOnce(101n);
			await engine.voidPendingSpend("42");
			expect(mockTB.voidTransfer).toHaveBeenCalledWith(42n);
		});

		it("propagates void errors", async () => {
			mockTB.voidTransfer.mockRejectedValueOnce(new Error("void failed"));
			await expect(engine.voidPendingSpend("42")).rejects.toThrow("void failed");
		});
	});

	describe("balance", () => {
		it("returns balance for a user", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 5000,
				pending: 200,
				total: 5200,
			});
			const bal = await engine.balance("user_1");
			expect(bal.available).toBe(5000);
			expect(bal.pending).toBe(200);
			expect(bal.total).toBe(5200);
		});

		it("delegates to tb.getAccountId then lookupBalance", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 1000,
				pending: 0,
				total: 1000,
			});
			await engine.balance("user_1");
			expect(mockTB.getAccountId).toHaveBeenCalledWith("user_1");
			expect(mockTB.lookupBalance).toHaveBeenCalledWith(mockTB.getAccountId("user_1"));
		});
	});

	describe("configurable hold TTL", () => {
		it("uses custom hold TTL when provided", async () => {
			const customEngine = new GovernEngine({
				tbClient: mockTB as unknown as GovernTBClient,
				holdTtlMs: 120_000, // 2 minutes
			});

			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});
			mockTB.createPendingTransfer.mockResolvedValueOnce(42n);

			await customEngine.spendPending({
				userId: "user_1",
				action: DEFAULT_ACTION,
			});

			const call = mockTB.createPendingTransfer.mock.calls[0]?.[0];
			expect(call.timeoutSeconds).toBe(120); // 120_000ms / 1000 = 120s
		});

		it("uses default hold TTL (5 min) when not specified", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});
			mockTB.createPendingTransfer.mockResolvedValueOnce(42n);

			await engine.spendPending({
				userId: "user_1",
				action: DEFAULT_ACTION,
			});

			const call = mockTB.createPendingTransfer.mock.calls[0]?.[0];
			expect(call.timeoutSeconds).toBe(300); // 300_000ms / 1000 = 300s
		});
	});

	describe("configurable DLQ path", () => {
		it("uses default DLQ path when not specified", async () => {
			const defaultEngine = new GovernEngine({
				tbClient: mockTB as unknown as GovernTBClient,
			});

			mockTB.postTransfer.mockRejectedValueOnce(new Error("post failed"));
			mockTB.voidTransfer.mockRejectedValueOnce(new Error("void failed"));

			await expect(defaultEngine.postPendingSpend("42")).rejects.toThrow(
				"Spend settlement ambiguous",
			);

			// The default path should be .usertools/dlq
			const filePath = mockWriteFileSync.mock.calls[0]?.[0] as string;
			expect(filePath).toContain("dlq");
			expect(filePath).toContain("dead-letter.jsonl");
		});
	});

	describe("two-phase lifecycle", () => {
		it("spendPending -> postPendingSpend (success path)", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});
			mockTB.createPendingTransfer.mockResolvedValueOnce(42n);
			mockTB.postTransfer.mockResolvedValueOnce(100n);

			const result = await engine.spendPending({
				userId: "user_1",
				action: DEFAULT_ACTION,
			});
			expect(result.pending).toBe(true);

			await engine.postPendingSpend(result.transferId);
			expect(mockTB.postTransfer).toHaveBeenCalledWith(42n, undefined);
		});

		it("spendPending -> voidPendingSpend (failure path)", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});
			mockTB.createPendingTransfer.mockResolvedValueOnce(42n);
			mockTB.voidTransfer.mockResolvedValueOnce(101n);

			const result = await engine.spendPending({
				userId: "user_1",
				action: DEFAULT_ACTION,
			});
			expect(result.pending).toBe(true);

			await engine.voidPendingSpend(result.transferId);
			expect(mockTB.voidTransfer).toHaveBeenCalledWith(42n);
		});

		it("full hold-settle-with-actual-amount flow", async () => {
			mockTB.lookupBalance.mockResolvedValueOnce({
				available: 100_000,
				pending: 0,
				total: 100_000,
			});
			mockTB.createPendingTransfer.mockResolvedValueOnce(42n);
			mockTB.postTransfer.mockResolvedValueOnce(100n);

			const result = await engine.spendPending({
				userId: "user_1",
				action: DEFAULT_ACTION,
			});
			expect(result.amount).toBe(105); // estimated cost

			// Actual cost was less
			await engine.postPendingSpend(result.transferId, 80);
			expect(mockTB.postTransfer).toHaveBeenCalledWith(42n, 80);
		});
	});
});
