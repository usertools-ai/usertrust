#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { spawn } from "node:child_process";
import { allowHostNotice } from "./allow-host.js";
import { parseUiArgs } from "./args.js";
import { listenUi } from "./listen.js";
import { createUiServer } from "./server.js";

const parsed = parseUiArgs(process.argv.slice(2));
if (!parsed.ok) {
	console.error(parsed.message);
	process.exit(parsed.code);
}
const { noOpen, port: requestedPort, allowHosts } = parsed.args;
const rootDir = parsed.args.rootDir ?? process.cwd();

const ui = await listenUi(
	(port) => createUiServer(rootDir, { port, allowHosts }),
	requestedPort,
).catch((err: unknown) => {
	console.error(`usertrust-ui: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});

const url = `http://127.0.0.1:${ui.port}`;
// The root as the OS opens it: the directory whose vault is shown.
console.log(`usertrust-ui serving ${ui.root} at ${url}`);
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
