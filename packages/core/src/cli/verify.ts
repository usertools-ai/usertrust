// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust verify — Verify audit chain integrity
 *
 * Calls verifyVault() on the local vault (anchored to the `.meta` head, spans
 * rotated segments) and displays the result. Sets a nonzero process exit code
 * on a FAILED verdict so CI gates fail on a tampered vault.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { verifyVault } from "../audit/verify.js";
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
		// A missing vault is a failed verification for CI purposes.
		process.exitCode = 1;
		return;
	}

	const result = verifyVault(vaultPath);
	const verifiedAt = new Date().toISOString();

	if (json) {
		console.log(
			JSON.stringify({
				command: "verify",
				success: result.valid,
				data: {
					valid: result.valid,
					chainLength: result.chainLength,
					errors: result.errors,
					merkleRoot: result.merkleRoot,
					verifiedAt,
				},
			}),
		);
		if (!result.valid) process.exitCode = 1;
		return;
	}

	if (result.valid) {
		console.log(pc.green(`Chain verified: ${result.chainLength} events, all hashes valid.`));
		if (result.merkleRoot) console.log(`Merkle root: ${pc.dim(result.merkleRoot)}`);
	} else {
		console.log(pc.red(`Chain verification FAILED: ${result.errors.length} error(s) found.`));
		console.log(`Events checked: ${result.chainLength}`);
		for (const err of result.errors) {
			console.log(pc.red(`  - ${err}`));
		}
		// Use process.exitCode (not process.exit) so buffered stdout flushes.
		process.exitCode = 1;
	}

	console.log(pc.dim(`Verified at: ${verifiedAt}`));
}
