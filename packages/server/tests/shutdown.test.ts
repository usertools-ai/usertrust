// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Shutdown ends every pending hold and RECORDS it, in ledger mode as in dry run.
 *
 * A stopped server's pending hold left no record in the chain. Two owners handled the one
 * signal: the governor's own safety net began its teardown first (it took the hold, and
 * was still on its way to the void), and the server's `close()` then asked the same governor
 * to destroy itself, got an immediate return from a teardown that had only begun, and let the
 * command line exit under it. Pinned here:
 *  - `close()` waits for a teardown that began elsewhere: after it resolves, the chain has the
 *    hold's `hold_released` (a ledger whose void takes a moment, a hold held at that time);
 *  - a plain `close()` records the hold as 'server shutdown', in ledger mode too, with its void;
 *  - the pool asks for governors that leave the signals to the host;
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGovernor, type Governor, readLedgerEvents } from "usertrust";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashKey } from "../src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";

const KEY = "ut_shutdown_key";
const AUTHORIZE = { model: "claude-sonnet-4-6", estimatedInputTokens: 10, maxOutputTokens: 10 };

/** A ledger whose void waits on `voidGate`, as a round trip to the ledger does. */
function gatedLedger() {
	const pending = new Set<string>();
	const voided: string[] = [];
	let open = (): void => {};
	const voidGate = new Promise<void>((resolve) => {
		open = resolve;
	});
	const engine = {
		spendPending: vi.fn(async (p: { transferId: string }) => {
			pending.add(p.transferId);
			return { transferId: p.transferId };
		}),
		postPendingSpend: vi.fn(async () => {}),
		voidPendingSpend: vi.fn(async (transferId: string) => {
			await voidGate;
			if (pending.delete(transferId)) voided.push(transferId);
		}),
		voidAllPending: vi.fn(async () => {
			for (const id of [...pending]) {
				pending.delete(id);
				voided.push(id);
			}
		}),
		lookupBalances: vi.fn(async (ids: bigint[]) => new Map(ids.map((id) => [id, 5_000]))),
		destroy: vi.fn(),
	};
	return { engine, voided, openVoid: open };
}

/** Let everything already queued run: microtasks and one macrotask turn, no timer. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

let server: UsertrustServer | undefined;
const governors: Governor[] = [];
afterEach(async () => {
	await server?.close();
	server = undefined;
	for (const g of governors.splice(0)) await g.destroy();
});

async function ledgerServer(opts: { holdVoid?: boolean } = {}) {
	const stateDir = await mkdtemp(join(tmpdir(), "utsrv-shutdown-"));
	const { engine, voided, openVoid } = gatedLedger();
	if (opts.holdVoid !== true) openVoid();
	const seen: Array<Record<string, unknown>> = [];
	server = createUsertrustServer({
		config: {
			host: "127.0.0.1",
			port: 0,
			stateDir,
			enforcement: "enforce",
			pendingTtlMs: 300_000,
			dryRun: false,
			tenants: [{ id: "acme", keyHash: hashKey(KEY), budget: 1_000_000 }],
		},
		factory: async (opts) => {
			seen.push({ ...opts });
			const governor = await createGovernor({ ...opts, _engine: engine as never });
			governors.push(governor);
			return governor;
		},
	});
	const { port } = await server.listen();
	const authorize = async (): Promise<string> => {
		const res = await fetch(`http://127.0.0.1:${port}/v1/authorize`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
			body: JSON.stringify(AUTHORIZE),
		});
		expect(res.status).toBe(200);
		return ((await res.json()) as { transferId: string }).transferId;
	};
	const chain = () =>
		readLedgerEvents(join(stateDir, "acme", ".usertrust")) as Array<{
			kind: string;
			data: Record<string, unknown>;
		}>;
	return { authorize, voided, seen, chain, engine, openVoid };
}

describe("shutdown with a pending hold, ledger mode (dryRun false)", () => {
	it("a plain close() ends the hold with its void and records it as 'server shutdown'", async () => {
		const { authorize, voided, chain } = await ledgerServer();
		const transferId = await authorize();
		await server?.close();
		server = undefined;
		expect(voided).toEqual([transferId]);
		const released = chain().filter((e) => e.kind === "hold_released");
		expect(released.map((e) => [e.data.transferId, e.data.reason])).toEqual([
			[transferId, "server shutdown"],
		]);
	});

	it("close() waits for a teardown another caller already began: the record has landed when it resolves", async () => {
		const { authorize, voided, chain, openVoid } = await ledgerServer({ holdVoid: true });
		const transferId = await authorize();
		const governor = governors[0] as Governor;
		// What the governor's own signal handler did first: begin the teardown, which took the hold
		// and is waiting on the ledger's void.
		void governor.destroy();
		let closed = false;
		const closing = (server as UsertrustServer).close().then(() => {
			closed = true;
		});
		server = undefined;
		for (let i = 0; i < 5; i += 1) await turn();
		// mutant: destroy() returns at once when already begun → close() resolves with the void still out
		expect(closed).toBe(false);
		openVoid();
		await closing;
		const released = chain().filter((e) => e.kind === "hold_released");
		expect(released.map((e) => e.data.transferId)).toEqual([transferId]);
		expect(voided).toEqual([transferId]);
	});

	it("the pool builds governors that leave the process signals to the server", async () => {
		const { authorize, seen } = await ledgerServer();
		await authorize();
		// mutant: the pool omits it → the governor's own SIGTERM/SIGINT listeners race the server's
		expect(seen.map((o) => o.installSignalHandlers)).toEqual([false]);
	});
});
