// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A usertrust-server with the DEFAULT log sink (stderr), for a test that closes this process's
 * stderr reader. Every governor it would create fails, so any authorize is a 500 that logs a line.
 * It talks to the test over STDOUT, which stays open: `listening <port>` once it listens, and
 * `other-writer:<code>` once SIGUSR2's write to stderr (a writer that is not the server) has
 * been answered. SIGTERM closes the server and exits 0.
 *
 * With `hang` as a third argument the server instead has a ledger deadline (100 ms) and a
 * governor whose authorize never answers, so an authorize is refused with a 503 and is still
 * waiting on the ledger at shutdown: `close()` logs its shutdown warning. Before exiting, it
 * reads `logLinesDropped` through a second server and writes `dropped-after-close:<n>` to stdout.
 *
 * argv: <stateDir> <keyHash> [hang]
 */

import type { Governor } from "usertrust";
import { createUsertrustServer } from "../../src/server.js";
import { createFakeGovernor } from "./fake-governor.js";

const [stateDir, keyHash, mode] = process.argv.slice(2);
if (stateDir === undefined || keyHash === undefined) throw new Error("usage: <stateDir> <keyHash>");
const hang = mode === "hang";

const config = {
	host: "127.0.0.1",
	port: 0,
	stateDir,
	enforcement: "enforce" as const,
	pendingTtlMs: 300_000,
	dryRun: true,
	tenants: [{ id: "t1", keyHash, budget: 50_000 }],
};
const hanging: Governor = {
	...createFakeGovernor().governor,
	authorize: () => new Promise(() => {}),
};
const server = createUsertrustServer({
	config: hang ? { ...config, dryRun: false, ledgerTimeoutMs: 100 } : config,
	factory: async () => {
		if (hang) return hanging;
		throw new Error("governor exploded");
	},
});

/** `logLinesDropped` through a second server: process-wide, so it outlives the closed one. */
async function droppedAfterClose(): Promise<number> {
	// The shutdown line's own write callback lands after close(): give it its turns.
	await new Promise((resolve) => setTimeout(resolve, 100));
	const probe = createUsertrustServer({ config: { ...config, stateDir: `${stateDir}-probe` } });
	const { port } = await probe.listen();
	const body = (await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json()) as {
		logLinesDropped: number;
	};
	await probe.close();
	return body.logLinesDropped;
}

process.on("SIGUSR2", () => {
	process.stderr.write("another writer\n", (err) => {
		const code = err ? ((err as NodeJS.ErrnoException).code ?? "error") : "ok";
		process.stdout.write(`other-writer:${code}\n`);
	});
});
process.on("SIGTERM", () => {
	void server.close().then(async () => {
		if (hang) process.stdout.write(`dropped-after-close:${await droppedAfterClose()}\n`);
		process.exit(0);
	});
});

const { port } = await server.listen();
process.stdout.write(`listening ${port}\n`);
