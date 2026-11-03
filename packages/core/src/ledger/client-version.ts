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

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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
 * The copy of `tigerbeetle-node` that code running from `fromDir` would `require`, found the way Node
 * finds it: `fromDir/node_modules`, then each parent's `node_modules`. A parent that is itself a
 * `node_modules` folder is searched directly (that is how a sibling package is found in a pnpm store),
 * and no `node_modules/node_modules` is ever looked at.
 */
function resolveFrom(fromDir: string): string | undefined {
	for (let dir = fromDir; ; dir = dirname(dir)) {
		const modules = basename(dir) === "node_modules" ? dir : join(dir, "node_modules");
		const found = versionAt(join(modules, PACKAGE, "package.json"));
		if (found !== undefined) return found;
		if (dirname(dir) === dir) return undefined;
	}
}

/**
 * The real directory of the first `usertrust` that `projectRoot` can see, walking up through its
 * parents' `node_modules`. `undefined` when none is installed. A symlink (a pnpm install) is followed,
 * because the client is looked up from where `usertrust` really lives, not from where it is linked.
 */
function installedUsertrust(projectRoot: string): string | undefined {
	for (let dir = projectRoot; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", "usertrust");
		try {
			const manifest = JSON.parse(readFileSync(join(candidate, "package.json"), "utf-8")) as {
				name?: unknown;
			};
			if (manifest.name === "usertrust") return realpathSync(candidate);
		} catch {
			// not here
		}
		if (dirname(dir) === dir) return undefined;
	}
}

/**
 * The version of `tigerbeetle-node` that the `usertrust` installed for `projectRoot` loads, read from
 * disk and never from the calling process's own copy.
 *
 * Node resolves `require("tigerbeetle-node")` from `usertrust`'s REAL path, so that is where this
 * starts: the first `usertrust` visible from the project (symlinks followed), then its own
 * `node_modules`, then each parent's. That is right for a nested npm install, a hoisted one, a pnpm
 * store and a workspace whose root holds `usertrust` and another client. Only when no `usertrust` is
 * installed yet does it fall back to the copy a project directory itself would find. `undefined` means
 * no copy is installed there.
 */
export function resolvedClientVersion(projectRoot: string): string | undefined {
	const root = resolve(projectRoot);
	return resolveFrom(installedUsertrust(root) ?? root);
}

/** True for an exact `x.y.z` version: no range operator, no tag, no wildcard. */
export function isExactVersion(spec: string): boolean {
	return /^\d+\.\d+\.\d+$/.test(spec);
}
