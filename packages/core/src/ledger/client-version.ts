// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Which `tigerbeetle-node` a project will actually load.
 *
 * TigerBeetle refuses a client that is newer than the server it talks to, so the server a project
 * runs must match the client the project resolves, not the one the caller (an `npx` copy, a global
 * install) happens to carry. This module reads the version off disk from the project's own
 * `node_modules`, the way Node would resolve the package, and says nothing when it is absent.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PACKAGE = "tigerbeetle-node";

/** The `version` of a `package.json` at `file`, or `undefined` when it is missing, unreadable or has none. */
function versionAt(file: string): string | undefined {
	if (!existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as { name?: unknown; version?: unknown };
		if (parsed.name !== PACKAGE) return undefined;
		return typeof parsed.version === "string" ? parsed.version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The version of `tigerbeetle-node` that code in `projectRoot` resolves, read from that project's
 * `node_modules` and never from the calling process's own copy.
 *
 * Two places are checked, in the order Node would find them for `usertrust` installed in the
 * project: the copy nested under the project's `usertrust` (`node_modules/usertrust/node_modules`),
 * then the copy visible from the project directory, walking up through its parents'
 * `node_modules` folders. `undefined` means no copy is installed there yet.
 */
export function resolvedClientVersion(projectRoot: string): string | undefined {
	const root = resolve(projectRoot);
	const nested = versionAt(
		join(root, "node_modules", "usertrust", "node_modules", PACKAGE, "package.json"),
	);
	if (nested !== undefined) return nested;
	for (let dir = root; ; dir = dirname(dir)) {
		const found = versionAt(join(dir, "node_modules", PACKAGE, "package.json"));
		if (found !== undefined) return found;
		if (dirname(dir) === dir) return undefined;
	}
}

/** True for an exact `x.y.z` version: no range operator, no tag, no wildcard. */
export function isExactVersion(spec: string): boolean {
	return /^\d+\.\d+\.\d+$/.test(spec);
}
