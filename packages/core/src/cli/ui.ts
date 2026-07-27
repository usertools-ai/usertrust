// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust ui — launch the local visual ledger (usertrust-ui).
 * Core stays lean: usertrust-ui is NOT a dependency; we spawn it when
 * resolvable and otherwise print the npx one-liner.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { CliOptions } from "./init.js";

export async function run(_rootDir?: string, _opts?: CliOptions, args?: string[]): Promise<void> {
	const require = createRequire(import.meta.url);
	let binPath: string | undefined;
	try {
		const pkgPath = require.resolve("usertrust-ui/package.json");
		// Amendment A8: parse the JSON ourselves — require() of JSON from ESM
		// createRequire works but couples us to CJS semantics for no gain.
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { bin?: Record<string, string> };
		const rel = pkg.bin?.["usertrust-ui"];
		if (rel) binPath = join(dirname(pkgPath), rel);
	} catch {
		// not installed
	}

	if (!binPath) {
		console.log("usertrust-ui is not installed. Launch it with:");
		console.log("  npx usertrust-ui");
		return;
	}

	const child = spawn(process.execPath, [binPath, ...(args ?? [])], { stdio: "inherit" });
	await new Promise<void>((resolve) => child.on("exit", () => resolve()));
}
