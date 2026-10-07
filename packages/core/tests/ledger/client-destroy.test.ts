// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A destroyed TrustTBClient stays destroyed (#249).
 *
 * The native client rejects a request in flight at its `destroy()` (or made after it) with
 * "Client was closed.". `withReconnect()` read that as a lost connection: it reconnected,
 * which builds a FRESH native client, and retried on it. Nothing ever destroys that
 * client, and an open TigerBeetle client keeps the process alive after shutdown.
 *
 * Pinned here, against a fake native client that behaves like tigerbeetle-node 0.17.9
 * (measured: a request in flight at `destroy()` either completes or rejects
 * `ERR_CLIENT_CLOSED`; one made after it rejects `ERR_CLIENT_CLOSED`):
 *  - an operation in flight at `destroy()` fails with its own error, and no client is built;
 *  - one started after `destroy()` fails with LedgerClientClosedError, before the native client;
 *  - a POST that committed but lost its reply fails, rather than being retried into an
 *    `exists` success on a fresh client;
 *  - a `destroy()` during a reconnect's backoff builds nothing, and every operation awaiting
 *    that reconnect fails with LedgerClientClosedError;
 *  - a health-check ping in flight at `destroy()` does not reconnect;
 *  - a native `destroy()` that throws still leaves the client closed (the flag is set first),
 *    and keeps its native client for a second `destroy()` to retry; once `destroy()` has
 *    returned, nothing touches the native client again;
 *  - EVERY public ledger operation fails after `destroy()`, the ones with a shortcut that
 *    never reaches the ledger included (a cached wallet id, an empty lookup); `ping()`
 *    reports unhealthy, its start-up grace period included; and `reconnect()` is refused,
 *    even while a reconnect that just finished is still cached;
 *  - each one refuses BEFORE its own input checks, so whatever its arguments (a reserved
 *    name, a transfer id out of range, a fractional amount, a treasury never set) an
 *    operation started after `destroy()` fails with LedgerClientClosedError;
 *  - NO REQUEST reaches a native client after `destroy()`, wherever it lands. Every
 *    operation is run through its whole sequence of requests, and `destroy()` is made to
 *    land at each await boundary in turn: as the operation reads a request's answer, while
 *    a request is in flight, and between a lost connection's reconnect and its retry. Where
 *    a native destroy that throws leaves the native client open, only the closed check
 *    stands between a later request and the ledger;
 *  - the source holds the shape that makes this so: every public async method but `ping()`
 *    opens with `this.assertOpen()`, and every request reaches the native client through
 *    `native()`, called by `withReconnect()` alone and handed to a closure that makes its
 *    one request at once;
 *  - CONTROLS: without `destroy()`, a lost connection still reconnects and retries, an
 *    operation on a client closed by OUR OWN reconnect still retries on the new one, and
 *    every refused input above is refused by its own check.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Respond = (client: number, op: string, batch: unknown[]) => Promise<unknown[]>;

/** The fake native layer: every client it built, every request, and how requests answer. */
const native = vi.hoisted(() => ({
	created: 0,
	destroyed: new Set<number>(),
	/** Requests an OPEN native client received. */
	calls: [] as string[],
	/** Every request and every destroy() made on ANY native client, closed ones included. */
	attempts: [] as string[],
	/** Upcoming createClient calls that throw (a failed reconnect attempt). */
	failCreate: 0,
	/** The next native destroy() throws, before it closes anything (as a throwing deinit would). */
	destroyThrows: false,
	/** Runs once a client is built. */
	onCreate: null as null | (() => void),
	respond: (async () => []) as Respond,
}));

vi.mock("tigerbeetle-node", () => {
	const closedError = (): Error =>
		Object.assign(new Error("Client was closed."), { code: "ERR_CLIENT_CLOSED" });
	return {
		createClient: () => {
			if (native.failCreate > 0) {
				native.failCreate -= 1;
				throw new Error("client init failed");
			}
			native.created += 1;
			const id = native.created;
			let open = true;
			const inFlight = new Set<(err: Error) => void>();
			const request =
				(op: string) =>
				(batch: unknown[]): Promise<unknown[]> => {
					native.attempts.push(`client${id}:${op}`);
					if (!open) return Promise.reject(closedError());
					native.calls.push(`client${id}:${op}`);
					return new Promise((resolve, reject) => {
						inFlight.add(reject);
						native.respond(id, op, batch).then(
							(value) => {
								inFlight.delete(reject);
								resolve(value);
							},
							(err: unknown) => {
								inFlight.delete(reject);
								reject(err);
							},
						);
					});
				};
			const built = {
				createAccounts: request("createAccounts"),
				createTransfers: request("createTransfers"),
				lookupAccounts: request("lookupAccounts"),
				lookupTransfers: request("lookupTransfers"),
				destroy: () => {
					native.attempts.push(`client${id}:destroy`);
					if (native.destroyThrows) {
						native.destroyThrows = false;
						throw new Error("deinit failed");
					}
					if (!open) return;
					open = false;
					native.destroyed.add(id);
					// As the binding does: what is still in flight is rejected.
					for (const reject of inFlight) reject(closedError());
					inFlight.clear();
				},
			};
			native.onCreate?.();
			return built;
		},
		AccountFlags: { debits_must_not_exceed_credits: 1 << 2, history: 1 << 5 },
		TransferFlags: { pending: 1, post_pending_transfer: 2, void_pending_transfer: 4 },
		CreateAccountStatus: { created: 4294967295, exists: 1 },
		CreateTransferStatus: { created: 4294967295, exists: 46, 46: "exists" },
		amount_max: (1n << 128n) - 1n,
	};
});

import {
	LedgerClientClosedError,
	PendingReplayError,
	TrustTBClient,
} from "../../src/ledger/client.js";

/** A request that never answers: it is in flight until its client is destroyed. */
const never = (): Promise<unknown[]> => new Promise(() => {});
const tick = () => new Promise((r) => setImmediate(r));
/** Clients built and never destroyed: each one keeps a process alive. */
const alive = () => native.created - native.destroyed.size;

/** Every public ledger operation, with in-memory state a shortcut could answer from set. */
const OPERATIONS: Array<[string, (c: TrustTBClient) => Promise<unknown>]> = [
	["createUserWallet, cached id", (c) => c.createUserWallet("cached-user")],
	["createUserWallet", (c) => c.createUserWallet("new-user")],
	["createCostCenterWallet", (c) => c.createCostCenterWallet("acme", "billing")],
	["createTreasury", (c) => c.createTreasury()],
	["ensureEscrowAccount", (c) => c.ensureEscrowAccount("escrow")],
	["createFundedBudgetWallet", (c) => c.createFundedBudgetWallet(100)],
	[
		"createPendingTransfer",
		(c) =>
			c.createPendingTransfer({ debitAccountId: 1n, creditAccountId: 2n, amount: 10, code: 1 }),
	],
	["postTransfer", (c) => c.postTransfer(1n, 10)],
	["voidTransfer", (c) => c.voidTransfer(1n)],
	[
		"immediateTransfer",
		(c) => c.immediateTransfer({ debitAccountId: 1n, creditAccountId: 2n, amount: 10, code: 1 }),
	],
	["lookupTransfer", (c) => c.lookupTransfer(1n)],
	["lookupAccounts", (c) => c.lookupAccounts([1n])],
	["lookupBalance", (c) => c.lookupBalance(1n)],
	["lookupBalances", (c) => c.lookupBalances([1n])],
	["lookupBalances, no ids", (c) => c.lookupBalances([])],
];

/** The one account the fake ledger holds. */
const KNOWN_ACCOUNT = 7n;
const TRANSFER = { debitAccountId: 1n, creditAccountId: 2n, amount: 10, code: 1 };

/** Answers like a TigerBeetle would, enough for every operation's whole sequence of requests. */
const ledgerAnswers = (replay: boolean): Respond => {
	const stored = new Map<bigint, unknown>();
	return async (_client, op, batch) => {
		if (op === "createTransfers") {
			const transfer = batch[0] as { id: bigint };
			stored.set(transfer.id, transfer);
			// A caller-supplied id replayed: `exists`, and the lookup finds the same transfer.
			return replay ? [{ index: 0, status: 46 }] : [];
		}
		if (op === "lookupTransfers") {
			return (batch as bigint[]).flatMap((id) => (stored.has(id) ? [stored.get(id)] : []));
		}
		if (op === "lookupAccounts") {
			return (batch as bigint[])
				.filter((id) => id === KNOWN_ACCOUNT)
				.map((id) => ({ id, credits_posted: 100n, debits_posted: 0n, debits_pending: 0n }));
		}
		return [];
	};
};

type Scenario = {
	name: string;
	/** A treasury id this client holds in memory. */
	treasury?: bigint;
	/** createTransfers answers `exists`: a caller-supplied id, replayed. */
	replay?: boolean;
	op: (c: TrustTBClient) => Promise<unknown>;
	/** Every request it makes, in order, when nothing is destroyed. */
	requests: string[];
	/** Without destroy(), it rejects with this; otherwise it resolves. */
	rejects?: typeof PendingReplayError;
};

/** Every public ledger operation, run through its whole sequence of requests. */
const SCENARIOS: Scenario[] = [
	{ name: "createUserWallet", op: (c) => c.createUserWallet("u1"), requests: ["createAccounts"] },
	{
		name: "createCostCenterWallet",
		op: (c) => c.createCostCenterWallet("acme", "billing"),
		requests: ["createAccounts"],
	},
	{ name: "createTreasury, none yet", op: (c) => c.createTreasury(), requests: ["createAccounts"] },
	{
		name: "createTreasury, held but not on the ledger",
		treasury: 5n,
		op: (c) => c.createTreasury(),
		requests: ["lookupAccounts", "createAccounts"],
	},
	{
		name: "ensureEscrowAccount",
		op: (c) => c.ensureEscrowAccount("escrow-1"),
		requests: ["createAccounts"],
	},
	{
		name: "createFundedBudgetWallet",
		treasury: 5n,
		op: (c) => c.createFundedBudgetWallet(100),
		requests: ["createAccounts", "createTransfers"],
	},
	{
		name: "createPendingTransfer",
		op: (c) => c.createPendingTransfer(TRANSFER),
		requests: ["createTransfers"],
	},
	{
		name: "createPendingTransfer, a replayed id",
		replay: true,
		op: (c) => c.createPendingTransfer({ ...TRANSFER, transferId: 9n }),
		requests: ["createTransfers", "lookupTransfers"],
		rejects: PendingReplayError,
	},
	{ name: "postTransfer", op: (c) => c.postTransfer(1n, 10), requests: ["createTransfers"] },
	{
		name: "postTransfer, a replayed id",
		replay: true,
		op: (c) => c.postTransfer(1n, 10, { transferId: 9n }),
		requests: ["createTransfers", "lookupTransfers"],
	},
	{ name: "voidTransfer", op: (c) => c.voidTransfer(1n), requests: ["createTransfers"] },
	{
		name: "voidTransfer, a replayed id",
		replay: true,
		op: (c) => c.voidTransfer(1n, { transferId: 9n }),
		requests: ["createTransfers", "lookupTransfers"],
	},
	{
		name: "immediateTransfer",
		op: (c) => c.immediateTransfer(TRANSFER),
		requests: ["createTransfers"],
	},
	{
		name: "immediateTransfer, a replayed id",
		replay: true,
		op: (c) => c.immediateTransfer({ ...TRANSFER, transferId: 9n }),
		requests: ["createTransfers", "lookupTransfers"],
	},
	{ name: "lookupTransfer", op: (c) => c.lookupTransfer(1n), requests: ["lookupTransfers"] },
	{
		name: "lookupAccounts",
		op: (c) => c.lookupAccounts([KNOWN_ACCOUNT]),
		requests: ["lookupAccounts"],
	},
	{
		name: "lookupBalance",
		op: (c) => c.lookupBalance(KNOWN_ACCOUNT),
		requests: ["lookupAccounts"],
	},
	{
		name: "lookupBalances",
		op: (c) => c.lookupBalances([KNOWN_ACCOUNT]),
		requests: ["lookupAccounts"],
	},
];

type Settled = { ok: true; value: unknown } | { ok: false; reason: unknown };
const settle = (p: Promise<unknown>): Promise<Settled> =>
	p.then(
		(value) => ({ ok: true, value }),
		(reason: unknown) => ({ ok: false, reason }),
	);

/** `value`, running `onRead` the first time it is read: a promise's `then` probe is no read. */
const readTrap = (value: unknown[], onRead: () => void): unknown[] => {
	let read = false;
	return new Proxy(value, {
		get(target, key, receiver) {
			if (key !== "then" && !read) {
				read = true;
				onRead();
			}
			return Reflect.get(target, key, receiver);
		},
	});
};

type Boundary = "answered" | "in flight" | "reconnected";

/**
 * Runs `s`, and makes destroy() land at `boundary` of its `k`-th request:
 *  - "answered": as the operation reads that request's answer, after the request completed
 *    and before the operation's next step;
 *  - "in flight": while the request is on its way, so the native destroy rejects it;
 *  - "reconnected": the request loses its connection, and destroy() lands as the reconnect
 *    settles, before the retry.
 * At "answered" and "reconnected" the native destroy THROWS, leaving its native client
 * open, the reconnect's new one included: only the closed check stands between a later
 * request and the ledger. Returns how the operation settled, and what the native layer had
 * seen when destroy() ended.
 */
async function destroyAt(s: Scenario, k: number, boundary: Boundary) {
	const answer = ledgerAnswers(s.replay ?? false);
	let destroyedAt: { attempts: number; created: number } | undefined;
	const destroyNow = (nativeThrows: boolean) => () => {
		native.destroyThrows = nativeThrows;
		try {
			client.destroy();
		} catch {
			// The native destroy threw: this client is closed all the same (the flag is first).
		}
		destroyedAt = { attempts: native.attempts.length, created: native.created };
	};
	let request = 0;
	native.respond = async (id, op, batch) => {
		request += 1;
		if (request !== k) return answer(id, op, batch);
		if (boundary === "in flight") {
			setImmediate(destroyNow(false));
			return never();
		}
		if (boundary === "reconnected") {
			native.onCreate = () => {
				native.onCreate = null;
				queueMicrotask(destroyNow(true));
			};
			throw new Error("connection refused");
		}
		return readTrap(await answer(id, op, batch), destroyNow(true));
	};
	if (s.treasury !== undefined) client.setTreasuryId(s.treasury);
	const outcome = await settle(s.op(client));
	return { outcome, destroyedAt };
}

/** Settled as `s` does without destroy(). Never reads a resolved value (it may be a trap). */
const expectAsWithoutDestroy = (outcome: Settled, s: Scenario) => {
	if (s.rejects === undefined) {
		expect(outcome.ok, outcome.ok ? "" : String((outcome as { reason: unknown }).reason)).toBe(
			true,
		);
	} else {
		expect(outcome.ok).toBe(false);
		expect((outcome as { reason: unknown }).reason).toBeInstanceOf(s.rejects);
	}
};

const expectClosed = (outcome: Settled) => {
	expect(outcome.ok).toBe(false);
	expect((outcome as { reason: unknown }).reason).toBeInstanceOf(LedgerClientClosedError);
};

/** Nothing reached any native client after destroy(), and no client was built after it. */
const expectNothingAfter = (destroyedAt: { attempts: number; created: number } | undefined) => {
	expect(destroyedAt, "destroy() never ran: the boundary was not reached").toBeDefined();
	if (!destroyedAt) return;
	expect(native.attempts.slice(destroyedAt.attempts)).toEqual([]);
	expect(native.created).toBe(destroyedAt.created);
};

/** client.ts, parsed by the TypeScript compiler, and its TrustTBClient class. */
async function parseClient() {
	const ts = (await import("typescript")).default;
	const path = fileURLToPath(new URL("../../src/ledger/client.ts", import.meta.url));
	const source = ts.createSourceFile(
		path,
		readFileSync(path, "utf-8"),
		ts.ScriptTarget.Latest,
		true,
	);
	let klass: import("typescript").ClassDeclaration | undefined;
	ts.forEachChild(source, (node) => {
		if (ts.isClassDeclaration(node) && node.name?.text === "TrustTBClient") klass = node;
	});
	if (!klass) throw new Error("client.ts no longer declares TrustTBClient");
	return { ts, source, klass };
}

let client: TrustTBClient;

beforeEach(() => {
	native.created = 0;
	native.destroyed = new Set();
	native.calls = [];
	native.attempts = [];
	native.failCreate = 0;
	native.destroyThrows = false;
	native.onCreate = null;
	native.respond = async () => [];
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	client = new TrustTBClient({ addresses: ["3000"] });
});

afterEach(() => {
	client.destroy();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("after destroy(), the client never reconnects", () => {
	it("an operation in flight at destroy() fails with its own error, and no client is built", async () => {
		native.respond = never;
		const lookup = client.lookupBalances([1n]);
		await tick();
		client.destroy();
		await expect(lookup).rejects.toThrow("Client was closed.");
		expect(native.created).toBe(1);
		expect(alive()).toBe(0);
		expect(native.calls).toEqual(["client1:lookupAccounts"]);
	});

	it("an operation started after destroy() fails with LedgerClientClosedError, before the native client", async () => {
		client.destroy();
		await expect(client.lookupBalances([1n])).rejects.toBeInstanceOf(LedgerClientClosedError);
		expect(native.calls).toEqual([]);
		expect(native.created).toBe(1);
		expect(alive()).toBe(0);
	});

	it("a POST that committed but lost its reply fails: no reconnect, no retry into an `exists` success", async () => {
		const committed = new Set<bigint>();
		native.respond = (id, op, batch) => {
			const transfer = batch[0] as { id: bigint };
			if (op !== "createTransfers") return Promise.resolve([]);
			// A retry of a committed id would be answered `exists`, which counts as success.
			if (committed.has(transfer.id)) return Promise.resolve([{ index: 0, status: 46 }]);
			committed.add(transfer.id);
			// The first client's reply never comes back: destroy() closes it first.
			return id === 1 ? never() : Promise.resolve([]);
		};
		const post = client.postTransfer(42n, 100);
		await tick();
		client.destroy();
		await expect(post).rejects.toThrow("Client was closed.");
		expect(committed.size).toBe(1);
		expect(native.calls).toEqual(["client1:createTransfers"]);
		expect(native.created).toBe(1);
		expect(alive()).toBe(0);
	});

	it("destroy() during a reconnect's backoff builds no client, and every operation awaiting that reconnect fails with LedgerClientClosedError", async () => {
		vi.useFakeTimers();
		native.respond = async () => {
			throw new Error("connection refused");
		};
		// The first reconnect attempt fails, so the reconnect sleeps out its backoff.
		native.failCreate = 1;
		const first = client.lookupBalances([1n]).catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(10);
		// A second operation, started during the backoff, waits on the same reconnect.
		const second = client.lookupBalances([2n]).catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(10);
		client.destroy();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await first).toBeInstanceOf(LedgerClientClosedError);
		expect(await second).toBeInstanceOf(LedgerClientClosedError);
		// Only the constructor's client was ever built, and it is destroyed.
		expect(native.created).toBe(1);
		expect(alive()).toBe(0);
	});

	it("a health-check ping in flight at destroy() does not reconnect", async () => {
		await client.createTreasury();
		native.respond = (_id, op) => (op === "lookupAccounts" ? never() : Promise.resolve([]));
		const ping = client.ping();
		await tick();
		client.destroy();
		expect(await ping).toBe(false);
		expect(native.created).toBe(1);
		expect(alive()).toBe(0);
	});

	it("a native destroy() that throws still leaves the client closed: nothing reaches the native client after it", async () => {
		native.destroyThrows = true;
		expect(() => client.destroy()).toThrow("deinit failed");
		await expect(client.lookupBalances([1n])).rejects.toBeInstanceOf(LedgerClientClosedError);
		expect(native.calls).toEqual([]);
		expect(native.created).toBe(1);
	});

	it("a native destroy() that throws keeps its native client for a second destroy() to retry, which closes it", () => {
		native.destroyThrows = true;
		expect(() => client.destroy()).toThrow("deinit failed");
		expect(alive()).toBe(1);
		client.destroy();
		expect(alive()).toBe(0);
	});

	it("once destroy() has returned, nothing touches the native client again, a second destroy() included", async () => {
		client.destroy();
		const after = native.attempts.length;
		client.destroy();
		await expect(client.lookupBalances([1n])).rejects.toBeInstanceOf(LedgerClientClosedError);
		expect(native.attempts.slice(after)).toEqual([]);
	});

	it("reconnect() itself is refused once destroyed", async () => {
		client.destroy();
		await expect(client.reconnect()).rejects.toBeInstanceOf(LedgerClientClosedError);
		expect(native.created).toBe(1);
	});

	it("destroy() between two steps of one operation: the later step is refused before the native client", async () => {
		// createTreasury() looks its treasury up, then creates it when the lookup finds none.
		// destroy() lands between the two steps, as the lookup's answer is read.
		client.setTreasuryId(5n);
		const noneThenDestroy = {
			get length() {
				client.destroy();
				return 0;
			},
		} as unknown as unknown[];
		native.respond = async (_id, op) => (op === "lookupAccounts" ? noneThenDestroy : []);
		await expect(client.createTreasury()).rejects.toBeInstanceOf(LedgerClientClosedError);
		expect(native.calls).toEqual(["client1:lookupAccounts"]);
		expect(native.created).toBe(1);
		expect(alive()).toBe(0);
	});
});

describe("every entry path honours destroy(), shortcuts included", () => {
	for (const [name, op] of OPERATIONS) {
		it(`${name} after destroy() fails with LedgerClientClosedError and never reaches the native client`, async () => {
			// In-memory state a shortcut could answer from.
			client.setAccountMapping("cached-user", 7n);
			client.setTreasuryId(5n);
			client.destroy();
			await expect(op(client)).rejects.toBeInstanceOf(LedgerClientClosedError);
			expect(native.calls).toEqual([]);
		});
	}

	// 30 s: it imports `typescript`, which under a loaded suite can outlast vitest's default 5 s.
	it("every public async method but ping() opens with this.assertOpen(), and each is in both tables", async () => {
		const { ts, source, klass } = await parseClient();
		const opens: string[] = [];
		const doesNot: string[] = [];
		for (const member of klass.members) {
			if (!ts.isMethodDeclaration(member) || !member.body) continue;
			const kinds = (ts.getModifiers(member) ?? []).map((m) => m.kind);
			if (!kinds.includes(ts.SyntaxKind.AsyncKeyword)) continue;
			if (kinds.includes(ts.SyntaxKind.PrivateKeyword)) continue;
			if (kinds.includes(ts.SyntaxKind.StaticKeyword)) continue;
			const first = member.body.statements[0];
			const checksFirst =
				first !== undefined &&
				ts.isExpressionStatement(first) &&
				first.expression.getText(source) === "this.assertOpen()";
			(checksFirst ? opens : doesNot).push(member.name.getText(source));
		}
		// ping() answers `false` instead (pinned below).
		expect(doesNot).toEqual(["ping"]);
		// A new operation fails this until it has a row in OPERATIONS (refused after destroy())
		// and in SCENARIOS (destroy() at each of its await boundaries), so behaviour pins it too.
		const tabled = new Set(OPERATIONS.map(([name]) => name.split(",")[0]));
		expect(opens.sort()).toEqual([...tabled, "reconnect"].sort());
		expect(new Set(SCENARIOS.map((s) => s.name.split(",")[0]))).toEqual(tabled);
	}, 30_000);

	it("every request reaches the native client through native(), called by withReconnect() alone, in a closure that makes one request at once", async () => {
		const { ts, source, klass } = await parseClient();
		const readsClient = new Set<string>();
		const callsNative: string[] = [];
		const requests = new Set<string>();
		const notOneRequest: string[] = [];
		for (const member of klass.members) {
			const name = ts.isConstructorDeclaration(member)
				? "constructor"
				: (member.name?.getText(source) ?? "?");
			const visit = (node: import("typescript").Node): void => {
				if (
					ts.isPropertyAccessExpression(node) &&
					node.expression.kind === ts.SyntaxKind.ThisKeyword &&
					node.name.text === "client"
				) {
					readsClient.add(name);
				}
				if (
					ts.isCallExpression(node) &&
					ts.isPropertyAccessExpression(node.expression) &&
					node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
				) {
					if (node.expression.name.text === "native") callsNative.push(name);
					if (node.expression.name.text === "withReconnect") {
						// `(native) => native.createAccounts([account])`: not async, so it cannot hold
						// the client across an await; one request, on the client it was handed.
						const arg = node.arguments[0];
						const param = arg && ts.isArrowFunction(arg) ? arg.parameters[0] : undefined;
						const body = arg && ts.isArrowFunction(arg) ? arg.body : undefined;
						const one =
							arg !== undefined &&
							ts.isArrowFunction(arg) &&
							!(ts.getModifiers(arg) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) &&
							arg.parameters.length === 1 &&
							param !== undefined &&
							body !== undefined &&
							ts.isCallExpression(body) &&
							ts.isPropertyAccessExpression(body.expression) &&
							ts.isIdentifier(body.expression.expression) &&
							body.expression.expression.text === param.name.getText(source);
						if (one)
							requests.add(
								(body.expression as import("typescript").PropertyAccessExpression).name.text,
							);
						else notOneRequest.push(arg?.getText(source) ?? "(no argument)");
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(member);
		}
		// Only the client's lifecycle touches the field; requests go through native().
		expect([...readsClient].sort()).toEqual(["_doReconnect", "constructor", "destroy", "native"]);
		// withReconnect() alone calls native(): for the request, and for its retry.
		expect(callsNative).toEqual(["withReconnect", "withReconnect"]);
		expect(notOneRequest).toEqual([]);
		// A control: the walk sees the requests, every kind this client makes.
		expect([...requests].sort()).toEqual([
			"createAccounts",
			"createTransfers",
			"lookupAccounts",
			"lookupTransfers",
		]);
	}, 30_000);

	it("ping() after destroy() reports unhealthy, its start-up grace period included", async () => {
		client.destroy();
		expect(await client.ping()).toBe(false);
		expect(native.calls).toEqual([]);
	});

	it("reconnect() right after destroy(), while a reconnect that just finished is still cached, is refused", async () => {
		// This reconnect completes synchronously; its cleanup is still queued.
		const finished = client.reconnect();
		client.destroy();
		await expect(client.reconnect()).rejects.toBeInstanceOf(LedgerClientClosedError);
		await finished;
		expect(alive()).toBe(0);
	});
});

describe("after destroy(), an operation is refused before its own input checks", () => {
	// Each is refused by the operation's own check, before it reaches withReconnect(): a name
	// reserved for pre-v3 cost centers, a transfer id outside (0, 2^128 - 1), an amount
	// BigInt() refuses, or a treasury this client was never given.
	const REFUSED_INPUTS: Array<[string, (c: TrustTBClient) => Promise<unknown>]> = [
		["createUserWallet, a reserved id", (c) => c.createUserWallet("acme::billing")],
		[
			"createCostCenterWallet, a reserved parent",
			(c) => c.createCostCenterWallet("acme::x", "billing"),
		],
		[
			"createCostCenterWallet, an invalid cost center",
			(c) => c.createCostCenterWallet("acme", "bill ing"),
		],
		["ensureEscrowAccount, a reserved label", (c) => c.ensureEscrowAccount("acme::billing")],
		["createFundedBudgetWallet, no treasury", (c) => c.createFundedBudgetWallet(100)],
		[
			"createPendingTransfer, transfer id 0",
			(c) => c.createPendingTransfer({ ...TRANSFER, transferId: 0n }),
		],
		[
			"createPendingTransfer, a fractional amount",
			(c) => c.createPendingTransfer({ ...TRANSFER, amount: 1.5 }),
		],
		["postTransfer, transfer id 0", (c) => c.postTransfer(1n, 10, { transferId: 0n })],
		["postTransfer, a fractional amount", (c) => c.postTransfer(1n, 1.5)],
		["voidTransfer, transfer id 0", (c) => c.voidTransfer(1n, { transferId: 0n })],
		[
			"immediateTransfer, transfer id 0",
			(c) => c.immediateTransfer({ ...TRANSFER, transferId: 0n }),
		],
		[
			"immediateTransfer, a fractional amount",
			(c) => c.immediateTransfer({ ...TRANSFER, amount: 1.5 }),
		],
	];
	for (const [name, op] of REFUSED_INPUTS) {
		it(`${name}: LedgerClientClosedError, not the input's own error`, async () => {
			client.destroy();
			await expect(op(client)).rejects.toBeInstanceOf(LedgerClientClosedError);
			expect(native.calls).toEqual([]);
		});

		// CONTROL: on an open client the input is refused by its own check, so the case above
		// reaches that check.
		it(`control: ${name}, on an open client, fails with its own error before the native client`, async () => {
			const err = await op(client).then(
				() => undefined,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(Error);
			expect(err).not.toBeInstanceOf(LedgerClientClosedError);
			expect(native.calls).toEqual([]);
		});
	}
});

describe("destroy() at every await boundary: no request reaches a native client after it", () => {
	for (const s of SCENARIOS) {
		// CONTROL: the sequence of requests the boundaries below are counted against.
		it(`${s.name}: without destroy(), it requests ${s.requests.join(" then ")}, and ${s.rejects ? `rejects with ${s.rejects.name}` : "resolves"}`, async () => {
			native.respond = ledgerAnswers(s.replay ?? false);
			if (s.treasury !== undefined) client.setTreasuryId(s.treasury);
			expectAsWithoutDestroy(await settle(s.op(client)), s);
			expect(native.attempts).toEqual(s.requests.map((op) => `client1:${op}`));
		});

		s.requests.forEach((request, i) => {
			const k = i + 1;
			const last = k === s.requests.length;

			it(`${s.name}: destroy() as it reads request ${k}'s answer (${request}): ${last ? "it settles as without destroy()" : "its next step fails with LedgerClientClosedError"}, and no request after`, async () => {
				const { outcome, destroyedAt } = await destroyAt(s, k, "answered");
				if (last) {
					expectAsWithoutDestroy(outcome, s);
					// An operation that hands its last answer back unread never reads it here.
					if (destroyedAt === undefined) return;
				} else {
					expectClosed(outcome);
				}
				expectNothingAfter(destroyedAt);
			});

			it(`${s.name}: destroy() while request ${k} (${request}) is in flight: its own error, and no request after`, async () => {
				const { outcome, destroyedAt } = await destroyAt(s, k, "in flight");
				expect(outcome.ok).toBe(false);
				expect((outcome as { reason: unknown }).reason).not.toBeInstanceOf(LedgerClientClosedError);
				expect(String((outcome as { reason: unknown }).reason)).toContain("Client was closed.");
				expectNothingAfter(destroyedAt);
				expect(alive()).toBe(0);
			});

			it(`${s.name}: request ${k} (${request}) loses its connection and destroy() lands before the retry: LedgerClientClosedError, and the reconnected client gets no request`, async () => {
				const { outcome, destroyedAt } = await destroyAt(s, k, "reconnected");
				expectClosed(outcome);
				expectNothingAfter(destroyedAt);
				// The reconnect built client 2 before destroy(), and its native destroy threw: it is
				// open, and only the closed check kept the retry off it.
				expect(native.created).toBe(2);
				expect(native.destroyed.has(2)).toBe(false);
			});
		});
	}

	it("ping(): its lookup loses its connection and destroy() lands before the retry: unhealthy, and the reconnected client gets no request", async () => {
		const ping: Scenario = {
			name: "ping",
			treasury: KNOWN_ACCOUNT,
			op: (c) => c.ping(),
			requests: ["lookupAccounts"],
		};
		const { outcome, destroyedAt } = await destroyAt(ping, 1, "reconnected");
		expect(outcome).toEqual({ ok: true, value: false });
		expectNothingAfter(destroyedAt);
		expect(native.created).toBe(2);
	});
});

describe("controls: without destroy(), the client still reconnects", () => {
	it("a lost connection reconnects and retries on the new client", async () => {
		native.respond = async (id) => {
			if (id === 1) throw new Error("connection refused");
			return [];
		};
		await expect(client.lookupBalances([1n])).resolves.toEqual(new Map());
		expect(native.calls).toEqual(["client1:lookupAccounts", "client2:lookupAccounts"]);
		// The old client is destroyed by the reconnect; one client is alive, as it should be.
		expect(alive()).toBe(1);
	});

	it("an operation on a client closed by OUR OWN reconnect still retries on the new client", async () => {
		native.respond = async (id) => (id === 1 ? never() : []);
		const lookup = client.lookupBalances([1n]);
		await tick();
		// A reconnect started elsewhere closes client1 under the lookup.
		await client.reconnect();
		await expect(lookup).resolves.toEqual(new Map());
		expect(native.destroyed.has(1)).toBe(true);
		expect(alive()).toBe(1);
	});
});
