#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { spawn } from "node:child_process";
import { allowHostNotice } from "./allow-host.js";
import { parseUiArgs } from "./args.js";
import { createUiServer } from "./server.js";

const parsed = parseUiArgs(process.argv.slice(2));
if (!parsed.ok) {
	console.error(parsed.message);
	process.exit(parsed.code);
}
const { noOpen, port: requestedPort, allowHosts } = parsed.args;
const rootDir = parsed.args.rootDir ?? process.cwd();

async function tryListen(): Promise<Awaited<ReturnType<typeof createUiServer>>> {
	if (requestedPort !== undefined) {
		// Explicit --port fails fast on conflict.
		return createUiServer(rootDir, { port: requestedPort, allowHosts });
	}
	for (let port = 4180; port < 4200; port++) {
		try {
			return await createUiServer(rootDir, { port, allowHosts });
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
if (allowHosts.length > 0) console.log(allowHostNotice(allowHosts));
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
