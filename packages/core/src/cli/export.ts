// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust export — write receipts as markdown (Obsidian-ready).
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import pc from "picocolors";
import { exportMarkdown } from "../export/markdown.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { CliOptions } from "./init.js";

export async function run(rootDir?: string, opts?: CliOptions, args?: string[]): Promise<void> {
	const root = rootDir ?? process.cwd();
	const vaultPath = join(root, VAULT_DIR);
	const json = opts?.json === true;
	const argv = args ?? process.argv.slice(3);

	const flagIdx = argv.indexOf("--markdown");
	const outArg = flagIdx >= 0 ? argv[flagIdx + 1] : undefined;

	const fail = (message: string): void => {
		if (json) {
			console.log(JSON.stringify({ command: "export", success: false, data: { message } }));
		} else {
			console.log(`${pc.red("export failed:")} ${message}`);
		}
		process.exitCode = 1;
	};

	if (!existsSync(vaultPath)) {
		fail("No trust vault found. Run `usertrust init` first.");
		return;
	}
	if (!outArg) {
		fail("Usage: usertrust export --markdown <dir>");
		return;
	}

	try {
		const result = exportMarkdown(vaultPath, resolve(root, outArg));
		if (json) {
			console.log(JSON.stringify({ command: "export", success: true, data: result }));
		} else {
			console.log(`Exported ${result.written} receipt note(s) to ${result.outDir}`);
			if (result.chainValid && result.vaultValid) {
				console.log("Chain integrity: verified");
			} else {
				console.log(`Chain integrity: ${pc.red("BROKEN")}`);
				const reason = result.vaultErrors[0];
				if (reason) console.log(`  ${pc.red(reason)}`);
			}
			console.log(
				"Open the folder as (or inside) an Obsidian vault; Receipts.base is the table view.",
			);
		}
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
}
