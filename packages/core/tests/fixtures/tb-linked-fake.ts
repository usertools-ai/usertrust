// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A stateful TigerBeetle fake that applies linked chains, for unit tests of the ledger client.
 *
 * The per-file mocks elsewhere answer each request from a script. None of them applies a linked
 * chain, so none can show what a two-transfer chain does when one leg is refused, replayed or
 * expired. This fake keeps accounts, transfers and pending states, and follows the rules of
 * tigerbeetle 0.17.9's state machine (`src/state_machine.zig`) for the parts it models:
 *  - balances: `debits_pending`, `debits_posted`, `credits_pending`, `credits_posted`, with
 *    `debits_must_not_exceed_credits` checked against `credits_posted` only, so pending credits
 *    are not spendable (`tigerbeetle.zig`, `debits_exceed_credits`);
 *  - a transfer's two accounts on one ledger, and the transfer on that ledger;
 *  - pending transfers with a timeout in seconds, expired by `advanceSeconds`; posting (partial or
 *    full, never above the pending amount) and voiding;
 *  - `exists` and the `exists_with_different_*` family, checked in the server's order (flags,
 *    pending_id, timeout, then the rest), with a post or void compared against its pending
 *    transfer for the fields it inherits;
 *  - `id_already_failed` for an id whose first attempt failed with a transient code;
 *  - linked chains: applied in order and rolled back on any failure. The first failure keeps its
 *    own code and every other event in the chain answers `linked_event_failed`. ANY status other
 *    than `created` breaks a chain, `exists` included, so a replayed chain answers
 *    `[exists, linked_event_failed]`, not `[exists, exists]`. A `linked` flag on the last event
 *    of a request answers `linked_event_chain_open`.
 * Balancing, closing and imported transfers are not modelled: a request that uses one throws,
 * so a test cannot pass on behaviour the fake does not have.
 *
 * One difference from a real cluster, on purpose: `advanceSeconds` releases an expired transfer's
 * balances at once, while TigerBeetle removes expired holds on a best-effort schedule, so a real
 * client can still see the pending amount for a while after the timeout. Rows that depend on the
 * real lag run against a cluster (`task-limit-client.tb.test.ts`, the abandoned-pair row).
 *
 * The numeric values below are tigerbeetle-node 0.17.9's. `tb-linked-fake.test.ts` pins them
 * against the binding's own enums, and `task-limit-client.tb.test.ts` runs one script of chains
 * on this fake and on a real cluster and requires the same answers.
 *
 * Usage, with the mock at module level as AGENTS.md asks:
 *
 *   const { fixture, fake } = await vi.hoisted(async () => {
 *     const fixture = await import("../fixtures/tb-linked-fake.js");
 *     return { fixture, fake: fixture.createLinkedFake() };
 *   });
 *   vi.mock("tigerbeetle-node", () => fixture.fakeModule(fake));
 */

import type { Account, Transfer } from "tigerbeetle-node";

/** `AccountFlags` and `TransferFlags` bit values, as tigerbeetle-node 0.17.9 defines them. */
export const FAKE_FLAGS = {
	account: {
		linked: 1,
		debits_must_not_exceed_credits: 2,
		credits_must_not_exceed_debits: 4,
		history: 8,
		imported: 16,
		closed: 32,
	},
	transfer: {
		linked: 1,
		pending: 2,
		post_pending_transfer: 4,
		void_pending_transfer: 8,
		balancing_debit: 16,
		balancing_credit: 32,
		closing_debit: 64,
		closing_credit: 128,
		imported: 256,
	},
} as const;

/** Every `CreateTransferStatus` this fake answers, with its tigerbeetle-node 0.17.9 value. */
export const FAKE_STATUS = {
	created: 4294967295,
	linked_event_failed: 1,
	linked_event_chain_open: 2,
	id_must_not_be_zero: 5,
	flags_are_mutually_exclusive: 7,
	debit_account_id_must_not_be_zero: 8,
	credit_account_id_must_not_be_zero: 10,
	accounts_must_be_different: 12,
	pending_id_must_be_zero: 13,
	pending_id_must_not_be_zero: 14,
	pending_id_must_be_different: 16,
	timeout_reserved_for_pending_transfer: 17,
	ledger_must_not_be_zero: 19,
	code_must_not_be_zero: 20,
	debit_account_not_found: 21,
	credit_account_not_found: 22,
	accounts_must_have_the_same_ledger: 23,
	transfer_must_have_the_same_ledger_as_accounts: 24,
	pending_transfer_not_found: 25,
	pending_transfer_not_pending: 26,
	pending_transfer_has_different_debit_account_id: 27,
	pending_transfer_has_different_credit_account_id: 28,
	pending_transfer_has_different_ledger: 29,
	pending_transfer_has_different_code: 30,
	exceeds_pending_transfer_amount: 31,
	pending_transfer_has_different_amount: 32,
	pending_transfer_already_posted: 33,
	pending_transfer_already_voided: 34,
	pending_transfer_expired: 35,
	exists_with_different_flags: 36,
	exists_with_different_debit_account_id: 37,
	exists_with_different_credit_account_id: 38,
	exists_with_different_amount: 39,
	exists_with_different_pending_id: 40,
	exists_with_different_user_data_128: 41,
	exists_with_different_user_data_64: 42,
	exists_with_different_user_data_32: 43,
	exists_with_different_timeout: 44,
	exists_with_different_code: 45,
	exists: 46,
	overflows_debits_pending: 47,
	overflows_credits_pending: 48,
	overflows_debits_posted: 49,
	overflows_credits_posted: 50,
	overflows_debits: 51,
	overflows_credits: 52,
	exceeds_credits: 54,
	exceeds_debits: 55,
	exists_with_different_ledger: 67,
	id_already_failed: 68,
} as const;

/**
 * Every `CreateAccountStatus` this fake answers, with its 0.17.9 value. Kept apart from
 * {@link FAKE_STATUS} because the two enums share names with different values (`exists` is 21
 * for an account and 46 for a transfer).
 */
export const FAKE_ACCOUNT_STATUS = {
	created: 4294967295,
	linked_event_failed: 1,
	linked_event_chain_open: 2,
	reserved_field: 4,
	reserved_flag: 5,
	id_must_not_be_zero: 6,
	flags_are_mutually_exclusive: 8,
	debits_pending_must_be_zero: 9,
	debits_posted_must_be_zero: 10,
	credits_pending_must_be_zero: 11,
	credits_posted_must_be_zero: 12,
	ledger_must_not_be_zero: 13,
	code_must_not_be_zero: 14,
	exists_with_different_flags: 15,
	exists_with_different_user_data_128: 16,
	exists_with_different_user_data_64: 17,
	exists_with_different_user_data_32: 18,
	exists_with_different_ledger: 19,
	exists_with_different_code: 20,
	exists: 21,
} as const;

/** tigerbeetle-node's `amount_max`: 2^128 - 1. */
export const AMOUNT_MAX = (1n << 128n) - 1n;

const U128_LIMIT = 1n << 128n;
const NS_PER_SECOND = 1_000_000_000n;

/**
 * The transfer codes a later attempt under the same id answers `id_already_failed` to
 * (`create_transfers.md`, "id_already_failed"; the closed-account pair is not modelled here).
 */
const TRANSIENT: ReadonlySet<number> = new Set([
	FAKE_STATUS.debit_account_not_found,
	FAKE_STATUS.credit_account_not_found,
	FAKE_STATUS.pending_transfer_not_found,
	FAKE_STATUS.exceeds_credits,
	FAKE_STATUS.exceeds_debits,
]);

const UNMODELLED_TRANSFER_FLAGS =
	FAKE_FLAGS.transfer.balancing_debit |
	FAKE_FLAGS.transfer.balancing_credit |
	FAKE_FLAGS.transfer.closing_debit |
	FAKE_FLAGS.transfer.closing_credit |
	FAKE_FLAGS.transfer.imported;

const UNMODELLED_ACCOUNT_FLAGS = FAKE_FLAGS.account.imported | FAKE_FLAGS.account.closed;

export type FakeAccount = Account;
export type FakeTransfer = Transfer;
export type FakeResult = { timestamp: bigint; status: number };
export type FakeOp = "createAccounts" | "createTransfers" | "lookupAccounts" | "lookupTransfers";

/** What a pending transfer has become. The stored transfer record itself never changes. */
export type PendingState = "pending" | "posted" | "voided" | "expired";

/** The native-client surface TrustTBClient uses. */
export interface FakeNativeClient {
	createAccounts(batch: Account[]): Promise<FakeResult[]>;
	createTransfers(batch: Transfer[]): Promise<FakeResult[]>;
	lookupAccounts(ids: bigint[]): Promise<Account[]>;
	lookupTransfers(ids: bigint[]): Promise<Transfer[]>;
	destroy(): void;
}

/**
 * Intercepts one request. `apply` runs it against the fake's state and returns its answer; a
 * hook may call it and then throw (a reply lost after the request committed), answer without
 * calling it, or call it after changing the state.
 */
export type RequestHook = (
	op: FakeOp,
	batch: readonly unknown[],
	apply: () => unknown[],
) => unknown[] | Promise<unknown[]>;

export interface LinkedFake {
	client: FakeNativeClient;
	accounts: Map<bigint, Account>;
	transfers: Map<bigint, Transfer>;
	/** What each pending transfer has become, by its id. */
	pendingState: Map<bigint, PendingState>;
	/** Every request made, in order, with a copy of its batch. */
	requests: Array<{ op: FakeOp; batch: unknown[] }>;
	/** How many times `destroy()` was called on the client. */
	destroyed: number;
	onRequest: RequestHook | null;
	/** Moves the fake's clock on, and expires every pending transfer whose timeout has passed. */
	advanceSeconds(n: number): void;
	/** Empties the ledger, the request log and the hook; the client object stays the same. */
	reset(): void;
}

/** A transfer with every field zero except those given. `timeoutSeconds` sets `timeout`. */
export function transferOf(
	fields: Partial<Omit<Transfer, "timeout">> & { id: bigint; timeoutSeconds?: number },
): Transfer {
	const { timeoutSeconds, ...rest } = fields;
	return {
		debit_account_id: 0n,
		credit_account_id: 0n,
		amount: 0n,
		pending_id: 0n,
		user_data_128: 0n,
		user_data_64: 0n,
		user_data_32: 0,
		ledger: 0,
		code: 0,
		flags: 0,
		timestamp: 0n,
		...rest,
		timeout: timeoutSeconds ?? 0,
	};
}

/** An account with zero balances and every field zero except those given. */
export function accountOf(fields: Partial<Account> & { id: bigint }): Account {
	return {
		debits_pending: 0n,
		debits_posted: 0n,
		credits_pending: 0n,
		credits_posted: 0n,
		user_data_128: 0n,
		user_data_64: 0n,
		user_data_32: 0,
		reserved: 0,
		ledger: 0,
		code: 0,
		flags: 0,
		timestamp: 0n,
		...fields,
	};
}

export function createLinkedFake(): LinkedFake {
	const accounts = new Map<bigint, Account>();
	const transfers = new Map<bigint, Transfer>();
	const pendingState = new Map<bigint, PendingState>();
	// Ids retired by a transient failure. Never rolled back with a chain: the server records
	// them after discarding the chain's effects.
	const orphaned = new Set<bigint>();
	// The fake's clock, in nanoseconds: each event takes the next tick, as each event in a real
	// request gets its own timestamp.
	let now = 1n;
	const tick = (): bigint => {
		now += 1n;
		return now;
	};

	const S = FAKE_STATUS;
	const TF = FAKE_FLAGS.transfer;
	const AF = FAKE_FLAGS.account;
	const has = (flags: number, bit: number): boolean => (flags & bit) !== 0;

	const expiresAt = (p: Transfer): bigint | null =>
		p.timeout === 0 ? null : p.timestamp + BigInt(p.timeout) * NS_PER_SECOND;

	const release = (p: Transfer): void => {
		const dr = accounts.get(p.debit_account_id);
		const cr = accounts.get(p.credit_account_id);
		if (dr) dr.debits_pending -= p.amount;
		if (cr) cr.credits_pending -= p.amount;
	};

	const expireDue = (): void => {
		for (const [id, state] of pendingState) {
			if (state !== "pending") continue;
			const p = transfers.get(id);
			const at = p ? expiresAt(p) : null;
			if (p && at !== null && at <= now) {
				pendingState.set(id, "expired");
				release(p);
			}
		}
	};

	const accountExists = (a: Account, e: Account): number => {
		const A = FAKE_ACCOUNT_STATUS;
		if (a.flags !== e.flags) return A.exists_with_different_flags;
		if (a.user_data_128 !== e.user_data_128) return A.exists_with_different_user_data_128;
		if (a.user_data_64 !== e.user_data_64) return A.exists_with_different_user_data_64;
		if (a.user_data_32 !== e.user_data_32) return A.exists_with_different_user_data_32;
		if (a.ledger !== e.ledger) return A.exists_with_different_ledger;
		if (a.code !== e.code) return A.exists_with_different_code;
		return A.exists;
	};

	const createAccount = (a: Account, ts: bigint): number => {
		const A = FAKE_ACCOUNT_STATUS;
		if (has(a.flags, UNMODELLED_ACCOUNT_FLAGS)) {
			throw new Error("tb-linked-fake: imported and closed accounts are not modelled");
		}
		if (a.reserved !== 0) return A.reserved_field;
		if (a.id === 0n) return A.id_must_not_be_zero;
		const e = accounts.get(a.id);
		if (e) return accountExists(a, e);
		if (
			has(a.flags, AF.debits_must_not_exceed_credits) &&
			has(a.flags, AF.credits_must_not_exceed_debits)
		) {
			return A.flags_are_mutually_exclusive;
		}
		if (a.debits_pending !== 0n) return A.debits_pending_must_be_zero;
		if (a.debits_posted !== 0n) return A.debits_posted_must_be_zero;
		if (a.credits_pending !== 0n) return A.credits_pending_must_be_zero;
		if (a.credits_posted !== 0n) return A.credits_posted_must_be_zero;
		if (a.ledger === 0) return A.ledger_must_not_be_zero;
		if (a.code === 0) return A.code_must_not_be_zero;
		accounts.set(a.id, { ...a, timestamp: ts });
		return A.created;
	};

	/** A post or void replayed: compared against the stored record and its pending transfer. */
	const postOrVoidExists = (t: Transfer, e: Transfer, p: Transfer): number => {
		if (t.debit_account_id !== 0n && t.debit_account_id !== e.debit_account_id) {
			return S.exists_with_different_debit_account_id;
		}
		if (t.credit_account_id !== 0n && t.credit_account_id !== e.credit_account_id) {
			return S.exists_with_different_credit_account_id;
		}
		if (has(t.flags, TF.void_pending_transfer)) {
			if (t.amount === 0n ? e.amount !== p.amount : t.amount !== e.amount) {
				return S.exists_with_different_amount;
			}
		} else if (t.amount === AMOUNT_MAX ? e.amount !== p.amount : t.amount !== e.amount) {
			return S.exists_with_different_amount;
		}
		const inherited = (want: bigint | number, got: bigint | number, pending: bigint | number) =>
			want === 0n || want === 0 ? got === pending : want === got;
		if (!inherited(t.user_data_128, e.user_data_128, p.user_data_128)) {
			return S.exists_with_different_user_data_128;
		}
		if (!inherited(t.user_data_64, e.user_data_64, p.user_data_64)) {
			return S.exists_with_different_user_data_64;
		}
		if (!inherited(t.user_data_32, e.user_data_32, p.user_data_32)) {
			return S.exists_with_different_user_data_32;
		}
		if (t.ledger !== 0 && t.ledger !== e.ledger) return S.exists_with_different_ledger;
		if (t.code !== 0 && t.code !== e.code) return S.exists_with_different_code;
		return S.exists;
	};

	const transferExists = (t: Transfer, e: Transfer): number => {
		// The flags change what the other comparisons mean, so they are compared first.
		if (t.flags !== e.flags) return S.exists_with_different_flags;
		if (t.pending_id !== e.pending_id) return S.exists_with_different_pending_id;
		if (t.timeout !== e.timeout) return S.exists_with_different_timeout;
		if (has(t.flags, TF.post_pending_transfer | TF.void_pending_transfer)) {
			const p = transfers.get(t.pending_id);
			if (!p) throw new Error("tb-linked-fake: a stored post or void lost its pending transfer");
			return postOrVoidExists(t, e, p);
		}
		if (t.debit_account_id !== e.debit_account_id) {
			return S.exists_with_different_debit_account_id;
		}
		if (t.credit_account_id !== e.credit_account_id) {
			return S.exists_with_different_credit_account_id;
		}
		if (t.amount !== e.amount) return S.exists_with_different_amount;
		if (t.user_data_128 !== e.user_data_128) return S.exists_with_different_user_data_128;
		if (t.user_data_64 !== e.user_data_64) return S.exists_with_different_user_data_64;
		if (t.user_data_32 !== e.user_data_32) return S.exists_with_different_user_data_32;
		if (t.ledger !== e.ledger) return S.exists_with_different_ledger;
		if (t.code !== e.code) return S.exists_with_different_code;
		return S.exists;
	};

	const postOrVoid = (t: Transfer, ts: bigint): number => {
		const post = has(t.flags, TF.post_pending_transfer);
		const isVoid = has(t.flags, TF.void_pending_transfer);
		if (post && isVoid) return S.flags_are_mutually_exclusive;
		if (has(t.flags, TF.pending)) return S.flags_are_mutually_exclusive;
		if (t.pending_id === 0n) return S.pending_id_must_not_be_zero;
		if (t.pending_id === t.id) return S.pending_id_must_be_different;
		if (t.timeout !== 0) return S.timeout_reserved_for_pending_transfer;
		const p = transfers.get(t.pending_id);
		if (!p) return S.pending_transfer_not_found;
		if (!has(p.flags, TF.pending)) return S.pending_transfer_not_pending;
		if (t.debit_account_id !== 0n && t.debit_account_id !== p.debit_account_id) {
			return S.pending_transfer_has_different_debit_account_id;
		}
		if (t.credit_account_id !== 0n && t.credit_account_id !== p.credit_account_id) {
			return S.pending_transfer_has_different_credit_account_id;
		}
		if (t.ledger !== 0 && t.ledger !== p.ledger) return S.pending_transfer_has_different_ledger;
		if (t.code !== 0 && t.code !== p.code) return S.pending_transfer_has_different_code;
		const amount = isVoid
			? t.amount === 0n
				? p.amount
				: t.amount
			: t.amount === AMOUNT_MAX
				? p.amount
				: t.amount;
		if (amount > p.amount) return S.exceeds_pending_transfer_amount;
		if (isVoid && amount < p.amount) return S.pending_transfer_has_different_amount;
		const state = pendingState.get(p.id);
		if (state === "posted") return S.pending_transfer_already_posted;
		if (state === "voided") return S.pending_transfer_already_voided;
		if (state === "expired") return S.pending_transfer_expired;
		const at = expiresAt(p);
		if (at !== null && at <= ts) return S.pending_transfer_expired;
		transfers.set(t.id, {
			id: t.id,
			debit_account_id: p.debit_account_id,
			credit_account_id: p.credit_account_id,
			user_data_128: t.user_data_128 !== 0n ? t.user_data_128 : p.user_data_128,
			user_data_64: t.user_data_64 !== 0n ? t.user_data_64 : p.user_data_64,
			user_data_32: t.user_data_32 !== 0 ? t.user_data_32 : p.user_data_32,
			ledger: p.ledger,
			code: p.code,
			pending_id: t.pending_id,
			// Zero, checked above. Copied rather than written as a literal.
			timeout: t.timeout,
			timestamp: ts,
			flags: t.flags,
			amount,
		});
		release(p);
		if (post) {
			const dr = accounts.get(p.debit_account_id);
			const cr = accounts.get(p.credit_account_id);
			if (dr) dr.debits_posted += amount;
			if (cr) cr.credits_posted += amount;
		}
		pendingState.set(p.id, post ? "posted" : "voided");
		return S.created;
	};

	const createTransfer = (t: Transfer, ts: bigint): number => {
		if (has(t.flags, UNMODELLED_TRANSFER_FLAGS)) {
			throw new Error(
				"tb-linked-fake: balancing, closing and imported transfers are not modelled",
			);
		}
		if (t.id === 0n) return S.id_must_not_be_zero;
		const e = transfers.get(t.id);
		if (e) return transferExists(t, e);
		if (orphaned.has(t.id)) return S.id_already_failed;
		if (has(t.flags, TF.post_pending_transfer | TF.void_pending_transfer)) {
			return postOrVoid(t, ts);
		}
		if (t.debit_account_id === 0n) return S.debit_account_id_must_not_be_zero;
		if (t.credit_account_id === 0n) return S.credit_account_id_must_not_be_zero;
		if (t.credit_account_id === t.debit_account_id) return S.accounts_must_be_different;
		if (t.pending_id !== 0n) return S.pending_id_must_be_zero;
		const pending = has(t.flags, TF.pending);
		if (!pending && t.timeout !== 0) return S.timeout_reserved_for_pending_transfer;
		if (t.ledger === 0) return S.ledger_must_not_be_zero;
		if (t.code === 0) return S.code_must_not_be_zero;
		const dr = accounts.get(t.debit_account_id);
		if (!dr) return S.debit_account_not_found;
		const cr = accounts.get(t.credit_account_id);
		if (!cr) return S.credit_account_not_found;
		if (dr.ledger !== cr.ledger) return S.accounts_must_have_the_same_ledger;
		if (t.ledger !== dr.ledger) return S.transfer_must_have_the_same_ledger_as_accounts;
		const amount = t.amount;
		if (pending && amount + dr.debits_pending >= U128_LIMIT) return S.overflows_debits_pending;
		if (pending && amount + cr.credits_pending >= U128_LIMIT) return S.overflows_credits_pending;
		if (amount + dr.debits_posted >= U128_LIMIT) return S.overflows_debits_posted;
		if (amount + cr.credits_posted >= U128_LIMIT) return S.overflows_credits_posted;
		if (amount + dr.debits_pending + dr.debits_posted >= U128_LIMIT) return S.overflows_debits;
		if (amount + cr.credits_pending + cr.credits_posted >= U128_LIMIT) return S.overflows_credits;
		if (
			has(dr.flags, AF.debits_must_not_exceed_credits) &&
			dr.debits_pending + dr.debits_posted + amount > dr.credits_posted
		) {
			return S.exceeds_credits;
		}
		if (
			has(cr.flags, AF.credits_must_not_exceed_debits) &&
			cr.credits_pending + cr.credits_posted + amount > cr.debits_posted
		) {
			return S.exceeds_debits;
		}
		transfers.set(t.id, { ...t, timestamp: ts });
		if (pending) {
			dr.debits_pending += amount;
			cr.credits_pending += amount;
			pendingState.set(t.id, "pending");
		} else {
			dr.debits_posted += amount;
			cr.credits_posted += amount;
		}
		return S.created;
	};

	type Snapshot = {
		accounts: Map<bigint, Account>;
		transfers: Map<bigint, Transfer>;
		pendingState: Map<bigint, PendingState>;
	};
	const snapshot = (): Snapshot => ({
		accounts: new Map([...accounts].map(([id, a]) => [id, { ...a }])),
		transfers: new Map(transfers),
		pendingState: new Map(pendingState),
	});
	const restore = (s: Snapshot): void => {
		accounts.clear();
		for (const [id, a] of s.accounts) accounts.set(id, a);
		transfers.clear();
		for (const [id, t] of s.transfers) transfers.set(id, t);
		pendingState.clear();
		for (const [id, st] of s.pendingState) pendingState.set(id, st);
	};

	/**
	 * One request of events, chains included, as `execute_create` runs it: a chain starts at its
	 * first linked event; once an event answers anything but `created` the chain is broken, its
	 * effects are discarded, its earlier events are rewritten to `linked_event_failed`, and its
	 * later events answer `linked_event_failed` without being evaluated.
	 */
	const execute = <E extends { id: bigint; flags: number }>(
		events: readonly E[],
		one: (event: E, ts: bigint) => number,
		codes: {
			created: number;
			exists: number;
			linked_event_failed: number;
			linked_event_chain_open: number;
		},
		transient: (status: number) => boolean,
		stored: (id: bigint) => bigint | undefined,
	): FakeResult[] => {
		const results: FakeResult[] = [];
		let chainStart: number | null = null;
		let broken = false;
		let saved: Snapshot | null = null;
		for (const [index, event] of events.entries()) {
			const ts = tick();
			const linked = has(event.flags, TF.linked);
			if (linked && chainStart === null) {
				chainStart = index;
				saved = snapshot();
			}
			let status: number;
			if (linked && index === events.length - 1) status = codes.linked_event_chain_open;
			else if (broken) status = codes.linked_event_failed;
			else status = one(event, ts);
			if (status !== codes.created) {
				if (chainStart !== null && !broken) {
					broken = true;
					if (saved) restore(saved);
					for (let i = chainStart; i < index; i++) {
						const earlier = results[i];
						if (earlier) earlier.status = codes.linked_event_failed;
					}
				}
				if (transient(status)) orphaned.add(event.id);
			}
			// `exists` answers with the STORED record's timestamp, as the server does
			// (state_machine.zig@0.17.9:3101); every other status with the event's own.
			const timestamp = status === codes.exists ? (stored(event.id) ?? ts) : ts;
			results.push({ timestamp, status });
			if (chainStart !== null && (!linked || status === codes.linked_event_chain_open)) {
				chainStart = null;
				broken = false;
				saved = null;
			}
		}
		return results;
	};

	const copyTransfer = (t: Transfer): Transfer => ({ ...t });
	const copyAccount = (a: Account): Account => ({ ...a });

	const fake: LinkedFake = {
		accounts,
		transfers,
		pendingState,
		requests: [],
		destroyed: 0,
		onRequest: null,
		advanceSeconds(n: number) {
			now += BigInt(n) * NS_PER_SECOND;
			expireDue();
		},
		reset() {
			accounts.clear();
			transfers.clear();
			pendingState.clear();
			orphaned.clear();
			now = 1n;
			fake.requests.length = 0;
			fake.destroyed = 0;
			fake.onRequest = null;
		},
		client: undefined as unknown as FakeNativeClient,
	};

	const request = async <R>(
		op: FakeOp,
		batch: readonly unknown[],
		apply: () => R[],
	): Promise<R[]> => {
		fake.requests.push({ op, batch: [...batch] });
		const hook = fake.onRequest;
		if (hook === null) return apply();
		return (await hook(op, batch, apply)) as R[];
	};

	fake.client = {
		createAccounts: (batch) =>
			request("createAccounts", batch, () =>
				execute(
					batch,
					createAccount,
					FAKE_ACCOUNT_STATUS,
					() => false,
					(id) => accounts.get(id)?.timestamp,
				),
			),
		createTransfers: (batch) =>
			request("createTransfers", batch, () =>
				execute(
					batch,
					createTransfer,
					FAKE_STATUS,
					(s) => TRANSIENT.has(s),
					(id) => transfers.get(id)?.timestamp,
				),
			),
		lookupAccounts: (ids) =>
			request("lookupAccounts", ids, () =>
				ids.flatMap((id) => {
					const a = accounts.get(id);
					return a ? [copyAccount(a)] : [];
				}),
			),
		lookupTransfers: (ids) =>
			request("lookupTransfers", ids, () =>
				ids.flatMap((id) => {
					const t = transfers.get(id);
					return t ? [copyTransfer(t)] : [];
				}),
			),
		destroy: () => {
			fake.destroyed += 1;
		},
	};
	return fake;
}

/** A numeric enum as TypeScript emits one: name to value, and value back to name. */
function enumOf<T extends Record<string, number>>(values: T): T & Record<number, string> {
	const out: Record<string | number, string | number> = { ...values };
	for (const [name, value] of Object.entries(values)) out[value] = name;
	return out as T & Record<number, string>;
}

/** The `tigerbeetle-node` module this fake stands in for: the factory a `vi.mock` returns. */
export function fakeModule(fake: LinkedFake) {
	return {
		createClient: () => fake.client,
		AccountFlags: enumOf({ none: 0, ...FAKE_FLAGS.account }),
		TransferFlags: enumOf({ none: 0, ...FAKE_FLAGS.transfer }),
		CreateAccountStatus: enumOf(FAKE_ACCOUNT_STATUS),
		CreateTransferStatus: enumOf(FAKE_STATUS),
		amount_max: AMOUNT_MAX,
	};
}
