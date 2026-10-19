// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * How the ledger's child processes (ledger-probe-child.ts, ledger-health-child.ts) load the
 * native TigerBeetle client. One module for both, so they never drift apart from each other or
 * from the server's governors.
 */

import { createRequire } from "node:module";

/** The slice of `tigerbeetle-node` the children use. */
export interface TigerBeetleModule {
	createClient(args: { cluster_id: bigint; replica_addresses: string[] }): {
		lookupAccounts(ids: bigint[]): Promise<unknown[]>;
		destroy(): void;
	};
}

/**
 * `tigerbeetle-node`, resolved from the core package's own location, so a child loads the very
 * native module the server's governors load.
 */
export function loadTigerBeetle(): TigerBeetleModule {
	const require = createRequire(import.meta.resolve("usertrust"));
	return require("tigerbeetle-node") as TigerBeetleModule;
}
