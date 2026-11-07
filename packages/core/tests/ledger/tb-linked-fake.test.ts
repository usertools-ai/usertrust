// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The linked-chain TigerBeetle fake, held to the rules of tigerbeetle 0.17.9.
 *
 * Unit tests of linked pairs rest on this fake, so it is tested on its own first: each rule
 * here is one the client's error handling depends on. The values are pinned against
 * tigerbeetle-node's own enums (its `dist/bindings.js`, which holds only the enums and loads no
 * native code). Behaviour is pinned against a real cluster by `task-limit-client.tb.test.ts`,
 * which runs one script of chains on both.
 */

import * as binding from "tigerbeetle-node/dist/bindings.js";
import { beforeEach, describe, expect, it } from "vitest";
import {
	AMOUNT_MAX,
	accountOf,
	createLinkedFake,
	FAKE_ACCOUNT_STATUS,
	FAKE_FLAGS,
	FAKE_STATUS,
	fakeModule,
	type LinkedFake,
	transferOf,
} from "../fixtures/tb-linked-fake.js";

const AF = FAKE_FLAGS.account;
const TF = FAKE_FLAGS.transfer;

const LEDGER_A = 1;
const LEDGER_B = 2;
const CODE = 7;
const EXPIRY_S = 2;
const LONG_S = 300;

// Account ids.
const SOURCE_A = 10n; // unconstrained, ledger A
const WALLET_A = 11n; // debits_must_not_exceed_credits, ledger A
const SOURCE_B = 20n; // unconstrained, ledger B
const LIMIT_B = 21n; // debits_must_not_exceed_credits, ledger B

let fake: LinkedFake;
let nextId = 1000n;
const id = (): bigint => {
	nextId += 1n;
	return nextId;
};

const names = (results: ReadonlyArray<{ status: number }>): string[] =>
	results.map((r) => String(fakeModule(fake).CreateTransferStatus[r.status]));

/** One createTransfers request, answered as status names. */
const send = async (batch: Parameters<LinkedFake["client"]["createTransfers"]>[0]) =>
	names(await fake.client.createTransfers(batch));

async function ledgers(walletCredit: bigint, limitCredit: bigint): Promise<void> {
	const results = await fake.client.createAccounts([
		accountOf({ id: SOURCE_A, ledger: LEDGER_A, code: CODE, flags: AF.history }),
		accountOf({
			id: WALLET_A,
			ledger: LEDGER_A,
			code: CODE,
			flags: AF.debits_must_not_exceed_credits | AF.history,
		}),
		accountOf({ id: SOURCE_B, ledger: LEDGER_B, code: CODE, flags: AF.history }),
		accountOf({
			id: LIMIT_B,
			ledger: LEDGER_B,
			code: CODE,
			flags: AF.debits_must_not_exceed_credits | AF.history,
		}),
	]);
	expect(results.map((r) => r.status)).toEqual(Array(4).fill(FAKE_ACCOUNT_STATUS.created));
	const funded = await fake.client.createTransfers([
		transferOf({
			id: id(),
			debit_account_id: SOURCE_A,
			credit_account_id: WALLET_A,
			amount: walletCredit,
			ledger: LEDGER_A,
			code: CODE,
		}),
		transferOf({
			id: id(),
			debit_account_id: SOURCE_B,
			credit_account_id: LIMIT_B,
			amount: limitCredit,
			ledger: LEDGER_B,
			code: CODE,
		}),
	]);
	expect(names(funded)).toEqual(["created", "created"]);
}

/** The pair shape: a payer leg on ledger A, linked to a limit leg on ledger B. */
function pair(amount: bigint, timeoutSeconds = LONG_S, ids = { a: id(), b: id() }) {
	return [
		transferOf({
			id: ids.a,
			debit_account_id: WALLET_A,
			credit_account_id: SOURCE_A,
			amount,
			ledger: LEDGER_A,
			code: CODE,
			flags: TF.pending | TF.linked,
			timeoutSeconds,
		}),
		transferOf({
			id: ids.b,
			debit_account_id: LIMIT_B,
			credit_account_id: SOURCE_B,
			amount,
			ledger: LEDGER_B,
			code: CODE,
			flags: TF.pending,
			timeoutSeconds,
		}),
	];
}

function resolvePair(ids: { a: bigint; b: bigint }, flag: number, amount: bigint) {
	return [
		transferOf({ id: id(), pending_id: ids.a, amount, flags: flag | TF.linked }),
		transferOf({ id: id(), pending_id: ids.b, amount, flags: flag }),
	];
}

const balances = (accountId: bigint) => {
	const a = fake.accounts.get(accountId);
	if (!a) throw new Error(`no account ${accountId}`);
	return {
		debits_pending: a.debits_pending,
		debits_posted: a.debits_posted,
		credits_pending: a.credits_pending,
		credits_posted: a.credits_posted,
	};
};

beforeEach(() => {
	fake = createLinkedFake();
});

describe("the fake's values are tigerbeetle-node 0.17.9's", () => {
	it("pins every transfer status, account status and flag against the binding's own enums", () => {
		const transferStatus = binding.CreateTransferStatus as unknown as Record<string, number>;
		for (const [name, value] of Object.entries(FAKE_STATUS)) {
			expect([name, transferStatus[name]]).toEqual([name, value]);
		}
		const accountStatus = binding.CreateAccountStatus as unknown as Record<string, number>;
		for (const [name, value] of Object.entries(FAKE_ACCOUNT_STATUS)) {
			expect([name, accountStatus[name]]).toEqual([name, value]);
		}
		const accountFlags = binding.AccountFlags as unknown as Record<string, number>;
		for (const [name, value] of Object.entries(FAKE_FLAGS.account)) {
			expect([name, accountFlags[name]]).toEqual([name, value]);
		}
		const transferFlags = binding.TransferFlags as unknown as Record<string, number>;
		for (const [name, value] of Object.entries(FAKE_FLAGS.transfer)) {
			expect([name, transferFlags[name]]).toEqual([name, value]);
		}
	});

	it("the module it stands in for maps each status value back to its name, as a TypeScript enum does", () => {
		const mod = fakeModule(fake);
		expect(mod.CreateTransferStatus[46]).toBe("exists");
		expect(mod.CreateAccountStatus[21]).toBe("exists");
		expect(mod.TransferFlags.linked).toBe(1);
		expect(mod.amount_max).toBe(AMOUNT_MAX);
		expect(mod.createClient()).toBe(fake.client);
	});
});

describe("linked chains", () => {
	it("a linked chain whose second transfer exceeds credits creates neither", async () => {
		await ledgers(1_000n, 100n);
		const before = { wallet: balances(WALLET_A), limit: balances(LIMIT_B) };
		const batch = pair(500n);
		const results = await fake.client.createTransfers(batch);
		expect(names(results)).toEqual(["linked_event_failed", "exceeds_credits"]);
		expect({ wallet: balances(WALLET_A), limit: balances(LIMIT_B) }).toEqual(before);
		expect(fake.transfers.has(batch[0]?.id ?? 0n)).toBe(false);
		expect(fake.transfers.has(batch[1]?.id ?? 0n)).toBe(false);
	});

	it("the first failure in a chain gets its own code", async () => {
		await ledgers(100n, 1_000n);
		expect(await send(pair(500n))).toEqual([
			"exceeds_credits",
			"linked_event_failed",
		]);
		// A three-event chain failing in the middle: the events before and after it both answer
		// linked_event_failed, and the one that failed keeps its own code.
		const [a, b] = pair(50n);
		const middle = transferOf({
			id: id(),
			debit_account_id: WALLET_A,
			credit_account_id: SOURCE_A,
			amount: 10_000n,
			ledger: LEDGER_A,
			code: CODE,
			flags: TF.linked,
		});
		if (!a || !b) throw new Error("pair() builds two transfers");
		expect(await send([a, middle, b])).toEqual([
			"linked_event_failed",
			"exceeds_credits",
			"linked_event_failed",
		]);
		expect(balances(WALLET_A).debits_pending).toBe(0n);
	});

	it("a trailing linked flag is linked_event_chain_open", async () => {
		await ledgers(1_000n, 1_000n);
		const [a] = pair(10n);
		if (!a) throw new Error("pair() builds two transfers");
		expect(await send([a])).toEqual(["linked_event_chain_open"]);
		const [c, d] = pair(10n);
		if (!c || !d) throw new Error("pair() builds two transfers");
		expect(await send([c, { ...d, flags: d.flags | TF.linked }])).toEqual(
			["linked_event_failed", "linked_event_chain_open"],
		);
		expect(balances(WALLET_A).debits_pending).toBe(0n);
		expect(balances(LIMIT_B).debits_pending).toBe(0n);
	});

	it("a replayed linked chain answers exists, then linked_event_failed, and changes nothing", async () => {
		await ledgers(1_000n, 1_000n);
		const batch = pair(400n);
		expect(await send(batch)).toEqual(["created", "created"]);
		const after = { wallet: balances(WALLET_A), limit: balances(LIMIT_B) };
		expect(await send(batch)).toEqual([
			"exists",
			"linked_event_failed",
		]);
		expect({ wallet: balances(WALLET_A), limit: balances(LIMIT_B) }).toEqual(after);
	});

	it("a replayed chain with a different amount answers exists_with_different_amount first", async () => {
		await ledgers(1_000n, 1_000n);
		const ids = { a: id(), b: id() };
		await fake.client.createTransfers(pair(400n, LONG_S, ids));
		expect(await send(pair(401n, LONG_S, ids))).toEqual([
			"exists_with_different_amount",
			"linked_event_failed",
		]);
	});

	it("a replayed post pair answers exists, then linked_event_failed", async () => {
		await ledgers(1_000n, 1_000n);
		const ids = { a: id(), b: id() };
		await fake.client.createTransfers(pair(400n, LONG_S, ids));
		const post = resolvePair(ids, TF.post_pending_transfer, 300n);
		expect(await send(post)).toEqual(["created", "created"]);
		expect(await send(post)).toEqual([
			"exists",
			"linked_event_failed",
		]);
	});

	it("a chain that spans two ledgers applies both legs", async () => {
		await ledgers(1_000n, 1_000n);
		expect(await send(pair(250n))).toEqual(["created", "created"]);
		expect(balances(WALLET_A).debits_pending).toBe(250n);
		expect(balances(LIMIT_B).debits_pending).toBe(250n);
		expect(balances(SOURCE_A).credits_pending).toBe(250n);
		expect(balances(SOURCE_B).credits_pending).toBe(250n);
	});

	it("independent events in one request succeed or fail alone", async () => {
		await ledgers(100n, 1_000n);
		const ok = transferOf({
			id: id(),
			debit_account_id: SOURCE_A,
			credit_account_id: WALLET_A,
			amount: 5n,
			ledger: LEDGER_A,
			code: CODE,
		});
		const refused = transferOf({
			id: id(),
			debit_account_id: WALLET_A,
			credit_account_id: SOURCE_A,
			amount: 10_000n,
			ledger: LEDGER_A,
			code: CODE,
		});
		expect(await send([ok, refused])).toEqual([
			"created",
			"exceeds_credits",
		]);
		expect(balances(WALLET_A).credits_posted).toBe(105n);
	});
});

describe("balances, pending transfers and expiry", () => {
	it("pending credits are not spendable", async () => {
		await ledgers(0n, 1_000n);
		// A pending transfer INTO the wallet: credits_pending rises, credits_posted does not.
		const incoming = transferOf({
			id: id(),
			debit_account_id: SOURCE_A,
			credit_account_id: WALLET_A,
			amount: 500n,
			ledger: LEDGER_A,
			code: CODE,
			flags: TF.pending,
			timeoutSeconds: LONG_S,
		});
		expect(await send([incoming])).toEqual(["created"]);
		expect(balances(WALLET_A).credits_pending).toBe(500n);
		const spend = transferOf({
			id: id(),
			debit_account_id: WALLET_A,
			credit_account_id: SOURCE_A,
			amount: 1n,
			ledger: LEDGER_A,
			code: CODE,
			flags: TF.pending,
			timeoutSeconds: LONG_S,
		});
		expect(await send([spend])).toEqual(["exceeds_credits"]);
	});

	it("an expired pending transfer cannot be posted and its amount returns", async () => {
		await ledgers(1_000n, 1_000n);
		const ids = { a: id(), b: id() };
		await fake.client.createTransfers(pair(600n, EXPIRY_S, ids));
		expect(balances(LIMIT_B).debits_pending).toBe(600n);
		fake.advanceSeconds(EXPIRY_S - 1);
		expect(balances(LIMIT_B).debits_pending).toBe(600n);
		fake.advanceSeconds(1);
		expect(balances(WALLET_A).debits_pending).toBe(0n);
		expect(balances(LIMIT_B).debits_pending).toBe(0n);
		expect(balances(SOURCE_B).credits_pending).toBe(0n);
		expect(fake.pendingState.get(ids.a)).toBe("expired");
		expect(fake.pendingState.get(ids.b)).toBe("expired");
		expect(await send(resolvePair(ids, TF.post_pending_transfer, 600n))).toEqual(
			["pending_transfer_expired", "linked_event_failed"],
		);
		expect(await send(resolvePair(ids, TF.void_pending_transfer, 0n))).toEqual(
			["pending_transfer_expired", "linked_event_failed"],
		);
		// The stored records do not change when a hold expires.
		expect((fake.transfers.get(ids.a)?.flags ?? 0) & TF.pending).toBe(TF.pending);
		// The capacity is back: a pair for the whole limit is accepted.
		expect(await send(pair(1_000n))).toEqual(["created", "created"]);
	});

	// state_machine.zig@0.17.9:4115-4124: amount_actual is the amount sent (or the pending's for
	// amount_max), and one above the pending amount is refused before anything is stored.
	it("a post above the pending amount is refused, with no partial effect", async () => {
		await ledgers(1_000n, 1_000n);
		const ids = { a: id(), b: id() };
		await fake.client.createTransfers(pair(400n, LONG_S, ids));
		const before = [WALLET_A, SOURCE_A, LIMIT_B, SOURCE_B].map(balances);
		const above = resolvePair(ids, TF.post_pending_transfer, 401n);
		expect(await send(above)).toEqual(["exceeds_pending_transfer_amount", "linked_event_failed"]);
		expect([WALLET_A, SOURCE_A, LIMIT_B, SOURCE_B].map(balances)).toEqual(before);
		expect(fake.transfers.has(above[0]?.id ?? 0n)).toBe(false);
		expect(fake.transfers.has(above[1]?.id ?? 0n)).toBe(false);
		expect(fake.pendingState.get(ids.a)).toBe("pending");
		expect(fake.pendingState.get(ids.b)).toBe("pending");
		// Nothing was consumed: the whole amount can still be posted.
		expect(await send(resolvePair(ids, TF.post_pending_transfer, 400n))).toEqual([
			"created",
			"created",
		]);
	});

	// state_machine.zig@0.17.9:4242-4250: the whole pending amount leaves debits_pending and
	// credits_pending, and only amount_actual is added to the posted balances; :4135 refuses a
	// second post of a pending transfer already posted.
	it("a post below the pending amount posts it, releases the rest, and cannot be posted again", async () => {
		await ledgers(1_000n, 1_000n);
		const ids = { a: id(), b: id() };
		await fake.client.createTransfers(pair(400n, LONG_S, ids));
		expect(await send(resolvePair(ids, TF.post_pending_transfer, 150n))).toEqual([
			"created",
			"created",
		]);
		// The debit side of each leg.
		expect(balances(WALLET_A)).toMatchObject({ debits_pending: 0n, debits_posted: 150n });
		expect(balances(LIMIT_B)).toMatchObject({ debits_pending: 0n, debits_posted: 150n });
		// The credit side of each leg. Each source was DEBITED 1,000 by the funding, so its
		// credits are the posted 150 alone.
		expect(balances(SOURCE_A)).toMatchObject({
			debits_posted: 1_000n,
			credits_pending: 0n,
			credits_posted: 150n,
		});
		expect(balances(SOURCE_B)).toMatchObject({
			debits_posted: 1_000n,
			credits_pending: 0n,
			credits_posted: 150n,
		});
		expect(await send(resolvePair(ids, TF.post_pending_transfer, 100n))).toEqual([
			"pending_transfer_already_posted",
			"linked_event_failed",
		]);
	});

	// state_machine.zig@0.17.9:4119: amount_max posts the pending's whole amount; any other amount,
	// 0 included (:4122 allows it), is posted as sent. postLinkedPair sends a concrete amount and
	// never amount_max, so the client's full post is the held amount itself.
	it("the full-amount sentinel is AMOUNT_MAX; a post of 0 posts nothing and releases the hold", async () => {
		await ledgers(1_000n, 1_000n);
		const full = { a: id(), b: id() };
		await fake.client.createTransfers(pair(400n, LONG_S, full));
		const post = resolvePair(full, TF.post_pending_transfer, AMOUNT_MAX);
		expect(await send(post)).toEqual(["created", "created"]);
		expect(fake.transfers.get(post[0]?.id ?? 0n)?.amount).toBe(400n);
		expect(fake.transfers.get(post[1]?.id ?? 0n)?.amount).toBe(400n);
		expect(balances(LIMIT_B)).toMatchObject({ debits_pending: 0n, debits_posted: 400n });

		const zero = { a: id(), b: id() };
		await fake.client.createTransfers(pair(300n, LONG_S, zero));
		expect(await send(resolvePair(zero, TF.post_pending_transfer, 0n))).toEqual([
			"created",
			"created",
		]);
		expect(balances(WALLET_A)).toMatchObject({ debits_pending: 0n, debits_posted: 400n });
		expect(balances(LIMIT_B)).toMatchObject({ debits_pending: 0n, debits_posted: 400n });
	});

	it("a post stores the pending transfer's accounts, ledger, code and user data", async () => {
		await ledgers(1_000n, 1_000n);
		const ids = { a: id(), b: id() };
		const [a, b] = pair(400n, LONG_S, ids);
		if (!a || !b) throw new Error("pair() builds two transfers");
		await fake.client.createTransfers([{ ...a, user_data_128: 77n, user_data_32: 3 }, b]);
		const post = resolvePair(ids, TF.post_pending_transfer, 100n);
		await fake.client.createTransfers(post);
		const stored = fake.transfers.get(post[0]?.id ?? 0n);
		expect(stored).toMatchObject({
			debit_account_id: WALLET_A,
			credit_account_id: SOURCE_A,
			ledger: LEDGER_A,
			code: CODE,
			user_data_128: 77n,
			user_data_32: 3,
			pending_id: ids.a,
			amount: 100n,
		});
	});

	it("a void releases the whole pending amount; a second void is pending_transfer_already_voided", async () => {
		await ledgers(1_000n, 1_000n);
		const ids = { a: id(), b: id() };
		await fake.client.createTransfers(pair(400n, LONG_S, ids));
		expect(await send(resolvePair(ids, TF.void_pending_transfer, 0n))).toEqual(
			["created", "created"],
		);
		expect(balances(WALLET_A)).toMatchObject({ debits_pending: 0n, debits_posted: 0n });
		expect(balances(LIMIT_B)).toMatchObject({ debits_pending: 0n, debits_posted: 0n });
		expect(await send(resolvePair(ids, TF.void_pending_transfer, 0n))).toEqual(
			["pending_transfer_already_voided", "linked_event_failed"],
		);
	});
});

describe("ids", () => {
	it("a replayed id with a different amount is exists_with_different_amount", async () => {
		await ledgers(1_000n, 1_000n);
		const t = transferOf({
			id: id(),
			debit_account_id: SOURCE_B,
			credit_account_id: LIMIT_B,
			amount: 500n,
			ledger: LEDGER_B,
			code: CODE,
		});
		expect(await send([t])).toEqual(["created"]);
		expect(await send([t])).toEqual(["exists"]);
		expect(await send([{ ...t, amount: 700n }])).toEqual([
			"exists_with_different_amount",
		]);
		expect(await send([{ ...t, flags: TF.pending }])).toEqual([
			"exists_with_different_flags",
		]);
		expect(balances(LIMIT_B).credits_posted).toBe(1_500n);
	});

	it("an id that failed transiently is id_already_failed on retry", async () => {
		await ledgers(100n, 1_000n);
		const spend = transferOf({
			id: id(),
			debit_account_id: WALLET_A,
			credit_account_id: SOURCE_A,
			amount: 500n,
			ledger: LEDGER_A,
			code: CODE,
		});
		expect(await send([spend])).toEqual(["exceeds_credits"]);
		// Funded now, and the same id still cannot succeed.
		await fake.client.createTransfers([
			transferOf({
				id: id(),
				debit_account_id: SOURCE_A,
				credit_account_id: WALLET_A,
				amount: 1_000n,
				ledger: LEDGER_A,
				code: CODE,
			}),
		]);
		expect(await send([spend])).toEqual(["id_already_failed"]);
	});

	it("in a refused chain only the leg that failed transiently is retired", async () => {
		await ledgers(1_000n, 100n);
		const ids = { a: id(), b: id() };
		expect(await send(pair(500n, LONG_S, ids))).toEqual([
			"linked_event_failed",
			"exceeds_credits",
		]);
		// The payer leg was rolled back, not failed: its id can still be used. The limit leg's
		// id is retired.
		const [a, b] = pair(500n, LONG_S, ids);
		if (!a || !b) throw new Error("pair() builds two transfers");
		expect(await send([{ ...a, flags: TF.pending }])).toEqual([
			"created",
		]);
		expect(await send([{ ...b, amount: 10n }])).toEqual([
			"id_already_failed",
		]);
	});

	it("a transfer whose accounts are on another ledger is refused", async () => {
		await ledgers(1_000n, 1_000n);
		const across = transferOf({
			id: id(),
			debit_account_id: LIMIT_B,
			credit_account_id: SOURCE_A,
			amount: 1n,
			ledger: LEDGER_B,
			code: CODE,
		});
		expect(await send([across])).toEqual([
			"accounts_must_have_the_same_ledger",
		]);
		const wrongLedger = transferOf({
			id: id(),
			debit_account_id: LIMIT_B,
			credit_account_id: SOURCE_B,
			amount: 1n,
			ledger: LEDGER_A,
			code: CODE,
		});
		expect(await send([wrongLedger])).toEqual([
			"transfer_must_have_the_same_ledger_as_accounts",
		]);
	});
});

describe("accounts", () => {
	it("an identical account is exists; one with other flags or user data is exists_with_different_*", async () => {
		const account = accountOf({
			id: 5n,
			ledger: LEDGER_B,
			code: CODE,
			flags: AF.debits_must_not_exceed_credits | AF.history,
			user_data_128: 9n,
			user_data_32: 1,
		});
		const status = async (a: typeof account) => (await fake.client.createAccounts([a]))[0]?.status;
		expect(await status(account)).toBe(FAKE_ACCOUNT_STATUS.created);
		expect(await status(account)).toBe(FAKE_ACCOUNT_STATUS.exists);
		expect(await status({ ...account, flags: AF.history })).toBe(
			FAKE_ACCOUNT_STATUS.exists_with_different_flags,
		);
		expect(await status({ ...account, user_data_128: 8n })).toBe(
			FAKE_ACCOUNT_STATUS.exists_with_different_user_data_128,
		);
		expect(await status({ ...account, user_data_32: 2 })).toBe(
			FAKE_ACCOUNT_STATUS.exists_with_different_user_data_32,
		);
		expect(await status({ ...account, ledger: LEDGER_A })).toBe(
			FAKE_ACCOUNT_STATUS.exists_with_different_ledger,
		);
	});

	it("lookups return copies, absent ids omitted", async () => {
		await ledgers(1_000n, 1_000n);
		const [found] = await fake.client.lookupAccounts([WALLET_A, 999n]);
		expect(found?.credits_posted).toBe(1_000n);
		if (found) found.credits_posted = 0n;
		expect(balances(WALLET_A).credits_posted).toBe(1_000n);
		expect(await fake.client.lookupTransfers([999n])).toEqual([]);
	});
});

describe("the request hook", () => {
	it("records every request, and can lose a reply after the request committed", async () => {
		await ledgers(1_000n, 1_000n);
		const batch = pair(100n);
		fake.onRequest = (_op, _batch, apply) => {
			apply();
			throw new Error("connection refused");
		};
		await expect(fake.client.createTransfers(batch)).rejects.toThrow("connection refused");
		// Committed although the caller saw an error: the retry is a replay.
		fake.onRequest = null;
		expect(await send(batch)).toEqual([
			"exists",
			"linked_event_failed",
		]);
		const ops = fake.requests.map((r) => r.op);
		expect(ops.slice(-2)).toEqual(["createTransfers", "createTransfers"]);
	});

	it("reset() empties the ledger and the log but keeps the client", async () => {
		const client = fake.client;
		await ledgers(1_000n, 1_000n);
		fake.reset();
		expect(fake.accounts.size).toBe(0);
		expect(fake.requests).toEqual([]);
		expect(fake.client).toBe(client);
	});

	it("refuses a flag it does not model rather than answering as if it did", async () => {
		await ledgers(1_000n, 1_000n);
		const balancing = transferOf({
			id: id(),
			debit_account_id: WALLET_A,
			credit_account_id: SOURCE_A,
			amount: 1n,
			ledger: LEDGER_A,
			code: CODE,
			flags: TF.balancing_debit,
		});
		await expect(fake.client.createTransfers([balancing])).rejects.toThrow("not modelled");
	});
});

