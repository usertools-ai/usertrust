// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The `createTBEngine` seam, driven against a stateful TigerBeetle fake that does
 * real double-entry math and enforces `debits_must_not_exceed_credits`.
 *
 * What it pins:
 *  - the debit account defaults to the session holding wallet (unattributed
 *    behaviour, unchanged from pre-envelope);
 *  - an explicit `debitAccountId` debits THAT account and leaves the session
 *    wallet untouched, through hold, settle AND void;
 *  - D5: on an ATTRIBUTED hold, TigerBeetle's `debit_account_not_found` means a
 *    never-allocated envelope (≡ zero balance), so it surfaces as an
 *    InsufficientBalanceError naming the envelope — not as a ledger outage;
 *  - an ATTRIBUTED hold rejected by the envelope's own
 *    `debits_must_not_exceed_credits` names THAT envelope and its real balance,
 *    never the session holding wallet and its seed;
 *  - on an UNATTRIBUTED hold both statuses keep today's classification exactly
 *    (raw TBTransferError → the governor's LedgerUnavailableError for a missing
 *    account; `trust:hold` + the session seed for an over-budget one), down to
 *    adding no ledger round trip — the session wallet is one this factory just
 *    created, so its absence really is an outage and its seed is already known.
 *
 * The factory is duplicated between `govern.ts` and `headless.ts` and must change
 * in lockstep (AGENTS.md, Known drift). Only `govern.ts`'s copy is reachable by
 * name — `headless.ts` is a package entry point, so exporting its copy would put
 * an engine factory in the published API for the sake of a test. The two copies
 * are held identical by the source-parity suite in
 * `tests/harden/engine-factory-parity.test.ts`, and the headless copy is driven
 * end-to-end through `createGovernor().authorize()` at the bottom of this file.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountFlags, CreateTransferStatus } from "tigerbeetle-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppendEventInput, AuditWriter } from "../../src/audit/chain.js";
import type { AuditEvent } from "../../src/shared/types.js";

const DMNEC = AccountFlags.debits_must_not_exceed_credits;
const DEBIT_ACCOUNT_NOT_FOUND = CreateTransferStatus.debit_account_not_found;

const { store, created, pendings, holds, mockClient, tb } = vi.hoisted(() => {
	interface Acct {
		flags: number;
		credits_posted: bigint;
		debits_posted: bigint;
		debits_pending: bigint;
	}
	interface Pend {
		debit: bigint;
		credit: bigint;
		amount: bigint;
	}
	/**
	 * The INSTALLED tigerbeetle-node enums, filled in by the module mock below —
	 * a `vi.hoisted` block cannot await the import itself, and the fake's handlers
	 * only read these at call time, long after the mock factory has run.
	 *
	 * Hand-copied constants are what let the previous fake answer 22 for
	 * `exceeds_credits`, the code the real database uses for
	 * `credit_account_not_found`. Production branches on specific numbers
	 * (`isTBInsufficientBalance`, `isTBDebitAccountNotFound`), so a mis-copied
	 * status makes the seam agree with itself and disagree with TigerBeetle.
	 */
	const tb = {} as {
		AccountFlags: typeof AccountFlags;
		TransferFlags: typeof import("tigerbeetle-node").TransferFlags;
		CreateAccountStatus: typeof import("tigerbeetle-node").CreateAccountStatus;
		CreateTransferStatus: typeof CreateTransferStatus;
		amount_max: bigint;
	};

	const store = new Map<bigint, Acct>();
	/** Account ids in creation order: [treasury, holding wallet, …]. */
	const created: bigint[] = [];
	/** Live pending transfers by id, so post/void can resolve their accounts. */
	const pendings = new Map<bigint, Pend>();
	/** Every accepted PENDING transfer, in order — the debit-account assertions. */
	const holds: Pend[] = [];

	const mockClient = {
		createAccounts: vi.fn(async (accts: { id: bigint; flags: number }[]) => {
			for (const a of accts) {
				if (store.has(a.id)) return [{ status: tb.CreateAccountStatus.exists }];
				store.set(a.id, {
					flags: a.flags,
					credits_posted: 0n,
					debits_posted: 0n,
					debits_pending: 0n,
				});
				created.push(a.id);
			}
			return [];
		}),
		createTransfers: vi.fn(
			async (
				xs: {
					id: bigint;
					debit_account_id: bigint;
					credit_account_id: bigint;
					pending_id: bigint;
					amount: bigint;
					flags: number;
				}[],
			) => {
				const S = tb.CreateTransferStatus;
				const {
					pending: PENDING_FLAG,
					post_pending_transfer: POST_FLAG,
					void_pending_transfer: VOID_FLAG,
				} = tb.TransferFlags;
				const DMNEC_FLAG = tb.AccountFlags.debits_must_not_exceed_credits;
				for (const t of xs) {
					// Post/void resolve their accounts from the original pending transfer
					// (the client sends 0n for both account ids on those).
					if (t.flags & (POST_FLAG | VOID_FLAG)) {
						const orig = pendings.get(t.pending_id);
						if (!orig) return [{ status: S.pending_transfer_not_found }];
						const debit = store.get(orig.debit);
						const credit = store.get(orig.credit);
						if (!debit || !credit) return [{ status: S.debit_account_not_found }];
						// `amount_max` is TigerBeetle's "post the whole pending amount"
						// sentinel, and is what the client sends when no actual amount is
						// given. Everything else is a literal request.
						const requested = t.amount === tb.amount_max ? orig.amount : t.amount;
						// Real TigerBeetle REJECTS a post above the pending amount — it does
						// not cap. (The previous fake capped, modelling semantics the
						// database does not have.) The rejection lands BEFORE the pending
						// debit is released, so a rejected post leaves the hold untouched.
						if ((t.flags & POST_FLAG) !== 0 && requested > orig.amount) {
							return [{ status: S.exceeds_pending_transfer_amount }];
						}
						debit.debits_pending -= orig.amount;
						if (t.flags & POST_FLAG) {
							debit.debits_posted += requested;
							credit.credits_posted += requested;
						}
						pendings.delete(t.pending_id);
						continue;
					}
					const debit = store.get(t.debit_account_id);
					const credit = store.get(t.credit_account_id);
					if (!debit) return [{ status: S.debit_account_not_found }];
					if (!credit) return [{ status: S.credit_account_not_found }];
					if (t.flags & PENDING_FLAG) {
						if (
							(debit.flags & DMNEC_FLAG) !== 0 &&
							debit.debits_pending + debit.debits_posted + t.amount > debit.credits_posted
						) {
							return [{ status: S.exceeds_credits }];
						}
						debit.debits_pending += t.amount;
						const rec = {
							debit: t.debit_account_id,
							credit: t.credit_account_id,
							amount: t.amount,
						};
						pendings.set(t.id, rec);
						holds.push(rec);
					} else {
						// Immediate transfer (treasury mint → wallet): the treasury carries no
						// balance constraint.
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
	return { store, created, pendings, holds, mockClient, tb };
});

// Only `createClient` is faked. Every enum and sentinel comes from the INSTALLED
// package, so the fake's status codes, account flags and transfer flags are the
// ones production compares against rather than a self-consistent fiction.
vi.mock("tigerbeetle-node", async (importOriginal) => {
	const actual = await importOriginal<typeof import("tigerbeetle-node")>();
	tb.AccountFlags = actual.AccountFlags;
	tb.TransferFlags = actual.TransferFlags;
	tb.CreateAccountStatus = actual.CreateAccountStatus;
	tb.CreateTransferStatus = actual.CreateTransferStatus;
	tb.amount_max = actual.amount_max;
	return { ...actual, createClient: vi.fn(() => mockClient) };
});

import { withCostCenter } from "../../src/budget/attribution.js";
import { createTBEngine, trust } from "../../src/govern.js";
import { createGovernor } from "../../src/headless.js";
import { TBTransferError, TrustTBClient } from "../../src/ledger/client.js";
import { InsufficientBalanceError, PolicyDeniedError } from "../../src/shared/errors.js";
import { TrustConfigSchema, type TrustReceipt } from "../../src/shared/types.js";

const CONFIG = TrustConfigSchema.parse({ budget: 100_000 });

function reset(): void {
	store.clear();
	created.length = 0;
	pendings.clear();
	holds.length = 0;
}

/** The session holding wallet: created right after the treasury. */
function holdingWallet(): bigint {
	const id = created[1];
	if (id === undefined) throw new Error("holding wallet was never created");
	return id;
}

describe("createTBEngine — caller-selected debit account", () => {
	it("defaults the debit to the funded session holding wallet", async () => {
		reset();
		const engine = await createTBEngine(CONFIG, 500);

		await engine.spendPending({ transferId: "call-1", amount: 40 });

		expect(holds).toHaveLength(1);
		expect(holds[0]?.debit).toBe(holdingWallet());
		expect(store.get(holdingWallet())?.debits_pending).toBe(40n);
		engine.destroy?.();
	});

	it("debits the caller-supplied account and leaves the session wallet untouched", async () => {
		reset();
		const engine = await createTBEngine(CONFIG, 500);
		const envelope = 777_000_111n;
		store.set(envelope, {
			flags: DMNEC,
			credits_posted: 200n,
			debits_posted: 0n,
			debits_pending: 0n,
		});

		await engine.spendPending({ transferId: "call-2", amount: 40, debitAccountId: envelope });

		expect(holds).toHaveLength(1);
		expect(holds[0]?.debit).toBe(envelope);
		expect(store.get(envelope)?.debits_pending).toBe(40n);
		// The seam must not double-reserve: the session wallet sees nothing.
		expect(store.get(holdingWallet())?.debits_pending).toBe(0n);
		engine.destroy?.();
	});

	it("settles an attributed hold against the same envelope account", async () => {
		reset();
		const engine = await createTBEngine(CONFIG, 500);
		const envelope = 777_000_222n;
		store.set(envelope, {
			flags: DMNEC,
			credits_posted: 200n,
			debits_posted: 0n,
			debits_pending: 0n,
		});

		await engine.spendPending({ transferId: "call-3", amount: 40, debitAccountId: envelope });
		await engine.postPendingSpend("call-3", 12);

		expect(store.get(envelope)?.debits_posted).toBe(12n);
		expect(store.get(envelope)?.debits_pending).toBe(0n);
		expect(store.get(holdingWallet())?.debits_posted).toBe(0n);
		engine.destroy?.();
	});

	it("voids an attributed hold against the same envelope account", async () => {
		reset();
		const engine = await createTBEngine(CONFIG, 500);
		const envelope = 777_000_333n;
		store.set(envelope, {
			flags: DMNEC,
			credits_posted: 200n,
			debits_posted: 0n,
			debits_pending: 0n,
		});

		await engine.spendPending({ transferId: "call-4", amount: 40, debitAccountId: envelope });
		await engine.voidPendingSpend("call-4");

		expect(store.get(envelope)?.debits_pending).toBe(0n);
		expect(store.get(envelope)?.debits_posted).toBe(0n);
		engine.destroy?.();
	});
});

describe("createTBEngine — rejection classification (D5)", () => {
	it("maps a missing ENVELOPE account to InsufficientBalanceError naming the envelope", async () => {
		reset();
		const engine = await createTBEngine(CONFIG, 500);
		const envelope = 909_090_909n;

		const err = await engine
			.spendPending({ transferId: "call-5", amount: 42, debitAccountId: envelope })
			.catch((e: unknown) => e);

		expect(err).toBeInstanceOf(InsufficientBalanceError);
		const balanceErr = err as InsufficientBalanceError;
		// Never-allocated ≡ zero balance: the envelope is named, and `available`
		// is the truthful 0 rather than the session wallet's seed.
		expect(balanceErr.userId).toBe(`envelope:${envelope}`);
		expect(balanceErr.required).toBe(42);
		expect(balanceErr.available).toBe(0);
		expect(balanceErr.message).toContain(`envelope:${envelope}`);
		engine.destroy?.();
	});

	it("keeps today's classification when the SESSION wallet is missing (unattributed)", async () => {
		reset();
		const engine = await createTBEngine(CONFIG, 500);
		// Simulate the outage this status really means for a session wallet the
		// factory itself just created.
		store.delete(holdingWallet());

		const err = await engine
			.spendPending({ transferId: "call-6", amount: 42 })
			.catch((e: unknown) => e);

		expect(err).toBeInstanceOf(TBTransferError);
		expect(err).not.toBeInstanceOf(InsufficientBalanceError);
		expect((err as TBTransferError).code).toBe(DEBIT_ACCOUNT_NOT_FOUND);
		engine.destroy?.();
	});

	it("keeps the over-budget mapping byte-identical on an unattributed hold", async () => {
		reset();
		const engine = await createTBEngine(CONFIG, 50);
		const readsBefore = mockClient.lookupAccounts.mock.calls.length;

		const err = await engine
			.spendPending({ transferId: "call-7", amount: 120 })
			.catch((e: unknown) => e);

		expect(err).toBeInstanceOf(InsufficientBalanceError);
		const balanceErr = err as InsufficientBalanceError;
		expect(balanceErr.userId).toBe("trust:hold");
		expect(balanceErr.required).toBe(120);
		expect(balanceErr.available).toBe(50);
		// Byte-identical includes the I/O: the session seed is a number this factory
		// already holds, so an unattributed rejection adds no ledger round trip.
		expect(mockClient.lookupAccounts.mock.calls.length).toBe(readsBefore);
		engine.destroy?.();
	});

	it("names the exhausted ENVELOPE and its real balance, not the session wallet", async () => {
		reset();
		const engine = await createTBEngine(CONFIG, 5_000);
		const envelope = 777_000_444n;
		store.set(envelope, {
			flags: DMNEC,
			credits_posted: 10n,
			debits_posted: 0n,
			debits_pending: 0n,
		});

		const err = await engine
			.spendPending({ transferId: "call-8", amount: 999, debitAccountId: envelope })
			.catch((e: unknown) => e);

		expect(err).toBeInstanceOf(InsufficientBalanceError);
		const balanceErr = err as InsufficientBalanceError;
		// The account that REJECTED is the account that gets named. Reporting
		// `trust:hold` + the 5000 session seed would name an account the hold never
		// touched and print `available` (5000) GREATER than `required` (999) — an
		// exhausted cost center rendered as an SDK bug, with nothing in the message
		// identifying which envelope to top up.
		expect(balanceErr.userId).toBe(`envelope:${envelope}`);
		expect(balanceErr.required).toBe(999);
		expect(balanceErr.available).toBe(10);
		expect(balanceErr.available).toBeLessThan(balanceErr.required);
		expect(balanceErr.message).toContain(`envelope:${envelope}`);
		expect(balanceErr.message).not.toContain("5000");
		// The read reports; it never decides. TigerBeetle's atomic rejection already
		// did that, and the hold reserved nothing.
		expect(store.get(envelope)?.debits_pending).toBe(0n);
		engine.destroy?.();
	});

	it("reports 0 rather than fabricating headroom when the reporting read fails", async () => {
		reset();
		const engine = await createTBEngine(CONFIG, 5_000);
		const envelope = 777_000_555n;
		store.set(envelope, {
			flags: DMNEC,
			credits_posted: 10n,
			debits_posted: 0n,
			debits_pending: 0n,
		});
		// The reporting read is the first lookup after the rejection.
		mockClient.lookupAccounts.mockImplementationOnce(async () => {
			throw new Error("tb: connection reset");
		});

		const err = await engine
			.spendPending({ transferId: "call-9", amount: 999, debitAccountId: envelope })
			.catch((e: unknown) => e);

		// A failed reporting read must not change the classification, and must not
		// invent an `available` the ledger never answered.
		expect(err).toBeInstanceOf(InsufficientBalanceError);
		const balanceErr = err as InsufficientBalanceError;
		expect(balanceErr.userId).toBe(`envelope:${envelope}`);
		expect(balanceErr.required).toBe(999);
		expect(balanceErr.available).toBe(0);
		expect(mockClient.lookupAccounts).toHaveBeenCalledWith([envelope]);
		engine.destroy?.();
	});
});

describe("createTBEngine — settle is capped at the reserved hold (D1)", () => {
	it("caps an above-hold settle at the reserved amount and reports the shortfall", async () => {
		reset();
		// Hold 78, actual 84. TigerBeetle REJECTS a post above the pending amount
		// (`exceeds_pending_transfer_amount`) rather than capping, so the factory has
		// to truncate before it asks — and hand the governor the 6-usertoken
		// shortfall to audit.
		const engine = await createTBEngine(CONFIG, 10_000);

		await engine.spendPending({ transferId: "t-over", amount: 78 });
		const result = await engine.postPendingSpend("t-over", 84);

		expect(result).toEqual({ posted: 78, shortfall: 6 });
		expect(store.get(holdingWallet())?.debits_posted).toBe(78n);
		expect(store.get(holdingWallet())?.debits_pending).toBe(0n);
		engine.destroy?.();
	});

	it("below-hold settle still posts the actual amount with zero shortfall", async () => {
		reset();
		const engine = await createTBEngine(CONFIG, 10_000);

		await engine.spendPending({ transferId: "t-under", amount: 78 });
		const result = await engine.postPendingSpend("t-under", 30);

		expect(result).toEqual({ posted: 30, shortfall: 0 });
		expect(store.get(holdingWallet())?.debits_posted).toBe(30n);
		expect(store.get(holdingWallet())?.debits_pending).toBe(0n);
		engine.destroy?.();
	});

	it("omitting the actual amount posts the whole hold, unchanged", async () => {
		reset();
		const engine = await createTBEngine(CONFIG, 10_000);

		await engine.spendPending({ transferId: "t-full", amount: 78 });
		const result = await engine.postPendingSpend("t-full");

		expect(result).toEqual({ posted: 78, shortfall: 0 });
		expect(store.get(holdingWallet())?.debits_posted).toBe(78n);
		expect(store.get(holdingWallet())?.debits_pending).toBe(0n);
		engine.destroy?.();
	});
});

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
 * `headless.ts` carries its own copy of the factory and is the engine
 * `createGovernor()` actually runs on. Its copy is not exported, so it is driven
 * here the way production drives it: a real governor over the same stateful fake,
 * authorizing one unattributed call. That pins the copy's default — the hold lands
 * on the funded session wallet — end to end; the parity suite covers the rest.
 */
describe("createGovernor — the headless copy of the factory", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = join(tmpdir(), `tb-engine-seam-${randomUUID()}`);
		mkdirSync(tmpVault, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("holds an unattributed call against the funded session wallet", async () => {
		reset();
		const governor = await createGovernor({
			budget: 100_000,
			vaultBase: tmpVault,
			_audit: makeMockAudit(),
		});

		const auth = await governor.authorize({
			model: "claude-sonnet-4-6",
			estimatedInputTokens: 100,
			maxOutputTokens: 50,
		});
		expect(holds).toHaveLength(1);
		expect(holds[0]?.debit).toBe(holdingWallet());

		await governor.settle(auth, { inputTokens: 100, outputTokens: 20 });
		expect(store.get(holdingWallet())?.debits_pending).toBe(0n);
		expect(store.get(holdingWallet())?.debits_posted).toBeGreaterThan(0n);

		await governor.destroy();
	});
});

// ── The envelope preflight, through the REAL factory ──
//
// MF1. The governor reads an envelope's balance through `TrustEngine.lookupBalances`,
// and the first cut of the threading implemented that method on TEST MOCKS ONLY. Every
// unit suite stayed green while production shipped attributed calls with no
// envelope-scoped policy numbers, no `budgetFractionRemaining`/`budgetRunwayHours`,
// and no `receipt.budget` — the visibility half of this feature dead on arrival, and
// the same mock-shadows-production shape AGENTS.md records for the budget API that
// once shipped fully exported with an unconstructable argument.
//
// So these two drive the preflight through `createTBEngine` itself — no `_engine`
// injection anywhere — against the stateful TigerBeetle fake above. A factory that
// stops delegating `lookupBalances` fails HERE, not silently in production.

describe("envelope preflight through the real createTBEngine (MF1)", () => {
	const PARENT = "acme";
	const COST_CENTER = "research";
	const ENVELOPE = TrustTBClient.deriveCostCenterAccountId(PARENT, COST_CENTER);
	const SCOPE_OPTS = { allocated: 10_000, periodStartMs: Date.UTC(2026, 7, 3, 0, 0, 0) };
	const PARAMS = {
		model: "claude-sonnet-4-6",
		max_tokens: 64,
		messages: [{ role: "user", content: "hello" }],
	};

	let tmpVault: string;

	beforeEach(() => {
		tmpVault = join(tmpdir(), `tb-engine-seam-${randomUUID()}`);
		mkdirSync(tmpVault, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	/** A funded envelope wallet, as `allocateBudget` would have left it. */
	function fundEnvelope(credits: bigint): void {
		store.set(ENVELOPE, {
			flags: DMNEC,
			credits_posted: credits,
			debits_posted: 0n,
			debits_pending: 0n,
		});
	}

	function anthropicMock() {
		return {
			messages: {
				create: vi.fn(async () => ({
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					model: "claude-sonnet-4-6",
					usage: { input_tokens: 10, output_tokens: 5 },
				})),
			},
		};
	}

	it("holds against the envelope and reports its post-settle balance on the receipt", async () => {
		reset();
		fundEnvelope(10_000n);
		const governed = await trust(anthropicMock(), {
			budget: 100_000,
			vaultBase: tmpVault,
			parentUserId: PARENT,
			_audit: makeMockAudit(),
		});

		const { receipt } = (await withCostCenter(
			COST_CENTER,
			() => governed.messages.create(PARAMS),
			SCOPE_OPTS,
		)) as { receipt: TrustReceipt };

		// The money went where the scope said it should.
		expect(holds).toHaveLength(1);
		expect(holds[0]?.debit).toBe(ENVELOPE);
		expect(store.get(holdingWallet())?.debits_pending).toBe(0n);
		expect(store.get(holdingWallet())?.debits_posted).toBe(0n);

		// And the receipt saw it, which is only possible if the factory delegated
		// lookupBalances to the real client.
		const env = store.get(ENVELOPE);
		if (env === undefined) throw new Error("the envelope account vanished");
		const remaining = Number(env.credits_posted - env.debits_posted - env.debits_pending);
		expect(env.debits_posted).toBeGreaterThan(0n);
		expect(receipt.budget).toEqual({
			costCenter: COST_CENTER,
			remaining,
			fraction: remaining / SCOPE_OPTS.allocated,
		});

		await governed.destroy();
	});

	it("gates the call on the envelope's real balance, denying pre-hold when it is short", async () => {
		reset();
		fundEnvelope(3n);
		const client = anthropicMock();
		const governed = await trust(client, {
			budget: 100_000,
			vaultBase: tmpVault,
			parentUserId: PARENT,
			_audit: makeMockAudit(),
		});

		// Three usertokens in the envelope against a much larger estimate. The
		// SESSION wallet holds 100_000, so a governor that fell back to session
		// numbers — or never read the envelope at all — would authorise this.
		await expect(
			withCostCenter(COST_CENTER, () => governed.messages.create(PARAMS), SCOPE_OPTS),
		).rejects.toBeInstanceOf(PolicyDeniedError);

		expect(holds).toHaveLength(0);
		expect(client.messages.create).not.toHaveBeenCalled();

		await governed.destroy();
	});
});

// ── Governor identity ──
//
// `parentUserId` is the parent half of the (parent, costCenter) tuple every
// envelope account is derived from. It is OPERATOR-trusted config, so it is
// validated by the one authoritative rule at CONSTRUCTION — before a governor
// exists, let alone a hold. Deferring it to the first attributed call would put
// the refusal on the money path, after the caller believed governance was up.

describe("governor identity — parentUserId is validated at construction", () => {
	let tmpVault: string;

	beforeEach(() => {
		tmpVault = join(tmpdir(), `tb-engine-seam-${randomUUID()}`);
		mkdirSync(tmpVault, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(tmpVault, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("trust() refuses a quarantined parent id before building anything", async () => {
		await expect(
			trust(
				{ messages: { create: vi.fn(async () => ({})) } },
				{
					parentUserId: "acme::billing",
					dryRun: true,
					vaultBase: tmpVault,
					_audit: makeMockAudit(),
				},
			),
		).rejects.toThrow(/parentUserId/);
	});

	it("createGovernor() refuses a parent id outside the charset", async () => {
		await expect(
			createGovernor({
				parentUserId: "acme billing",
				dryRun: true,
				vaultBase: tmpVault,
				_audit: makeMockAudit(),
			}),
		).rejects.toThrow(/parentUserId/);
	});

	it("accepts a legal parent id on both governors", async () => {
		const governed = await trust(
			{ messages: { create: vi.fn(async () => ({})) } },
			{
				parentUserId: "acct:123",
				dryRun: true,
				vaultBase: tmpVault,
				_audit: makeMockAudit(),
			},
		);
		await governed.destroy();

		const governor = await createGovernor({
			parentUserId: "acct:123",
			dryRun: true,
			vaultBase: tmpVault,
			_audit: makeMockAudit(),
		});
		await governor.destroy();
	});
});
