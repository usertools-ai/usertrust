// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust verify — Verify audit chain integrity
 *
 * Calls verifyChain() on the local vault's audit log and displays the result.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { verifyChain } from "../audit/verify.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { CliOptions } from "./init.js";

export async function run(rootDir?: string, opts?: CliOptions): Promise<void> {
	const root = rootDir ?? process.cwd();
	const vaultPath = join(root, VAULT_DIR);
	const json = opts?.json === true;

	if (!existsSync(vaultPath)) {
		if (json) {
			console.log(
				JSON.stringify({
					command: "verify",
					success: false,
					data: { message: "No trust vault found. Run `usertrust init` first." },
				}),
			);
		} else {
			console.log(`${pc.red("No trust vault found.")} Run \`usertrust init\` first.`);
		}
		return;
	}

	const logPath = join(vaultPath, "audit", "events.jsonl");
	const result = verifyChain(logPath);

	if (json) {
		console.log(
			JSON.stringify({
				command: "verify",
				success: result.valid,
				data: {
					valid: result.valid,
					eventsVerified: result.eventsVerified,
					errors: result.errors,
					latestHash: result.latestHash,
					verifiedAt: result.verifiedAt,
				},
			}),
		);
		return;
	}

	if (result.valid) {
		console.log(pc.green(`Chain verified: ${result.eventsVerified} events, all hashes valid.`));
		console.log(`Latest hash: ${pc.dim(result.latestHash)}`);
	} else {
		console.log(pc.red(`Chain verification FAILED: ${result.errors.length} error(s) found.`));
		console.log(`Events checked: ${result.eventsVerified}`);
		for (const err of result.errors) {
			console.log(pc.red(`  - ${err}`));
		}
	}

	console.log(pc.dim(`Verified at: ${result.verifiedAt}`));
}
