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
 *  - a native `destroy()` that throws still leaves the client closed (the flag is set first);
 *  - CONTROLS: without `destroy()`, a lost connection still reconnects and retries, and an
 *    operation on a client closed by OUR OWN reconnect still retries on the new one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Respond = (client: number, op: string, batch: unknown[]) => Promise<unknown[]>;

/** The fake native layer: every client it built, every request, and how requests answer. */
const native = vi.hoisted(() => ({
	created: 0,
	destroyed: new Set<number>(),
	calls: [] as string[],
	/** Upcoming createClient calls that throw (a failed reconnect attempt). */
	failCreate: 0,
	/** The next native destroy() throws, before it closes anything (as a throwing deinit would). */
	destroyThrows: false,
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
			return {
				createAccounts: request("createAccounts"),
				createTransfers: request("createTransfers"),
				lookupAccounts: request("lookupAccounts"),
				lookupTransfers: request("lookupTransfers"),
				destroy: () => {
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
		},
		AccountFlags: { debits_must_not_exceed_credits: 1 << 2, history: 1 << 5 },
		TransferFlags: { pending: 1, post_pending_transfer: 2, void_pending_transfer: 4 },
		CreateAccountStatus: { created: 4294967295, exists: 1 },
		CreateTransferStatus: { created: 4294967295, exists: 46, 46: "exists" },
		amount_max: (1n << 128n) - 1n,
	};
});

import { LedgerClientClosedError, TrustTBClient } from "../../src/ledger/client.js";

/** A request that never answers: it is in flight until its client is destroyed. */
const never = (): Promise<unknown[]> => new Promise(() => {});
const tick = () => new Promise((r) => setImmediate(r));
/** Clients built and never destroyed: each one keeps a process alive. */
const alive = () => native.created - native.destroyed.size;

let client: TrustTBClient;

beforeEach(() => {
	native.created = 0;
	native.destroyed = new Set();
	native.calls = [];
	native.failCreate = 0;
	native.destroyThrows = false;
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

	it("reconnect() itself is refused once destroyed", async () => {
		client.destroy();
		await expect(client.reconnect()).rejects.toBeInstanceOf(LedgerClientClosedError);
		expect(native.created).toBe(1);
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
