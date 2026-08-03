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
/** The display/audit label. No account id is derived from it any more. */
const CHILD = `${PARENT}::${COST_CENTER}`;
/**
 * The PARENT account is derived with the same static the implementation uses: this
 * suite polices the wiring, not the wallet hash. The CHILD account is spelled out
 * instead — it is the id this change moves, and a fixture recomputed from the
 * implementation would follow a regression in the derivation rather than catch it.
 * Same spec as the KAT suite in `tests/ledger/client.test.ts`
 * (sha256("usertrust:cost-center:v1" ‖ u32be(|p|) ‖ p ‖ u32be(|c|) ‖ c), first 16
 * bytes), computed outside src.
 */
const PARENT_ACCOUNT = TrustTBClient.deriveAccountId(PARENT);
const CHILD_ACCOUNT = 121007886255115536666701565033995618887n;

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;

/**
 * Create a mock TrustTBClient with vi.fn() methods.
 *
 * `getAccountId` THROWS, exactly as a real client does in a process that never
 * called `createUserWallet` — its `accountMap` is per-process and nothing in src
 * populates it for a parent id. A fake that answered the lookup would let this
 * whole suite pass while every allocate and reclaim rejected before any ledger
 * I/O in production. Both accounts must be derived; nothing here may be looked up.
 */
function createMockTBClient() {
	return {
		getAccountId: vi.fn((userId: string): bigint => {
			throw new Error(`No TigerBeetle account for user: ${userId}`);
		}),
		getTreasuryId: vi.fn(() => 1n),
		lookupBalance: vi.fn(),
		createPendingTransfer: vi.fn(),
		postTransfer: vi.fn(),
		voidTransfer: vi.fn(),
		immediateTransfer: vi.fn(),
		lookupTransfer: vi.fn(),
		// Non-empty by default: the cost-center wallet exists.
		lookupAccounts: vi.fn(async () => [{}]),
		createCostCenterWallet: vi.fn(async () => CHILD_ACCOUNT),
		// Retained on the mock surface only so the suite can prove the money path never
		// reaches it: the wallet-namespace door is not part of allocation any more.
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

/**
 * Run `fn` with console.warn silenced, returning what it printed alongside the result.
 *
 * The calls are copied out before `mockRestore` runs, which clears them.
 */
async function captureWarnings<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; warnings: unknown[][] }> {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	try {
		const result = await fn();
		return { result, warnings: warn.mock.calls.map((call) => [...call] as unknown[]) };
	} finally {
		warn.mockRestore();
	}
}

describe("cost-center account identity", () => {
	// The whole point of the change: the account a cost center's money lives in is the
	// tuple hash, and the `parent::costCenter` label is no longer a preimage of ANY
	// account. Both alternatives are spelled out so this proof cannot follow a change
	// in either derivation.
	it("is the tuple hash, never the label's wallet account", () => {
		expect(CHILD_ACCOUNT).toBe(TrustTBClient.deriveCostCenterAccountId(PARENT, COST_CENTER));
		// sha256("wallet:user_1::research"), first 128 bits — the account the retired
		// joined-string derivation funded, and the one an ordinary wallet named
		// `user_1::research` still lands on.
		expect(CHILD_ACCOUNT).not.toBe(195432381428127027762980276717845140591n);
		expect(CHILD_ACCOUNT).not.toBe(TrustTBClient.deriveAccountId(CHILD));
		expect(CHILD_ACCOUNT).not.toBe(PARENT_ACCOUNT);
	});
});

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

	// Both sides asserted together on purpose. The COST CENTER may carry no colon at
	// all: it is the label's maximal colon-free suffix, which is the only thing that
	// keeps `parent::costCenter` readable back into its two parts. The PARENT may not
	// carry `::` either, for an unrelated reason — `deriveAccountId("user::sub")` is
	// where an unreclaimed pre-v3 cost center sits on an upgraded cluster, so
	// allocating from that parent debits stranded legacy money as if it were his.
	it("rejects an embedded `::` in either part", () => {
		expect(() => costCenterUserId(PARENT, "a::b")).toThrow(/costCenter/);
		expect(() => costCenterUserId("user::sub", COST_CENTER)).toThrow(
			/parentUserId must not contain "::" \(reserved for pre-v3 cost-center accounts\)/,
		);
	});

	// The quarantine message must be distinguishable from the charset message: `::`
	// SATISFIES PARENT_USER_ID_PATTERN, so an operator shown that regex would read it
	// as admitting the id that was just refused.
	it("names the `::` quarantine distinctly from the charset refusal", () => {
		expect(() => costCenterUserId("user::sub", COST_CENTER)).toThrow(
			/parentUserId must not contain/,
		);
		expect(() => costCenterUserId("\u001b[31muser", COST_CENTER)).toThrow(
			/parentUserId must match/,
		);
	});

	// Single `:` is exactly what issue #64 asked for and the quarantine leaves it
	// alone — only the doubled separator names a legacy account.
	it("rejects a bare colon in the cost center but allows it in the parent", () => {
		expect(() => costCenterUserId(PARENT, "a:b")).toThrow(/costCenter/);
		expect(costCenterUserId("user:1", COST_CENTER)).toBe(`user:1::${COST_CENTER}`);
		expect(costCenterUserId("acme:eu:prod", COST_CENTER)).toBe(`acme:eu:prod::${COST_CENTER}`);
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

		// The TUPLE reaches the ledger door, never the joined label: creation and
		// resolveAccounts must hash the same two strings through the same static, or the
		// cross-check below would fire on every allocation. `createUserWallet` — the
		// wallet-namespace door — has no part in the money path any more.
		expect(mockTB.createCostCenterWallet).toHaveBeenCalledWith(PARENT, COST_CENTER);
		expect(mockTB.createUserWallet).not.toHaveBeenCalled();
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

		const created = mockTB.createCostCenterWallet.mock.invocationCallOrder[0] as number;
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
		expect(mockTB.createCostCenterWallet).not.toHaveBeenCalled();
		expect(mockTB.immediateTransfer).not.toHaveBeenCalled();
	});

	it("rejects an invalid cost-center name before any ledger I/O", async () => {
		for (const costCenter of ["a::b", "research/sub", "", "c".repeat(65)]) {
			await expect(
				allocateBudget(asClient(mockTB), { parentUserId: PARENT, costCenter, amount: 500 }),
			).rejects.toThrow(/costCenter/);
		}
		expect(mockTB.createCostCenterWallet).not.toHaveBeenCalled();
		expect(mockTB.immediateTransfer).not.toHaveBeenCalled();
	});

	it("rejects an invalid parent id before any ledger I/O", async () => {
		for (const parentUserId of ["acct 42", "acct\n42", "", "p".repeat(129)]) {
			await expect(
				allocateBudget(asClient(mockTB), { parentUserId, costCenter: COST_CENTER, amount: 500 }),
			).rejects.toThrow(/parentUserId/);
		}
		expect(mockTB.createCostCenterWallet).not.toHaveBeenCalled();
		expect(mockTB.immediateTransfer).not.toHaveBeenCalled();
	});

	// The quarantine has to hold on the MONEY path, not just in `costCenterUserId`'s
	// unit tests: `resolveAccounts` derives the parent account with
	// `deriveAccountId(parentUserId)`, so a `::` parent on an upgraded cluster would
	// debit an unreclaimed pre-v3 cost-center account and report it as the parent's
	// allocation.
	it("rejects a `::`-bearing parent before any ledger I/O", async () => {
		await expect(
			allocateBudget(asClient(mockTB), {
				parentUserId: "acme::billing",
				costCenter: COST_CENTER,
				amount: 500,
			}),
		).rejects.toThrow(/parentUserId must not contain "::"/);
		expect(mockTB.createCostCenterWallet).not.toHaveBeenCalled();
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

	// D10: `createCostCenterWallet` absorbs CreateAccountStatus.exists internally and
	// resolves with the existing id, so an already-created wallet is observationally
	// identical to a fresh one. There is no rejection to catch here.
	it("proceeds normally when the cost-center wallet already exists", async () => {
		mockTB.createCostCenterWallet.mockResolvedValueOnce(CHILD_ACCOUNT);
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
		mockTB.createCostCenterWallet.mockRejectedValueOnce(
			new Error("Failed to create cost-center wallet: exists_with_different_flags"),
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
	// and credit the same account — a no-op that reports as a funded allocation. The
	// two ids are now hashed in DISJOINT domains, so the guard is unreachable short of
	// a 128-bit truncated-hash collision; the spy targets the cost-center static
	// because that is the only one of the two whose output the guard compares.
	it("refuses to transfer when the cost center resolves to the parent account", async () => {
		const derive = vi
			.spyOn(TrustTBClient, "deriveCostCenterAccountId")
			.mockReturnValue(PARENT_ACCOUNT);
		try {
			await expect(
				allocateBudget(asClient(mockTB), {
					parentUserId: PARENT,
					costCenter: COST_CENTER,
					amount: 500,
				}),
			).rejects.toThrow("budget: cost center resolves to the parent account");
		} finally {
			derive.mockRestore();
		}
		expect(mockTB.immediateTransfer).not.toHaveBeenCalled();
		expect(mockTB.createCostCenterWallet).not.toHaveBeenCalled();
	});

	it("refuses to transfer when the created wallet id differs from the derived id", async () => {
		// A creation path that answers with anything but the tuple id — poisoned, or
		// simply hashing a different preimage than resolveAccounts does — would make
		// allocate fund an account that reclaim and status never read.
		mockTB.createCostCenterWallet.mockResolvedValueOnce(999n);

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

		const { result } = await captureWarnings(() =>
			allocateBudget(asClient(mockTB), {
				parentUserId: PARENT,
				costCenter: COST_CENTER,
				amount: 500,
				auditWriter: audit,
			}),
		);

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

	// A2: `BudgetAuditWriter` is public, so the thrown value is consumer code's.
	// Discarding it leaves a committed grant whose lost event names neither the
	// cost center nor the amount nor a reason.
	it("warns with the event kind, cost center and amount when the audit append throws", async () => {
		mockTB.immediateTransfer.mockResolvedValueOnce(42n);
		const audit = createMockAuditWriter();
		audit.appendEvent.mockRejectedValueOnce(new Error("audit disk full"));

		const { result, warnings } = await captureWarnings(() =>
			allocateBudget(asClient(mockTB), {
				parentUserId: PARENT,
				costCenter: COST_CENTER,
				amount: 500,
				auditWriter: audit,
			}),
		);

		expect(warnings).toHaveLength(1);
		expect(String(warnings[0]?.[0])).toContain("audit event was not written");
		expect(warnings[0]?.[1]).toEqual({
			kind: "budget_allocated",
			costCenterUserId: CHILD,
			amount: 500,
			error: "audit disk full",
		});
		expect(result.auditFailureReason).toBe("audit disk full");
	});

	it("carries a non-Error audit rejection through as its string form", async () => {
		mockTB.immediateTransfer.mockResolvedValueOnce(42n);
		const audit = createMockAuditWriter();
		audit.appendEvent.mockRejectedValueOnce("writer exploded");

		const { result } = await captureWarnings(() =>
			allocateBudget(asClient(mockTB), {
				parentUserId: PARENT,
				costCenter: COST_CENTER,
				amount: 500,
				auditWriter: audit,
			}),
		);

		expect(result.auditFailed).toBe(true);
		expect(result.auditFailureReason).toBe("writer exploded");
	});

	it("leaves auditFailureReason unset and warns nothing on a successful append", async () => {
		mockTB.immediateTransfer.mockResolvedValueOnce(42n);
		const audit = createMockAuditWriter();

		const { result, warnings } = await captureWarnings(() =>
			allocateBudget(asClient(mockTB), {
				parentUserId: PARENT,
				costCenter: COST_CENTER,
				amount: 500,
				auditWriter: audit,
			}),
		);

		expect(result.auditFailureReason).toBeUndefined();
		expect(warnings).toHaveLength(0);
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

		const { result } = await captureWarnings(() =>
			reclaimBudget(asClient(mockTB), {
				parentUserId: PARENT,
				costCenter: COST_CENTER,
				auditWriter: audit,
			}),
		);

		expect(result.reclaimed).toBe(320);
		expect(result.transferId).toBe("77");
		expect(result.audited).toBe(false);
		expect(result.auditFailed).toBe(true);
		expect(mockTB.immediateTransfer).toHaveBeenCalledOnce();
	});

	// A2: the reclaim direction must report the same way — the amount warned is the
	// amount that actually moved, not a caller-supplied figure.
	it("warns with the event kind, cost center and amount when the audit append throws", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 320, pending: 0, total: 320 });
		mockTB.immediateTransfer.mockResolvedValueOnce(77n);
		const audit = createMockAuditWriter();
		audit.appendEvent.mockRejectedValueOnce(new Error("chain sealed"));

		const { result, warnings } = await captureWarnings(() =>
			reclaimBudget(asClient(mockTB), {
				parentUserId: PARENT,
				costCenter: COST_CENTER,
				auditWriter: audit,
			}),
		);

		expect(warnings).toHaveLength(1);
		expect(String(warnings[0]?.[0])).toContain("audit event was not written");
		expect(warnings[0]?.[1]).toEqual({
			kind: "budget_reclaimed",
			costCenterUserId: CHILD,
			amount: 320,
			error: "chain sealed",
		});
		expect(result.auditFailureReason).toBe("chain sealed");
	});

	it("refuses to transfer when the cost center resolves to the parent account", async () => {
		const derive = vi
			.spyOn(TrustTBClient, "deriveCostCenterAccountId")
			.mockReturnValue(PARENT_ACCOUNT);
		try {
			await expect(
				reclaimBudget(asClient(mockTB), { parentUserId: PARENT, costCenter: COST_CENTER }),
			).rejects.toThrow("budget: cost center resolves to the parent account");
		} finally {
			derive.mockRestore();
		}
		expect(mockTB.immediateTransfer).not.toHaveBeenCalled();
	});

	it("rejects an invalid cost-center name before any ledger I/O", async () => {
		await expect(
			reclaimBudget(asClient(mockTB), { parentUserId: PARENT, costCenter: "a::b" }),
		).rejects.toThrow(/costCenter/);
		expect(mockTB.lookupBalance).not.toHaveBeenCalled();
	});

	// Reclaim CREDITS the parent account, so a `::` parent is the mirror-image
	// hazard of allocation's: on an upgraded cluster it would sweep a cost center's
	// balance into an unreclaimed pre-v3 account instead of the operator's wallet.
	it("rejects a `::`-bearing parent before any ledger I/O", async () => {
		await expect(
			reclaimBudget(asClient(mockTB), { parentUserId: "acme::billing", costCenter: COST_CENTER }),
		).rejects.toThrow(/parentUserId must not contain "::"/);
		expect(mockTB.lookupBalance).not.toHaveBeenCalled();
		expect(mockTB.immediateTransfer).not.toHaveBeenCalled();
	});
});

// A1: the whole money path is dead in a fresh process if either account is looked
// up. `accountMap` is per-process and nothing in src populates it for a parent id,
// so a lookup rejects with "No TigerBeetle account for user" BEFORE any transfer —
// a wallet that exists in TigerBeetle is unreachable. Both ids must be derived.
describe("fresh client with an empty accountMap", () => {
	let mockTB: MockTB;

	beforeEach(() => {
		vi.clearAllMocks();
		mockTB = createMockTBClient();
	});

	it("allocates without consulting the client account map", async () => {
		mockTB.createCostCenterWallet.mockResolvedValueOnce(
			TrustTBClient.deriveCostCenterAccountId("local", "research"),
		);
		mockTB.immediateTransfer.mockResolvedValueOnce(42n);

		const result = await allocateBudget(asClient(mockTB), {
			parentUserId: "local",
			costCenter: "research",
			amount: 500,
		});

		expect(result.allocated).toBe(500);
		expect(mockTB.getAccountId).not.toHaveBeenCalled();
		expect(mockTB.immediateTransfer).toHaveBeenCalledWith({
			debitAccountId: TrustTBClient.deriveAccountId("local"),
			creditAccountId: TrustTBClient.deriveCostCenterAccountId("local", "research"),
			amount: 500,
			code: XFER_BUDGET_GRANT,
		});
	});

	it("reclaims without consulting the client account map", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 320, pending: 0, total: 320 });
		mockTB.immediateTransfer.mockResolvedValueOnce(77n);

		const result = await reclaimBudget(asClient(mockTB), {
			parentUserId: "local",
			costCenter: "research",
		});

		expect(result.reclaimed).toBe(320);
		expect(mockTB.getAccountId).not.toHaveBeenCalled();
		expect(mockTB.immediateTransfer).toHaveBeenCalledWith({
			debitAccountId: TrustTBClient.deriveCostCenterAccountId("local", "research"),
			creditAccountId: TrustTBClient.deriveAccountId("local"),
			amount: 320,
			code: XFER_BUDGET_RECLAIM,
		});
	});

	// The parent account is credited at the id its wallet was CREATED as — the same
	// pure hash `createUserWallet` derives from. A parent that truly has no wallet
	// then fails inside TigerBeetle at commit, not before any I/O.
	it("credits the parent at the id createUserWallet would have derived", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 320, pending: 0, total: 320 });
		mockTB.immediateTransfer.mockResolvedValueOnce(77n);

		await reclaimBudget(asClient(mockTB), { parentUserId: PARENT, costCenter: COST_CENTER });

		const call = mockTB.immediateTransfer.mock.calls[0]?.[0] as { creditAccountId: bigint };
		expect(call.creditAccountId).toBe(PARENT_ACCOUNT);
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

	// This path derives the child account itself instead of going through
	// resolveAccounts, which is exactly how it can drift: were it still hashing the
	// `parent::costCenter` label it would read a DIFFERENT account than allocateBudget
	// funds, and every status would report a zero balance against a funded cost center
	// — a governance read that fails open, silently.
	it("reads the same tuple-derived account allocateBudget funds", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 750, pending: 0, total: 750 });

		await getBudgetStatus(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			allocated: 1000,
			periodStartMs: T0,
			nowMs: T0 + HOUR,
		});

		expect(mockTB.lookupAccounts).toHaveBeenCalledWith([CHILD_ACCOUNT]);
		expect(mockTB.lookupBalance).toHaveBeenCalledWith(CHILD_ACCOUNT);
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
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 750, pending: 0, total: 750 });

		const status = await getBudgetStatus(asClient(mockTB), {
			parentUserId: PARENT,
			costCenter: COST_CENTER,
			allocated: 1000,
			periodStartMs: T0,
			nowMs: T0 + HOUR,
		});

		expect(status.balance).toBe(750);
		expect(mockTB.getAccountId).not.toHaveBeenCalled();
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

/**
 * Issue #64: a namespaced tenant id (`acct:123`) is legal for a parent now. The whole
 * money path is exercised, not just the charset, because a parent id is only as legal
 * as the narrowest door it passes through — and because the three entry points derive
 * the child account at three different places, any one of which could still be hashing
 * a joined string.
 */
describe("colon-bearing parent id end-to-end", () => {
	const NS_PARENT = "acct:123";
	const NS_COST_CENTER = "ops";
	const NS_CHILD = `${NS_PARENT}::${NS_COST_CENTER}`;
	const NS_PARENT_ACCOUNT = TrustTBClient.deriveAccountId(NS_PARENT);
	/** Spelled out to the same spec as the other fixtures, computed outside src. */
	const NS_CHILD_ACCOUNT = 160742871849986625332418382313225136092n;

	let mockTB: MockTB;

	beforeEach(() => {
		vi.clearAllMocks();
		mockTB = createMockTBClient();
		mockTB.createCostCenterWallet.mockResolvedValue(NS_CHILD_ACCOUNT);
	});

	it("keeps the account out of reach of any wallet id, and of neighbouring pairs", () => {
		expect(TrustTBClient.deriveCostCenterAccountId(NS_PARENT, NS_COST_CENTER)).toBe(
			NS_CHILD_ACCOUNT,
		);
		// An integrator wallet literally named `acct:123::ops` hashes in the `wallet:`
		// namespace and lands nowhere near this account — the sweep the retired
		// joined-string derivation made possible.
		expect(NS_CHILD_ACCOUNT).not.toBe(TrustTBClient.deriveAccountId(NS_CHILD));
		// And it is the LENGTH PREFIXES, not the punctuation rules, that keep legal
		// pairs apart: all three of these concatenate to the same bytes, and a
		// prefix-free derivation would alias them onto one account.
		expect(TrustTBClient.deriveCostCenterAccountId("acct:12", "3ops")).not.toBe(NS_CHILD_ACCOUNT);
		expect(TrustTBClient.deriveCostCenterAccountId("acct", "123ops")).not.toBe(NS_CHILD_ACCOUNT);
	});

	it("allocates into the tuple account and labels the audit event with the parent", async () => {
		mockTB.immediateTransfer.mockResolvedValueOnce(42n);
		const audit = createMockAuditWriter();

		const result = await allocateBudget(asClient(mockTB), {
			parentUserId: NS_PARENT,
			costCenter: NS_COST_CENTER,
			amount: 500,
			auditWriter: audit,
		});

		expect(mockTB.createCostCenterWallet).toHaveBeenCalledWith(NS_PARENT, NS_COST_CENTER);
		expect(mockTB.immediateTransfer).toHaveBeenCalledWith({
			debitAccountId: NS_PARENT_ACCOUNT,
			creditAccountId: NS_CHILD_ACCOUNT,
			amount: 500,
			code: XFER_BUDGET_GRANT,
		});
		expect(result.costCenterUserId).toBe(NS_CHILD);
		expect(audit.appendEvent).toHaveBeenCalledWith({
			kind: "budget_allocated",
			actor: NS_PARENT,
			data: { costCenter: NS_COST_CENTER, amount: 500, costCenterUserId: NS_CHILD },
		});
	});

	it("reclaims out of the same account it allocated into", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 320, pending: 0, total: 320 });
		mockTB.immediateTransfer.mockResolvedValueOnce(77n);

		const result = await reclaimBudget(asClient(mockTB), {
			parentUserId: NS_PARENT,
			costCenter: NS_COST_CENTER,
		});

		expect(mockTB.immediateTransfer).toHaveBeenCalledWith({
			debitAccountId: NS_CHILD_ACCOUNT,
			creditAccountId: NS_PARENT_ACCOUNT,
			amount: 320,
			code: XFER_BUDGET_RECLAIM,
		});
		expect(result.reclaimed).toBe(320);
	});

	it("reads that same account back through getBudgetStatus", async () => {
		mockTB.lookupBalance.mockResolvedValueOnce({ available: 750, pending: 0, total: 750 });

		const status = await getBudgetStatus(asClient(mockTB), {
			parentUserId: NS_PARENT,
			costCenter: NS_COST_CENTER,
			allocated: 1000,
			periodStartMs: T0,
			nowMs: T0 + HOUR,
		});

		expect(mockTB.lookupAccounts).toHaveBeenCalledWith([NS_CHILD_ACCOUNT]);
		expect(status.costCenterUserId).toBe(NS_CHILD);
		expect(status.balance).toBe(750);
	});
});
