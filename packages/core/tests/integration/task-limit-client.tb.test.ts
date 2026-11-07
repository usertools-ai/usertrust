// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Real TigerBeetle: the ledger client's task-limit primitives.
 *
 * A task limit is an account on a second ledger, debited beside the payer by each hold made
 * inside the task, as one linked pair of pending transfers. The unit suites pin the client
 * against a fake (`tests/fixtures/tb-linked-fake.ts`); this file pins what only a real cluster
 * can show:
 *  - an abandoned pair's amounts return to the task when the ledger expires it, and the stored
 *    records still read pending;
 *  - ensuring a task's limit from two clients at once grants it once, a replay is verified, and
 *    another limit under the same grant id is the ledger's own conflict;
 *  - the fake answers every chain in one script exactly as the cluster does, a replayed pair
 *    included: in 0.17.9 an `exists` inside a linked chain breaks the chain, so the replay
 *    answers `[exists, linked_event_failed]`;
 *  - the client recovers a replayed pair by looking both legs up, and a pair recovered after its
 *    timeout is not a live hold: its post takes the expired path.
 *
 * A reply lost after the request committed is made by wrapping the native client: the request
 * reaches the cluster, and the client sees "connection refused", reconnects and resends it.
 *
 * Self-skips (via `describe.skipIf`) whenever `USERTRUST_TB_ADDRESS` is unset. All cluster code
 * lives inside the `it` bodies, and every row uses fresh random ids and namespaces, so rows never
 * collide on the shared cluster.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Lost replies: armed per row, and every answer a two-transfer request got from the cluster. */
const flow = vi.hoisted(() => ({
	/** Lose the reply of the next two-transfer request once it has committed. */
	loseNextPairReply: null as null | { beforeError: () => Promise<void> },
	/** The status names the cluster gave each two-transfer request, in order. */
	pairAnswers: [] as string[][],
}));

vi.mock("tigerbeetle-node", async (importOriginal) => {
	const actual = await importOriginal<typeof import("tigerbeetle-node")>();
	type Native = ReturnType<typeof actual.createClient>;
	type Batch = Parameters<Native["createTransfers"]>[0];
	return {
		...actual,
		createClient: (args: Parameters<typeof actual.createClient>[0]) => {
			const client = actual.createClient(args);
			const createTransfers = async (batch: Batch) => {
				const results = await client.createTransfers(batch);
				if (batch.length !== 2) return results;
				flow.pairAnswers.push(results.map((r) => String(actual.CreateTransferStatus[r.status])));
				const lose = flow.loseNextPairReply;
				if (lose === null) return results;
				flow.loseNextPairReply = null;
				await lose.beforeError();
				throw new Error("connection refused");
			};
			const destroy = (): void => client.destroy();
			return new Proxy(client, {
				get(target, prop, receiver) {
					if (prop === "createTransfers") return createTransfers;
					if (prop === "destroy") return destroy;
					return Reflect.get(target, prop, receiver);
				},
			});
		},
	};
});

import {
	CODE_PLATFORM_TREASURY,
	CODE_TASK_LIMIT,
	CODE_TASK_LIMIT_OPERATOR,
	CODE_USER_WALLET,
	LEDGER_TASK_LIMITS,
	LEDGER_USERTOKENS,
	TaskLimitLegError,
	TBTransferError,
	TransferIdRetiredError,
	TrustTBClient,
	XFER_PURCHASE,
	XFER_SPEND,
	XFER_TASK_LIMIT_GRANT,
	XFER_TASK_LIMIT_HOLD,
} from "../../src/ledger/client.js";
import {
	accountOf,
	createLinkedFake,
	FAKE_FLAGS,
	FAKE_STATUS,
	fakeModule,
	transferOf,
} from "../fixtures/tb-linked-fake.js";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;

/** A hold that expires during the row. */
const EXPIRY_S = 2;
/** A hold that outlives the row; it is posted or voided before the row ends. */
const LONG_S = 300;

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	flow.loseNextPairReply = null;
	flow.pairAnswers = [];
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A random id in (0, 2^128 - 1): fresh per run, so rows never meet on the shared cluster. */
const freshId = (): bigint => BigInt(`0x${randomBytes(16).toString("hex")}`) | 1n;

/** Polls `done` every 250 ms; throws when the ledger has not got there within the bound. */
async function until(what: string, done: () => Promise<boolean>): Promise<void> {
	// timing: 30 s budget for the ledger to expire a 2 s hold (removal is best-effort, with no
	// documented bound); slowest of 20 CI runs: NOT YET MEASURED, record it here before merge.
	const deadline = Date.now() + 30_000;
	while (!(await done())) {
		// timing: the same 30 s budget as the deadline above; the poll interval is 250 ms.
		if (Date.now() > deadline) throw new Error(`the ledger did not ${what} within 30 s`);
		// timing: a 250 ms poll interval inside the 30 s budget above.
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

function newClient(): TrustTBClient {
	const tb = new TrustTBClient({ addresses: [TB_ADDRESS as string], clusterId: 0n });
	cleanup.push(() => tb.destroy());
	return tb;
}

/**
 * A namespace with a task account granted `limit`, and a payer wallet funded `funds`, through
 * the client's own methods. Returns the ids a pair needs.
 */
async function taskWithPayer(tb: TrustTBClient, limit: number, funds: number) {
	const namespace = `tl-${randomUUID()}`;
	const taskId = `task-${randomUUID().slice(0, 8)}`;
	const operator = await tb.createTaskLimitOperator(namespace);
	const task = await tb.createTaskLimitAccount(namespace, taskId);
	const keyHex = task.toString(16).padStart(32, "0");
	await tb.immediateTransfer({
		ledger: LEDGER_TASK_LIMITS,
		transferId: TrustTBClient.deriveTransferId(keyHex, "limit"),
		debitAccountId: operator,
		creditAccountId: task,
		amount: limit,
		code: XFER_TASK_LIMIT_GRANT,
		userData128: task,
	});
	const treasury = await tb.createTreasury();
	const payer = await tb.createUserWallet(`tl-payer-${randomUUID()}`);
	await tb.immediateTransfer({
		debitAccountId: treasury,
		creditAccountId: payer,
		amount: funds,
		code: XFER_PURCHASE,
	});
	const pair = (amount: number, timeoutSeconds = LONG_S) => ({
		amount,
		timeoutSeconds,
		payer: { debitAccountId: payer, creditAccountId: treasury, code: XFER_SPEND },
		limit: { debitAccountId: task, creditAccountId: operator, userData128: task },
	});
	const pending = async () => {
		const accounts = await tb.lookupAccounts([task, payer]);
		const of = (id: bigint) => accounts.find((a) => a.id === id)?.debits_pending;
		return { task: of(task), payer: of(payer) };
	};
	return { namespace, taskId, operator, task, keyHex, treasury, payer, pair, pending };
}

describe.skipIf(!TB_ADDRESS)("real TigerBeetle: task-limit ledger primitives", () => {
	it("a pair abandoned mid-task returns to the task when the ledger expires it", async () => {
		const tb = newClient();
		const t = await taskWithPayer(tb, 1_000, 10_000);

		const abandoned = await tb.createLinkedPendingPair(t.pair(600, EXPIRY_S));
		expect(await t.pending()).toEqual({ task: 600n, payer: 600n });

		// The task has 400 left: a second 600 is the limit leg's refusal, and the payer leg is
		// rolled back with it.
		const refused = await tb.createLinkedPendingPair(t.pair(600, EXPIRY_S)).catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(TaskLimitLegError);
		expect((refused as TaskLimitLegError).code).toBe(FAKE_STATUS.exceeds_credits);
		expect(await t.pending()).toEqual({ task: 600n, payer: 600n });

		// Nobody posts or voids it.
		await until("expire the abandoned pair", async () => {
			const p = await t.pending();
			return p.task === 0n && p.payer === 0n;
		});

		// The whole limit is back.
		const whole = await tb.createLinkedPendingPair(t.pair(1_000));
		expect(await t.pending()).toEqual({ task: 1_000n, payer: 1_000n });

		// The stored records of the expired legs do not change: they still read pending.
		for (const id of [abandoned.payerId, abandoned.limitId]) {
			const stored = await tb.lookupTransfer(id);
			expect((stored?.flags ?? 0) & FAKE_FLAGS.transfer.pending).toBe(FAKE_FLAGS.transfer.pending);
		}
		const leg = await tb.lookupTransfer(abandoned.limitId);
		expect(leg).toMatchObject({
			ledger: LEDGER_TASK_LIMITS,
			code: XFER_TASK_LIMIT_HOLD,
			timeout: EXPIRY_S,
			user_data_128: t.task,
		});

		await tb.voidLinkedPair(whole.payerId, whole.limitId);
		expect(await t.pending()).toEqual({ task: 0n, payer: 0n });
	}, 60_000); // timing: 60 s test budget over the 30 s expiry poll above; NOT YET MEASURED on CI.

	it("ensuring a task's limit is idempotent across clients and replays", async () => {
		const first = newClient();
		const second = newClient();
		const namespace = `tl-${randomUUID()}`;
		const taskId = `task-${randomUUID().slice(0, 8)}`;
		const key = TrustTBClient.deriveTaskLimitAccountId(namespace, taskId);
		const keyHex = key.toString(16).padStart(32, "0");
		const grantId = TrustTBClient.deriveTransferId(keyHex, "limit");
		const ensure = async (tb: TrustTBClient, limit: number) => {
			const operator = await tb.createTaskLimitOperator(namespace);
			const task = await tb.createTaskLimitAccount(namespace, taskId);
			return tb.immediateTransfer({
				ledger: LEDGER_TASK_LIMITS,
				transferId: grantId,
				debitAccountId: operator,
				creditAccountId: task,
				amount: limit,
				code: XFER_TASK_LIMIT_GRANT,
				userData128: task,
			});
		};

		await expect(Promise.all([ensure(first, 500), ensure(second, 500)])).resolves.toEqual([
			grantId,
			grantId,
		]);
		const grant = await first.lookupTransfer(grantId);
		expect(grant).toMatchObject({
			amount: 500n,
			ledger: LEDGER_TASK_LIMITS,
			code: XFER_TASK_LIMIT_GRANT,
			credit_account_id: key,
			user_data_128: key,
		});
		const [account] = await first.lookupAccounts([key]);
		expect(account).toMatchObject({
			credits_posted: 500n,
			ledger: LEDGER_TASK_LIMITS,
			code: CODE_TASK_LIMIT,
			user_data_128: TrustTBClient.taskNamespaceTag(namespace),
			user_data_64: 0n,
			user_data_32: 1,
		});
		const [operator] = await first.lookupAccounts([TrustTBClient.deriveTaskLimitOperatorId(namespace)]);
		expect(operator?.code).toBe(CODE_TASK_LIMIT_OPERATOR);

		// A third ensure is a replay: `exists`, verified, and nothing moves.
		await expect(ensure(second, 500)).resolves.toBe(grantId);
		expect((await first.lookupAccounts([key]))[0]?.credits_posted).toBe(500n);

		// Another limit under the same grant id is the ledger's own conflict.
		const conflict = await ensure(first, 700).catch((e: unknown) => e);
		expect(conflict).toBeInstanceOf(TBTransferError);
		expect((conflict as TBTransferError).code).toBe(FAKE_STATUS.exists_with_different_amount);
		expect((await first.lookupAccounts([key]))[0]?.credits_posted).toBe(500n);
	});

	it("the fake agrees with the real cluster on every scripted chain", async () => {
		const tbNode = await import("tigerbeetle-node");
		const raw = tbNode.createClient({ cluster_id: 0n, replica_addresses: [TB_ADDRESS as string] });
		cleanup.push(() => raw.destroy());
		const fake = createLinkedFake();
		const fakeNames = fakeModule(fake).CreateTransferStatus;

		const AF = FAKE_FLAGS.account;
		const TF = FAKE_FLAGS.transfer;
		const ids = {
			treasury: freshId(),
			payer: freshId(),
			rich: freshId(),
			operator: freshId(),
			task: freshId(),
			roomy: freshId(),
		};
		const wallet = AF.debits_must_not_exceed_credits | AF.history;
		const accounts = [
			accountOf({ id: ids.treasury, ledger: 1, code: CODE_PLATFORM_TREASURY, flags: AF.history }),
			accountOf({ id: ids.payer, ledger: 1, code: CODE_USER_WALLET, flags: wallet }),
			accountOf({ id: ids.rich, ledger: 1, code: CODE_USER_WALLET, flags: wallet }),
			accountOf({ id: ids.operator, ledger: 2, code: CODE_TASK_LIMIT_OPERATOR, flags: AF.history }),
			accountOf({ id: ids.task, ledger: 2, code: CODE_TASK_LIMIT, flags: wallet }),
			accountOf({ id: ids.roomy, ledger: 2, code: CODE_TASK_LIMIT, flags: wallet }),
		];
		const realAccounts = await raw.createAccounts(accounts);
		expect(realAccounts.map((r) => String(tbNode.CreateAccountStatus[r.status]))).toEqual(
			Array(accounts.length).fill("created"),
		);
		await fake.client.createAccounts(accounts);

		type T = ReturnType<typeof transferOf>;
		/** One request on both ledgers: the status names each answered. */
		const both = async (batch: T[]) => {
			const real = await raw.createTransfers(batch);
			const faked = await fake.client.createTransfers(batch);
			return {
				real: real.map((r) => String(tbNode.CreateTransferStatus[r.status])),
				fake: faked.map((r) => String(fakeNames[r.status])),
			};
		};
		const used = new Set<string>();
		const step = async (name: string, batch: T[], expected: string[]) => {
			const answers = await both(batch);
			for (const n of [...answers.real, ...answers.fake]) used.add(n);
			expect({ step: name, ...answers }).toEqual({ step: name, real: expected, fake: expected });
		};
		const fund = (debit: bigint, credit: bigint, amount: bigint, ledger: number) =>
			transferOf({
				id: freshId(),
				debit_account_id: debit,
				credit_account_id: credit,
				amount,
				ledger,
				code: XFER_PURCHASE,
			});
		const pair = (
			payer: bigint,
			task: bigint,
			amount: bigint,
			timeoutSeconds = LONG_S,
			legs = { a: freshId(), b: freshId() },
		): T[] => [
			transferOf({
				id: legs.a,
				debit_account_id: payer,
				credit_account_id: ids.treasury,
				amount,
				ledger: LEDGER_USERTOKENS,
				code: XFER_SPEND,
				flags: TF.pending | TF.linked,
				timeoutSeconds,
			}),
			transferOf({
				id: legs.b,
				debit_account_id: task,
				credit_account_id: ids.operator,
				amount,
				ledger: LEDGER_TASK_LIMITS,
				code: XFER_TASK_LIMIT_HOLD,
				flags: TF.pending,
				timeoutSeconds,
				user_data_128: task,
			}),
		];
		const legsOf = (batch: T[]) => ({ a: batch[0]?.id ?? 0n, b: batch[1]?.id ?? 0n });
		/**
		 * What each ledger STORED for `batch`, every field but the timestamp. A post or void stores
		 * the pending's accounts, ledger and code, and the pending's user data where 0 was sent
		 * (state_machine.zig@0.17.9:4195-4209): the fake must store the same, or a replay compare
		 * that passes on it could fail on the cluster.
		 */
		const storedAgree = async (name: string, batch: T[]) => {
			const strip = (list: T[]) =>
				Object.fromEntries(
					list.map(({ timestamp: _t, ...rest }) => [rest.id.toString(16), rest]),
				);
			const ids = batch.map((t) => t.id);
			const real = await raw.lookupTransfers(ids);
			const faked = await fake.client.lookupTransfers(ids);
			expect({ step: name, found: real.length }).toEqual({ step: name, found: ids.length });
			expect({ step: name, stored: strip(faked) }).toEqual({ step: name, stored: strip(real) });
		};
		const resolve = (legs: { a: bigint; b: bigint }, flag: number, amount: bigint): T[] => [
			transferOf({ id: freshId(), pending_id: legs.a, amount, flags: flag | TF.linked }),
			transferOf({ id: freshId(), pending_id: legs.b, amount, flags: flag }),
		];

		await step(
			"funding: the payers on ledger 1, the task accounts on ledger 2",
			[
				fund(ids.treasury, ids.payer, 1_000n, 1),
				fund(ids.treasury, ids.rich, 10_000n, 1),
				{ ...fund(ids.operator, ids.task, 1_000n, 2), code: XFER_TASK_LIMIT_GRANT },
				{ ...fund(ids.operator, ids.roomy, 10_000n, 2), code: XFER_TASK_LIMIT_GRANT },
			],
			["created", "created", "created", "created"],
		);
		const first = pair(ids.payer, ids.task, 600n);
		await step("a pair inside both bounds, across two ledgers", first, ["created", "created"]);
		await step("the payer leg exceeds its credits", pair(ids.payer, ids.roomy, 500n), [
			"exceeds_credits",
			"linked_event_failed",
		]);
		await step("the limit leg exceeds its credits", pair(ids.rich, ids.task, 500n), [
			"linked_event_failed",
			"exceeds_credits",
		]);
		await step("a replay of a created pair", first, ["exists", "linked_event_failed"]);
		await step(
			"a replay of a created pair with another amount",
			pair(ids.payer, ids.task, 601n, LONG_S, legsOf(first)),
			["exists_with_different_amount", "linked_event_failed"],
		);
		const partial = resolve(legsOf(first), TF.post_pending_transfer, 250n);
		await step("post part of a pair", partial, ["created", "created"]);
		await storedAgree("the stored post pair", partial);
		await step("a replayed post pair", partial, ["exists", "linked_event_failed"]);
		const second = pair(ids.payer, ids.task, 100n);
		await step("a second pair", second, ["created", "created"]);
		await step(
			"a post above the pending amount",
			resolve(legsOf(second), TF.post_pending_transfer, 150n),
			["exceeds_pending_transfer_amount", "linked_event_failed"],
		);
		const voided = resolve(legsOf(second), TF.void_pending_transfer, 0n);
		await step("void a pair", voided, ["created", "created"]);
		await storedAgree("the stored void pair", voided);
		await step("a replayed void pair", voided, ["exists", "linked_event_failed"]);
		const [payerLeg] = pair(ids.payer, ids.task, 1n);
		if (!payerLeg) throw new Error("pair() builds two transfers");
		await step(
			"a chain whose second leg's accounts are on two ledgers",
			[
				payerLeg,
				transferOf({
					id: freshId(),
					debit_account_id: ids.task,
					credit_account_id: ids.treasury,
					amount: 1n,
					ledger: LEDGER_TASK_LIMITS,
					code: XFER_TASK_LIMIT_HOLD,
					flags: TF.pending,
					timeoutSeconds: LONG_S,
				}),
			],
			["linked_event_failed", "accounts_must_have_the_same_ledger"],
		);
		await step("a trailing linked flag on one event", [{ ...payerLeg, id: freshId() }], [
			"linked_event_chain_open",
		]);
		const open = pair(ids.payer, ids.task, 1n);
		await step(
			"a trailing linked flag closing a chain",
			open.map((t) => ({ ...t, flags: t.flags | TF.linked })),
			["linked_event_failed", "linked_event_chain_open"],
		);
		const expiring = pair(ids.payer, ids.task, 50n, EXPIRY_S);
		await step("a pair with a short timeout", expiring, ["created", "created"]);
		fake.advanceSeconds(EXPIRY_S);
		await until("expire the short pair", async () => {
			const found = await raw.lookupAccounts([ids.payer, ids.task]);
			return found.length === 2 && found.every((a) => a.debits_pending === 0n);
		});
		await step(
			"void after expiry",
			resolve(legsOf(expiring), TF.void_pending_transfer, 0n),
			["pending_transfer_expired", "linked_event_failed"],
		);
		const rest = pair(ids.rich, ids.task, 750n);
		await step("the whole remaining limit after expiry", rest, ["created", "created"]);
		await step("one more usertoken than the limit allows", pair(ids.rich, ids.task, 1n), [
			"linked_event_failed",
			"exceeds_credits",
		]);
		await step("release it", resolve(legsOf(rest), TF.void_pending_transfer, 0n), [
			"created",
			"created",
		]);

		// The balances agree too, account by account.
		const real = await raw.lookupAccounts(accounts.map((a) => a.id));
		const faked = await fake.client.lookupAccounts(accounts.map((a) => a.id));
		const view = (list: typeof real) =>
			Object.fromEntries(
				list.map((a) => [
					a.id.toString(16),
					[a.debits_pending, a.debits_posted, a.credits_pending, a.credits_posted],
				]),
			);
		expect(view(faked)).toEqual(view(real));

		// Every status the fake used has the real binding's value.
		const realStatus = tbNode.CreateTransferStatus as unknown as Record<string, number>;
		const fakeStatus = FAKE_STATUS as unknown as Record<string, number>;
		for (const n of used) expect([n, fakeStatus[n]]).toEqual([n, realStatus[n]]);
	}, 60_000); // timing: 60 s test budget over the 30 s expiry poll above; NOT YET MEASURED on CI.

	it("a replayed pair answers exists, then linked_event_failed, and the client recovers it with one lookup", async () => {
		const tb = newClient();
		const t = await taskWithPayer(tb, 1_000, 10_000);
		flow.loseNextPairReply = { beforeError: async () => {} };

		const ids = await tb.createLinkedPendingPair(t.pair(400));
		expect(flow.pairAnswers).toEqual([
			["created", "created"],
			["exists", "linked_event_failed"],
		]);
		// Held once, not twice.
		expect(await t.pending()).toEqual({ task: 400n, payer: 400n });
		expect(await tb.lookupTransfer(ids.limitId)).toMatchObject({
			ledger: LEDGER_TASK_LIMITS,
			code: XFER_TASK_LIMIT_HOLD,
			amount: 400n,
		});

		// A replayed post is recovered the same way.
		flow.loseNextPairReply = { beforeError: async () => {} };
		await tb.postLinkedPair(ids.payerId, ids.limitId, 300);
		expect(flow.pairAnswers.slice(2)).toEqual([
			["created", "created"],
			["exists", "linked_event_failed"],
		]);
		const [task] = await tb.lookupAccounts([t.task]);
		expect(task).toMatchObject({ debits_pending: 0n, debits_posted: 300n });

		// And a replayed void: the cluster answers the resend [exists, linked_event_failed], and
		// the client's compare by TigerBeetle's own rule (state_machine.zig@0.17.9:4301-4381)
		// accepts the stored void, which carries the pending's accounts, ledger, code and amount.
		const released = await tb.createLinkedPendingPair(t.pair(200));
		flow.loseNextPairReply = { beforeError: async () => {} };
		await tb.voidLinkedPair(released.payerId, released.limitId);
		expect(flow.pairAnswers.slice(4)).toEqual([
			["created", "created"],
			["created", "created"],
			["exists", "linked_event_failed"],
		]);
		expect(await t.pending()).toEqual({ task: 0n, payer: 0n });
		const [after] = await tb.lookupAccounts([t.task]);
		expect(after).toMatchObject({ debits_posted: 300n, credits_posted: 1_000n });
	});

	it("a grant sent before its task account exists retires the derived grant id", async () => {
		// Why ensure is strictly sequential: credit_account_not_found is a transient code, and a
		// transfer id whose first attempt failed with one is refused for good (id_already_failed,
		// create_transfers.md). This task id can never get its limit under the derived grant id.
		const tb = newClient();
		const namespace = `tl-${randomUUID()}`;
		const taskId = `task-${randomUUID().slice(0, 8)}`;
		const operator = await tb.createTaskLimitOperator(namespace);
		const key = TrustTBClient.deriveTaskLimitAccountId(namespace, taskId);
		const grant = {
			ledger: LEDGER_TASK_LIMITS,
			transferId: TrustTBClient.deriveTransferId(key.toString(16).padStart(32, "0"), "limit"),
			debitAccountId: operator,
			creditAccountId: key,
			amount: 500,
			code: XFER_TASK_LIMIT_GRANT,
			userData128: key,
		};
		const early = await tb.immediateTransfer(grant).catch((e: unknown) => e);
		expect(early).toBeInstanceOf(TBTransferError);
		expect((early as TBTransferError).code).toBe(FAKE_STATUS.credit_account_not_found);
		await tb.createTaskLimitAccount(namespace, taskId);
		const retired = await tb.immediateTransfer(grant).catch((e: unknown) => e);
		expect(retired).toBeInstanceOf(TransferIdRetiredError);
		expect((retired as TBTransferError).code).toBe(FAKE_STATUS.id_already_failed);
		expect((await tb.lookupAccounts([key]))[0]?.credits_posted).toBe(0n);
	});

	it("a pair replayed after it expired is not a live hold", async () => {
		const tb = newClient();
		const t = await taskWithPayer(tb, 1_000, 10_000);
		// The pair commits, its reply is lost, and the resend reaches the cluster only once the
		// pair has expired.
		flow.loseNextPairReply = {
			beforeError: () =>
				until("expire the pair whose reply was lost", async () => {
					const p = await t.pending();
					return p.task === 0n && p.payer === 0n;
				}),
		};

		const ids = await tb.createLinkedPendingPair(t.pair(400, EXPIRY_S));
		expect(flow.pairAnswers).toEqual([
			["created", "created"],
			["exists", "linked_event_failed"],
		]);
		expect(await t.pending()).toEqual({ task: 0n, payer: 0n });

		// The recovered pair is gone from the ledger: its post is the existing expired path, on
		// the payer leg, and charges nothing.
		const err = await tb.postLinkedPair(ids.payerId, ids.limitId, 400).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TBTransferError);
		expect(err).not.toBeInstanceOf(TaskLimitLegError);
		expect((err as TBTransferError).code).toBe(FAKE_STATUS.pending_transfer_expired);
		// The task's spent EXCLUDES the call whose settle did not complete (disclosed, not charged):
		// nothing is posted on the task, nothing is held, and its limit is untouched.
		const [task] = await tb.lookupAccounts([t.task]);
		expect(task?.debits_posted).toBe(0n);
		expect(task?.debits_pending).toBe(0n);
		expect(task?.credits_posted).toBe(1_000n);
	}, 60_000); // timing: 60 s test budget over the 30 s expiry poll above; NOT YET MEASURED on CI.
});
