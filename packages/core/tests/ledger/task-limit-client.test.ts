// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * TrustTBClient's task-limit primitives, against the linked-chain fake.
 *
 * A task limit is an account on a second ledger that each hold made inside the task debits
 * beside its payer, as one linked pair of pending transfers: TigerBeetle creates both or
 * neither. What is pinned here:
 *  - the derived ids (task key, operator, namespace tag): known answers, spelled out, and three
 *    disjoint domains;
 *  - the accounts: the fields written on creation, `exists` as success, every
 *    `exists_with_different_*` refused;
 *  - the pair: one request of two transfers, the payer leg first and linked; which leg refused
 *    decides the error (a plain TBTransferError for the payer leg, so every existing catch site
 *    reads it as before; TaskLimitLegError for the limit leg);
 *  - replays. In tigerbeetle 0.17.9 an `exists` inside a linked chain breaks the chain
 *    (`src/state_machine.zig`, execute_create: any status other than `created` does), so a pair
 *    resent after its reply was lost answers `[exists, linked_event_failed]`, and its second leg
 *    is never evaluated. Only that exact answer is read as a possible replay, and only one lookup
 *    of both legs, matching what was sent field for field, turns it into success. Anything else
 *    is a hard failure, and a lookup that does not match is also reported as a process warning:
 *    a pair id that answers `exists` for a transfer this call did not send is an integrity fault;
 *  - a pair recovered after its timeout is not a live hold: its post takes the expired path.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fixture, fake } = await vi.hoisted(async () => {
	const fixture = await import("../fixtures/tb-linked-fake.js");
	return { fixture, fake: fixture.createLinkedFake() };
});
vi.mock("tigerbeetle-node", () => fixture.fakeModule(fake));

import {
	CODE_TASK_LIMIT,
	CODE_TASK_LIMIT_OPERATOR,
	LEDGER_TASK_LIMITS,
	LEDGER_USERTOKENS,
	LINKED_PAIR_MISMATCH_WARNING,
	TASK_ACCOUNT_SCHEMA,
	TaskLimitLegError,
	TBTransferError,
	TransferIdRetiredError,
	TransferReplayMismatchError,
	TrustTBClient,
	XFER_SPEND,
	XFER_TASK_LIMIT_GRANT,
	XFER_TASK_LIMIT_HOLD,
} from "../../src/ledger/client.js";

const { FAKE_FLAGS, FAKE_STATUS, accountOf, transferOf } = fixture;
const AF = FAKE_FLAGS.account;
const TF = FAKE_FLAGS.transfer;
const S = FAKE_STATUS;

const HOLD_S = 300;
const EXPIRY_S = 2;

// Accounts the pair rows use, created directly on the fake so these rows test the pair alone.
const TREASURY = 101n;
const WALLET = 102n;
const OPERATOR = 201n;
const TASK = 202n;

let client: TrustTBClient;

beforeEach(() => {
	fake.reset();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	client = new TrustTBClient({ addresses: ["3000"] });
});

afterEach(() => {
	client.destroy();
	vi.restoreAllMocks();
});

/** The ledger a pair needs: a funded wallet and its treasury, a task account and its operator. */
async function ledgers(walletCredit: bigint, taskLimit: bigint): Promise<void> {
	await fake.client.createAccounts([
		accountOf({ id: TREASURY, ledger: LEDGER_USERTOKENS, code: 2, flags: AF.history }),
		accountOf({
			id: WALLET,
			ledger: LEDGER_USERTOKENS,
			code: 1,
			flags: AF.debits_must_not_exceed_credits | AF.history,
		}),
		accountOf({
			id: OPERATOR,
			ledger: LEDGER_TASK_LIMITS,
			code: CODE_TASK_LIMIT_OPERATOR,
			flags: AF.history,
		}),
		accountOf({
			id: TASK,
			ledger: LEDGER_TASK_LIMITS,
			code: CODE_TASK_LIMIT,
			flags: AF.debits_must_not_exceed_credits | AF.history,
		}),
	]);
	await fake.client.createTransfers([
		transferOf({
			id: 9_001n,
			debit_account_id: TREASURY,
			credit_account_id: WALLET,
			amount: walletCredit,
			ledger: LEDGER_USERTOKENS,
			code: 5,
		}),
		transferOf({
			id: 9_002n,
			debit_account_id: OPERATOR,
			credit_account_id: TASK,
			amount: taskLimit,
			ledger: LEDGER_TASK_LIMITS,
			code: XFER_TASK_LIMIT_GRANT,
		}),
	]);
	fake.requests.length = 0;
}

/** A pair for `amount`, payer = the wallet, limit = the task. */
const pairFor = (amount: number, timeoutSeconds = HOLD_S) => ({
	amount,
	timeoutSeconds,
	payer: {
		debitAccountId: WALLET,
		creditAccountId: TREASURY,
		code: XFER_SPEND,
		userData128: 11n,
		userData64: 12n,
		userData32: 13,
	},
	limit: { debitAccountId: TASK, creditAccountId: OPERATOR, userData128: TASK },
});

const requestsOf = (op: string) => fake.requests.filter((r) => r.op === op);
type SentTransfer = ReturnType<typeof transferOf>;
const sentBatch = (i: number): SentTransfer[] => {
	const r = requestsOf("createTransfers")[i];
	if (!r) throw new Error(`no createTransfers request ${i}`);
	return r.batch as SentTransfer[];
};

const balance = (accountId: bigint) => {
	const a = fake.accounts.get(accountId);
	if (!a) throw new Error(`no account ${accountId}`);
	return a;
};

/** The first attempt commits, then its reply is lost: the client reconnects and resends it. */
function loseFirstReply(afterCommit?: () => void): void {
	let lost = false;
	fake.onRequest = (op, _batch, apply) => {
		if (op !== "createTransfers" || lost) return apply();
		lost = true;
		apply();
		afterCommit?.();
		throw new Error("connection refused");
	};
}

/**
 * The pair answers `[exists, linked_event_failed]`, as a replay does, while the fake holds
 * `stored(sent)` under the sent ids: what a lookup of the two legs will find.
 */
function replayAnswer(stored: (sent: SentTransfer[]) => SentTransfer[]): void {
	fake.onRequest = (op, batch, apply) => {
		if (op !== "createTransfers") return apply();
		for (const t of stored(batch as SentTransfer[]))
			fake.transfers.set(t.id, { ...t, timestamp: 5n });
		return [
			{ timestamp: 0n, status: S.exists },
			{ timestamp: 0n, status: S.linked_event_failed },
		];
	};
}

/** The pair answers exactly `statuses`, whatever was sent. */
function answer(...statuses: number[]): void {
	fake.onRequest = (op, _batch, apply) =>
		op === "createTransfers" ? statuses.map((status) => ({ timestamp: 0n, status })) : apply();
}

const settle = <T>(p: Promise<T>) =>
	p.then(
		() => undefined,
		(e: unknown) => e,
	);

describe("task-limit constants", () => {
	it("are the values the ledger records carry", () => {
		expect(LEDGER_TASK_LIMITS).toBe(2);
		expect(CODE_TASK_LIMIT).toBe(4);
		expect(CODE_TASK_LIMIT_OPERATOR).toBe(5);
		expect(XFER_TASK_LIMIT_GRANT).toBe(10);
		expect(XFER_TASK_LIMIT_HOLD).toBe(11);
		expect(TASK_ACCOUNT_SCHEMA).toBe(1);
		expect(LINKED_PAIR_MISMATCH_WARNING).toBe("USERTRUST_LEDGER_PAIR_MISMATCH");
	});

	it("TaskLimitLegError is a TBTransferError, so existing catch sites still match", () => {
		const err = new TaskLimitLegError(S.exceeds_credits, "limit leg refused");
		expect(err).toBeInstanceOf(TBTransferError);
		expect(err.name).toBe("TaskLimitLegError");
		expect(err.code).toBe(S.exceeds_credits);
	});
});

describe("derived ids", () => {
	/** The derivation, written out here from its definition, not taken from the client. */
	const tuple = (tag: string, ...parts: string[]): bigint => {
		const chunks: Buffer[] = [Buffer.from(tag, "utf8")];
		for (const part of parts) {
			const bytes = Buffer.from(part, "utf8");
			const len = Buffer.alloc(4);
			len.writeUInt32BE(bytes.length);
			chunks.push(len, bytes);
		}
		return BigInt(
			`0x${createHash("sha256").update(Buffer.concat(chunks)).digest("hex").slice(0, 32)}`,
		);
	};

	// Known answers computed outside the implementation (sha256 of the domain tag, then each part
	// as a big-endian u32 UTF-8 byte length and its bytes; the first 16 bytes). Spelled out, so a
	// change to a tag, the prefixes or the truncation breaks this suite.
	it("derives the task key from a domain-tagged, length-prefixed tuple", () => {
		expect(TrustTBClient.deriveTaskLimitAccountId("local", "a")).toBe(
			336617073386892556721645347786877214709n,
		);
		expect(TrustTBClient.deriveTaskLimitAccountId("acme:eu", "build.1")).toBe(
			145335685176581486952267431332613058238n,
		);
		// A multibyte namespace: the prefix counts UTF-8 bytes. A code-unit count derives
		// 300613416154839918664282252967734619410n instead.
		expect(TrustTBClient.deriveTaskLimitAccountId("\u00e9quipe", "a")).toBe(
			114683262744481504069649086242835571669n,
		);
		for (const [ns, id] of [
			["local", "a"],
			["acme:eu", "build.1"],
			["\u00e9quipe", "a"],
		] as const) {
			expect(TrustTBClient.deriveTaskLimitAccountId(ns, id)).toBe(
				tuple("usertrust:task-limit:v1", ns, id),
			);
		}
		expect(TrustTBClient.deriveTaskLimitAccountId("ab", "c")).not.toBe(
			TrustTBClient.deriveTaskLimitAccountId("a", "bc"),
		);
	});

	it("derives the operator id and the namespace tag under their own tags", () => {
		expect(TrustTBClient.deriveTaskLimitOperatorId("local")).toBe(
			246640142458018110351941908793456646562n,
		);
		expect(TrustTBClient.taskNamespaceTag("local")).toBe(186289599134792991193483597080094301258n);
		expect(TrustTBClient.deriveTaskLimitOperatorId("acme:eu")).toBe(
			tuple("usertrust:task-limit-operator:v1", "acme:eu"),
		);
		expect(TrustTBClient.taskNamespaceTag("acme:eu")).toBe(
			tuple("usertrust:task-namespace:v1", "acme:eu"),
		);
	});

	it("task key, operator id and namespace tag live in three disjoint domains", () => {
		const key = TrustTBClient.deriveTaskLimitAccountId("x", "y");
		const operator = TrustTBClient.deriveTaskLimitOperatorId("x");
		const tag = TrustTBClient.taskNamespaceTag("x");
		expect(new Set([key, operator, tag]).size).toBe(3);
		for (const v of [key, operator, tag]) {
			expect(v).not.toBe(TrustTBClient.deriveCostCenterAccountId("x", "y"));
			expect(v).not.toBe(TrustTBClient.deriveAccountId("x"));
			expect(v).not.toBe(TrustTBClient.deriveTransferId("x", "y"));
		}
		// The bare hash of the namespace, which a tag without a domain would collide with.
		expect(tag).not.toBe(
			BigInt(`0x${createHash("sha256").update("x").digest("hex").slice(0, 32)}`),
		);
	});
});

describe("task-limit accounts", () => {
	it("createTaskLimitAccount writes ledger 2, code 4, the namespace tag and schema 1", async () => {
		const id = await client.createTaskLimitAccount("local", "a");
		expect(id).toBe(TrustTBClient.deriveTaskLimitAccountId("local", "a"));
		const [request] = requestsOf("createAccounts");
		expect(request?.batch).toHaveLength(1);
		expect(request?.batch[0]).toMatchObject({
			id,
			ledger: LEDGER_TASK_LIMITS,
			code: CODE_TASK_LIMIT,
			flags: AF.debits_must_not_exceed_credits | AF.history,
			user_data_128: TrustTBClient.taskNamespaceTag("local"),
			user_data_64: 0n,
			user_data_32: TASK_ACCOUNT_SCHEMA,
		});
		// Derived, so `exists` is the same account: success.
		await expect(client.createTaskLimitAccount("local", "a")).resolves.toBe(id);
	});

	it("createTaskLimitAccount refuses an account that exists with other flags", async () => {
		const id = TrustTBClient.deriveTaskLimitAccountId("local", "b");
		await fake.client.createAccounts([
			accountOf({
				id,
				ledger: LEDGER_TASK_LIMITS,
				code: CODE_TASK_LIMIT,
				flags: AF.history,
				user_data_128: TrustTBClient.taskNamespaceTag("local"),
				user_data_32: TASK_ACCOUNT_SCHEMA,
			}),
		]);
		await expect(client.createTaskLimitAccount("local", "b")).rejects.toThrow(
			"exists_with_different_flags",
		);
	});

	it("createTaskLimitAccount refuses an account that exists with another schema", async () => {
		const id = TrustTBClient.deriveTaskLimitAccountId("local", "c");
		await fake.client.createAccounts([
			accountOf({
				id,
				ledger: LEDGER_TASK_LIMITS,
				code: CODE_TASK_LIMIT,
				flags: AF.debits_must_not_exceed_credits | AF.history,
				user_data_128: TrustTBClient.taskNamespaceTag("local"),
				user_data_32: TASK_ACCOUNT_SCHEMA + 1,
			}),
		]);
		await expect(client.createTaskLimitAccount("local", "c")).rejects.toThrow(
			"exists_with_different_user_data_32",
		);
	});

	it("createTaskLimitOperator writes ledger 2, code 5, history only, and no user data", async () => {
		const id = await client.createTaskLimitOperator("local");
		expect(id).toBe(TrustTBClient.deriveTaskLimitOperatorId("local"));
		expect(requestsOf("createAccounts")[0]?.batch[0]).toMatchObject({
			id,
			ledger: LEDGER_TASK_LIMITS,
			code: CODE_TASK_LIMIT_OPERATOR,
			flags: AF.history,
			user_data_128: 0n,
			user_data_64: 0n,
			user_data_32: 0,
		});
		await expect(client.createTaskLimitOperator("local")).resolves.toBe(id);
	});

	it.each<[string, () => Promise<unknown>]>([
		["a task id with a slash", () => client.createTaskLimitAccount("local", "a/b")],
		["an empty task id", () => client.createTaskLimitAccount("local", "")],
		["a 129-character task id", () => client.createTaskLimitAccount("local", "a".repeat(129))],
		["a non-ASCII task id", () => client.createTaskLimitAccount("local", "\u00e9")],
		["a namespace with a space", () => client.createTaskLimitAccount("a b", "t")],
		["a namespace in the reserved :: form", () => client.createTaskLimitOperator("acme::x")],
	])("refuses %s before any request", async (_name, op) => {
		await expect(op()).rejects.toThrow();
		expect(fake.requests).toEqual([]);
	});
});

describe("createLinkedPendingPair", () => {
	it("createLinkedPendingPair submits one request of two transfers, payer linked first", async () => {
		await ledgers(1_000n, 1_000n);
		const { payerId, limitId } = await client.createLinkedPendingPair(pairFor(400));
		expect(requestsOf("createTransfers")).toHaveLength(1);
		const [a, b] = sentBatch(0);
		expect(sentBatch(0)).toHaveLength(2);
		expect(a).toMatchObject({
			id: payerId,
			debit_account_id: WALLET,
			credit_account_id: TREASURY,
			amount: 400n,
			pending_id: 0n,
			ledger: LEDGER_USERTOKENS,
			code: XFER_SPEND,
			flags: TF.pending | TF.linked,
			timeout: HOLD_S,
			user_data_128: 11n,
			user_data_64: 12n,
			user_data_32: 13,
		});
		expect(b).toMatchObject({
			id: limitId,
			debit_account_id: TASK,
			credit_account_id: OPERATOR,
			amount: 400n,
			pending_id: 0n,
			ledger: LEDGER_TASK_LIMITS,
			code: XFER_TASK_LIMIT_HOLD,
			flags: TF.pending,
			timeout: HOLD_S,
			user_data_128: TASK,
			user_data_64: 0n,
			user_data_32: 0,
		});
		expect(payerId).not.toBe(limitId);
		expect(balance(WALLET).debits_pending).toBe(400n);
		expect(balance(TASK).debits_pending).toBe(400n);
		expect(requestsOf("lookupTransfers")).toEqual([]);
	});

	it("a payer-leg rejection throws a plain TBTransferError with the payer code", async () => {
		await ledgers(100n, 1_000n);
		const err = await settle(client.createLinkedPendingPair(pairFor(400)));
		expect(err).toBeInstanceOf(TBTransferError);
		expect(err).not.toBeInstanceOf(TaskLimitLegError);
		expect((err as TBTransferError).code).toBe(S.exceeds_credits);
		expect(balance(TASK).debits_pending).toBe(0n);
	});

	it("a limit-leg rejection throws TaskLimitLegError with the limit code", async () => {
		await ledgers(1_000n, 100n);
		const err = await settle(client.createLinkedPendingPair(pairFor(400)));
		expect(err).toBeInstanceOf(TaskLimitLegError);
		expect((err as TaskLimitLegError).code).toBe(S.exceeds_credits);
		// Linked: the payer leg was rolled back with it.
		expect(balance(WALLET).debits_pending).toBe(0n);
	});

	it("a limit leg on a task account that does not exist is TaskLimitLegError(debit_account_not_found)", async () => {
		await ledgers(1_000n, 1_000n);
		const p = pairFor(10);
		const err = await settle(
			client.createLinkedPendingPair({ ...p, limit: { ...p.limit, debitAccountId: 999n } }),
		);
		expect(err).toBeInstanceOf(TaskLimitLegError);
		expect((err as TaskLimitLegError).code).toBe(S.debit_account_not_found);
	});

	it("exists_with_different_amount on the payer leg is a hard conflict, not a replay", async () => {
		await ledgers(1_000n, 1_000n);
		answer(S.exists_with_different_amount, S.linked_event_failed);
		const err = await settle(client.createLinkedPendingPair(pairFor(10)));
		expect(err).toBeInstanceOf(TBTransferError);
		expect(err).not.toBeInstanceOf(TaskLimitLegError);
		expect(err).not.toBeInstanceOf(TransferReplayMismatchError);
		expect((err as TBTransferError).code).toBe(S.exists_with_different_amount);
		expect(requestsOf("lookupTransfers")).toEqual([]);
	});

	it.each<[string, number]>([
		["zero", 0],
		["negative", -1],
		["fractional", 1.5],
		// TigerBeetle's timeout is a u32 count of seconds.
		["above the u32 maximum", 2 ** 32],
	])(
		"refuses a %s timeout before any request: a pair must expire if nobody settles it",
		async (_n, t) => {
			await ledgers(1_000n, 1_000n);
			await expect(client.createLinkedPendingPair(pairFor(10, t))).rejects.toThrow();
			expect(fake.requests).toEqual([]);
		},
	);
});

describe("a replayed pair", () => {
	it("a replayed pair is verified by one lookup of both legs", async () => {
		await ledgers(1_000n, 1_000n);
		loseFirstReply();
		const { payerId, limitId } = await client.createLinkedPendingPair(pairFor(400));
		expect(fake.requests.map((r) => r.op)).toEqual([
			"createTransfers",
			"createTransfers",
			"lookupTransfers",
		]);
		// The resend is the same two transfers, under the same ids.
		expect(sentBatch(1)).toEqual(sentBatch(0));
		expect(requestsOf("lookupTransfers")[0]?.batch).toEqual([payerId, limitId]);
		// Held once, not twice.
		expect(balance(WALLET).debits_pending).toBe(400n);
		expect(balance(TASK).debits_pending).toBe(400n);
	});

	const FIELDS: Array<[string, (t: SentTransfer) => SentTransfer]> = [
		["amount", (t) => ({ ...t, amount: t.amount + 1n })],
		["debit_account_id", (t) => ({ ...t, debit_account_id: 77n })],
		["credit_account_id", (t) => ({ ...t, credit_account_id: 77n })],
		["ledger", (t) => ({ ...t, ledger: t.ledger + 10 })],
		["code", (t) => ({ ...t, code: t.code + 10 })],
		["flags", (t) => ({ ...t, flags: t.flags ^ TF.linked })],
		["user_data_128", (t) => ({ ...t, user_data_128: t.user_data_128 + 1n })],
		["user_data_64", (t) => ({ ...t, user_data_64: t.user_data_64 + 1n })],
		["user_data_32", (t) => ({ ...t, user_data_32: t.user_data_32 + 1 })],
		["timeout", (t) => ({ ...t, timeout: t.timeout + 1 })],
		["pending_id", (t) => ({ ...t, pending_id: 77n })],
	];

	for (const leg of [0, 1] as const) {
		it.each(FIELDS)(
			`a replayed pair with a mismatched field is a hard failure: %s on the ${leg === 0 ? "payer" : "limit"} leg`,
			async (field, change) => {
				await ledgers(1_000n, 1_000n);
				const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
				replayAnswer((sent) => sent.map((t, i) => (i === leg ? change(t) : t)));
				const err = await settle(client.createLinkedPendingPair(pairFor(400)));
				expect(err).toBeInstanceOf(TransferReplayMismatchError);
				expect((err as TransferReplayMismatchError).field).toBe(field);
				expect((err as TransferReplayMismatchError).transferId).toBe(sentBatch(0)[leg]?.id);
				expect(requestsOf("lookupTransfers")).toHaveLength(1);
				expect(emit).toHaveBeenCalledWith(expect.stringContaining(String(sentBatch(0)[leg]?.id)), {
					code: LINKED_PAIR_MISMATCH_WARNING,
				});
			},
		);
	}

	it.each([
		["payer", 0],
		["limit", 1],
	] as const)(
		"a replayed pair with only one leg stored is a hard failure and an integrity warning: the %s leg missing",
		async (_name, missing) => {
			await ledgers(1_000n, 1_000n);
			const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
			replayAnswer((sent) => sent.filter((_t, i) => i !== missing));
			const err = await settle(client.createLinkedPendingPair(pairFor(400)));
			expect(err).toBeInstanceOf(TransferReplayMismatchError);
			expect(err).toBeInstanceOf(TBTransferError);
			expect((err as TransferReplayMismatchError).transferId).toBe(sentBatch(0)[missing]?.id);
			expect((err as TransferReplayMismatchError).field).toBe("record (none found)");
			expect(emit).toHaveBeenCalledTimes(1);
			expect(emit).toHaveBeenCalledWith(expect.any(String), {
				code: LINKED_PAIR_MISMATCH_WARNING,
			});
		},
	);

	it("a replay answer with neither leg stored is a hard failure and an integrity warning", async () => {
		await ledgers(1_000n, 1_000n);
		const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		replayAnswer(() => []);
		const err = await settle(client.createLinkedPendingPair(pairFor(400)));
		expect(err).toBeInstanceOf(TransferReplayMismatchError);
		expect(emit).toHaveBeenCalledWith(expect.any(String), { code: LINKED_PAIR_MISMATCH_WARNING });
	});

	it.each<[string, number[]]>([
		["exists, created", [S.exists, S.created]],
		["created, exists", [S.created, S.exists]],
		["exists, exists", [S.exists, S.exists]],
		["linked_event_failed, exists", [S.linked_event_failed, S.exists]],
		["linked_event_failed, linked_event_failed", [S.linked_event_failed, S.linked_event_failed]],
		["created, exceeds_credits", [S.created, S.exceeds_credits]],
		["exceeds_credits, created", [S.exceeds_credits, S.created]],
		["exists, exceeds_credits", [S.exists, S.exceeds_credits]],
	])("any other mixed answer is a hard failure, with no lookup: %s", async (_name, statuses) => {
		await ledgers(1_000n, 1_000n);
		answer(...statuses);
		const err = await settle(client.createLinkedPendingPair(pairFor(10)));
		expect(err).toBeInstanceOf(TBTransferError);
		expect(err).not.toBeInstanceOf(TaskLimitLegError);
		expect(err).not.toBeInstanceOf(TransferReplayMismatchError);
		expect(String(err)).toContain("inconsistent");
		expect(requestsOf("lookupTransfers")).toEqual([]);
	});

	// In 0.17.9 create_transfers answers exactly one result per event (state_machine.zig:3167-3183),
	// so a pair is answered with two. Anything else, an empty answer included, is not read as
	// "both created": that would report a hold the ledger may never have made.
	it.each<[string, number[]]>([
		["no result", []],
		["one result", [S.created]],
		["three results", [S.created, S.created, S.created]],
	])("an answer with %s for two transfers is a hard failure", async (_name, statuses) => {
		await ledgers(1_000n, 1_000n);
		answer(...statuses);
		await expect(client.createLinkedPendingPair(pairFor(10))).rejects.toThrow();
		expect(requestsOf("lookupTransfers")).toEqual([]);
	});

	it.each<[string, number[]]>([
		["no result", []],
		["one result", [S.created]],
		["three results", [S.created, S.created, S.created]],
	])("a post or void pair answered with %s is a hard failure", async (_name, statuses) => {
		await ledgers(1_000n, 1_000n);
		const { payerId, limitId } = await client.createLinkedPendingPair(pairFor(10));
		answer(...statuses);
		await expect(client.postLinkedPair(payerId, limitId, 10)).rejects.toThrow();
		await expect(client.voidLinkedPair(payerId, limitId)).rejects.toThrow();
		expect(requestsOf("lookupTransfers")).toEqual([]);
	});

	it("a pair recovered after its timeout resolves, and its post takes the expired path", async () => {
		await ledgers(1_000n, 1_000n);
		// The reply is lost, and the resend reaches the ledger only after the pair expired.
		loseFirstReply(() => fake.advanceSeconds(EXPIRY_S));
		const { payerId, limitId } = await client.createLinkedPendingPair(pairFor(400, EXPIRY_S));
		expect(fake.pendingState.get(payerId)).toBe("expired");
		expect(balance(TASK).debits_pending).toBe(0n);
		const err = await settle(client.postLinkedPair(payerId, limitId, 400));
		expect(err).toBeInstanceOf(TBTransferError);
		expect(err).not.toBeInstanceOf(TaskLimitLegError);
		expect((err as TBTransferError).code).toBe(S.pending_transfer_expired);
		expect(balance(WALLET).debits_posted).toBe(0n);
		expect(balance(TASK).debits_posted).toBe(0n);
	});
});

/**
 * A post or void pair sends 0 for every field TigerBeetle takes from the pending transfer, so the
 * replay compare's wildcards are exact: the stored values are the pending's (state_machine.zig
 * :4195-4209), fixed by `pending_id`.
 */
function expectInheritedFieldsSentAsZero(batch: SentTransfer[]): void {
	expect(batch).toHaveLength(2);
	for (const t of batch) {
		expect([t.debit_account_id, t.credit_account_id, t.ledger, t.code]).toEqual([0n, 0n, 0, 0]);
		expect([t.user_data_128, t.user_data_64, t.user_data_32]).toEqual([0n, 0n, 0]);
		expect(t.timeout).toBe(0);
	}
}

describe("postLinkedPair and voidLinkedPair", () => {
	async function heldPair(amount: number, timeoutSeconds = HOLD_S) {
		await ledgers(1_000n, 1_000n);
		const ids = await client.createLinkedPendingPair(pairFor(amount, timeoutSeconds));
		fake.requests.length = 0;
		return ids;
	}

	it("postLinkedPair posts both legs at the same amount, linked", async () => {
		const { payerId, limitId } = await heldPair(400);
		await client.postLinkedPair(payerId, limitId, 250);
		expect(requestsOf("createTransfers")).toHaveLength(1);
		const [a, b] = sentBatch(0);
		expect(a).toMatchObject({
			pending_id: payerId,
			amount: 250n,
			flags: TF.post_pending_transfer | TF.linked,
		});
		expect(b).toMatchObject({ pending_id: limitId, amount: 250n, flags: TF.post_pending_transfer });
		expectInheritedFieldsSentAsZero(sentBatch(0));
		expect(balance(WALLET)).toMatchObject({ debits_pending: 0n, debits_posted: 250n });
		expect(balance(TASK)).toMatchObject({ debits_pending: 0n, debits_posted: 250n });
	});

	it("a full post sends the held amount, never amount_max", async () => {
		// The replay compare for a post rests on this: a concrete amount is stored as sent, so a
		// replay compares it exactly. amount_max would be stored as the pending's amount
		// (state_machine.zig@0.17.9:4119) and could only be checked against the pending record.
		const { payerId, limitId } = await heldPair(400);
		await client.postLinkedPair(payerId, limitId, 400);
		const sent = sentBatch(0);
		expect(sent.map((t) => t.amount)).toEqual([400n, 400n]);
		for (const t of sent) expect(t.amount).not.toBe(fixture.AMOUNT_MAX);
		expect(sent.map((t) => fake.transfers.get(t.id)?.amount)).toEqual([400n, 400n]);
		expect(balance(TASK)).toMatchObject({ debits_pending: 0n, debits_posted: 400n });
	});

	it("a post above the pending amount is the payer leg's code, as a plain TBTransferError", async () => {
		const { payerId, limitId } = await heldPair(400);
		const err = await settle(client.postLinkedPair(payerId, limitId, 401));
		expect(err).not.toBeInstanceOf(TaskLimitLegError);
		expect((err as TBTransferError).code).toBe(S.exceeds_pending_transfer_amount);
		expect(balance(TASK).debits_pending).toBe(400n);
	});

	it("a post the limit leg refuses is TaskLimitLegError with the limit code", async () => {
		const { payerId, limitId } = await heldPair(400);
		// The limit leg alone was voided out of band.
		await fake.client.createTransfers([
			transferOf({ id: 9_100n, pending_id: limitId, flags: TF.void_pending_transfer }),
		]);
		const err = await settle(client.postLinkedPair(payerId, limitId, 100));
		expect(err).toBeInstanceOf(TaskLimitLegError);
		expect((err as TaskLimitLegError).code).toBe(S.pending_transfer_already_voided);
		expect(balance(WALLET).debits_pending).toBe(400n);
	});

	it("a replayed post pair is verified by one lookup of both legs", async () => {
		const { payerId, limitId } = await heldPair(400);
		loseFirstReply();
		await client.postLinkedPair(payerId, limitId, 300);
		expect(fake.requests.map((r) => r.op)).toEqual([
			"createTransfers",
			"createTransfers",
			"lookupTransfers",
		]);
		const sent = sentBatch(0);
		expect(requestsOf("lookupTransfers")[0]?.batch).toEqual(sent.map((t) => t.id));
		expect(balance(TASK).debits_posted).toBe(300n);
	});

	it.each<[string, (t: SentTransfer) => SentTransfer]>([
		["amount", (t: SentTransfer) => ({ ...t, amount: t.amount - 1n })],
		["flags", (t: SentTransfer) => ({ ...t, flags: TF.void_pending_transfer })],
		["pending_id", (t: SentTransfer) => ({ ...t, pending_id: 77n })],
		["timeout", (t: SentTransfer) => ({ ...t, timeout: t.timeout + 9 })],
	])("a replayed post pair with a mismatched %s is a hard failure", async (field, change) => {
		const { payerId, limitId } = await heldPair(400);
		const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		replayAnswer((sent) => [sent[0] as SentTransfer, change(sent[1] as SentTransfer)]);
		const err = await settle(client.postLinkedPair(payerId, limitId, 300));
		expect(err).toBeInstanceOf(TransferReplayMismatchError);
		expect((err as TransferReplayMismatchError).field).toBe(field);
		expect(emit).toHaveBeenCalledWith(expect.any(String), { code: LINKED_PAIR_MISMATCH_WARNING });
	});

	it("a replayed post pair with only one leg stored is a hard failure and an integrity warning", async () => {
		const { payerId, limitId } = await heldPair(400);
		const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		replayAnswer((sent) => sent.slice(0, 1));
		const err = await settle(client.postLinkedPair(payerId, limitId, 300));
		expect(err).toBeInstanceOf(TransferReplayMismatchError);
		expect((err as TransferReplayMismatchError).field).toBe("record (none found)");
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it("voidLinkedPair voids both legs, linked, and the whole amount returns", async () => {
		const { payerId, limitId } = await heldPair(400);
		await client.voidLinkedPair(payerId, limitId);
		const [a, b] = sentBatch(0);
		expect(a).toMatchObject({
			pending_id: payerId,
			amount: 0n,
			flags: TF.void_pending_transfer | TF.linked,
		});
		expect(b).toMatchObject({ pending_id: limitId, amount: 0n, flags: TF.void_pending_transfer });
		expectInheritedFieldsSentAsZero(sentBatch(0));
		expect(balance(WALLET)).toMatchObject({ debits_pending: 0n, debits_posted: 0n });
		expect(balance(TASK)).toMatchObject({ debits_pending: 0n, debits_posted: 0n });
		expect(fake.pendingState.get(limitId)).toBe("voided");
	});

	it("voidLinkedPair on an expired pair: pending_transfer_expired on the payer leg surfaces as that code", async () => {
		const { payerId, limitId } = await heldPair(400, EXPIRY_S);
		fake.advanceSeconds(EXPIRY_S);
		const err = await settle(client.voidLinkedPair(payerId, limitId));
		expect(err).toBeInstanceOf(TBTransferError);
		expect(err).not.toBeInstanceOf(TaskLimitLegError);
		expect((err as TBTransferError).code).toBe(S.pending_transfer_expired);
	});

	it("a replayed void pair is verified by one lookup of both legs", async () => {
		const { payerId, limitId } = await heldPair(400);
		loseFirstReply();
		await client.voidLinkedPair(payerId, limitId);
		expect(fake.requests.map((r) => r.op)).toEqual([
			"createTransfers",
			"createTransfers",
			"lookupTransfers",
		]);
		expect(fake.pendingState.get(payerId)).toBe("voided");
		// The stored voids carry the pending's accounts, ledger, code and amount, not the zeros
		// sent: the compare accepts them by TigerBeetle's own rule.
		const stored = sentBatch(0).map((t) => fake.transfers.get(t.id));
		expect(stored.map((t) => t?.amount)).toEqual([400n, 400n]);
		expect(stored.map((t) => t?.ledger)).toEqual([LEDGER_USERTOKENS, LEDGER_TASK_LIMITS]);
	});

	for (const leg of [0, 1] as const) {
		it.each<[string, (t: SentTransfer) => SentTransfer]>([
			["flags", (t: SentTransfer) => ({ ...t, flags: t.flags ^ TF.linked })],
			["pending_id", (t: SentTransfer) => ({ ...t, pending_id: 77n })],
			["timeout", (t: SentTransfer) => ({ ...t, timeout: t.timeout + 9 })],
		])(
			`a replayed void pair with a mismatched %s is a hard failure: the ${leg === 0 ? "payer" : "limit"} leg`,
			async (field, change) => {
				const { payerId, limitId } = await heldPair(400);
				const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
				replayAnswer((sent) => sent.map((t, i) => (i === leg ? change(t) : t)));
				const err = await settle(client.voidLinkedPair(payerId, limitId));
				expect(err).toBeInstanceOf(TransferReplayMismatchError);
				expect((err as TransferReplayMismatchError).field).toBe(field);
				expect((err as TransferReplayMismatchError).transferId).toBe(sentBatch(0)[leg]?.id);
				expect(emit).toHaveBeenCalledWith(expect.any(String), {
					code: LINKED_PAIR_MISMATCH_WARNING,
				});
			},
		);
	}

	it.each([
		["payer", 0],
		["limit", 1],
	] as const)(
		"a replayed void pair with only one leg stored is a hard failure and an integrity warning: the %s leg missing",
		async (_name, missing) => {
			const { payerId, limitId } = await heldPair(400);
			const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
			replayAnswer((sent) => sent.filter((_t, i) => i !== missing));
			const err = await settle(client.voidLinkedPair(payerId, limitId));
			expect(err).toBeInstanceOf(TransferReplayMismatchError);
			expect((err as TransferReplayMismatchError).transferId).toBe(sentBatch(0)[missing]?.id);
			expect((err as TransferReplayMismatchError).field).toBe("record (none found)");
			expect(emit).toHaveBeenCalledTimes(1);
		},
	);
});

describe("immediateTransfer on the task-limit ledger", () => {
	it("immediateTransfer with ledger 2 submits ledger 2 and verifies a caller-supplied id as before", async () => {
		await ledgers(1_000n, 0n);
		const grantId = TrustTBClient.deriveTransferId("grant-key", "limit");
		const grant = {
			ledger: LEDGER_TASK_LIMITS,
			debitAccountId: OPERATOR,
			creditAccountId: TASK,
			amount: 500,
			code: XFER_TASK_LIMIT_GRANT,
			transferId: grantId,
			userData128: TASK,
		};
		await expect(client.immediateTransfer(grant)).resolves.toBe(grantId);
		expect(sentBatch(0)[0]).toMatchObject({
			id: grantId,
			ledger: LEDGER_TASK_LIMITS,
			code: XFER_TASK_LIMIT_GRANT,
			flags: 0,
			user_data_128: TASK,
		});
		expect(balance(TASK).credits_posted).toBe(500n);
		// The replay answers `exists`, is looked up and verified, and moves nothing.
		await expect(client.immediateTransfer(grant)).resolves.toBe(grantId);
		expect(requestsOf("lookupTransfers")).toHaveLength(1);
		expect(balance(TASK).credits_posted).toBe(500n);
		// The same id with another amount is the server's own conflict.
		const err = await settle(client.immediateTransfer({ ...grant, amount: 700 }));
		expect(err).toBeInstanceOf(TBTransferError);
		expect((err as TBTransferError).code).toBe(S.exists_with_different_amount);
	});

	it("a grant sent before its task account exists retires the derived grant id", async () => {
		// Why ensure must be strictly sequential (operator, then account, then grant): the first
		// attempt fails with credit_account_not_found, a transient code, and TigerBeetle then
		// answers id_already_failed to that id for good.
		const operator = await client.createTaskLimitOperator("local");
		const key = TrustTBClient.deriveTaskLimitAccountId("local", "early");
		const grant = {
			ledger: LEDGER_TASK_LIMITS,
			transferId: TrustTBClient.deriveTransferId(key.toString(16).padStart(32, "0"), "limit"),
			debitAccountId: operator,
			creditAccountId: key,
			amount: 500,
			code: XFER_TASK_LIMIT_GRANT,
			userData128: key,
		};
		const early = await settle(client.immediateTransfer(grant));
		expect(early).toBeInstanceOf(TBTransferError);
		expect((early as TBTransferError).code).toBe(S.credit_account_not_found);
		await client.createTaskLimitAccount("local", "early");
		const retired = await settle(client.immediateTransfer(grant));
		expect(retired).toBeInstanceOf(TransferIdRetiredError);
		expect(balance(key).credits_posted).toBe(0n);
	});

	it("immediateTransfer without a ledger stays on the usertoken ledger", async () => {
		await ledgers(1_000n, 0n);
		await client.immediateTransfer({
			debitAccountId: TREASURY,
			creditAccountId: WALLET,
			amount: 5,
			code: 5,
		});
		expect(sentBatch(0)[0]?.ledger).toBe(LEDGER_USERTOKENS);
	});
});
