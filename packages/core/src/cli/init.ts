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
import type { ModelRates } from "../ledger/pricing.js";
import { modelsForProvider, PRICING_TABLE, PRICING_TABLE_VERSION } from "../ledger/pricing.js";
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

// ── Local inference presets (M2 local-model governance) ──

type LocalPreset = "ollama" | "lmstudio" | "vllm";

const LOCAL_PRESET_URLS: Record<LocalPreset, string> = {
	ollama: "http://localhost:11434",
	lmstudio: "http://localhost:1234",
	vllm: "http://localhost:8000",
};

const DEFAULT_POLICY = `rules:
  - name: block-budget-overshoot
    effect: deny
    enforcement: hard
    conditions:
      - field: budget_remaining_after
        operator: lt
        value: 0

  - name: block-budget-exhausted
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

/**
 * Probe an OpenAI-compatible endpoint for its installed model list.
 * Best-effort: global fetch with a 500ms AbortController timeout; any
 * failure (endpoint down, non-200, bad JSON) returns an empty list and
 * the wizard proceeds without a model list.
 */
async function probeLocalModels(base: string): Promise<string[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 500);
	try {
		const res = await fetch(`${base}/v1/models`, { signal: controller.signal });
		if (!res.ok) return [];
		const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
		if (!Array.isArray(body.data)) return [];
		return body.data.map((entry) => entry.id).filter((id): id is string => typeof id === "string");
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
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

	// Step 4: Local inference — Ollama / LM Studio / vLLM endpoint presets.
	// The chosen endpoint classifies as LOCAL scope: calls settle at nominal
	// local rates (default {0,0} + the >=1 floor = 1 usertoken per call)
	// instead of frontier fallback rates.
	let endpoints: VaultData["endpoints"];
	let localModels: Record<string, ModelRates> | undefined;

	// Opt-in confirm gate before the runtime picker (Task 7 integration fix):
	// declining (the default) reproduces the pre-M2 prompt sequence exactly —
	// the picker below (clack.select, a prompt primitive the pre-M2 wizard
	// never used) is only reached on explicit opt-in, so existing interactive
	// flows and their pinned tests observe an unchanged wizard.
	const wantsLocal = await clack.confirm({
		message: "Configure local inference (Ollama / LM Studio / vLLM)?",
		initialValue: false,
	});
	if (clack.isCancel(wantsLocal)) {
		clack.log.warn("Setup cancelled.");
		return;
	}

	if (wantsLocal === true) {
		const localChoice = await clack.select({
			message: "Pick your local runtime:",
			options: [
				{ value: "skip", label: "Skip — cloud providers only" },
				{ value: "ollama", label: `Ollama (${LOCAL_PRESET_URLS.ollama})` },
				{ value: "lmstudio", label: `LM Studio (${LOCAL_PRESET_URLS.lmstudio})` },
				{ value: "vllm", label: `vLLM (${LOCAL_PRESET_URLS.vllm})` },
			],
			initialValue: "skip",
		});

		if (clack.isCancel(localChoice)) {
			clack.log.warn("Setup cancelled.");
			return;
		}

		if (localChoice !== "skip") {
			const runtime = localChoice as LocalPreset;
			const base = LOCAL_PRESET_URLS[runtime];
			endpoints = [{ match: base, class: "local", runtime }];

			const s = clack.spinner();
			s.start(`Probing ${base}/v1/models...`);
			const models = await probeLocalModels(base);
			if (models.length > 0) {
				s.stop(`Found ${models.length} model${models.length === 1 ? "" : "s"} at ${base}`);
				// {0,0} suggested rates: with the >=1 cost floor, every call to these
				// models settles at exactly 1 nominal usertoken. Raise the rates later
				// for GPU-amortized showback (local.rateClass: "amortized-usd").
				localModels = {};
				for (const model of models) {
					clack.log.step(`  ${model}`);
					localModels[model] = { inputPer1k: 0, outputPer1k: 0 };
				}
			} else {
				s.stop("No response — endpoint saved without a model list");
			}
		}
	}

	// Step 5: Create vault
	createVault(vaultPath, {
		budget: budgetUsertokens,
		providers,
		pricing,
		...(customRates !== undefined ? { customRates } : {}),
		...(endpoints !== undefined ? { endpoints } : {}),
		...(localModels !== undefined ? { localModels } : {}),
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
	/** Local inference endpoint matchers (consumed by classifyEndpoint). */
	endpoints?: Array<{ match: string; class: "local"; runtime: LocalPreset }>;
	/** Detected local models, written to local.models with {0,0} nominal rates. */
	localModels?: Record<string, ModelRates>;
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

	if (data.endpoints && data.endpoints.length > 0) {
		config.endpoints = data.endpoints;
	}

	if (data.localModels && Object.keys(data.localModels).length > 0) {
		// All other local.* keys are zod-defaulted (autoDetectLoopback: true,
		// defaultRate {0,0}, rateClass "nominal", injectUsageOptions: true).
		config.local = { models: data.localModels };
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
