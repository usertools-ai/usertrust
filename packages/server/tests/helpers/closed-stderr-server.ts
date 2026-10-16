// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A usertrust-server with the DEFAULT log sink (stderr), for a test that closes this process's
 * stderr reader. Every governor it would create fails, so any authorize is a 500 that logs a line.
 * It talks to the test over STDOUT, which stays open: `listening <port>` once it listens, and
 * `other-writer:<code>` once SIGUSR2's write to stderr (a writer that is not the server) has
 * been answered. SIGTERM closes the server and exits 0.
 *
 * argv: <stateDir> <keyHash>
 */

import { createUsertrustServer } from "../../src/server.js";

const [stateDir, keyHash] = process.argv.slice(2);
if (stateDir === undefined || keyHash === undefined) throw new Error("usage: <stateDir> <keyHash>");

const server = createUsertrustServer({
	config: {
		host: "127.0.0.1",
		port: 0,
		stateDir,
		enforcement: "enforce",
		pendingTtlMs: 300_000,
		dryRun: true,
		tenants: [{ id: "t1", keyHash, budget: 50_000 }],
	},
	factory: async () => {
		throw new Error("governor exploded");
	},
});

process.on("SIGUSR2", () => {
	process.stderr.write("another writer\n", (err) => {
		const code = err ? ((err as NodeJS.ErrnoException).code ?? "error") : "ok";
		process.stdout.write(`other-writer:${code}\n`);
	});
});
process.on("SIGTERM", () => {
	void server.close().then(() => process.exit(0));
});

const { port } = await server.listen();
process.stdout.write(`listening ${port}\n`);
