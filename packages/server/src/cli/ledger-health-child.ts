// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The ledger health observer's child process: `node ledger-health-child.js <clusterId> <addressesJson>`.
 * One per distinct ledger target the server's tenants use, for as long as the server runs
 * (ledger-health.ts). It opens ONE TigerBeetle client (one session) and answers its parent's
 * probes over IPC:
 * - `{ probe: n }` → `lookupAccounts([])`, then `{ reply: n }`, or `{ error: n, code }` with the
 *   native code. The parent never sends a probe before the last one is answered.
 * - On eviction (`EVICTION_CODES`, the core ledger client's own set, or `ERR_CLIENT_CLOSED`, since
 *   nothing here closes the client) it sends `{ evicted: true }` and exits 5. It never calls `destroy()`: exit is always a
 *   process exit, and the session dies with the process.
 * It runs apart from the server because the native client can panic, and a panic in native code
 * kills the whole process. Diagnostics go to the parent as `{ log }` messages (it has no stderr
 * the parent reads), with fixed text only.
 */

import { loadTigerBeetle } from "./tigerbeetle-load.js";

/** The parent is gone: nobody is left to read an answer (ledger-probe-child.ts's code). */
const ORPHANED = 4;
/** The cluster evicted this client's session. */
const EVICTED = 5;
/** The native client could not be loaded or created here. */
const NO_CLIENT = 6;

/**
 * The codes that say the cluster evicted this client's session: the core ledger client's
 * EVICTION_CODES (packages/core/src/ledger/client.ts), plus `ERR_CLIENT_CLOSED`, which a native
 * client nothing destroyed raises for every request once it has learned of its eviction.
 */
const EVICTION_CODES: ReadonlySet<string> = new Set([
	"ERR_CLIENT_EVICTED",
	"ERR_CLIENT_RELEASE_TOO_LOW",
	"ERR_CLIENT_RELEASE_TOO_HIGH",
	"ERR_CLIENT_CLOSED",
]);

const [clusterId, addressesJson] = process.argv.slice(2);
if (clusterId === undefined || addressesJson === undefined) {
	process.exit(2);
}

// Orphan safety, as ledger-probe-child.ts does it.
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

function send(message: object): void {
	if (process.connected) process.send?.(message);
}

let client: ReturnType<ReturnType<typeof loadTigerBeetle>["createClient"]> | undefined;
let busy = false;

async function probe(n: number): Promise<void> {
	if (client === undefined || busy) return;
	busy = true;
	try {
		await client.lookupAccounts([]);
		send({ reply: n });
	} catch (err) {
		const code = (err as { code?: unknown }).code;
		if (typeof code === "string" && EVICTION_CODES.has(code)) {
			send({ evicted: true });
			process.exit(EVICTED);
		}
		send({ error: n, code: typeof code === "string" ? code : "error" });
	} finally {
		busy = false;
	}
}

// Registered before the native client loads: a probe sent the moment this child starts is kept.
process.on("message", (message: unknown) => {
	const n = (message as { probe?: unknown } | null)?.probe;
	if (typeof n === "number") void probe(n);
});

try {
	client = loadTigerBeetle().createClient({
		cluster_id: BigInt(clusterId),
		replica_addresses: JSON.parse(addressesJson) as string[],
	});
} catch {
	send({ log: "the TigerBeetle client could not be created" });
	process.exit(NO_CLIENT);
}
send({ ready: true });
