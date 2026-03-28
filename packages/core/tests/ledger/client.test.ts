import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mock variables so they're available inside the vi.mock factory
const {
	mockCreateAccounts,
	mockCreateTransfers,
	mockLookupAccounts,
	mockLookupTransfers,
	mockDestroy,
	mockClient,
	mockCreateClient,
} = vi.hoisted(() => {
	const mockCreateAccounts = vi.fn();
	const mockCreateTransfers = vi.fn();
	const mockLookupAccounts = vi.fn();
	const mockLookupTransfers = vi.fn();
	const mockDestroy = vi.fn();

	const mockClient = {
		createAccounts: mockCreateAccounts,
		createTransfers: mockCreateTransfers,
		lookupAccounts: mockLookupAccounts,
		lookupTransfers: mockLookupTransfers,
		destroy: mockDestroy,
	};

	const mockCreateClient = vi.fn(() => mockClient);

	return {
		mockCreateAccounts,
		mockCreateTransfers,
		mockLookupAccounts,
		mockLookupTransfers,
		mockDestroy,
		mockClient,
		mockCreateClient,
	};
});

vi.mock("tigerbeetle-node", () => ({
	createClient: mockCreateClient,
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

import {
	CODE_ESCROW,
	CODE_PLATFORM_TREASURY,
	CODE_USER_WALLET,
	LEDGER_USERTOKENS,
	TBTransferError,
	TrustTBClient,
	XFER_A2A_DELEGATION,
	XFER_ALLOCATION,
	XFER_PURCHASE,
	XFER_REFUND,
	XFER_SPEND,
	XFER_TOOL_CALL,
	XFER_TRANSFER,
} from "../../src/ledger/client.js";

/** Reset mockCreateClient to the default implementation (return mockClient). */
function resetCreateClient() {
	mockCreateClient.mockImplementation(() => mockClient);
}

describe("TrustTBClient", () => {
	let client: TrustTBClient;

	beforeEach(() => {
		vi.clearAllMocks();
		resetCreateClient();
		vi.useFakeTimers();
		client = new TrustTBClient({ addresses: ["3000"] });
	});

	afterEach(() => {
		client.destroy();
		vi.useRealTimers();
	});

	describe("deriveAccountId", () => {
		it("returns deterministic bigint for same userId", () => {
			const id1 = TrustTBClient.deriveAccountId("user_123");
			const id2 = TrustTBClient.deriveAccountId("user_123");
			expect(id1).toBe(id2);
		});

		it("returns different IDs for different users", () => {
			const id1 = TrustTBClient.deriveAccountId("user_123");
			const id2 = TrustTBClient.deriveAccountId("user_456");
			expect(id1).not.toBe(id2);
		});

		it("returns a bigint", () => {
			const id = TrustTBClient.deriveAccountId("test");
			expect(typeof id).toBe("bigint");
		});
	});

	describe("createUserWallet", () => {
		it("creates account and returns account ID", async () => {
			mockCreateAccounts.mockResolvedValueOnce([]);
			const id = await client.createUserWallet("user_1");
			expect(typeof id).toBe("bigint");
			expect(mockCreateAccounts).toHaveBeenCalledOnce();
		});

		it("returns cached ID on second call", async () => {
			mockCreateAccounts.mockResolvedValueOnce([]);
			const id1 = await client.createUserWallet("user_2");
			const id2 = await client.createUserWallet("user_2");
			expect(id1).toBe(id2);
			expect(mockCreateAccounts).toHaveBeenCalledTimes(1);
		});

		it("handles account-already-exists gracefully", async () => {
			mockCreateAccounts.mockResolvedValueOnce([{ index: 0, result: 1 }]); // exists
			const id = await client.createUserWallet("user_3");
			expect(typeof id).toBe("bigint");
		});

		it("throws on other creation errors", async () => {
			mockCreateAccounts.mockResolvedValueOnce([{ index: 0, result: 99 }]);
			await expect(client.createUserWallet("user_4")).rejects.toThrow("Failed to create account");
		});

		it("throws when error array element is undefined", async () => {
			mockCreateAccounts.mockResolvedValueOnce([undefined]);
			await expect(client.createUserWallet("user_undef")).rejects.toThrow(
				"Unknown account/transfer error",
			);
		});

		it("retries on connection error via withReconnect", async () => {
			mockCreateAccounts
				.mockRejectedValueOnce(new Error("connection refused"))
				.mockResolvedValueOnce([]);
			const id = await client.createUserWallet("user_reconnect");
			expect(typeof id).toBe("bigint");
			expect(mockCreateAccounts).toHaveBeenCalledTimes(2);
		});
	});

	describe("createPendingTransfer", () => {
		it("creates transfer and returns transfer ID", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			const id = await client.createPendingTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 100,
				code: XFER_SPEND,
			});
			expect(typeof id).toBe("bigint");
			expect(mockCreateTransfers).toHaveBeenCalledOnce();
		});

		it("throws TBTransferError on failure", async () => {
			mockCreateTransfers.mockResolvedValueOnce([{ index: 0, result: 22 }]);
			await expect(
				client.createPendingTransfer({
					debitAccountId: 1n,
					creditAccountId: 2n,
					amount: 100,
					code: XFER_SPEND,
				}),
			).rejects.toThrow(TBTransferError);
		});

		it("throws when error array element is undefined", async () => {
			mockCreateTransfers.mockResolvedValueOnce([undefined]);
			await expect(
				client.createPendingTransfer({
					debitAccountId: 1n,
					creditAccountId: 2n,
					amount: 100,
					code: XFER_SPEND,
				}),
			).rejects.toThrow("Unknown account/transfer error");
		});

		it("passes optional userData and timeout fields", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			await client.createPendingTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 50,
				code: XFER_SPEND,
				timeoutSeconds: 600,
				userData128: 42n,
				userData64: 7n,
				userData32: 99,
			});
			const transfer = mockCreateTransfers.mock.calls[0]?.[0][0];
			expect(transfer.user_data_128).toBe(42n);
			expect(transfer.user_data_64).toBe(7n);
			expect(transfer.user_data_32).toBe(99);
			expect(transfer.timeout).toBe(600);
		});

		it("defaults timeout to 300 seconds", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			await client.createPendingTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 50,
				code: XFER_SPEND,
			});
			const transfer = mockCreateTransfers.mock.calls[0]?.[0][0];
			expect(transfer.timeout).toBe(300);
		});
	});

	describe("postTransfer", () => {
		it("posts pending transfer", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			const id = await client.postTransfer(123n);
			expect(typeof id).toBe("bigint");
		});

		it("throws on failure", async () => {
			mockCreateTransfers.mockResolvedValueOnce([{ index: 0, result: 5 }]);
			await expect(client.postTransfer(123n)).rejects.toThrow("Post transfer failed");
		});

		it("throws when error array element is undefined", async () => {
			mockCreateTransfers.mockResolvedValueOnce([undefined]);
			await expect(client.postTransfer(123n)).rejects.toThrow("Unknown account/transfer error");
		});

		it("uses amount_max when no amount provided", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			await client.postTransfer(123n);
			const transfer = mockCreateTransfers.mock.calls[0]?.[0][0];
			expect(transfer.amount).toBe((1n << 128n) - 1n);
		});

		it("uses specified amount when provided", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			await client.postTransfer(123n, 42);
			const transfer = mockCreateTransfers.mock.calls[0]?.[0][0];
			expect(transfer.amount).toBe(42n);
		});
	});

	describe("voidTransfer", () => {
		it("voids pending transfer", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			const id = await client.voidTransfer(123n);
			expect(typeof id).toBe("bigint");
		});

		it("throws on failure", async () => {
			mockCreateTransfers.mockResolvedValueOnce([{ index: 0, result: 5 }]);
			await expect(client.voidTransfer(123n)).rejects.toThrow("Void transfer failed");
		});

		it("throws when error array element is undefined", async () => {
			mockCreateTransfers.mockResolvedValueOnce([undefined]);
			await expect(client.voidTransfer(123n)).rejects.toThrow("Unknown account/transfer error");
		});
	});

	describe("immediateTransfer", () => {
		it("creates an immediate (non-pending) transfer", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			const id = await client.immediateTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 500,
				code: XFER_PURCHASE,
			});
			expect(typeof id).toBe("bigint");
			const transfer = mockCreateTransfers.mock.calls[0]?.[0][0];
			expect(transfer.flags).toBe(0); // no pending flag
			expect(transfer.pending_id).toBe(0n);
			expect(transfer.timeout).toBe(0);
		});

		it("throws TBTransferError on failure", async () => {
			mockCreateTransfers.mockResolvedValueOnce([{ index: 0, result: 22 }]);
			await expect(
				client.immediateTransfer({
					debitAccountId: 1n,
					creditAccountId: 2n,
					amount: 500,
					code: XFER_PURCHASE,
				}),
			).rejects.toThrow(TBTransferError);
		});

		it("throws when error array element is undefined", async () => {
			mockCreateTransfers.mockResolvedValueOnce([undefined]);
			await expect(
				client.immediateTransfer({
					debitAccountId: 1n,
					creditAccountId: 2n,
					amount: 500,
					code: XFER_PURCHASE,
				}),
			).rejects.toThrow("Unknown account/transfer error");
		});

		it("uses provided transferId when given", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			const id = await client.immediateTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 500,
				code: XFER_PURCHASE,
				transferId: 999n,
			});
			expect(id).toBe(999n);
			const transfer = mockCreateTransfers.mock.calls[0]?.[0][0];
			expect(transfer.id).toBe(999n);
		});

		it("passes optional userData fields", async () => {
			mockCreateTransfers.mockResolvedValueOnce([]);
			await client.immediateTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 500,
				code: XFER_PURCHASE,
				userData128: 10n,
				userData64: 20n,
				userData32: 30,
			});
			const transfer = mockCreateTransfers.mock.calls[0]?.[0][0];
			expect(transfer.user_data_128).toBe(10n);
			expect(transfer.user_data_64).toBe(20n);
			expect(transfer.user_data_32).toBe(30);
		});

		it("retries on connection error via withReconnect", async () => {
			mockCreateTransfers.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce([]);
			const id = await client.immediateTransfer({
				debitAccountId: 1n,
				creditAccountId: 2n,
				amount: 500,
				code: XFER_PURCHASE,
			});
			expect(typeof id).toBe("bigint");
			expect(mockCreateTransfers).toHaveBeenCalledTimes(2);
		});
	});

	describe("lookupAccounts", () => {
		it("returns accounts from TB", async () => {
			const mockAccount = {
				id: 1n,
				credits_posted: 1000n,
				debits_posted: 200n,
				debits_pending: 50n,
			};
			mockLookupAccounts.mockResolvedValueOnce([mockAccount]);
			const accounts = await client.lookupAccounts([1n]);
			expect(accounts).toHaveLength(1);
			expect(accounts[0]?.id).toBe(1n);
		});

		it("returns empty array when no accounts found", async () => {
			mockLookupAccounts.mockResolvedValueOnce([]);
			const accounts = await client.lookupAccounts([999n]);
			expect(accounts).toHaveLength(0);
		});
	});

	describe("lookupBalance", () => {
		it("returns available, pending, and total", async () => {
			mockLookupAccounts.mockResolvedValueOnce([
				{
					id: 1n,
					credits_posted: 1000n,
					debits_posted: 200n,
					debits_pending: 50n,
					credits_pending: 0n,
				},
			]);
			const bal = await client.lookupBalance(1n);
			expect(bal.total).toBe(800); // 1000 - 200
			expect(bal.pending).toBe(50);
			expect(bal.available).toBe(750); // 800 - 50
		});

		it("throws if account not found", async () => {
			mockLookupAccounts.mockResolvedValueOnce([]);
			await expect(client.lookupBalance(999n)).rejects.toThrow("Account not found");
		});

		it("clamps available to 0 when pending exceeds posted", async () => {
			mockLookupAccounts.mockResolvedValueOnce([
				{
					id: 1n,
					credits_posted: 100n,
					debits_posted: 0n,
					debits_pending: 200n,
					credits_pending: 0n,
				},
			]);
			const bal = await client.lookupBalance(1n);
			expect(bal.available).toBe(0);
			expect(bal.total).toBe(100);
			expect(bal.pending).toBe(200);
		});

		it("clamps total to 0 when debits exceed credits", async () => {
			mockLookupAccounts.mockResolvedValueOnce([
				{
					id: 1n,
					credits_posted: 100n,
					debits_posted: 200n,
					debits_pending: 0n,
					credits_pending: 0n,
				},
			]);
			const bal = await client.lookupBalance(1n);
			expect(bal.total).toBe(0); // Math.max(0, -100)
			expect(bal.available).toBe(0);
		});

		it("throws on balance overflow exceeding MAX_SAFE_INTEGER", async () => {
			mockLookupAccounts.mockResolvedValueOnce([
				{
					id: 1n,
					credits_posted: BigInt(Number.MAX_SAFE_INTEGER) + 100n,
					debits_posted: 0n,
					debits_pending: 0n,
					credits_pending: 0n,
				},
			]);
			await expect(client.lookupBalance(1n)).rejects.toThrow("Balance overflow");
		});

		it("throws on negative balance overflow exceeding -MAX_SAFE_INTEGER", async () => {
			mockLookupAccounts.mockResolvedValueOnce([
				{
					id: 1n,
					credits_posted: 0n,
					debits_posted: BigInt(Number.MAX_SAFE_INTEGER) + 100n,
					debits_pending: 0n,
					credits_pending: 0n,
				},
			]);
			await expect(client.lookupBalance(1n)).rejects.toThrow("Balance overflow");
		});

		it("throws on pending overflow exceeding MAX_SAFE_INTEGER", async () => {
			mockLookupAccounts.mockResolvedValueOnce([
				{
					id: 1n,
					credits_posted: 1000n,
					debits_posted: 0n,
					debits_pending: BigInt(Number.MAX_SAFE_INTEGER) + 100n,
					credits_pending: 0n,
				},
			]);
			await expect(client.lookupBalance(1n)).rejects.toThrow("Pending overflow");
		});
	});

	describe("lookupTransfer", () => {
		it("returns transfer when found", async () => {
			const mockTransfer = { id: 100n, amount: 500n };
			mockLookupTransfers.mockResolvedValueOnce([mockTransfer]);
			const result = await client.lookupTransfer(100n);
			expect(result).toEqual(mockTransfer);
		});

		it("returns null when not found", async () => {
			mockLookupTransfers.mockResolvedValueOnce([]);
			const result = await client.lookupTransfer(999n);
			expect(result).toBeNull();
		});
	});

	describe("destroy", () => {
		it("destroys the underlying client", () => {
			client.destroy();
			expect(mockDestroy).toHaveBeenCalledOnce();
		});

		it("clears health check interval on destroy", () => {
			client.destroy();
			mockLookupAccounts.mockResolvedValue([]);
			vi.advanceTimersByTime(60_000);
			expect(mockLookupAccounts).not.toHaveBeenCalled();
		});

		it("calling destroy twice does not throw", () => {
			client.destroy();
			expect(() => client.destroy()).not.toThrow();
		});
	});

	describe("treasury", () => {
		it("setTreasuryId stores the ID", () => {
			client.setTreasuryId(42n);
			expect(client.getTreasuryId()).toBe(42n);
		});

		it("getTreasuryId throws when not initialized", () => {
			expect(() => client.getTreasuryId()).toThrow("Treasury not initialized");
		});

		it("createTreasury creates a new treasury account", async () => {
			mockCreateAccounts.mockResolvedValueOnce([]);
			const id = await client.createTreasury();
			expect(typeof id).toBe("bigint");
			expect(mockCreateAccounts).toHaveBeenCalledOnce();
			expect(client.getTreasuryId()).toBe(id);
		});

		it("createTreasury returns existing treasury when already set and found", async () => {
			client.setTreasuryId(42n);
			mockLookupAccounts.mockResolvedValueOnce([{ id: 42n }]);
			const id = await client.createTreasury();
			expect(id).toBe(42n);
			expect(mockCreateAccounts).not.toHaveBeenCalled();
		});

		it("createTreasury re-creates when treasuryId is set but account not found", async () => {
			client.setTreasuryId(42n);
			mockLookupAccounts.mockResolvedValueOnce([]); // not found
			mockCreateAccounts.mockResolvedValueOnce([]);
			const id = await client.createTreasury();
			expect(id).toBe(42n); // reuses the set ID
			expect(mockCreateAccounts).toHaveBeenCalledOnce();
		});

		it("createTreasury throws on creation errors", async () => {
			mockCreateAccounts.mockResolvedValueOnce([{ index: 0, result: 99 }]);
			await expect(client.createTreasury()).rejects.toThrow("Failed to create treasury");
		});

		it("createTreasury throws when error array element is undefined", async () => {
			mockCreateAccounts.mockResolvedValueOnce([undefined]);
			await expect(client.createTreasury()).rejects.toThrow("Unknown account/transfer error");
		});
	});

	describe("account mapping", () => {
		it("setAccountMapping and getAccountId round-trip", () => {
			client.setAccountMapping("user_x", 99n);
			expect(client.getAccountId("user_x")).toBe(99n);
		});

		it("getAccountId throws for unknown user", () => {
			expect(() => client.getAccountId("unknown")).toThrow("No TigerBeetle account for user");
		});

		it("setAccountMapping overwrites previous mapping", () => {
			client.setAccountMapping("user_x", 99n);
			client.setAccountMapping("user_x", 200n);
			expect(client.getAccountId("user_x")).toBe(200n);
		});
	});

	describe("ping", () => {
		it("returns true within grace period when not initialized", async () => {
			const result = await client.ping();
			expect(result).toBe(true);
		});

		it("returns true when initialized and treasury account found", async () => {
			client.setTreasuryId(42n);
			mockLookupAccounts.mockResolvedValueOnce([{ id: 42n }]);
			const result = await client.ping();
			expect(result).toBe(true);
		});

		it("returns false when initialized and treasury account not found", async () => {
			client.setTreasuryId(42n);
			mockLookupAccounts.mockResolvedValueOnce([]);
			const result = await client.ping();
			expect(result).toBe(false);
		});

		it("returns false on lookup error (catches all exceptions)", async () => {
			client.setTreasuryId(42n);
			// Make lookupAccounts reject with a non-connection error so withReconnect
			// rethrows it (no reconnect attempt), then ping's catch returns false.
			mockLookupAccounts.mockRejectedValueOnce(new Error("unexpected failure"));
			const result = await client.ping();
			expect(result).toBe(false);
		});

		it("returns false after grace period when not initialized", async () => {
			vi.advanceTimersByTime(61_000);
			const result = await client.ping();
			expect(result).toBe(false);
		});
	});

	describe("withReconnect", () => {
		it("retries on connection error (ECONNREFUSED)", async () => {
			mockLookupAccounts
				.mockRejectedValueOnce(new Error("connection refused"))
				.mockResolvedValueOnce([{ id: 1n }]);
			const accounts = await client.lookupAccounts([1n]);
			expect(accounts).toHaveLength(1);
			expect(mockLookupAccounts).toHaveBeenCalledTimes(2);
		});

		it("retries on ECONNRESET", async () => {
			mockCreateTransfers.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce([]);
			const id = await client.voidTransfer(1n);
			expect(typeof id).toBe("bigint");
			expect(mockCreateTransfers).toHaveBeenCalledTimes(2);
		});

		it("retries on 'client is closed' error", async () => {
			mockLookupTransfers
				.mockRejectedValueOnce(new Error("client is closed"))
				.mockResolvedValueOnce([{ id: 1n }]);
			const result = await client.lookupTransfer(1n);
			expect(result).toEqual({ id: 1n });
		});

		it("retries on 'not connected' error", async () => {
			mockLookupAccounts
				.mockRejectedValueOnce(new Error("not connected"))
				.mockResolvedValueOnce([]);
			const accounts = await client.lookupAccounts([1n]);
			expect(accounts).toHaveLength(0);
		});

		it("retries on 'socket' error", async () => {
			mockLookupAccounts
				.mockRejectedValueOnce(new Error("socket hang up"))
				.mockResolvedValueOnce([]);
			const accounts = await client.lookupAccounts([1n]);
			expect(accounts).toHaveLength(0);
		});

		it("retries on 'timeout' error", async () => {
			mockLookupAccounts
				.mockRejectedValueOnce(new Error("request timeout"))
				.mockResolvedValueOnce([]);
			const accounts = await client.lookupAccounts([1n]);
			expect(accounts).toHaveLength(0);
		});

		it("does not retry on non-connection errors", async () => {
			mockLookupAccounts.mockRejectedValueOnce(new Error("invalid argument"));
			await expect(client.lookupAccounts([1n])).rejects.toThrow("invalid argument");
			expect(mockLookupAccounts).toHaveBeenCalledTimes(1);
		});

		it("does not treat non-Error objects as connection errors", async () => {
			mockLookupAccounts.mockRejectedValueOnce("string error");
			await expect(client.lookupAccounts([1n])).rejects.toBe("string error");
			expect(mockLookupAccounts).toHaveBeenCalledTimes(1);
		});
	});

	describe("reconnect", () => {
		it("deduplicates concurrent reconnect calls", async () => {
			mockCreateAccounts
				.mockRejectedValueOnce(new Error("connection refused"))
				.mockResolvedValueOnce([]);

			const promise1 = client.createUserWallet("user_dedup1");
			await promise1;
			expect(mockCreateAccounts).toHaveBeenCalledTimes(2);
		});

		it("reconnect destroys old client and creates new one", async () => {
			mockLookupAccounts.mockRejectedValueOnce(new Error("closed")).mockResolvedValueOnce([]);
			await client.lookupAccounts([1n]);
			expect(mockDestroy).toHaveBeenCalled();
			// createClient called: once in constructor, once in reconnect
			expect(mockCreateClient).toHaveBeenCalledTimes(2);
		});
	});

	describe("health check interval", () => {
		it("triggers ping at 30-second intervals", async () => {
			client.setTreasuryId(42n);
			mockLookupAccounts.mockResolvedValue([{ id: 42n }]);

			await vi.advanceTimersByTimeAsync(30_000);

			expect(mockLookupAccounts).toHaveBeenCalled();
		});

		it("exercises health check failure path when ping rejects (onAlert)", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			client.destroy();

			const onAlert = vi.fn();
			const alertClient = new TrustTBClient({
				addresses: ["3000"],
				onAlert,
			});

			// Override ping to reject — forces the health check .catch path
			vi.spyOn(alertClient, "ping").mockRejectedValue(new Error("ping boom"));
			// Override reconnect to also reject
			vi.spyOn(alertClient, "reconnect").mockRejectedValue(new Error("reconnect boom"));

			// Fire health check interval
			await vi.advanceTimersByTimeAsync(30_000);

			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("Health check reconnection failed"),
				expect.any(Error),
			);
			expect(onAlert).toHaveBeenCalledWith(
				expect.stringContaining("health check failed"),
				expect.objectContaining({ error: "reconnect boom" }),
			);

			alertClient.destroy();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it("exercises health check failure path when ping rejects (console.warn fallback)", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			client.destroy();

			// No onAlert callback
			const noAlertClient = new TrustTBClient({ addresses: ["3000"] });

			vi.spyOn(noAlertClient, "ping").mockRejectedValue(new Error("ping boom"));
			vi.spyOn(noAlertClient, "reconnect").mockRejectedValue(new Error("reconnect boom"));

			await vi.advanceTimersByTimeAsync(30_000);

			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("Health check reconnection failed"),
				expect.any(Error),
			);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("[usertrust]"),
				expect.objectContaining({ error: "reconnect boom" }),
			);

			noAlertClient.destroy();
			warnSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it("exercises health check failure path with non-Error rejection", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			client.destroy();

			const noAlertClient = new TrustTBClient({ addresses: ["3000"] });

			vi.spyOn(noAlertClient, "ping").mockRejectedValue("string error");
			vi.spyOn(noAlertClient, "reconnect").mockRejectedValue("string reconnect error");

			await vi.advanceTimersByTimeAsync(30_000);

			// Non-Error → String(err) path
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("[usertrust]"),
				expect.objectContaining({ error: "string reconnect error" }),
			);

			noAlertClient.destroy();
			warnSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it("clears health check interval on reconnection failure", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			client.destroy();

			const alertClient = new TrustTBClient({
				addresses: ["3000"],
				onAlert: vi.fn(),
			});

			vi.spyOn(alertClient, "ping").mockRejectedValue(new Error("ping boom"));
			vi.spyOn(alertClient, "reconnect").mockRejectedValue(new Error("reconnect boom"));

			// Fire first health check
			await vi.advanceTimersByTimeAsync(30_000);

			// After failure, interval should be cleared — no more calls
			const pingMock = alertClient.ping as ReturnType<typeof vi.fn>;
			const callCount = pingMock.mock.calls.length;

			// Advance another 30s — should NOT trigger another health check
			await vi.advanceTimersByTimeAsync(30_000);
			expect(pingMock.mock.calls.length).toBe(callCount);

			alertClient.destroy();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		});
	});

	describe("_doReconnect error handling", () => {
		it("calls onAlert when all reconnection attempts fail", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			client.destroy();

			const onAlert = vi.fn();
			const alertClient = new TrustTBClient({
				addresses: ["3000"],
				onAlert,
			});
			alertClient.destroy(); // Stop health check interval

			mockCreateClient.mockImplementation(() => {
				throw new Error("cannot connect");
			});

			// Start reconnect — don't await yet (backoff uses setTimeout)
			const promise = alertClient.reconnect().catch((e: Error) => e);

			// Advance time to flush all exponential backoff delays (1+2+4+8=15s)
			await vi.advanceTimersByTimeAsync(16_000);

			const err = await promise;
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toBe("cannot connect");

			expect(onAlert).toHaveBeenCalledWith(
				expect.stringContaining("all reconnection attempts failed"),
				expect.any(Object),
			);

			resetCreateClient();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it("logs to console when all reconnection attempts fail and no onAlert", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			client.destroy();

			const noAlertClient = new TrustTBClient({ addresses: ["3000"] });
			noAlertClient.destroy();

			mockCreateClient.mockImplementation(() => {
				throw new Error("cannot connect");
			});

			const promise = noAlertClient.reconnect().catch((e: Error) => e);
			await vi.advanceTimersByTimeAsync(16_000);

			const err = await promise;
			expect(err).toBeInstanceOf(Error);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[usertrust]"));

			resetCreateClient();
			warnSpy.mockRestore();
			logSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it("reconnect deduplicates concurrent calls", async () => {
			client.destroy();
			const testClient = new TrustTBClient({ addresses: ["3000"] });
			testClient.destroy();

			// reconnect() deduplicates via reconnectPromise
			const p1 = testClient.reconnect();
			const p2 = testClient.reconnect();

			await p1;
			await p2;

			// createClient called: constructor + 1 reconnect (deduplicated)
			expect(mockCreateClient).toHaveBeenCalledTimes(3); // main client + testClient + reconnect
		});
	});

	describe("constructor options", () => {
		it("defaults clusterId to 0n", () => {
			const call = mockCreateClient.mock.calls[0]?.[0];
			expect(call.cluster_id).toBe(0n);
		});

		it("accepts custom clusterId", () => {
			const customClient = new TrustTBClient({
				addresses: ["3000"],
				clusterId: 5n,
			});
			const lastCall = mockCreateClient.mock.calls[mockCreateClient.mock.calls.length - 1]?.[0];
			expect(lastCall.cluster_id).toBe(5n);
			customClient.destroy();
		});

		it("accepts onAlert callback", () => {
			const onAlert = vi.fn();
			const customClient = new TrustTBClient({
				addresses: ["3000"],
				onAlert,
			});
			expect(onAlert).not.toHaveBeenCalled();
			customClient.destroy();
		});
	});

	describe("TBTransferError", () => {
		it("carries error code", () => {
			const err = new TBTransferError(22, "exceeds_credits");
			expect(err.code).toBe(22);
			expect(err.message).toBe("exceeds_credits");
			expect(err.name).toBe("TBTransferError");
		});

		it("is an instance of Error", () => {
			const err = new TBTransferError(30, "overflow");
			expect(err).toBeInstanceOf(Error);
		});
	});

	describe("constants", () => {
		it("LEDGER_USERTOKENS is 1", () => {
			expect(LEDGER_USERTOKENS).toBe(1);
		});

		it("account codes are distinct", () => {
			expect(CODE_USER_WALLET).not.toBe(CODE_PLATFORM_TREASURY);
			expect(CODE_PLATFORM_TREASURY).not.toBe(CODE_ESCROW);
			expect(CODE_USER_WALLET).not.toBe(CODE_ESCROW);
		});

		it("transfer codes are distinct sequential integers", () => {
			const codes = [
				XFER_PURCHASE,
				XFER_SPEND,
				XFER_TRANSFER,
				XFER_REFUND,
				XFER_ALLOCATION,
				XFER_TOOL_CALL,
				XFER_A2A_DELEGATION,
			];
			expect(new Set(codes).size).toBe(7);
			expect(codes).toEqual([1, 2, 3, 4, 5, 6, 7]);
		});
	});
});
