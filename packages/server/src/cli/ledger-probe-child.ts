// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The ledger probe's child process: `node ledger-probe-child.js <clusterId> <addressesJson>`.
 * It makes one TigerBeetle round trip and exits 0. It runs apart from the server
 * (ledger-probe.ts) because the native client can panic, and a panic in native code
 * kills the whole process: no JavaScript can catch it.
 */

import { createRequire } from "node:module";

/** The slice of `tigerbeetle-node` the probe uses. */
interface TigerBeetleModule {
	createClient(args: { cluster_id: bigint; replica_addresses: string[] }): {
		lookupAccounts(ids: bigint[]): Promise<unknown[]>;
		destroy(): void;
	};
}

const [clusterId, addressesJson] = process.argv.slice(2);
if (clusterId === undefined || addressesJson === undefined) {
	process.stderr.write("usage: ledger-probe-child <clusterId> <addressesJson>\n");
	process.exit(2);
}

// Resolved from the core package's own location, so the probe loads the very
// `tigerbeetle-node` the server's governors load.
const require = createRequire(import.meta.resolve("usertrust"));
const { createClient } = require("tigerbeetle-node") as TigerBeetleModule;

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
