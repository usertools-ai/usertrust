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
	effectiveCacheWrite1hRate,
	type LongPromptTier,
	type ModelRates,
	modelsForProvider,
	PRICING_TABLE,
	PRICING_TABLE_VERSION,
	resolveAppliedRates,
	supportsCacheWrite1h,
} from "../ledger/pricing.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { TrustConfig } from "../shared/types.js";
import { TrustConfigSchema } from "../shared/types.js";
import { toSafeJson } from "./target.js";

export interface PricingOpts {
	json: boolean;
}

/**
 * The per-request prompt tier that prices a model: the BUILT-IN row's, and only when no
 * operator custom row replaces it (custom rates are flat, so a custom row has none).
 */
function tierOf(custom: unknown, base: ModelRates | undefined): LongPromptTier | undefined {
	return custom === undefined ? base?.longPrompt : undefined;
}

/** A row's higher per-request tier in $/MTok, resolved the way settlement charges it. */
function longPromptPerM(tier: LongPromptTier) {
	const applied = resolveAppliedRates(tier.rates);
	return {
		overPromptTokens: tier.thresholdTokens,
		inputPerM: applied.inputPer1k / 10,
		outputPerM: applied.outputPer1k / 10,
		cacheReadPerM: applied.cacheReadPer1k / 10,
		cacheWritePerM: applied.cacheWritePer1k / 10,
		cacheWrite1hPerM: effectiveCacheWrite1hRate(tier.rates) / 10,
	};
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
				cacheWrite1hPerM: number | null;
				/** Present only for a row priced per request by prompt length (`longPrompt`). */
				longPrompt?: {
					overPromptTokens: number;
					inputPerM: number;
					outputPerM: number;
					cacheReadPerM: number;
					cacheWritePerM: number;
					cacheWrite1hPerM: number;
				};
				source: string;
			}
		> = {};
		for (const model of modelKeys) {
			const custom = customRates?.[model];
			const base = PRICING_TABLE[model];
			const source = custom ? "custom" : "recommended";
			const r = custom ?? base;
			const tier = tierOf(custom, base);
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
					// The rate a 1-hour cache write settles at (explicit, or the derived
					// dearer-of-5m-and-2x-input when the row publishes none).
					// null = the model has no 1-hour tier (a built-in row with no explicit rate);
					// operator-owned rates derive one, as settlement does.
					cacheWrite1hPerM: supportsCacheWrite1h(r, custom !== undefined)
						? effectiveCacheWrite1hRate(r) / 10
						: null,
					// The higher per-request tier: every category above, for a prompt over the
					// threshold (input + cache reads + cache writes).
					...(tier === undefined ? {} : { longPrompt: longPromptPerM(tier) }),
					source,
				};
			}
		}
		console.log(toSafeJson({ command: "pricing", pricing, version: PRICING_TABLE_VERSION, rates }));
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
		const oneHour = supportsCacheWrite1h(r, custom !== undefined)
			? ` (1h $${(effectiveCacheWrite1hRate(r) / 10).toFixed(2)})`
			: "";
		const tag = custom ? pc.yellow(" (custom)") : "";
		const tier = tierOf(custom, base);
		const tiered = tier === undefined ? "" : pc.dim(" (prompts up to the threshold)");
		console.log(
			`  ${pc.cyan(model.padEnd(24))} in $${inputPerM} out $${outputPerM} ` +
				`cache-read $${cacheReadPerM} cache-write $${cacheWritePerM}${oneHour} per 1M${tag}${tiered}`,
		);
		if (tier !== undefined) {
			const long = longPromptPerM(tier);
			const over = `over ${tier.thresholdTokens.toLocaleString("en-US")} prompt tokens`;
			console.log(
				`  ${"".padEnd(24)} in $${long.inputPerM.toFixed(2)} out $${long.outputPerM.toFixed(2)} ` +
					`cache-read $${long.cacheReadPerM.toFixed(2)} cache-write $${long.cacheWritePerM.toFixed(2)}` +
					` (1h $${long.cacheWrite1hPerM.toFixed(2)}) per 1M ${pc.dim(`(${over})`)}`,
			);
		}
	}

	console.log(pc.dim(`\n  Mode: ${pricing} | Run \`usertrust init --reconfigure\` to change\n`));
}
