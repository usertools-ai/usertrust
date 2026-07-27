import { describe, expect, it, vi } from "vitest";

// A STATEFUL tigerbeetle-node fake that implements real double-entry balance
// math and enforces debits_must_not_exceed_credits — so an over-budget pending
// debit is genuinely rejected. This is a behavioral test against real ledger
// semantics, not a mock asserting a mock.
const DMNEC = 1 << 2; // debits_must_not_exceed_credits
const PENDING = 1;
const EXCEEDS_CREDITS = 22;

const { store, mockClient } = vi.hoisted(() => {
	interface Acct {
		flags: number;
		credits_posted: bigint;
		debits_posted: bigint;
		debits_pending: bigint;
	}
	const store = new Map<bigint, Acct>();
	const mockClient = {
		createAccounts: vi.fn(async (accts: { id: bigint; flags: number }[]) => {
			for (const a of accts) {
				if (store.has(a.id)) return [{ status: 1 /* exists */ }];
				store.set(a.id, {
					flags: a.flags,
					credits_posted: 0n,
					debits_posted: 0n,
					debits_pending: 0n,
				});
			}
			return [];
		}),
		createTransfers: vi.fn(
			async (
				xs: {
					debit_account_id: bigint;
					credit_account_id: bigint;
					amount: bigint;
					flags: number;
				}[],
			) => {
				for (const t of xs) {
					const debit = store.get(t.debit_account_id);
					const credit = store.get(t.credit_account_id);
					if (!debit || !credit) return [{ status: 40 /* account not found */ }];
					if (t.flags & PENDING) {
						// Pending debit: enforce the flag on the debited account.
						if (
							(debit.flags & DMNEC) !== 0 &&
							debit.debits_pending + debit.debits_posted + t.amount > debit.credits_posted
						) {
							return [{ status: EXCEEDS_CREDITS }];
						}
						debit.debits_pending += t.amount;
					} else {
						// Immediate transfer (mint/allocation): no balance constraint here
						// (treasury is history-only, unconstrained).
						debit.debits_posted += t.amount;
						credit.credits_posted += t.amount;
					}
				}
				return [];
			},
		),
		lookupAccounts: vi.fn(async (ids: bigint[]) =>
			ids
				.map((id) => {
					const a = store.get(id);
					return a
						? {
								id,
								credits_posted: a.credits_posted,
								debits_posted: a.debits_posted,
								debits_pending: a.debits_pending,
								credits_pending: 0n,
							}
						: undefined;
				})
				.filter(Boolean),
		),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	};
	return { store, mockClient };
});

vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => mockClient),
	AccountFlags: { debits_must_not_exceed_credits: 1 << 2, history: 1 << 5 },
	TransferFlags: { pending: 1, post_pending_transfer: 2, void_pending_transfer: 4 },
	CreateAccountStatus: { created: 4294967295, exists: 1 },
	CreateTransferStatus: {
		created: 4294967295,
		exceeds_credits: 22,
		overflows_debits: 30,
		overflows_debits_pending: 31,
	},
	amount_max: (1n << 128n) - 1n,
}));

import { TBTransferError, TrustTBClient, XFER_SPEND } from "../../src/ledger/client.js";

describe("createFundedBudgetWallet — real, funded, balance-enforcing budget wallet", () => {
	it("creates a debits_must_not_exceed_credits wallet funded with the seed, and rejects over-budget holds", async () => {
		store.clear();
		const client = new TrustTBClient({ addresses: ["3000"] });
		await client.createTreasury();
		const treasury = client.getTreasuryId();

		const walletId = await client.createFundedBudgetWallet(100);

		// The wallet is balance-enforcing and actually funded with the seed.
		const acct = store.get(walletId);
		expect(acct).toBeDefined();
		expect(acct && (acct.flags & DMNEC) !== 0).toBe(true);
		expect(acct?.credits_posted).toBe(100n);

		// A hold within budget succeeds…
		await expect(
			client.createPendingTransfer({
				debitAccountId: walletId,
				creditAccountId: treasury,
				amount: 60,
				code: XFER_SPEND,
			}),
		).resolves.toBeDefined();

		// …and a further hold that would exceed the funded budget is atomically rejected.
		const err = await client
			.createPendingTransfer({
				debitAccountId: walletId,
				creditAccountId: treasury,
				amount: 60,
				code: XFER_SPEND,
			})
			.catch((e) => e);
		expect(err).toBeInstanceOf(TBTransferError);
		expect((err as TBTransferError).code).toBe(EXCEEDS_CREDITS);

		client.destroy();
	});

	it("uses a FRESH account id per call so re-init never double-funds a shared wallet", async () => {
		store.clear();
		const client = new TrustTBClient({ addresses: ["3000"] });
		await client.createTreasury();

		const id1 = await client.createFundedBudgetWallet(100);
		const id2 = await client.createFundedBudgetWallet(100);

		// Distinct accounts, each funded with exactly its own seed (no accumulation).
		expect(id1).not.toBe(id2);
		expect(store.get(id1)?.credits_posted).toBe(100n);
		expect(store.get(id2)?.credits_posted).toBe(100n);

		client.destroy();
	});
});
