// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust pricing — Display current rate configuration
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";
import {
	modelsForProvider,
	PRICING_TABLE,
	PRICING_TABLE_VERSION,
	resolveAppliedRates,
} from "../ledger/pricing.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { TrustConfig } from "../shared/types.js";
import { TrustConfigSchema } from "../shared/types.js";

export interface PricingOpts {
	json: boolean;
}

export async function run(rootDir?: string, opts?: PricingOpts): Promise<void> {
	const root = rootDir ?? process.cwd();
	const configPath = join(root, VAULT_DIR, "usertrust.config.json");
	const json = opts?.json === true;

	let config: TrustConfig | null = null;
	if (existsSync(configPath)) {
		const raw = JSON.parse(await readFile(configPath, "utf-8"));
		config = TrustConfigSchema.parse(raw);
	}

	const pricing = config?.pricing ?? "recommended";
	const customRates = config?.customRates;
	const providers = config?.providers ?? [];

	// Determine which models to show
	const modelKeys =
		providers.length > 0
			? providers.flatMap((p) => modelsForProvider(p.name))
			: Object.keys(PRICING_TABLE);

	if (json) {
		const rates: Record<
			string,
			{
				inputPerM: number;
				outputPerM: number;
				cacheReadPerM: number;
				cacheWritePerM: number;
				source: string;
			}
		> = {};
		for (const model of modelKeys) {
			const custom = customRates?.[model];
			const base = PRICING_TABLE[model];
			const source = custom ? "custom" : "recommended";
			const r = custom ?? base;
			if (r) {
				// Four resolved tiers (D1): an omitted cache rate is published at
				// inputPer1k — what the operator is actually charged for it — never
				// as a hole in the export.
				const applied = resolveAppliedRates(r);
				rates[model] = {
					inputPerM: applied.inputPer1k / 10,
					outputPerM: applied.outputPer1k / 10,
					cacheReadPerM: applied.cacheReadPer1k / 10,
					cacheWritePerM: applied.cacheWritePer1k / 10,
					source,
				};
			}
		}
		console.log(
			JSON.stringify({ command: "pricing", pricing, version: PRICING_TABLE_VERSION, rates }),
		);
		return;
	}

	console.log(pc.bold(`\n  Rates (${pricing}, verified ${PRICING_TABLE_VERSION})\n`));

	for (const model of modelKeys) {
		const custom = customRates?.[model];
		const base = PRICING_TABLE[model];
		const r = custom ?? base;
		if (!r) continue;

		const applied = resolveAppliedRates(r);
		const inputPerM = (applied.inputPer1k / 10).toFixed(2);
		const outputPerM = (applied.outputPer1k / 10).toFixed(2);
		const cacheReadPerM = (applied.cacheReadPer1k / 10).toFixed(2);
		const cacheWritePerM = (applied.cacheWritePer1k / 10).toFixed(2);
		const tag = custom ? pc.yellow(" (custom)") : "";
		console.log(
			`  ${pc.cyan(model.padEnd(24))} in $${inputPerM} out $${outputPerM} ` +
				`cache-read $${cacheReadPerM} cache-write $${cacheWritePerM} per 1M${tag}`,
		);
	}

	console.log(pc.dim(`\n  Mode: ${pricing} | Run \`usertrust init --reconfigure\` to change\n`));
}
