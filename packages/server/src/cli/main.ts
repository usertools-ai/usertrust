#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { loadServerConfig } from "../config.js";
import { createUsertrustServer } from "../server.js";

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
	const configPath = argValue("--config") ?? "usertrust-server.config.json";
	const config = await loadServerConfig(configPath);
	const portOverride = argValue("--port");
	if (portOverride) config.port = Number.parseInt(portOverride, 10);
	const server = createUsertrustServer({ config });
	const { port } = await server.listen();
	process.stderr.write(`usertrust-server listening on ${config.host}:${port}\n`);
	const shutdown = async (): Promise<void> => {
		process.stderr.write("usertrust-server shutting down — voiding pending holds\n");
		await server.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
	process.stderr.write(
		`usertrust-server failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(1);
});
