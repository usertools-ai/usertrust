// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust init — Interactive onboarding wizard
 *
 * Walks the user through API key setup, budget configuration,
 * and pricing selection. Creates the .usertrust/ vault with
 * config, .env, policy, and .gitignore.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { PRICING_TABLE, PRICING_TABLE_VERSION, modelsForProvider } from "../ledger/pricing.js";
import type { ModelRates } from "../ledger/pricing.js";
import { VAULT_DIR } from "../shared/constants.js";
import { detectProvider, maskKey, validateKey } from "./validate-key.js";

export interface CliOptions {
	json?: boolean;
	skipVerify?: boolean;
	reconfigure?: boolean;
}

const ENV_VAR_MAP: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GOOGLE_API_KEY",
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

const SUBDIRS = ["audit", "policies", "patterns", "snapshots", "board", "dlq"] as const;

function envVarName(provider: string): string {
	return ENV_VAR_MAP[provider] ?? `${provider.toUpperCase()}_API_KEY`;
}

export async function run(rootDir?: string, opts?: CliOptions): Promise<void> {
	const root = rootDir ?? process.cwd();
	const vaultPath = join(root, VAULT_DIR);
	const json = opts?.json === true;

	// ── Check existing vault ──
	if (existsSync(vaultPath) && !opts?.reconfigure) {
		if (json) {
			console.log(
				JSON.stringify({
					command: "init",
					success: false,
					data: { message: "Vault already exists", path: vaultPath },
				}),
			);
		} else {
			clack.log.warn(`Vault already exists at ${vaultPath}`);
		}
		return;
	}

	// ── Non-interactive (--json) mode ──
	if (json) {
		createVault(vaultPath, {
			budget: 50_000,
			providers: [],
			pricing: "recommended",
			keys: {},
		});
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
		return;
	}

	// ── Interactive wizard ──
	clack.intro("usertrust init");

	// Step 1: API key loop
	const keys: Record<string, string> = {};
	const providers: Array<{ name: string; models: string[] }> = [];

	while (true) {
		const keyResult = await clack.text({
			message:
				Object.keys(keys).length === 0
					? "Paste your API key:"
					: "Paste another API key (empty = done):",
			placeholder: "sk-...",
		});

		if (clack.isCancel(keyResult)) {
			clack.log.warn("Setup cancelled.");
			return;
		}

		const key = (keyResult as string).trim();
		if (key === "") break;

		let provider = detectProvider(key);

		if (provider === null) {
			const providerResult = await clack.text({
				message: "Could not detect provider. Enter provider name:",
				placeholder: "e.g. mistral, deepseek",
			});

			if (clack.isCancel(providerResult)) {
				clack.log.warn("Setup cancelled.");
				return;
			}

			provider = (providerResult as string).trim().toLowerCase();
			if (!/^[a-z][a-z0-9-]{0,31}$/.test(provider)) {
				clack.log.warn("Provider name must be lowercase alphanumeric (max 32 chars).");
				continue;
			}
		}

		// Validate key unless --skip-verify
		if (!opts?.skipVerify) {
			const s = clack.spinner();
			s.start(`Validating ${provider} key...`);
			const result = await validateKey(key, provider);
			if (result.valid) {
				s.stop(`${provider} key valid (${maskKey(key)})`);
			} else {
				s.stop(`${provider} key validation failed: ${result.error}`);
				clack.log.warn("Key added anyway — you can fix it later in .usertrust/.env");
			}
		} else {
			clack.log.info(`Added ${provider} key (${maskKey(key)})`);
		}

		keys[provider] = key;
		const models = modelsForProvider(provider);
		providers.push({ name: provider, models });
	}

	// Step 2: Budget
	const budgetResult = await clack.text({
		message: "Monthly budget: $",
		placeholder: "50",
		validate: (value) => {
			if (!value) return "Enter a positive number";
			const cleaned = value.replace(/[$,]/g, "");
			if (Number.isNaN(Number(cleaned)) || Number(cleaned) <= 0) {
				return "Enter a positive number";
			}
		},
	});

	if (clack.isCancel(budgetResult)) {
		clack.log.warn("Setup cancelled.");
		return;
	}

	const dollars = Number((budgetResult as string).replace(/[$,]/g, ""));
	const budgetUsertokens = Math.round(dollars * 10_000);

	// Step 3: Rates
	let pricing: "recommended" | "custom" = "recommended";
	let customRates: Record<string, ModelRates> | undefined;

	const useRecommended = await clack.confirm({
		message: `Use recommended rates? (verified ${PRICING_TABLE_VERSION})`,
		initialValue: true,
	});

	if (clack.isCancel(useRecommended)) {
		clack.log.warn("Setup cancelled.");
		return;
	}

	if (!useRecommended) {
		pricing = "custom";
		customRates = {};

		// Show rate card for configured providers
		for (const p of providers) {
			const models = modelsForProvider(p.name);
			if (models.length === 0) continue;

			clack.log.info(`\n${p.name} models:`);
			for (const model of models) {
				const rates = PRICING_TABLE[model];
				if (!rates) continue;
				clack.log.step(`  ${model}: input=${rates.inputPer1k}/1k, output=${rates.outputPer1k}/1k`);
			}
		}

		// Allow editing individual models
		while (true) {
			const modelResult = await clack.text({
				message: "Model to edit (empty = accept all):",
				placeholder: "e.g. claude-sonnet-4-6",
			});

			if (clack.isCancel(modelResult)) {
				clack.log.warn("Setup cancelled.");
				return;
			}

			const model = (modelResult as string).trim();
			if (model === "") break;

			if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(model)) {
				clack.log.warn("Invalid model name.");
				continue;
			}

			const inputResult = await clack.text({
				message: `${model} input rate ($/1M tokens):`,
			});

			if (clack.isCancel(inputResult)) {
				clack.log.warn("Setup cancelled.");
				return;
			}

			const outputResult = await clack.text({
				message: `${model} output rate ($/1M tokens):`,
			});

			if (clack.isCancel(outputResult)) {
				clack.log.warn("Setup cancelled.");
				return;
			}

			const inputPerM = Number(inputResult);
			const outputPerM = Number(outputResult);

			if (
				!Number.isFinite(inputPerM) ||
				inputPerM < 0 ||
				!Number.isFinite(outputPerM) ||
				outputPerM < 0
			) {
				clack.log.warn("Rates must be non-negative numbers. Skipping.");
				continue;
			}

			// Convert $/1M to usertokens/1K: $X per 1M = X*10 usertokens per 1K
			customRates[model] = {
				inputPer1k: inputPerM * 10,
				outputPer1k: outputPerM * 10,
			};

			clack.log.success(`Updated ${model}`);
		}
	}

	// Step 4: Create vault
	createVault(vaultPath, {
		budget: budgetUsertokens,
		providers,
		pricing,
		...(customRates !== undefined ? { customRates } : {}),
		keys,
	});

	clack.outro(`Vault created at ${vaultPath}`);
}

interface VaultData {
	budget: number;
	providers: Array<{ name: string; models: string[] }>;
	pricing: "recommended" | "custom";
	customRates?: Record<string, ModelRates>;
	keys?: Record<string, string>;
}

function createVault(vaultPath: string, data: VaultData): void {
	// Create directory structure
	mkdirSync(vaultPath, { recursive: true });
	for (const sub of SUBDIRS) {
		mkdirSync(join(vaultPath, sub), { recursive: true });
	}

	// Build config
	const config: Record<string, unknown> = {
		budget: data.budget,
		tier: "mini",
		policies: "./policies/default.yml",
		pii: "warn",
		board: { enabled: false, vetoThreshold: "high" },
		circuitBreaker: { failureThreshold: 5, resetTimeout: 60000 },
		patterns: { enabled: true, feedProxy: false },
		audit: { rotation: "daily", indexLimit: 10000 },
		providers: data.providers,
		pricing: data.pricing,
	};

	if (data.customRates && Object.keys(data.customRates).length > 0) {
		config.customRates = data.customRates;
	}

	// Write config
	writeFileSync(
		join(vaultPath, "usertrust.config.json"),
		JSON.stringify(config, null, "\t"),
		"utf-8",
	);

	// Write default policy
	writeFileSync(join(vaultPath, "policies", "default.yml"), DEFAULT_POLICY, "utf-8");

	// Write .env with API keys
	if (data.keys && Object.keys(data.keys).length > 0) {
		const envLines = Object.entries(data.keys).map(([provider, key]) => {
			const escaped = key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
			return `${envVarName(provider)}="${escaped}"`;
		});
		writeFileSync(join(vaultPath, ".env"), `${envLines.join("\n")}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
	}

	// Write .gitignore
	const gitignoreContent = `tigerbeetle/
*.tigerbeetle
dlq/
.env
`;
	writeFileSync(join(vaultPath, ".gitignore"), gitignoreContent, "utf-8");

	// Set vault permissions to 700 (owner only)
	chmodSync(vaultPath, 0o700);
}
