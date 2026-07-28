// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock tigerbeetle-node — allocation.ts reaches CreateTransferStatus through
// ledger/client.js, which is a real (unmocked) module in these tests.
vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(),
	AccountFlags: { debits_must_not_exceed_credits: 1 << 2, history: 1 << 5 },
	TransferFlags: { pending: 1, post_pending_transfer: 2, void_pending_transfer: 4 },
	CreateAccountStatus: { created: 4294967295, exists: 1, exists_with_different_flags: 2 },
	CreateTransferStatus: {
		created: 4294967295,
		exceeds_credits: 22,
		overflows_debits: 30,
		overflows_debits_pending: 31,
	},
	amount_max: (1n << 128n) - 1n,
}));

import type { AppendEventInput } from "../../src/audit/chain.js";
import {
	allocateBudget,
	costCenterUserId,
	getBudgetStatus,
	reclaimBudget,
} from "../../src/budget/allocation.js";
import { computeRunway } from "../../src/budget/runway.js";
import {
	TrustTBClient,
	XFER_BUDGET_GRANT,
	XFER_BUDGET_RECLAIM,
	XFER_SPEND,
} from "../../src/ledger/client.js";
import { InsufficientBalanceError } from "../../src/shared/errors.js";

const PARENT = "user_1";
const COST_CENTER = "research";
const CHILD = `${PARENT}::${COST_CENTER}`;
const PARENT_ACCOUNT = 111n;
/** Derived with the same static the implementation uses — never hardcoded. */
const CHILD_ACCOUNT = TrustTBClient.deriveAccountId(CHILD);

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;

/** Create a mock TrustTBClient with vi.fn() methods. */
function createMockTBClient() {
	return {
		getAccountId: vi.fn(() => PARENT_ACCOUNT),
		getTreasuryId: vi.fn(() => 1n),
		lookupBalance: vi.fn(),
		createPendingTransfer: vi.fn(),
		postTransfer: vi.fn(),
		voidTransfer: vi.fn(),
		immediateTransfer: vi.fn(),
		lookupTransfer: vi.fn(),
		// Non-empty by default: the cost-center wallet exists.
		lookupAccounts: vi.fn(async () => [{}]),
		createUserWallet: vi.fn(async () => CHILD_ACCOUNT),
		createTreasury: vi.fn(),
		setTreasuryId: vi.fn(),
		setAccountMapping: vi.fn(),
		ping: vi.fn(),
		destroy: vi.fn(),
	};
}

type MockTB = ReturnType<typeof createMockTBClient>;

/** Build a rejection with TigerBeetle's exact TBTransferError shape (name + numeric code). */
function tbTransferError(message: string, code: number): Error {
	const err = new Error(message);
	Object.assign(err, { name: "TBTransferError", code });
	return err;
}

function createMockAuditWriter() {
	return { appendEvent: vi.fn(async (_input: AppendEventInput): Promise<unknown> => ({})) };
}

/** Cast helper — the mock implements only the slice of the client this module uses. */
function asClient(mock: MockTB): TrustTBClient {
	return mock as unknown as TrustTBClient;
}

describe("costCenterUserId", () => {
	it("derives `parent::costCenter`", () => {
		expect(costCenterUserId(PARENT, COST_CENTER)).toBe(CHILD);
	});

	it("accepts a single-character cost center and parent", () => {
		expect(costCenterUserId("a", "b")).toBe("a::b");
	});

	it("accepts both parts at their maximum length", () => {
		const parent = "p".repeat(128);
		const cc = "c".repeat(64);
		const derived = costCenterUserId(parent, cc);
		expect(derived).toBe(`${parent}::${cc}`);
		// 128 + 2 + 64 — the component bounds keep the derived id under the 200 cap.
		expect(derived.length).toBe(194);
	});

	it("rejects an empty cost center or parent", () => {
		expect(() => costCenterUserId(PARENT, "")).toThrow(/costCenter/);
		expect(() => costCenterUserId("", COST_CENTER)).toThrow(/parentUserId/);
	});

	it("rejects either part one character past its maximum", () => {
		expect(() => costCenterUserId(PARENT, "c".repeat(65))).toThrow(/costCenter/);
		expect(() => costCenterUserId("p".repeat(129), COST_CENTER)).toThrow(/parentUserId/);
	});

	it("rejects an embedded `::` in either part so the derived id stays unambiguous", () => {
		expect(() => costCenterUserId(PARENT, "a::b")).toThrow(/costCenter/);
		expect(() => costCenterUserId("user::sub", COST_CENTER)).toThrow(/parentUserId/);
	});

	it("rejects a bare colon in either part", () => {
		expect(() => costCenterUserId(PARENT, "a:b")).toThrow(/costCenter/);
		expect(() => costCenterUserId("user:1", COST_CENTER)).toThrow(/parentUserId/);
	});

	it("rejects a slash in the cost center", () => {
		expect(() => costCenterUserId(PARENT, "research/sub")).toThrow(/costCenter/);
	});

	it("rejects embedded newlines and ANSI escapes in either part", () => {
		for (const bad of ["cc\nx", "cc\r\nx", "\u001b[31mcc", "cc x", "cc "]) {
			expect(() => costCenterUserId(PARENT, bad)).toThrow(/costCenter/);
		}
		for (const bad of ["user\nx", "user\r\nx", "\u001b[31muser", "user x", "user "]) {
			expect(() => costCenterUserId(bad, COST_CENTER)).toThrow(/parentUserId/);
		}
	});

	it("rejects a trailing newline (the classic anchored-regex bypass)", () => {
		expect(() => costCenterUserId(PARENT, `${COST_CENTER}\n`)).toThrow(/costCenter/);
		expect(() => costCenterUserId(`${PARENT}\n`, COST_CENTER)).toThrow(/parentUserId/);
	});

	it("accepts leading and trailing punctuation from the allowed set", () => {
		// Deliberate: `.` and `-` carry no meaning here — the derived id is hashed
		// into an account id and embedded in JSON, never used as a filesystem path.
		expect(costCenterUserId(".user.", "-cc-")).toBe(".user.::-cc-");
		expect(costCenterUserId("a@b.com", "cc.v2")).toBe("a@b.com::cc.v2");
	});

	it("rejects `@` in the cost center but allows it in the parent", () => {
		expect(costCenterUserId("a@b.com", COST_CENTER)).toBe(`a@b.com::${COST_CENTER}`);
		expect(() => costCenterUserId(PARENT, "cc@v2")).toThrow(/costCenter/);
	});

	it("rejects non-string input from untyped JS callers", () => {
		expect(() => costCenterUserId(PARENT, 123 as unknown as string)).toThrow(/costCenter/);
		expect(() => costCenterUserId(null as unknown as string, COST_CENTER)).toThrow(/parentUserId/);
	});

	it("never collides across distinct (parent, costCenter) pairs", () => {
		const pairs: Array<[string, string]> = [
			["a", "b"],
			["a.b", "c"],
			["a", "b.c"],
			["ab", "c"],
			["a-b", "c"],
		];
		const derived = pairs.map(([p, c]) => costCenterUserId(p, c));
		expect(new Set(derived).size).toBe(pairs.length);
	});
});

describe("allocateBudget", () => {
	let mockTB: MockTB;

	beforeEach(() => {
		vi.clearAllMocks();
		mockTB = createMockTBClient();
	});

	it("creates the cost-center wallet then transfers parent -> child", async () => {
		mockTB.immediateTransfer.mockResolvedValueOnce(42n);

		const result = await allocateBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			amount: 500,
		});

		// `{ derived: true }` is the opt-in past the reserved-`::` guard on ordinary
		// wallet ids — without it the cost-center wallet cannot be created at all.
		expect(mockTB.createUserWallet).toHaveBeenCalledWith(CHILD, { derived: true });
		expect(mockTB.immediateTransfer).toHaveBeenCalledOnce();
		const call = mockTB.immediateTransfer.mock.calls[0]?.[0];
		expect(call).toEqual({
			debitAccountId: PARENT_ACCOUNT,
			creditAccountId: CHILD_ACCOUNT,
			amount: 500,
			code: XFER_BUDGET_GRANT,
		});
		expect(result).toEqual({
			costCenterUserId: CHILD,
			transferId: "42",
			allocated: 500,
			audited: false,
		});
	});

	it("creates the wallet before transferring", async () => {
		mockTB.immediateTransfer.mockResolvedValueOnce(42n);

		await allocateBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			amount: 500,
		});

		const created = mockTB.createUserWallet.mock.invocationCallOrder[0] as number;
		const transferred = mockTB.immediateTransfer.mock.invocationCallOrder[0] as number;
		expect(created).toBeLessThan(transferred);
	});

	// AUD-455: the TOCTOU invariant. A balance read before the transfer would be a
	// check-then-act race; TigerBeetle enforces debits_must_not_exceed_credits atomically.
	it("never reads the parent balance before transferring", async () => {
		mockTB.immediateTransfer.mockResolvedValueOnce(42n);

		await allocateBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			amount: 500,
		});

		expect(mockTB.lookupBalance).not.toHaveBeenCalled();
	});

	it("rejects a non-positive, fractional, or unsafe amount before any ledger I/O", async () => {
		for (const amount of [0, -1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
			await expect(
				allocateBudget(asClient(mockTB), {
					parentUserId: PARENT,
					costCenter: COST_CENTER,
					amount,
				}),
			).rejects.toThrow("budget: amount must be a positive integer");
		}
		expect(mockTB.createUserWallet).not.toHaveBeenCalled();
		expect(mockTB.immediateTransfer).not.toHaveBeenCalled();
	});

	it("rejects an invalid cost-center name before any ledger I/O", async () => {
		for (const costCenter of ["a::b", "research/sub", "", "c".repeat(65)]) {
			await expect(
				allocateBudget(asClient(mockTB), { parentUserId: PARENT, costCenter, amount: 500 }),
			).rejects.toThrow(/costCenter/);
		}
		expect(mockTB.createUserWallet).not.toHaveBeenCalled();
		expect(mockTB.immediateTransfer).not.toHaveBeenCalled();
	});

	it("translates a TigerBeetle insufficient-balance rejection into InsufficientBalanceError", async () => {
		mockTB.immediateTransfer.mockRejectedValueOnce(
			tbTransferError("Transfer failed: exceeds_credits", 22),
		);
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 10, pending: 0, total: 10 });

		const err = await allocateBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			amount: 500,
		}).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(InsufficientBalanceError);
		expect((err as InsufficientBalanceError).message).toContain("500");
		expect((err as InsufficientBalanceError).message).toContain("10");
	});

	it("reads the balance only AFTER the transfer is rejected, for the error message", async () => {
		mockTB.immediateTransfer.mockRejectedValueOnce(
			tbTransferError("Transfer failed: exceeds_credits", 22),
		);
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 10, pending: 0, total: 10 });

		await allocateBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			amount: 500,
		}).catch(() => undefined);

		const transferred = mockTB.immediateTransfer.mock.invocationCallOrder[0] as number;
		const lookedUp = mockTB.lookupBalance.mock.invocationCallOrder[0] as number;
		expect(transferred).toBeLessThan(lookedUp);
	});

	it("reports 0 available when the post-rejection balance lookup also fails", async () => {
		mockTB.immediateTransfer.mockRejectedValueOnce(
			tbTransferError("Transfer failed: exceeds_credits", 22),
		);
		mockTB.lookupBalance.mockRejectedValueOnce(new Error("TB unreachable"));

		const err = await allocateBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			amount: 500,
		}).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(InsufficientBalanceError);
		expect((err as InsufficientBalanceError).available).toBe(0);
	});

	it("translates every TigerBeetle balance-rejection code", async () => {
		for (const code of [22, 30, 31]) {
			vi.clearAllMocks();
			mockTB.immediateTransfer.mockRejectedValueOnce(tbTransferError("Transfer failed", code));
			mockTB.lookupBalance.mockResolvedValueOnce({ available: 0, pending: 0, total: 0 });
			await expect(
				allocateBudget(asClient(mockTB), {
					parentUserId: PARENT,
					costCenter: COST_CENTER,
					amount: 500,
				}),
			).rejects.toThrow(InsufficientBalanceError);
		}
	});

	it("propagates a non-balance transfer rejection unchanged", async () => {
		mockTB.immediateTransfer.mockRejectedValueOnce(new Error("Connection refused"));

		await expect(
			allocateBudget(asClient(mockTB), {
				parentUserId: PARENT,
				costCenter: COST_CENTER,
				amount: 500,
			}),
		).rejects.toThrow("Connection refused");
		expect(mockTB.lookupBalance).not.toHaveBeenCalled();
	});

	// D10: `createUserWallet` absorbs CreateAccountStatus.exists internally and
	// resolves with the existing id, so an already-created wallet is observationally
	// identical to a fresh one. There is no rejection to catch here.
	it("proceeds normally when the cost-center wallet already exists", async () => {
		mockTB.createUserWallet.mockResolvedValueOnce(CHILD_ACCOUNT);
		mockTB.immediateTransfer.mockResolvedValueOnce(43n);

		const result = await allocateBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			amount: 500,
		});

		expect(result.transferId).toBe("43");
		expect(mockTB.immediateTransfer).toHaveBeenCalledOnce();
	});

	it("propagates a wallet-creation failure that is NOT `exists` and issues no transfer", async () => {
		mockTB.createUserWallet.mockRejectedValueOnce(
			new Error("Failed to create account: exists_with_different_flags"),
		);

		await expect(
			allocateBudget(asClient(mockTB), {
				parentUserId: PARENT,
				costCenter: COST_CENTER,
				amount: 500,
			}),
		).rejects.toThrow("exists_with_different_flags");
		expect(mockTB.immediateTransfer).not.toHaveBeenCalled();
	});

	// D8: a cost center that resolves to its own parent would let a transfer debit
	// and credit the same account — a no-op that reports as a funded allocation.
	it("refuses to transfer when the cost center resolves to the parent account", async () => {
		mockTB.getAccountId.mockReturnValueOnce(CHILD_ACCOUNT);

		await expect(
			allocateBudget(asClient(mockTB), {
				parentUserId: PARENT,
				costCenter: COST_CENTER,
				amount: 500,
			}),
		).rejects.toThrow("budget: cost center resolves to the parent account");
		expect(mockTB.immediateTransfer).not.toHaveBeenCalled();
		expect(mockTB.createUserWallet).not.toHaveBeenCalled();
	});

	it("refuses to transfer when the created wallet id differs from the derived id", async () => {
		// A poisoned accountMap (setAccountMapping) would make allocate fund an
		// account that reclaim and status never read.
		mockTB.createUserWallet.mockResolvedValueOnce(999n);

		await expect(
			allocateBudget(asClient(mockTB), {
				parentUserId: PARENT,
				costCenter: COST_CENTER,
				amount: 500,
			}),
		).rejects.toThrow("budget: cost center account id does not match its derived id");
		expect(mockTB.immediateTransfer).not.toHaveBeenCalled();
	});

	it("emits a budget_allocated audit event with a closed payload", async () => {
		mockTB.immediateTransfer.mockResolvedValueOnce(42n);
		const audit = createMockAuditWriter();

		await allocateBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			amount: 500,
			auditWriter: audit,
		});

		expect(audit.appendEvent).toHaveBeenCalledOnce();
		expect(audit.appendEvent).toHaveBeenCalledWith({
			kind: "budget_allocated",
			actor: PARENT,
			data: { costCenter: COST_CENTER, amount: 500, costCenterUserId: CHILD },
		});
	});

	// D6: the payload is constructed literally — caller input is never spread in.
	it("never leaks unexpected caller fields into the audit payload", async () => {
		mockTB.immediateTransfer.mockResolvedValueOnce(42n);
		const audit = createMockAuditWriter();

		await allocateBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			amount: 500,
			auditWriter: audit,
			apiKey: "sk-secret",
			prompt: "free-form text",
		} as unknown as Parameters<typeof allocateBudget>[1]);

		const event = audit.appendEvent.mock.calls[0]?.[0] as unknown as {
			data: Record<string, unknown>;
		};
		expect(Object.keys(event.data).sort()).toEqual(["amount", "costCenter", "costCenterUserId"]);
	});

	// The allocation direction must NOT reuse the metering path's spend code:
	// reconciliation summing XFER_SPEND debits would count a delegation twice,
	// once moving into the cost center and again when the cost center spends it.
	it("moves the grant under a code distinct from a metered spend", () => {
		expect(XFER_BUDGET_GRANT).not.toBe(XFER_SPEND);
		expect(XFER_BUDGET_GRANT).not.toBe(XFER_BUDGET_RECLAIM);
	});

	// Money must not move with no audit AND no signal: without an explicit
	// `audited`, an unaudited allocation is byte-identical to an audited one.
	it("reports audited: false when no writer is supplied, and emits no event", async () => {
		mockTB.immediateTransfer.mockResolvedValueOnce(42n);

		const result = await allocateBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			amount: 500,
		});

		expect(result.audited).toBe(false);
		expect(result.auditFailed).toBeUndefined();
	});

	it("reports audited: true when the append lands in the chain", async () => {
		mockTB.immediateTransfer.mockResolvedValueOnce(42n);
		const audit = createMockAuditWriter();

		const result = await allocateBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			amount: 500,
			auditWriter: audit,
		});

		expect(result.audited).toBe(true);
		expect(result.auditFailed).toBeUndefined();
	});

	// D5: the transfer is authoritative. A failed audit append must never re-transfer.
	it("reports auditFailed without re-transferring when the audit append throws", async () => {
		mockTB.immediateTransfer.mockResolvedValueOnce(42n);
		const audit = createMockAuditWriter();
		audit.appendEvent.mockRejectedValueOnce(new Error("audit disk full"));

		const result = await allocateBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			amount: 500,
			auditWriter: audit,
		});

		expect(result.transferId).toBe("42");
		expect(result.allocated).toBe(500);
		expect(result.audited).toBe(false);
		expect(result.auditFailed).toBe(true);
		expect(mockTB.immediateTransfer).toHaveBeenCalledOnce();
	});

	it("leaves auditFailed unset when the audit append succeeds", async () => {
		mockTB.immediateTransfer.mockResolvedValueOnce(42n);
		const audit = createMockAuditWriter();

		const result = await allocateBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			amount: 500,
			auditWriter: audit,
		});

		expect(result.auditFailed).toBeUndefined();
	});
});

describe("reclaimBudget", () => {
	let mockTB: MockTB;

	beforeEach(() => {
		vi.clearAllMocks();
		mockTB = createMockTBClient();
	});

	it("moves exactly the available balance child -> parent under the reclaim code", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 320, pending: 0, total: 320 });
		mockTB.immediateTransfer.mockResolvedValueOnce(77n);

		const result = await reclaimBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
		});

		expect(mockTB.immediateTransfer).toHaveBeenCalledWith({
			debitAccountId: CHILD_ACCOUNT,
			creditAccountId: PARENT_ACCOUNT,
			amount: 320,
			code: XFER_BUDGET_RECLAIM,
		});
		expect(result).toEqual({ reclaimed: 320, transferId: "77", audited: false });
	});

	it("uses a transfer code distinct from allocation", () => {
		expect(XFER_BUDGET_RECLAIM).not.toBe(XFER_BUDGET_GRANT);
		expect(XFER_BUDGET_RECLAIM).not.toBe(XFER_SPEND);
	});

	it("excludes held funds — it reclaims available, not total", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 200, pending: 100, total: 300 });
		mockTB.immediateTransfer.mockResolvedValueOnce(77n);

		const result = await reclaimBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
		});

		expect(result.reclaimed).toBe(200);
	});

	it("returns a zero reclaim and issues no transfer on an empty cost center", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 0, pending: 0, total: 0 });

		const result = await reclaimBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
		});

		expect(result).toEqual({ reclaimed: 0, transferId: null, audited: false });
		expect(mockTB.immediateTransfer).not.toHaveBeenCalled();
	});

	it("is safe to call twice — the second call moves nothing", async () => {
		mockTB.lookupBalance
			.mockResolvedValueOnce({ available: 320, pending: 0, total: 320 })
			.mockResolvedValueOnce({ available: 0, pending: 0, total: 0 });
		mockTB.immediateTransfer.mockResolvedValueOnce(77n);

		const first = await reclaimBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
		});
		const second = await reclaimBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
		});

		expect(first.reclaimed).toBe(320);
		expect(second).toEqual({ reclaimed: 0, transferId: null, audited: false });
		expect(mockTB.immediateTransfer).toHaveBeenCalledOnce();
	});

	it("treats a never-allocated cost center as an implicit zero", async () => {
		mockTB.lookupAccounts.mockResolvedValueOnce([]);

		const result = await reclaimBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
		});

		expect(result).toEqual({ reclaimed: 0, transferId: null, audited: false });
		expect(mockTB.lookupBalance).not.toHaveBeenCalled();
		expect(mockTB.immediateTransfer).not.toHaveBeenCalled();
	});

	// D3: reclaim is optimistic read-then-transfer. A concurrent spend or a second
	// reclaim landing between the two is a benign race, not a failure.
	it("returns a zero reclaim when the balance goes stale before the transfer", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 100, pending: 0, total: 100 });
		mockTB.immediateTransfer.mockRejectedValueOnce(
			tbTransferError("Transfer failed: exceeds_credits", 22),
		);

		const result = await reclaimBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
		});

		expect(result).toEqual({ reclaimed: 0, transferId: null, audited: false });
	});

	it("treats every balance-rejection code as the benign race", async () => {
		for (const code of [22, 30, 31]) {
			vi.clearAllMocks();
			mockTB.lookupBalance.mockResolvedValueOnce({ available: 100, pending: 0, total: 100 });
			mockTB.immediateTransfer.mockRejectedValueOnce(tbTransferError("Transfer failed", code));

			const result = await reclaimBudget(asClient(mockTB), {
				parentUserId: PARENT,
				costCenter: COST_CENTER,
			});

			expect(result).toEqual({ reclaimed: 0, transferId: null, audited: false });
		}
	});

	it("rethrows any rejection that is not an insufficient balance", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 100, pending: 0, total: 100 });
		mockTB.immediateTransfer.mockRejectedValueOnce(new Error("Connection refused"));

		await expect(
			reclaimBudget(asClient(mockTB), { parentUserId: PARENT, costCenter: COST_CENTER }),
		).rejects.toThrow("Connection refused");
	});

	it("does not emit an audit event for a zero reclaim", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 0, pending: 0, total: 0 });
		const audit = createMockAuditWriter();

		await reclaimBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			auditWriter: audit,
		});

		expect(audit.appendEvent).not.toHaveBeenCalled();
	});

	it("emits a budget_reclaimed audit event with a closed payload", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 320, pending: 0, total: 320 });
		mockTB.immediateTransfer.mockResolvedValueOnce(77n);
		const audit = createMockAuditWriter();

		const result = await reclaimBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			auditWriter: audit,
		});

		expect(audit.appendEvent).toHaveBeenCalledWith({
			kind: "budget_reclaimed",
			actor: PARENT,
			data: { costCenter: COST_CENTER, amount: 320, costCenterUserId: CHILD },
		});
		expect(result.audited).toBe(true);
		expect(result.auditFailed).toBeUndefined();
	});

	it("reports audited: false when money moves with no writer supplied", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 320, pending: 0, total: 320 });
		mockTB.immediateTransfer.mockResolvedValueOnce(77n);

		const result = await reclaimBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
		});

		expect(result.reclaimed).toBe(320);
		expect(result.audited).toBe(false);
		expect(result.auditFailed).toBeUndefined();
	});

	it("reports auditFailed without re-transferring when the audit append throws", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 320, pending: 0, total: 320 });
		mockTB.immediateTransfer.mockResolvedValueOnce(77n);
		const audit = createMockAuditWriter();
		audit.appendEvent.mockRejectedValueOnce(new Error("audit disk full"));

		const result = await reclaimBudget(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			auditWriter: audit,
		});

		expect(result.reclaimed).toBe(320);
		expect(result.transferId).toBe("77");
		expect(result.audited).toBe(false);
		expect(result.auditFailed).toBe(true);
		expect(mockTB.immediateTransfer).toHaveBeenCalledOnce();
	});

	it("refuses to transfer when the cost center resolves to the parent account", async () => {
		mockTB.getAccountId.mockReturnValueOnce(CHILD_ACCOUNT);

		await expect(
			reclaimBudget(asClient(mockTB), { parentUserId: PARENT, costCenter: COST_CENTER }),
		).rejects.toThrow("budget: cost center resolves to the parent account");
		expect(mockTB.immediateTransfer).not.toHaveBeenCalled();
	});

	it("rejects an invalid cost-center name before any ledger I/O", async () => {
		await expect(
			reclaimBudget(asClient(mockTB), { parentUserId: PARENT, costCenter: "a::b" }),
		).rejects.toThrow(/costCenter/);
		expect(mockTB.lookupBalance).not.toHaveBeenCalled();
	});
});

describe("getBudgetStatus", () => {
	let mockTB: MockTB;

	beforeEach(() => {
		vi.clearAllMocks();
		mockTB = createMockTBClient();
	});

	it("returns the balance and a runway consistent with computeRunway", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 750, pending: 0, total: 750 });

		const status = await getBudgetStatus(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			allocated: 1000,
			periodStartMs: T0,
			nowMs: T0 + 5 * HOUR,
		});

		expect(status.costCenterUserId).toBe(CHILD);
		expect(status.balance).toBe(750);
		expect(status.runway).toEqual(
			computeRunway({
				allocated: 1000,
				spent: 250,
				periodStartMs: T0,
				nowMs: T0 + 5 * HOUR,
			}),
		);
	});

	it("derives spent as allocated minus balance", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 400, pending: 0, total: 400 });

		const status = await getBudgetStatus(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			allocated: 1000,
			periodStartMs: T0,
			nowMs: T0 + HOUR,
		});

		expect(status.runway.remaining).toBe(400);
		expect(status.runway.burnRatePerHour).toBe(600);
	});

	// D4: an over-funded child (funded outside allocateBudget) must not report
	// negative spend, which would invert the burn rate.
	it("clamps spent to zero when the child holds more than it was allocated", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 1500, pending: 0, total: 1500 });

		const status = await getBudgetStatus(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			allocated: 1000,
			periodStartMs: T0,
			nowMs: T0 + HOUR,
		});

		expect(status.balance).toBe(1500);
		expect(status.runway.burnRatePerHour).toBe(0);
		expect(status.runway.remaining).toBe(1000);
		expect(status.runway.fractionRemaining).toBe(1);
	});

	// D11: never-allocated is an implicit zero, not a throw.
	it("returns a zero balance for a cost center that was never allocated", async () => {
		mockTB.lookupAccounts.mockResolvedValueOnce([]);

		const status = await getBudgetStatus(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: "never-used",
			allocated: 1000,
			periodStartMs: T0,
			nowMs: T0 + HOUR,
		});

		expect(status.balance).toBe(0);
		expect(status.runway.remaining).toBe(0);
		expect(status.runway.fractionRemaining).toBe(0);
		expect(mockTB.lookupBalance).not.toHaveBeenCalled();
	});

	it("passes the period end through so onPace is computed", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 990, pending: 0, total: 990 });

		const status = await getBudgetStatus(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			allocated: 1000,
			periodStartMs: T0,
			periodEndMs: T0 + 24 * HOUR,
			nowMs: T0 + HOUR,
		});

		expect(status.runway.onPace).toBe(true);
	});

	it("reads the wall clock at this call site when nowMs is omitted", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 500, pending: 0, total: 500 });
		vi.spyOn(Date, "now").mockReturnValue(T0 + 2 * HOUR);

		const status = await getBudgetStatus(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			allocated: 1000,
			periodStartMs: T0,
		});

		expect(status.runway.burnRatePerHour).toBe(250);
		vi.restoreAllMocks();
	});

	it("does not require the parent to be in the client account map", async () => {
		mockTB.getAccountId.mockImplementationOnce(() => {
			throw new Error("No TigerBeetle account for user: user_1");
		});
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 750, pending: 0, total: 750 });

		const status = await getBudgetStatus(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			allocated: 1000,
			periodStartMs: T0,
			nowMs: T0 + HOUR,
		});

		expect(status.balance).toBe(750);
	});

	it("rejects an invalid cost-center name before any ledger I/O", async () => {
		await expect(
			getBudgetStatus(asClient(mockTB), {
				parentUserId: PARENT,
				costCenter: "bad/name",
				allocated: 1000,
				periodStartMs: T0,
			}),
		).rejects.toThrow(/costCenter/);
		expect(mockTB.lookupAccounts).not.toHaveBeenCalled();
	});
});
