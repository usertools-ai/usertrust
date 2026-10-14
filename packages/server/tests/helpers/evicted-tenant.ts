// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

// Run in its OWN process by evicted-tenant.tb.test.ts, under source-preload.mjs, against a private
// TigerBeetle cluster: `node --import source-preload.mjs evicted-tenant.ts <port> <stateDir>`.
//
// Two tenants' governors from the server's pool, each with its own ledger client: tenant `a`
// registers its session first, then `b`. 63 newer sessions, one at a time, then push out the
// oldest one only, `a`'s, while it is idle. The fixture waits for a line on stdin, which the
// parent writes once `a`'s client has logged its eviction. Then `b` places HOLDS holds, and the
// pool tears both down at once (destroyAll), as the server's close() does: `a`'s destroy() must
// not abort the process while `b` is still voiding its holds and writing their records.
//
// The ledger client's 30 s health check is held off: each check renews the session, and the
// push-out takes longer than 30 s, so with it running `a` is never pushed out.
//
// Lines on stdout: start, destroying, destroyed, end; then, if something still holds the event
// loop after 3 s (`a`'s evicted native client, left open), still-alive and process.exit(0).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "tigerbeetle-node";
import type { ServerConfig, TenantConfig } from "../../src/config.js";

const HOLDS = 20;
const [port = "", stateDir = ""] = process.argv.slice(2);
const address = `127.0.0.1:${port}`;
const print = (line: Record<string, unknown>): void => {
	process.stdout.write(`${JSON.stringify(line)}\n`);
};

let reconnects = 0;
console.log = (...args: unknown[]) => {
	if (String(args[0]).includes("Reconnection attempt")) reconnects += 1;
};

let heldChecks = 0;
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = ((fn: () => void, ms?: number, ...args: unknown[]) => {
	if (ms === 30_000) {
		heldChecks += 1;
		return realSetInterval(() => {}, 2 ** 31 - 1);
	}
	return realSetInterval(fn, ms, ...args);
}) as typeof setInterval;

const { GovernorPool } = await import("../../src/pool.js");

const configPath = join(stateDir, "tenant.config.json");
const tenant = (id: string): TenantConfig =>
	({ id, keyHash: "unused", budget: 10_000_000, configPath }) as TenantConfig;
for (const id of ["a", "b"]) mkdirSync(join(stateDir, id), { recursive: true });
const pool = new GovernorPool({ stateDir, dryRun: false } as ServerConfig);
await pool.get(tenant("a"));
const b = await pool.get(tenant("b"));
print({ step: "start", heldChecks });

for (let i = 0; i < 63; i++) {
	const other = createClient({ cluster_id: 0n, replica_addresses: [address] });
	await other.lookupAccounts([]);
	other.destroy();
}
await new Promise((resolve) => process.stdin.once("data", resolve));
process.stdin.destroy();

for (let i = 0; i < HOLDS; i++) {
	await b.authorize({
		model: "claude-sonnet-4-6",
		estimatedInputTokens: 1_000,
		maxOutputTokens: 200,
	});
}
print({ step: "destroying", reconnects });
await pool.destroyAll();
print({ step: "destroyed", reconnects });

print({ step: "end" });
setTimeout(() => {
	print({ step: "still-alive" });
	process.exit(0);
}, 3_000).unref();
