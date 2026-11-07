// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Real TigerBeetle: the ledger engine's task-limit legs.
 *
 * The unit suite (`tests/govern/task-limit-engine.test.ts`) pins the engine against the
 * linked-chain fake. This file pins what only a real cluster can show:
 *  - parallel holds in one task, raced from four ledger clients, are admitted exactly up to the
 *    task's limit, whatever the interleaving;
 *  - task legs stay off the usertoken ledger: the usertoken ledger's spend transfers add up to
 *    the posted costs alone, and one query of the task-limit ledger by the task's key returns
 *    every limit leg;
 *  - a post after the payer leg expired takes today's expired path, and the task's spent leaves
 *    the call out (it is disclosed, not charged);
 *  - a pair refused by its limit leg whose reply was lost is resent under the same ids, answers
 *    id_already_failed, and is then submitted once under new ids and read on its merits: still
 *    refused when the task is full, admitted when it has room again.
 *
 * A reply lost after the request committed is made by wrapping the native client: the request
 * reaches the cluster, and the client sees "connection refused", reconnects and resends it.
 *
 * Self-skips (via `describe.skipIf`) whenever `USERTRUST_TB_ADDRESS` is unset. All cluster code
 * lives inside the `it` bodies, and every row uses fresh namespaces and principal tags, so rows
 * never collide on the shared cluster. At most four ledger clients per row.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Lost replies: armed per row, and what every two-transfer request sent and got back. */
const flow = vi.hoisted(() => ({
	/** Lose the reply of the next two-transfer request once it has committed. */
	loseNextPairReply: null as null | { beforeError: () => Promise<void> },
	/** The status names the cluster gave each two-transfer request, in order. */
	pairAnswers: [] as string[][],
	/** The two ids each two-transfer request sent, in order. */
	pairIds: [] as bigint[][],
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
				flow.pairIds.push(batch.map((t) => t.id));
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

import { createTBEngine, type TrustEngine } from "../../src/govern.js";
import {
	LEDGER_TASK_LIMITS,
	LEDGER_USERTOKENS,
	TaskLimitLegError,
	TBTransferError,
	TrustTBClient,
	XFER_PURCHASE,
	XFER_SPEND,
	XFER_TASK_LIMIT_GRANT,
	XFER_TASK_LIMIT_HOLD,
} from "../../src/ledger/client.js";
import { TrustConfigSchema } from "../../src/shared/types.js";
import { FAKE_FLAGS, FAKE_STATUS } from "../fixtures/tb-linked-fake.js";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;

/** A hold that expires during the row. */
const EXPIRY_S = 2;
/** A hold that outlives the row; it is posted or voided before the row ends. */
const LONG_S = 300;

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	flow.loseNextPairReply = null;
	flow.pairAnswers = [];
	flow.pairIds = [];
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Polls `done` every 250 ms; throws when the ledger has not got there within the bound. */
async function until(what: string, done: () => Promise<boolean>): Promise<void> {
	// timing: 15 s budget for the ledger to expire a 2 s hold (removal is best-effort, with no
	// documented bound); NOT YET MEASURED for this file: the gate records the slowest of 20 runs.
	const deadline = Date.now() + 15_000;
	while (!(await done())) {
		// timing: the same 15 s budget as the deadline above; the poll interval is 250 ms.
		if (Date.now() > deadline) throw new Error(`the ledger did not ${what} within 15 s`);
		// timing: a 250 ms poll interval inside the 15 s budget above.
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

function newClient(): TrustTBClient {
	const tb = new TrustTBClient({ addresses: [TB_ADDRESS as string], clusterId: 0n });
	cleanup.push(() => tb.destroy());
	return tb;
}

async function newEngine(budget: number): Promise<TrustEngine & Required<Pick<TrustEngine, "ensureTaskLimit" | "lookupTaskLimit">>> {
	const config = TrustConfigSchema.parse({
		budget,
		tigerbeetle: { addresses: [TB_ADDRESS], clusterId: 0 },
	});
	const engine = await createTBEngine(config, budget);
	cleanup.push(async () => {
		await engine.voidAllPending?.();
		await engine.close?.();
	});
	if (engine.ensureTaskLimit === undefined || engine.lookupTaskLimit === undefined) {
		throw new Error("createTBEngine has no task-limit support");
	}
	return engine as TrustEngine & Required<Pick<TrustEngine, "ensureTaskLimit" | "lookupTaskLimit">>;
}

/**
 * A task granted `limit` and a payer wallet funded `funds`, through the client's own methods.
 * Returns what a pair needs.
 */
async function taskWithPayer(tb: TrustTBClient, limit: number, funds: number) {
	const namespace = `tl-${randomUUID()}`;
	const taskId = `task-${randomUUID().slice(0, 8)}`;
	const operator = await tb.createTaskLimitOperator(namespace);
	const task = await tb.createTaskLimitAccount(namespace, taskId);
	await tb.immediateTransfer({
		ledger: LEDGER_TASK_LIMITS,
		transferId: TrustTBClient.deriveTransferId(task.toString(16).padStart(32, "0"), "limit"),
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
	return { namespace, taskId, operator, task, treasury, payer, pair };
}

describe.skipIf(!TB_ADDRESS)("real TigerBeetle: the engine's task-limit legs", () => {
	it("parallel holds in one task cannot exceed its limit, raced from four ledger clients", async () => {
		const clients = [newClient(), newClient(), newClient(), newClient()];
		const first = clients[0] as TrustTBClient;
		const HOLD = 10;
		const K = 7;
		const t = await taskWithPayer(first, K * HOLD, 1_000_000);
		const outcomes = await Promise.allSettled(
			Array.from({ length: 20 }, (_, i) =>
				(clients[i % clients.length] as TrustTBClient).createLinkedPendingPair(t.pair(HOLD)),
			),
		);
		const admitted = outcomes.filter((o) => o.status === "fulfilled");
		const refused = outcomes.filter((o) => o.status === "rejected");
		expect(admitted).toHaveLength(K);
		expect(refused).toHaveLength(20 - K);
		for (const r of refused) {
			const reason = (r as PromiseRejectedResult).reason;
			expect(reason).toBeInstanceOf(TaskLimitLegError);
			expect((reason as TaskLimitLegError).code).toBe(FAKE_STATUS.exceeds_credits);
		}
		const [account] = await first.lookupAccounts([t.task]);
		expect((account?.debits_pending ?? 0n) + (account?.debits_posted ?? 0n)).toBe(BigInt(K * HOLD));
		// The payer was debited for the admitted holds only.
		const [payer] = await first.lookupAccounts([t.payer]);
		expect(payer?.debits_pending).toBe(BigInt(K * HOLD));
		for (const a of admitted) {
			const ids = (a as PromiseFulfilledResult<{ payerId: bigint; limitId: bigint }>).value;
			await first.voidLinkedPair(ids.payerId, ids.limitId);
		}
		const [after] = await first.lookupAccounts([t.task]);
		expect(after?.debits_pending).toBe(0n);
	}, 30_000); // timing: 30 s test budget for 20 pairs on four clients; NOT YET MEASURED on CI.

	it("task legs stay off the usertoken ledger", async () => {
		const engine = await newEngine(1_000_000);
		const namespace = `tl-${randomUUID()}`;
		const taskId = `task-${randomUUID().slice(0, 8)}`;
		const { key } = await engine.ensureTaskLimit({ namespace, taskId, limit: 1_000 });
		const taskLimit = { key, rootKey: key, taskId, limit: 1_000 };
		// A principal tag of this row's own, so the usertoken-ledger query sees only these calls.
		const tag = BigInt(`0x${randomBytes(8).toString("hex")}`) | 1n;
		const userData = { userData128: 0n, userData64: tag, userData32: 0 };
		await engine.spendPending({ transferId: "c1", amount: 30, taskLimit, userData });
		await engine.spendPending({ transferId: "c2", amount: 20, taskLimit, userData });
		await engine.spendPending({ transferId: "c3", amount: 10, taskLimit, userData });
		await engine.postPendingSpend("c1", 25);
		await engine.postPendingSpend("c2", 20);
		await engine.voidPendingSpend("c3");

		const tbNode = await import("tigerbeetle-node");
		const raw = tbNode.createClient({ cluster_id: 0n, replica_addresses: [TB_ADDRESS as string] });
		cleanup.push(() => raw.destroy());
		const query = (filter: { ledger: number; code: number; ud128?: bigint; ud64?: bigint }) =>
			raw.queryTransfers({
				user_data_128: filter.ud128 ?? 0n,
				user_data_64: filter.ud64 ?? 0n,
				user_data_32: 0,
				ledger: filter.ledger,
				code: filter.code,
				timestamp_min: 0n,
				timestamp_max: 0n,
				limit: 100,
				flags: 0,
			});
		const isPost = (t: { flags: number }) => (t.flags & FAKE_FLAGS.transfer.post_pending_transfer) !== 0;

		// The usertoken ledger: three holds, two posts and a void, and its posted spend is the costs.
		const spend = await query({ ledger: LEDGER_USERTOKENS, code: XFER_SPEND, ud64: tag });
		expect(spend).toHaveLength(6);
		expect(spend.filter(isPost).reduce((sum, t) => sum + t.amount, 0n)).toBe(45n);
		// No usertoken-ledger transfer carries the task's key.
		expect(await query({ ledger: LEDGER_USERTOKENS, code: 0, ud128: key })).toEqual([]);

		// The task-limit ledger: one query by the key returns every limit leg, and nothing else is
		// on another ledger.
		const legs = await query({ ledger: LEDGER_TASK_LIMITS, code: XFER_TASK_LIMIT_HOLD, ud128: key });
		expect(legs).toHaveLength(6);
		expect(legs.filter(isPost).reduce((sum, t) => sum + t.amount, 0n)).toBe(45n);
		const byKey = await query({ ledger: 0, code: 0, ud128: key });
		expect(byKey.every((t) => t.ledger === LEDGER_TASK_LIMITS)).toBe(true);
		// The legs and the grant.
		expect(byKey).toHaveLength(7);
		await expect(engine.lookupTaskLimit(key)).resolves.toEqual({ limit: 1_000, spent: 45, held: 0 });
	});

	it("a post after the payer leg expired takes today's expired path, and the task's spent leaves it out", async () => {
		const engine = await newEngine(1_000_000);
		const namespace = `tl-${randomUUID()}`;
		const taskId = `task-${randomUUID().slice(0, 8)}`;
		const { key } = await engine.ensureTaskLimit({ namespace, taskId, limit: 1_000 });
		await engine.spendPending({
			transferId: "c1",
			amount: 40,
			taskLimit: { key, rootKey: key, taskId, limit: 1_000 },
			timeoutSeconds: EXPIRY_S,
		});
		await until("expire the hold", async () => (await engine.lookupTaskLimit(key))?.held === 0);

		const err = await engine.postPendingSpend("c1", 30).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TBTransferError);
		expect(err).not.toBeInstanceOf(TaskLimitLegError);
		expect((err as TBTransferError).code).toBe(FAKE_STATUS.pending_transfer_expired);
		// Disclosed, not charged: the call is not in the task's spent, and nothing is held.
		await expect(engine.lookupTaskLimit(key)).resolves.toEqual({ limit: 1_000, spent: 0, held: 0 });
		// A void of the expired hold is success and clears the entry.
		await expect(engine.voidPendingSpend("c1")).resolves.toBeUndefined();
	}, 30_000); // timing: 30 s test budget over the 15 s expiry poll above; NOT YET MEASURED on CI.

	it("a lost reply of a pair refused by its limit leg is re-sent under new ids and refused on its merits", async () => {
		const tb = newClient();
		const t = await taskWithPayer(tb, 100, 10_000);
		await tb.createLinkedPendingPair(t.pair(100));
		flow.pairAnswers = [];
		flow.pairIds = [];
		flow.loseNextPairReply = { beforeError: async () => {} };

		const err = await tb.createLinkedPendingPair(t.pair(50)).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TaskLimitLegError);
		expect((err as TaskLimitLegError).code).toBe(FAKE_STATUS.exceeds_credits);
		expect(flow.pairAnswers).toEqual([
			["linked_event_failed", "exceeds_credits"],
			["linked_event_failed", "id_already_failed"],
			["linked_event_failed", "exceeds_credits"],
		]);
		// The resend reused the ids; the last attempt minted new ones.
		expect(flow.pairIds[1]).toEqual(flow.pairIds[0]);
		for (const id of flow.pairIds[2] ?? []) expect(flow.pairIds[0]).not.toContain(id);
	});

	it("a lost reply of a pair refused by its limit leg is admitted under new ids once the task has room", async () => {
		const tb = newClient();
		const t = await taskWithPayer(tb, 100, 10_000);
		const full = await tb.createLinkedPendingPair(t.pair(100));
		flow.pairAnswers = [];
		flow.pairIds = [];
		// Refused (the task is full), its reply lost, and the pair that filled it voided before the
		// resend reaches the cluster.
		flow.loseNextPairReply = {
			beforeError: () => tb.voidLinkedPair(full.payerId, full.limitId),
		};

		const ids = await tb.createLinkedPendingPair(t.pair(60));
		expect(flow.pairAnswers).toEqual([
			["linked_event_failed", "exceeds_credits"],
			["created", "created"],
			["linked_event_failed", "id_already_failed"],
			["created", "created"],
		]);
		expect([ids.payerId, ids.limitId]).toEqual(flow.pairIds[3]);
		for (const id of flow.pairIds[3] ?? []) expect(flow.pairIds[0]).not.toContain(id);
		const [task] = await tb.lookupAccounts([t.task]);
		expect(task?.debits_pending).toBe(60n);
		await tb.voidLinkedPair(ids.payerId, ids.limitId);
	});
});
