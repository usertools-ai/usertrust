// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `TrustTBClient.connectDeadline(timeoutMs)`: a governor that reaches something which is not a
 * usertrust ledger (a listener that never answers, a cluster of another id, a client the cluster
 * evicts) stops at the deadline with a message, instead of waiting for tigerbeetle-node, which retries
 * forever and has no request timeout.
 *
 * tigerbeetle-node is replaced by a mock that behaves as the binding does where it matters here: a
 * request on a destroyed client fails CLOSED, destroy() rejects what is in flight, and destroying a
 * client the cluster evicted aborts the process (recorded in `native.aborts`, never run).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Respond = (id: number, op: string, batch: unknown[]) => Promise<unknown[]>;

const native = vi.hoisted(() => ({
	created: 0,
	destroyed: new Set<number>(),
	calls: [] as string[],
	respond: (async () => []) as Respond,
	/** Clients the cluster evicted: each answers "closed" from then on, as the binding does. */
	evicted: new Set<number>(),
	/** destroy() called on an evicted client: in tigerbeetle-node 0.17.9 that aborts the process. */
	aborts: [] as number[],
}));

vi.mock("tigerbeetle-node", () => {
	const closedError = (): Error =>
		Object.assign(new Error("Client was closed."), { code: "ERR_CLIENT_CLOSED" });
	return {
		createClient: () => {
			native.created += 1;
			const id = native.created;
			let open = true;
			const inFlight = new Set<(err: Error) => void>();
			const request =
				(op: string) =>
				(batch: unknown[]): Promise<unknown[]> => {
					if (!open || native.evicted.has(id)) return Promise.reject(closedError());
					native.calls.push(`client${id}:${op}`);
					return new Promise((resolve, reject) => {
						inFlight.add(reject);
						native.respond(id, op, batch).then(resolve, reject);
					});
				};
			return {
				createAccounts: request("createAccounts"),
				createTransfers: request("createTransfers"),
				lookupAccounts: request("lookupAccounts"),
				lookupTransfers: request("lookupTransfers"),
				destroy: () => {
					if (native.evicted.has(id)) native.aborts.push(id);
					if (!open) return;
					open = false;
					native.destroyed.add(id);
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

import { TrustTBClient } from "../../src/ledger/client.js";
import { LedgerUnavailableError } from "../../src/shared/errors.js";

const never: Respond = () => new Promise(() => {});

let client: TrustTBClient;

beforeEach(() => {
	native.created = 0;
	native.destroyed = new Set();
	native.calls = [];
	native.respond = async () => [];
	native.evicted = new Set();
	native.aborts = [];
	vi.spyOn(console, "warn").mockImplementation(() => {});
	client = new TrustTBClient({ addresses: ["127.0.0.1:3001"] });
});

afterEach(() => {
	client.destroy();
	vi.restoreAllMocks();
});

describe("connectDeadline", () => {
	it("a ledger that answers: resolves, makes one lookup, and leaves the client open and usable", async () => {
		await client.connectDeadline(1_000);
		expect(native.calls).toEqual(["client1:lookupAccounts"]);
		expect(native.destroyed.size).toBe(0);
		await expect(client.lookupAccounts([1n])).resolves.toEqual([]);
	});

	it("something listens but never answers: stops at the deadline, names the fix, and closes the client", async () => {
		native.respond = never;
		const started = Date.now();
		const err = await client.connectDeadline(100).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(LedgerUnavailableError);
		const message = (err as Error).message;
		expect(message).toContain("something is listening at 127.0.0.1:3001");
		expect(message).toContain("no usertrust ledger answered in 0.1 s");
		expect(message).toContain("npx usertrust tb status");
		// Bounded by the deadline plus close()'s own probe wait, not by the binding.
		// timing: 5 s bound over a 100 ms deadline plus close()'s 2 s probe wait (4.2x headroom on the worst case); it took 2.1 s locally, as the mock never answers the probe either.
		expect(Date.now() - started).toBeLessThan(5_000);
		// The existing close() path ran: the native client was destroyed, so nothing holds the process.
		expect([...native.destroyed]).toEqual([1]);
		expect(native.aborts).toEqual([]);
		// And the wrapper is closed: nothing reconnects it.
		await expect(client.lookupAccounts([1n])).rejects.toThrow();
		expect(native.created).toBe(1);
	});

	it("a client the cluster evicts: says the process must exit on its own, and never destroys the evicted client", async () => {
		native.respond = async (id) => {
			native.evicted.add(id);
			throw Object.assign(new Error("evicted"), { code: "ERR_CLIENT_EVICTED" });
		};
		const err = await client.connectDeadline(1_000).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(LedgerUnavailableError);
		const message = (err as Error).message;
		expect(message).toContain("ERR_CLIENT_EVICTED");
		expect(message).toContain("will not exit on its own");
		expect(message).toContain("process.exit()");
		// destroy() on an evicted client aborts the process in 0.17.9: it must not be called.
		expect(native.aborts).toEqual([]);
		expect(native.destroyed.size).toBe(0);
	});

	it("any other failure is rethrown as it came, and the client is closed", async () => {
		native.respond = async () => {
			throw new Error("boom");
		};
		await expect(client.connectDeadline(1_000)).rejects.toThrow("boom");
		expect([...native.destroyed]).toEqual([1]);
	});
});
