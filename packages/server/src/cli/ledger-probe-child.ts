// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The ledger probe's child process:
 * `node ledger-probe-child.js <clusterId> <addressesJson> <timeoutMs>`.
 * It makes one TigerBeetle round trip and exits 0. It runs apart from the server
 * (ledger-probe.ts) because the native client can panic, and a panic in native code
 * kills the whole process: no JavaScript can catch it.
 *
 * It never outlives the server: a client with no TigerBeetle to answer retries without
 * end, so the child keeps its own deadline, and exits as soon as its parent is gone.
 */

import { loadTigerBeetle } from "./tigerbeetle-load.js";

/** Read by the parent's classifier (ledger-probe.ts, CHILD_DEADLINE_LINE): keep them equal. */
const DEADLINE_LINE = "ledger probe: no answer before the deadline";
/** The parent is gone: nobody is left to read an answer. */
const ORPHANED = 4;

const [clusterId, addressesJson, timeoutArg] = process.argv.slice(2);
const timeoutMs = Number(timeoutArg);
if (clusterId === undefined || addressesJson === undefined || !(timeoutMs > 0)) {
	process.stderr.write("usage: ledger-probe-child <clusterId> <addressesJson> <timeoutMs>\n");
	process.exit(2);
}

// Armed before anything that can hang, the native client's load included. Ref'd: it is
// what ends a probe nobody answers.
setTimeout(() => {
	process.stderr.write(`${DEADLINE_LINE} (${timeoutMs} ms)\n`);
	process.exit(3);
}, timeoutMs);

// The parent's IPC channel closes when it dies, by any signal: SIGKILL included, which
// leaves it no chance to kill this child itself.
if (process.send !== undefined) {
	if (!process.connected) process.exit(ORPHANED);
	process.on("disconnect", () => process.exit(ORPHANED));
}
// The backstop where there is no IPC channel: a re-parented child has a new ppid.
const parentPid = process.ppid;
setInterval(() => {
	if (process.ppid !== parentPid) process.exit(ORPHANED);
}, 250).unref();

// Resolved from the core package's own location, so the probe loads the very
// `tigerbeetle-node` the server's governors load.
const { createClient } = loadTigerBeetle();

try {
	const client = createClient({
		cluster_id: BigInt(clusterId),
		replica_addresses: JSON.parse(addressesJson) as string[],
	});
	// A read of one account id: one round trip, and it writes nothing.
	await client.lookupAccounts([1n]);
	client.destroy();
	process.exit(0);
} catch (err) {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
}
