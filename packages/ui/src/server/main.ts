#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { spawn } from "node:child_process";
import { createUiServer } from "./server.js";

const argv = process.argv.slice(2);
const noOpen = argv.includes("--no-open");
const portIdx = argv.indexOf("--port");
const requestedPort = portIdx >= 0 ? Number(argv[portIdx + 1]) : undefined;
const positional = argv.filter((a, i) => !a.startsWith("-") && (portIdx < 0 || i !== portIdx + 1));
const rootDir = positional[0] ?? process.cwd();

if (requestedPort !== undefined && !Number.isInteger(requestedPort)) {
	console.error("usertrust-ui: --port requires an integer");
	process.exit(1);
}

async function tryListen(): Promise<Awaited<ReturnType<typeof createUiServer>>> {
	if (requestedPort !== undefined) {
		// Explicit --port fails fast on conflict.
		return createUiServer(rootDir, { port: requestedPort });
	}
	for (let port = 4180; port < 4200; port++) {
		try {
			return await createUiServer(rootDir, { port });
		} catch {
			// EADDRINUSE — probe upward
		}
	}
	throw new Error("no free port in 4180-4199; pass --port");
}

const ui = await tryListen().catch((err: unknown) => {
	console.error(`usertrust-ui: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});

const url = `http://127.0.0.1:${ui.port}`;
console.log(`usertrust-ui serving ${rootDir} at ${url}`);
if (!noOpen) {
	// Amendment A8: Windows has no `start` binary — it is a cmd built-in, and
	// the first quoted argument is the window title, hence the empty string.
	const child =
		process.platform === "darwin"
			? spawn("open", [url], { stdio: "ignore", detached: true })
			: process.platform === "win32"
				? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true })
				: spawn("xdg-open", [url], { stdio: "ignore", detached: true });
	child.unref();
}
