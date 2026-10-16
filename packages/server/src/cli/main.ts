#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { loadServerConfig } from "../config.js";
import { probeLedger } from "../ledger-probe.js";
import { secureTenantVaults } from "../pool.js";
import { createUsertrustServer } from "../server.js";
import { scrubForStderr } from "./scrub.js";

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
	const configPath = argValue("--config") ?? "usertrust-server.config.json";
	const config = await loadServerConfig(configPath);
	const portOverride = argValue("--port");
	if (portOverride) config.port = Number.parseInt(portOverride, 10);
	// Before anything binds: a tenant vault its governor would refuse, or an unusable ledger,
	// would otherwise fail every request (an opaque 500) or crash or hang the first one.
	secureTenantVaults(config);
	await probeLedger(config);
	// The operator's server reports ledger reachability unless its config turns it off.
	config.ledgerHealth ??= "child";
	const server = createUsertrustServer({ config });
	// The handlers go in BEFORE the server listens: a supervisor (or a test) that signals the
	// moment it reads the listening line must reach shutdown, never the default action, which
	// kills the process. close() is safe on a server that is not listening yet.
	const shutdown = async (): Promise<void> => {
		process.stderr.write("usertrust-server shutting down — voiding pending holds\n");
		await server.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
	const { port } = await server.listen();
	process.stderr.write(`usertrust-server listening on ${scrubForStderr(config.host)}:${port}\n`);
}

main().catch((err: unknown) => {
	// The message can carry configured values (a ledger address, a path) and a probe child's
	// stderr: sanitized here, at the terminal, while probeLedger's own Error keeps them raw.
	const message = scrubForStderr(err instanceof Error ? err.message : String(err));
	process.stderr.write(`usertrust-server failed to start: ${message}\n`);
	process.exit(1);
});
