// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { parseAllowHosts } from "./allow-host.js";

export interface UiArgs {
	noOpen: boolean;
	port: number | undefined;
	rootDir: string | undefined;
	allowHosts: string[];
}

/** Parse `usertrust-ui` arguments; an error carries the message and the exit code. */
export function parseUiArgs(
	argv: readonly string[],
): { ok: true; args: UiArgs } | { ok: false; message: string; code: number } {
	const noOpen = argv.includes("--no-open");
	const portIdx = argv.indexOf("--port");
	const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : undefined;
	if (port !== undefined && !Number.isInteger(port)) {
		return { ok: false, message: "usertrust-ui: --port requires an integer", code: 1 };
	}
	const rawHosts: string[] = [];
	const valueIdx = new Set<number>();
	if (portIdx >= 0) valueIdx.add(portIdx + 1);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] !== "--allow-host") continue;
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("-")) {
			return { ok: false, message: "usertrust-ui: --allow-host requires a host name", code: 2 };
		}
		rawHosts.push(value);
		valueIdx.add(i + 1);
	}
	const hosts = parseAllowHosts(rawHosts);
	if (!hosts.ok) return { ok: false, message: `usertrust-ui: ${hosts.error}`, code: 2 };
	const positional = argv.filter((a, i) => !a.startsWith("-") && !valueIdx.has(i));
	return { ok: true, args: { noOpen, port, rootDir: positional[0], allowHosts: hosts.names } };
}
