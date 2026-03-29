// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust init — Initialize trust vault
 *
 * Creates the .usertrust/ directory structure with default config,
 * policy, and .gitignore. Sets permissions to 700 (owner only).
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { VAULT_DIR } from "../shared/constants.js";

export interface CliOptions {
	json?: boolean;
}

const DEFAULT_CONFIG = {
	budget: 50000,
	tier: "mini",
	policies: "./policies/default.yml",
	pii: "warn",
	board: { enabled: false, vetoThreshold: "high" },
	circuitBreaker: { failureThreshold: 5, resetTimeout: 60000 },
	patterns: { enabled: true, feedProxy: false },
	audit: { rotation: "daily", indexLimit: 10000 },
};

const DEFAULT_POLICY = `rules:
  - name: block-zero-budget
    effect: deny
    enforcement: hard
    conditions:
      - field: budget_remaining
        operator: lte
        value: 0

  - name: warn-high-cost
    effect: warn
    enforcement: soft
    conditions:
      - field: estimated_cost
        operator: gt
        value: 1000
`;

const GITIGNORE = `tigerbeetle/
*.tigerbeetle
dlq/
`;

const SUBDIRS = ["audit", "policies", "patterns", "snapshots", "board", "dlq"] as const;

export async function run(rootDir?: string, opts?: CliOptions): Promise<void> {
	const root = rootDir ?? process.cwd();
	const vaultPath = join(root, VAULT_DIR);
	const json = opts?.json === true;

	if (existsSync(vaultPath)) {
		if (json) {
			console.log(
				JSON.stringify({
					command: "init",
					success: false,
					data: { message: "Vault already exists", path: vaultPath },
				}),
			);
		} else {
			console.log(pc.yellow(`Vault already exists at ${vaultPath}`));
		}
		return;
	}

	// Create directory structure
	mkdirSync(vaultPath, { recursive: true });
	for (const sub of SUBDIRS) {
		mkdirSync(join(vaultPath, sub), { recursive: true });
	}

	// Write default config
	writeFileSync(
		join(vaultPath, "usertrust.config.json"),
		JSON.stringify(DEFAULT_CONFIG, null, "\t"),
		"utf-8",
	);

	// Write default policy
	writeFileSync(join(vaultPath, "policies", "default.yml"), DEFAULT_POLICY, "utf-8");

	// Write .gitignore
	writeFileSync(join(vaultPath, ".gitignore"), GITIGNORE, "utf-8");

	// Set vault permissions to 700 (owner only)
	chmodSync(vaultPath, 0o700);

	if (json) {
		console.log(
			JSON.stringify({
				command: "init",
				success: true,
				data: {
					path: vaultPath,
					directories: [...SUBDIRS],
					config: "usertrust.config.json",
					policy: "policies/default.yml",
				},
			}),
		);
	} else {
		console.log(pc.green(`Initialized trust vault at ${vaultPath}`));
		console.log(pc.dim("  Created: audit/, policies/, patterns/, snapshots/, board/, dlq/"));
		console.log(pc.dim("  Config:  usertrust.config.json"));
		console.log(pc.dim("  Policy:  policies/default.yml"));
	}
}
