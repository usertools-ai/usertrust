// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The ledger engine's task-limit legs, against the linked-chain fake.
 *
 * A hold made inside a task is one linked pair: the payer leg (the ordinary hold, unchanged) and
 * a limit leg on the task's account on the task-limit ledger. This file drives `createTBEngine`
 * (govern.ts's copy; headless.ts carries the same factory, held identical by
 * `tests/harden/engine-factory-parity.test.ts`) and pins:
 *  - ensure: the operator, then the task account, then the grant, each confirmed before the next
 *    is sent (a grant sent before its account exists retires its derived id for good); cached per
 *    engine by the task's key and limit; another limit for a known task is TaskLimitConflictError;
 *  - the hold: one request of two transfers, payer first and linked, the limit leg's fields
 *    reserved; a hold outside every task is exactly today's single transfer;
 *  - which leg refused decides the error: the payer's refusal keeps today's
 *    InsufficientBalanceError exactly, the limit leg's is TaskLimitExceededError, and the task's
 *    check comes first (its error IS a TBTransferError, so the payer's check would take it);
 *  - settle posts both legs at one concrete capped amount; void and destroy end both legs; an
 *    expired leg is success for a void and never for a post;
 *  - a task account that disappeared under a warm cache is re-ensured once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fixture, fake } = await vi.hoisted(async () => {
	const fixture = await import("../fixtures/tb-linked-fake.js");
	return { fixture, fake: fixture.createLinkedFake() };
});
vi.mock("tigerbeetle-node", () => fixture.fakeModule(fake));
// The native client is faked, so there is no listener to reach: the TCP preflight is stood down.
vi.mock("../../src/ledger/preflight.js", () => ({ preflightLedger: async () => {} }));

import type { TrustEngine } from "../../src/govern.js";
import { createTBEngine } from "../../src/govern.js";
import {
	CODE_TASK_LIMIT,
	CODE_TASK_LIMIT_OPERATOR,
	LEDGER_TASK_LIMITS,
	LEDGER_USERTOKENS,
	TASK_ACCOUNT_SCHEMA,
	TaskLimitLegError,
	TBTransferError,
	TrustTBClient,
	XFER_SPEND,
	XFER_TASK_LIMIT_GRANT,
	XFER_TASK_LIMIT_HOLD,
} from "../../src/ledger/client.js";
import {
	InsufficientBalanceError,
	TaskLimitConflictError,
	TaskLimitExceededError,
} from "../../src/shared/errors.js";
import { TrustConfigSchema } from "../../src/shared/types.js";

const { FAKE_FLAGS, FAKE_STATUS, AMOUNT_MAX, accountOf } = fixture;
const TF = FAKE_FLAGS.transfer;
const AF = FAKE_FLAGS.account;
const S = FAKE_STATUS;

const CONFIG = TrustConfigSchema.parse({ budget: 100_000 });
const SEED = 10_000;
const NS = "local";
const HOLD_S = 300;
const EXPIRY_S = 2;

type Engine = TrustEngine & {
	ensureTaskLimit: NonNullable<TrustEngine["ensureTaskLimit"]>;
	lookupTaskLimit: NonNullable<TrustEngine["lookupTaskLimit"]>;
};

const engines: TrustEngine[] = [];
async function newEngine(seed = SEED): Promise<Engine> {
	const engine = await createTBEngine(CONFIG, seed);
	engines.push(engine);
	if (engine.ensureTaskLimit === undefined || engine.lookupTaskLimit === undefined) {
		throw new Error("createTBEngine has no task-limit support");
	}
	return engine as Engine;
}

beforeEach(() => {
	fake.reset();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	for (const e of engines.splice(0)) e.destroy?.();
	vi.restoreAllMocks();
});

/** The task-limit param a controller passes for (namespace, taskId, limit). */
function task(taskId: string, limit: number) {
	const key = TrustTBClient.deriveTaskLimitAccountId(NS, taskId);
	return { key, rootKey: key, taskId, limit };
}
const keyHex = (key: bigint) => key.toString(16).padStart(32, "0");
const grantId = (key: bigint) => TrustTBClient.deriveTransferId(keyHex(key), "limit");

type Sent = ReturnType<typeof fixture.transferOf>;
const transferRequests = () =>
	fake.requests.filter((r) => r.op === "createTransfers").map((r) => r.batch as Sent[]);
const lastBatch = (): Sent[] => {
	const all = transferRequests();
	const last = all[all.length - 1];
	if (!last) throw new Error("no createTransfers request");
	return last;
};
const account = (id: bigint) => {
	const a = fake.accounts.get(id);
	if (!a) throw new Error(`no account ${id}`);
	return a;
};
/** The engine's session holding wallet: the only ledger-1 account with the wallet flags. */
const holdingWallet = (): bigint => {
	for (const a of fake.accounts.values()) {
		if (a.ledger === LEDGER_USERTOKENS && (a.flags & AF.debits_must_not_exceed_credits) !== 0) {
			return a.id;
		}
	}
	throw new Error("no holding wallet");
};

const settle = <T>(p: Promise<T>) =>
	p.then(
		() => undefined,
		(e: unknown) => e,
	);

describe("ensureTaskLimit", () => {
	it("creates the operator, then the task account, then the grant, each in its own request", async () => {
		const engine = await newEngine();
		fake.requests.length = 0;
		const t = task("ensure-1", 500);
		await expect(
			engine.ensureTaskLimit({ namespace: NS, taskId: "ensure-1", limit: 500 }),
		).resolves.toEqual({ key: t.key });
		expect(fake.requests.map((r) => r.op)).toEqual([
			"createAccounts",
			"createAccounts",
			"createTransfers",
		]);
		const [operator, taskAccount, grant] = fake.requests.map((r) => r.batch[0]);
		expect(operator).toMatchObject({
			id: TrustTBClient.deriveTaskLimitOperatorId(NS),
			ledger: LEDGER_TASK_LIMITS,
			code: CODE_TASK_LIMIT_OPERATOR,
		});
		expect(taskAccount).toMatchObject({
			id: t.key,
			ledger: LEDGER_TASK_LIMITS,
			code: CODE_TASK_LIMIT,
		});
		expect(grant).toMatchObject({ id: grantId(t.key), amount: 500n, credit_account_id: t.key });
		expect(account(t.key).credits_posted).toBe(500n);
	});

	it("ensure sends the grant only after the operator and the task account are confirmed", async () => {
		const engine = await newEngine();
		const t = task("ensure-2", 500);
		// The task account already exists with other flags: its create is refused.
		await fake.client.createAccounts([
			accountOf({
				id: t.key,
				ledger: LEDGER_TASK_LIMITS,
				code: CODE_TASK_LIMIT,
				flags: AF.history,
			}),
		]);
		fake.requests.length = 0;
		await expect(
			engine.ensureTaskLimit({ namespace: NS, taskId: "ensure-2", limit: 500 }),
		).rejects.toThrow("exists_with_different_flags");
		// No grant was ever sent, so its derived id was never put at risk.
		expect(transferRequests()).toEqual([]);
		expect(fake.transfers.has(grantId(t.key))).toBe(false);
	});

	it("a refused operator create sends neither the account nor the grant", async () => {
		const engine = await newEngine();
		await fake.client.createAccounts([
			accountOf({
				id: TrustTBClient.deriveTaskLimitOperatorId(NS),
				ledger: LEDGER_TASK_LIMITS,
				code: CODE_TASK_LIMIT_OPERATOR,
				flags: AF.debits_must_not_exceed_credits,
			}),
		]);
		fake.requests.length = 0;
		await expect(
			engine.ensureTaskLimit({ namespace: NS, taskId: "ensure-3", limit: 500 }),
		).rejects.toThrow();
		expect(fake.requests.map((r) => r.op)).toEqual(["createAccounts"]);
	});

	it("the same task with another limit throws TaskLimitConflictError before any hold", async () => {
		const first = await newEngine();
		await first.ensureTaskLimit({ namespace: NS, taskId: "conflict", limit: 500 });
		// Another engine (another process) asks for another limit under the same task id.
		const second = await newEngine();
		fake.requests.length = 0;
		const err = await settle(
			second.ensureTaskLimit({ namespace: NS, taskId: "conflict", limit: 700 }),
		);
		expect(err).toBeInstanceOf(TaskLimitConflictError);
		expect(err).toMatchObject({ taskId: "conflict", requestedLimit: 700, existingLimit: 500 });
		expect(account(task("conflict", 500).key).credits_posted).toBe(500n);
		// Nothing was held.
		expect(transferRequests().filter((b) => b.length === 2)).toEqual([]);
	});

	it("ensure is cached per (key, limit)", async () => {
		const engine = await newEngine();
		await engine.ensureTaskLimit({ namespace: NS, taskId: "cached", limit: 500 });
		fake.requests.length = 0;
		await engine.ensureTaskLimit({ namespace: NS, taskId: "cached", limit: 500 });
		expect(fake.requests).toEqual([]);
		// A changed limit is refused from the cache, without I/O.
		const err = await settle(
			engine.ensureTaskLimit({ namespace: NS, taskId: "cached", limit: 600 }),
		);
		expect(err).toBeInstanceOf(TaskLimitConflictError);
		expect(err).toMatchObject({ requestedLimit: 600, existingLimit: 500 });
		expect(fake.requests).toEqual([]);
		// Another task id is ensured on its own.
		await engine.ensureTaskLimit({ namespace: NS, taskId: "cached-2", limit: 500 });
		expect(fake.requests.map((r) => r.op)).toEqual([
			"createAccounts",
			"createAccounts",
			"createTransfers",
		]);
	});

	it("a second engine ensuring the same task and limit replays the grant and moves nothing", async () => {
		const first = await newEngine();
		await first.ensureTaskLimit({ namespace: NS, taskId: "replayed", limit: 500 });
		const second = await newEngine();
		await second.ensureTaskLimit({ namespace: NS, taskId: "replayed", limit: 500 });
		expect(account(task("replayed", 500).key).credits_posted).toBe(500n);
	});

	it("a grant id retired by an earlier failure is a hard error naming the task", async () => {
		const engine = await newEngine();
		const t = task("grant-gone", 500);
		// The grant was once sent before the task account existed: its derived id is retired.
		await fake.client.createAccounts([
			accountOf({
				id: TrustTBClient.deriveTaskLimitOperatorId(NS),
				ledger: LEDGER_TASK_LIMITS,
				code: CODE_TASK_LIMIT_OPERATOR,
				flags: AF.history,
			}),
		]);
		await fake.client.createTransfers([
			fixture.transferOf({
				id: grantId(t.key),
				debit_account_id: TrustTBClient.deriveTaskLimitOperatorId(NS),
				credit_account_id: t.key,
				amount: 500n,
				ledger: LEDGER_TASK_LIMITS,
				code: XFER_TASK_LIMIT_GRANT,
				user_data_128: t.key,
			}),
		]);
		const err = await settle(
			engine.ensureTaskLimit({ namespace: NS, taskId: "grant-gone", limit: 500 }),
		);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(TaskLimitConflictError);
		// It cannot be repaired under this task id, so the error names the task.
		expect(String(err)).toContain("grant-gone");
	});

	it("lookupTaskLimit reads limit, spent and held from one account lookup, and undefined when absent", async () => {
		const engine = await newEngine();
		const t = task("looked-up", 500);
		await engine.ensureTaskLimit({ namespace: NS, taskId: "looked-up", limit: 500 });
		await engine.spendPending({ transferId: "c1", amount: 100, taskLimit: t });
		await engine.spendPending({ transferId: "c2", amount: 50, taskLimit: t });
		await engine.postPendingSpend("c1", 80);
		fake.requests.length = 0;
		await expect(engine.lookupTaskLimit(t.key)).resolves.toEqual({
			limit: 500,
			spent: 80,
			held: 50,
		});
		expect(fake.requests.map((r) => r.op)).toEqual(["lookupAccounts"]);
		await expect(engine.lookupTaskLimit(task("never", 1).key)).resolves.toBeUndefined();
	});
});

describe("a hold inside a task", () => {
	it("a task-limited hold submits one linked pair, payer first", async () => {
		const engine = await newEngine();
		const t = task("pair", 1_000);
		await engine.ensureTaskLimit({ namespace: NS, taskId: "pair", limit: 1_000 });
		fake.requests.length = 0;
		await engine.spendPending({ transferId: "c1", amount: 120, taskLimit: t });
		expect(transferRequests()).toHaveLength(1);
		const [a, b] = lastBatch();
		expect(lastBatch()).toHaveLength(2);
		expect(a).toMatchObject({
			debit_account_id: holdingWallet(),
			amount: 120n,
			ledger: LEDGER_USERTOKENS,
			code: XFER_SPEND,
			flags: TF.pending | TF.linked,
			timeout: HOLD_S,
		});
		expect(b).toMatchObject({
			debit_account_id: t.key,
			credit_account_id: TrustTBClient.deriveTaskLimitOperatorId(NS),
			amount: 120n,
			ledger: LEDGER_TASK_LIMITS,
			code: XFER_TASK_LIMIT_HOLD,
			flags: TF.pending,
			timeout: HOLD_S,
		});
		expect(account(holdingWallet()).debits_pending).toBe(120n);
		expect(account(t.key).debits_pending).toBe(120n);
	});

	it("both legs carry the hold's own timeout", async () => {
		const engine = await newEngine();
		const t = task("ttl", 1_000);
		await engine.ensureTaskLimit({ namespace: NS, taskId: "ttl", limit: 1_000 });
		await engine.spendPending({ transferId: "c1", amount: 10, taskLimit: t, timeoutSeconds: 900 });
		expect(lastBatch().map((x) => x.timeout)).toEqual([900, 900]);
	});

	it("an untasked hold submits exactly today's single transfer", async () => {
		const engine = await newEngine();
		fake.requests.length = 0;
		await engine.spendPending({
			transferId: "plain",
			amount: 40,
			userData: { userData128: 5n, userData64: 6n, userData32: 7 },
		});
		// The transfer the factory submitted before task limits existed, field by field: one
		// transfer, no linked flag, ledger 1.
		expect(transferRequests()).toEqual([
			[
				{
					id: expect.any(BigInt),
					debit_account_id: holdingWallet(),
					credit_account_id: expect.any(BigInt),
					amount: 40n,
					pending_id: 0n,
					user_data_128: 5n,
					user_data_64: 6n,
					user_data_32: 7,
					timeout: HOLD_S,
					ledger: LEDGER_USERTOKENS,
					code: XFER_SPEND,
					flags: TF.pending,
					timestamp: 0n,
				},
			],
		]);
	});

	it("task ledger fields are stamped as reserved", async () => {
		const engine = await newEngine();
		const t = task("reserved", 1_000);
		await engine.ensureTaskLimit({ namespace: NS, taskId: "reserved", limit: 1_000 });
		await engine.spendPending({
			transferId: "c1",
			amount: 10,
			taskLimit: t,
			userData: { userData128: 5n, userData64: 6n, userData32: 7 },
		});
		expect(account(t.key)).toMatchObject({
			user_data_128: TrustTBClient.taskNamespaceTag(NS),
			user_data_64: 0n,
			user_data_32: TASK_ACCOUNT_SCHEMA,
		});
		expect(fake.transfers.get(grantId(t.key))).toMatchObject({
			ledger: LEDGER_TASK_LIMITS,
			code: XFER_TASK_LIMIT_GRANT,
			user_data_128: t.key,
			user_data_64: 0n,
			user_data_32: 0,
		});
		const [a, b] = lastBatch();
		// The payer leg keeps the principal's tags; the limit leg carries the root key only.
		expect(a).toMatchObject({ user_data_128: 5n, user_data_64: 6n, user_data_32: 7 });
		expect(b).toMatchObject({ user_data_128: t.rootKey, user_data_64: 0n, user_data_32: 0 });
	});

	it("an attributed hold inside a task debits the envelope on the payer leg and the task on the limit leg", async () => {
		const engine = await newEngine();
		const t = task("envelope", 1_000);
		const envelope = 777_000_111n;
		await fake.client.createAccounts([
			accountOf({
				id: envelope,
				ledger: LEDGER_USERTOKENS,
				code: 1,
				flags: AF.debits_must_not_exceed_credits | AF.history,
			}),
		]);
		await engine.ensureTaskLimit({ namespace: NS, taskId: "envelope", limit: 1_000 });
		// Fund the envelope from the treasury the engine created.
		const treasury = [...fake.accounts.values()].find(
			(x) => x.ledger === LEDGER_USERTOKENS && x.flags === AF.history,
		);
		if (!treasury) throw new Error("no treasury");
		await fake.client.createTransfers([
			fixture.transferOf({
				id: 4_242n,
				debit_account_id: treasury.id,
				credit_account_id: envelope,
				amount: 500n,
				ledger: LEDGER_USERTOKENS,
				code: 9,
			}),
		]);
		await engine.spendPending({
			transferId: "c1",
			amount: 40,
			debitAccountId: envelope,
			taskLimit: t,
		});
		expect(account(envelope).debits_pending).toBe(40n);
		expect(account(holdingWallet()).debits_pending).toBe(0n);
		expect(account(t.key).debits_pending).toBe(40n);
	});

	it("a hold for a task this engine never ensured is refused before any request", async () => {
		const engine = await newEngine();
		fake.requests.length = 0;
		await expect(
			engine.spendPending({ transferId: "c1", amount: 10, taskLimit: task("never-ensured", 100) }),
		).rejects.toThrow();
		expect(transferRequests()).toEqual([]);
	});
});

describe("which leg refused decides the error", () => {
	it("a payer-leg refusal keeps today's InsufficientBalanceError exactly", async () => {
		const engine = await newEngine(100);
		const t = task("payer-short", 10_000);
		await engine.ensureTaskLimit({ namespace: NS, taskId: "payer-short", limit: 10_000 });
		const err = await settle(engine.spendPending({ transferId: "c1", amount: 400, taskLimit: t }));
		expect(err).toBeInstanceOf(InsufficientBalanceError);
		expect(err).not.toBeInstanceOf(TaskLimitExceededError);
		// The message an untasked hold over the seed gets today.
		expect((err as Error).message).toBe(
			new InsufficientBalanceError("trust:hold", 400, 100).message,
		);
		expect(account(t.key).debits_pending).toBe(0n);
	});

	it("a limit-leg refusal is TaskLimitExceededError with the task's figures, never the budget's", async () => {
		const engine = await newEngine();
		const t = task("limit-short", 500);
		await engine.ensureTaskLimit({ namespace: NS, taskId: "limit-short", limit: 500 });
		await engine.spendPending({ transferId: "c1", amount: 300, taskLimit: t });
		await engine.postPendingSpend("c1", 120);
		await engine.spendPending({ transferId: "c2", amount: 200, taskLimit: t });
		// Spent 120 and held 200 of 500: 180 is left, so a hold of 250 is refused by the task.
		const err = await settle(engine.spendPending({ transferId: "c3", amount: 250, taskLimit: t }));
		expect(err).toBeInstanceOf(TaskLimitExceededError);
		// The task's check comes first: TaskLimitLegError is a TBTransferError, and the payer's
		// insufficient-balance check would otherwise report the session wallet and its seed.
		expect((err as InsufficientBalanceError).userId).toBe("task:limit-short");
		expect(err).toMatchObject({ taskId: "limit-short", limit: 500, required: 250, available: 180 });
		// Linked: the payer leg holds nothing for the refused call.
		expect(account(holdingWallet()).debits_pending).toBe(200n);
	});

	it("when both bounds are exhausted the payer's refusal is the one reported", async () => {
		const engine = await newEngine(100);
		const t = task("both-short", 50);
		await engine.ensureTaskLimit({ namespace: NS, taskId: "both-short", limit: 50 });
		const err = await settle(engine.spendPending({ transferId: "c1", amount: 400, taskLimit: t }));
		expect(err).toBeInstanceOf(InsufficientBalanceError);
		expect(err).not.toBeInstanceOf(TaskLimitExceededError);
	});

	it("a failed re-read after a limit-leg refusal reports 0 and keeps the classification", async () => {
		const engine = await newEngine();
		const t = task("reread", 100);
		await engine.ensureTaskLimit({ namespace: NS, taskId: "reread", limit: 100 });
		fake.onRequest = (op, _batch, apply) => {
			if (op === "lookupAccounts") throw new Error("lookup failed");
			return apply();
		};
		const err = await settle(engine.spendPending({ transferId: "c1", amount: 400, taskLimit: t }));
		expect(err).toBeInstanceOf(TaskLimitExceededError);
		expect(err).toMatchObject({ available: 0 });
	});

	it("any other answer for the pair is a hard ledger error, not a budget denial", async () => {
		const engine = await newEngine();
		const t = task("mixed", 1_000);
		await engine.ensureTaskLimit({ namespace: NS, taskId: "mixed", limit: 1_000 });
		fake.onRequest = (op, batch, apply) =>
			op === "createTransfers" && batch.length === 2
				? [
						{ timestamp: 0n, status: S.exists },
						{ timestamp: 0n, status: S.created },
					]
				: apply();
		const err = await settle(engine.spendPending({ transferId: "c1", amount: 10, taskLimit: t }));
		expect(err).toBeInstanceOf(TBTransferError);
		expect(err).not.toBeInstanceOf(InsufficientBalanceError);
	});

	it("a limit leg refused for a reason other than its balance is a hard ledger error", async () => {
		const engine = await newEngine();
		const t = task("other-code", 1_000);
		await engine.ensureTaskLimit({ namespace: NS, taskId: "other-code", limit: 1_000 });
		fake.onRequest = (op, batch, apply) =>
			op === "createTransfers" && batch.length === 2
				? [
						{ timestamp: 0n, status: S.linked_event_failed },
						{ timestamp: 0n, status: S.accounts_must_have_the_same_ledger },
					]
				: apply();
		const err = await settle(engine.spendPending({ transferId: "c1", amount: 10, taskLimit: t }));
		expect(err).toBeInstanceOf(TaskLimitLegError);
		expect(err).not.toBeInstanceOf(InsufficientBalanceError);
	});
});

describe("a stale ensure cache", () => {
	/** The task-limit ledger lost its accounts (a cluster reset) while the engine's cache is warm. */
	function dropTaskLedger(): void {
		for (const [id, a] of [...fake.accounts]) {
			if (a.ledger === LEDGER_TASK_LIMITS) fake.accounts.delete(id);
		}
		for (const [id, t] of [...fake.transfers]) {
			if (t.ledger === LEDGER_TASK_LIMITS) fake.transfers.delete(id);
		}
	}

	it("a stale ensure cache re-ensures once on a missing task account", async () => {
		const engine = await newEngine();
		const t = task("stale", 500);
		await engine.ensureTaskLimit({ namespace: NS, taskId: "stale", limit: 500 });
		dropTaskLedger();
		fake.requests.length = 0;
		await engine.spendPending({ transferId: "c1", amount: 100, taskLimit: t });
		// The refused pair, the re-ensure (operator, account, grant), then the pair again.
		expect(fake.requests.map((r) => r.op)).toEqual([
			"createTransfers",
			"createAccounts",
			"createAccounts",
			"createTransfers",
			"createTransfers",
		]);
		expect(account(t.key)).toMatchObject({ credits_posted: 500n, debits_pending: 100n });
	});

	it("a second miss after the re-ensure is TaskLimitExceededError with nothing available", async () => {
		const engine = await newEngine();
		const t = task("stale-twice", 500);
		await engine.ensureTaskLimit({ namespace: NS, taskId: "stale-twice", limit: 500 });
		let pairs = 0;
		fake.onRequest = (op, batch, apply) => {
			if (op === "createTransfers" && batch.length === 2) {
				pairs += 1;
				return [
					{ timestamp: 0n, status: S.linked_event_failed },
					{ timestamp: 0n, status: S.debit_account_not_found },
				];
			}
			return apply();
		};
		const err = await settle(engine.spendPending({ transferId: "c1", amount: 100, taskLimit: t }));
		expect(err).toBeInstanceOf(TaskLimitExceededError);
		expect(err).toMatchObject({ taskId: "stale-twice", available: 0 });
		// Re-ensured once, held twice: never a loop.
		expect(pairs).toBe(2);
	});
});

describe("settle, void and destroy on a task hold", () => {
	async function held(amount: number, timeoutSeconds?: number) {
		const engine = await newEngine();
		const t = task("settle", 1_000);
		await engine.ensureTaskLimit({ namespace: NS, taskId: "settle", limit: 1_000 });
		await engine.spendPending({
			transferId: "c1",
			amount,
			taskLimit: t,
			...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
		});
		fake.requests.length = 0;
		return { engine, t };
	}

	it("settle posts both legs at the capped amount, and the shortfall is reported once", async () => {
		const { engine, t } = await held(100);
		await expect(engine.postPendingSpend("c1", 140)).resolves.toEqual({
			posted: 100,
			shortfall: 40,
		});
		const [a, b] = lastBatch();
		expect(a).toMatchObject({ amount: 100n, flags: TF.post_pending_transfer | TF.linked });
		expect(b).toMatchObject({ amount: 100n, flags: TF.post_pending_transfer });
		expect(account(holdingWallet())).toMatchObject({ debits_pending: 0n, debits_posted: 100n });
		expect(account(t.key)).toMatchObject({ debits_pending: 0n, debits_posted: 100n });
	});

	it("settle below the hold posts that amount on both legs and releases the rest", async () => {
		const { engine, t } = await held(100);
		await expect(engine.postPendingSpend("c1", 60)).resolves.toEqual({ posted: 60, shortfall: 0 });
		expect(lastBatch().map((x) => x.amount)).toEqual([60n, 60n]);
		expect(account(t.key)).toMatchObject({ debits_pending: 0n, debits_posted: 60n });
	});

	it("a settle with no amount posts the held amount on both legs, never amount_max", async () => {
		const { engine, t } = await held(100);
		await expect(engine.postPendingSpend("c1")).resolves.toEqual({ posted: 100, shortfall: 0 });
		for (const x of lastBatch()) expect(x.amount).not.toBe(AMOUNT_MAX);
		expect(lastBatch().map((x) => x.amount)).toEqual([100n, 100n]);
		expect(account(t.key).debits_posted).toBe(100n);
	});

	it("void ends both legs; an expired leg is success; pendingMap is cleared", async () => {
		const { engine, t } = await held(100);
		await engine.voidPendingSpend("c1");
		const [a, b] = lastBatch();
		expect(a).toMatchObject({ flags: TF.void_pending_transfer | TF.linked });
		expect(b).toMatchObject({ flags: TF.void_pending_transfer });
		expect(account(t.key).debits_pending).toBe(0n);
		expect(account(holdingWallet()).debits_pending).toBe(0n);
		// The entry is gone: a second void finds nothing to void.
		await expect(engine.voidPendingSpend("c1")).rejects.toThrow();
	});

	it("a void of an expired pair is success, and clears the entry", async () => {
		const { engine } = await held(100, EXPIRY_S);
		fake.advanceSeconds(EXPIRY_S);
		await expect(engine.voidPendingSpend("c1")).resolves.toBeUndefined();
		await expect(engine.voidPendingSpend("c1")).rejects.toThrow();
	});

	it("a void whose limit leg answers pending_transfer_expired is success too", async () => {
		const { engine } = await held(100);
		fake.onRequest = (op, batch, apply) =>
			op === "createTransfers" && batch.length === 2
				? [
						{ timestamp: 0n, status: S.linked_event_failed },
						{ timestamp: 0n, status: S.pending_transfer_expired },
					]
				: apply();
		await expect(engine.voidPendingSpend("c1")).resolves.toBeUndefined();
	});

	it("pending_transfer_expired on a post is not success", async () => {
		const { engine, t } = await held(100, EXPIRY_S);
		fake.advanceSeconds(EXPIRY_S);
		const err = await settle(engine.postPendingSpend("c1", 80));
		expect(err).toBeInstanceOf(TBTransferError);
		expect((err as TBTransferError).code).toBe(S.pending_transfer_expired);
		// Nothing was charged to the task: its spent excludes the call.
		expect(account(t.key)).toMatchObject({ debits_posted: 0n, debits_pending: 0n });
	});

	it("destroy voids both legs of every task hold", async () => {
		const engine = await newEngine();
		const t = task("destroy", 1_000);
		await engine.ensureTaskLimit({ namespace: NS, taskId: "destroy", limit: 1_000 });
		await engine.spendPending({ transferId: "c1", amount: 100, taskLimit: t });
		await engine.spendPending({ transferId: "c2", amount: 50, taskLimit: t });
		await engine.spendPending({ transferId: "c3", amount: 25 });
		fake.requests.length = 0;
		await engine.voidAllPending?.();
		expect(account(t.key).debits_pending).toBe(0n);
		expect(account(holdingWallet()).debits_pending).toBe(0n);
		const batches = transferRequests();
		expect(batches.filter((x) => x.length === 2)).toHaveLength(2);
		expect(batches.filter((x) => x.length === 1)).toHaveLength(1);
	});
});
