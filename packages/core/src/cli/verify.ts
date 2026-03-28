// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust verify — Verify audit chain integrity
 *
 * Calls verifyChain() on the local vault's audit log and displays the result.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { verifyChain } from "../audit/verify.js";
import { VAULT_DIR } from "../shared/constants.js";

export async function run(rootDir?: string): Promise<void> {
	const root = rootDir ?? process.cwd();
	const vaultPath = join(root, VAULT_DIR);

	if (!existsSync(vaultPath)) {
		console.log("No governance vault found. Run `usertrust init` first.");
		return;
	}

	const logPath = join(vaultPath, "audit", "events.jsonl");
	const result = verifyChain(logPath);

	if (result.valid) {
		console.log(`Chain verified: ${result.eventsVerified} events, all hashes valid.`);
		console.log(`Latest hash: ${result.latestHash}`);
	} else {
		console.log(`Chain verification FAILED: ${result.errors.length} error(s) found.`);
		console.log(`Events checked: ${result.eventsVerified}`);
		for (const err of result.errors) {
			console.log(`  - ${err}`);
		}
	}

	console.log(`Verified at: ${result.verifiedAt}`);
}
