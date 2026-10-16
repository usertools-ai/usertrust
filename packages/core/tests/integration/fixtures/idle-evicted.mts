// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Run in its OWN process by `evicted-client.tb.test.ts`, against a private TigerBeetle cluster:
 * `tsx idle-evicted.mts <address> <request|governor|timeout>`.
 *
 * A session the cluster pushes out while its client is IDLE: the native client learns of it
 * about 25 s later from its own traffic (it logs "session evicted"), and from then on fails
 * every request ERR_CLIENT_CLOSED, never ERR_CLIENT_EVICTED (tigerbeetle-node 0.17.9). Sessions
 * are pushed out one at a time, as in `evicted-client.mts`. The fixture then waits for a line on
 * stdin, which the parent writes once the client has logged its eviction, so what follows runs
 * on a client that learned of it with no request since.
 *
 * - `request`: a TrustTBClient (no treasury, so no health check); then ONE ordinary request,
 *   which must be answered through a reconnect, and destroy().
 * - `governor`: a createGovernor() governor; then its destroy(), which must not abort.
 * - `timeout`: a TrustTBClient whose cluster the parent stops (SIGSTOP) before the go line;
 *   then close(), whose probe is never answered: the client is destroyed after the bound, and
 *   the process ends on its own.
 *
 * In `governor` mode the ledger client's 30 s health check is held off. Each check is a ledger
 * request that renews the session, and the push-out (64 sessions, one at a time) takes longer
 * than 30 s, so with it running the session is never pushed out. With a faster cluster it can
 * be, and the check then usually meets the eviction first: the client-destroy unit rows pin that
 * path. Held off here, the eviction reaches the governor's client the way close() exists for.
 *
 * Lines on stdout (and stderr, so the parent can order them against the client's own log):
 * start, request, destroying, destroyed, end; then, if something still holds the event loop
 * after 3 s (an evicted native client left open), still-alive, and process.exit(0).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "tigerbeetle-node";

const [address = "", mode = "request"] = process.argv.slice(2);
const print = (line: Record<string, unknown>): void => {
	const text = `${JSON.stringify(line)}\n`;
	process.stdout.write(text);
	process.stderr.write(text);
};

let reconnects = 0;
console.log = (...args: unknown[]) => {
	if (String(args[0]).includes("Reconnection attempt")) reconnects += 1;
};

let heldChecks = 0;
if (mode === "governor") {
	const realSetInterval = globalThis.setInterval;
	globalThis.setInterval = ((fn: () => void, ms?: number, ...args: unknown[]) => {
		if (ms === 30_000) {
			heldChecks += 1;
			return realSetInterval(() => {}, 2 ** 31 - 1);
		}
		return realSetInterval(fn, ms, ...args);
	}) as typeof setInterval;
}

/** 64 newer sessions, one at a time: the oldest session in the cluster's table is evicted. */
async function pushOut(): Promise<void> {
	for (let i = 0; i < 64; i++) {
		const other = createClient({ cluster_id: 0n, replica_addresses: [address] });
		await other.lookupAccounts([]);
		other.destroy();
	}
}

/** The parent's go line: written once the client has logged its eviction (or its cluster stopped). */
async function go(): Promise<void> {
	await new Promise((resolve) => process.stdin.once("data", resolve));
	process.stdin.destroy();
}

const { TrustTBClient } = await import("../../../src/ledger/client.js");

if (mode === "governor") {
	const { createGovernor } = await import("../../../src/headless.js");
	const dir = mkdtempSync(join(tmpdir(), "usertrust-idle-evicted-"));
	mkdirSync(join(dir, ".usertrust"), { recursive: true });
	writeFileSync(
		join(dir, ".usertrust", "usertrust.config.json"),
		JSON.stringify({ budget: 1_000_000, tigerbeetle: { addresses: [address], clusterId: 0 } }),
	);
	const gov = await createGovernor({ vaultBase: dir });
	print({ step: "start", vault: dir, heldChecks });
	await pushOut();
	await go();
	print({ step: "destroying" });
	await gov.destroy();
	print({ step: "destroyed", reconnects });
} else {
	const target = new TrustTBClient({ addresses: [address], clusterId: 0n });
	await target.lookupAccounts([1n]);
	print({ step: "start" });
	if (mode === "timeout") {
		await go();
		const started = Date.now();
		print({ step: "destroying" });
		await target.close();
		print({ step: "destroyed", ms: Date.now() - started, reconnects });
	} else {
		await pushOut();
		await go();
		const answered = await target.lookupAccounts([1n]).then(
			(accounts) => Array.isArray(accounts),
			(err: unknown) => String(err),
		);
		print({ step: "request", answered, reconnects });
		print({ step: "destroying" });
		target.destroy();
		print({ step: "destroyed" });
	}
}

print({ step: "end" });
setTimeout(() => {
	print({ step: "still-alive" });
	process.exit(0);
}, 3_000).unref();
