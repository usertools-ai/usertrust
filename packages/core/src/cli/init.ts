/**
 * CLI: usertrust init — Initialize governance vault
 *
 * Creates the .usertrust/ directory structure with default config,
 * policy, and .gitignore. Sets permissions to 700 (owner only).
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VAULT_DIR } from "../shared/constants.js";

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

export async function run(rootDir?: string): Promise<void> {
	const root = rootDir ?? process.cwd();
	const vaultPath = join(root, VAULT_DIR);

	if (existsSync(vaultPath)) {
		console.log(`Vault already exists at ${vaultPath}`);
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

	console.log(`Initialized governance vault at ${vaultPath}`);
	console.log("  Created: audit/, policies/, patterns/, snapshots/, board/, dlq/");
	console.log("  Config:  usertrust.config.json");
	console.log("  Policy:  policies/default.yml");
}
