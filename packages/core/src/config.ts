// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { VAULT_DIR } from "./shared/constants.js";
import { TrustConfigSchema } from "./shared/types.js";
import type { TrustConfig } from "./shared/types.js";

/**
 * Load trust config from `.usertrust/usertrust.config.json`, merged with
 * optional runtime overrides. Returns a validated TrustConfig.
 *
 * @param overrides - Optional partial config to merge on top of file values
 * @param vaultBase - Base directory containing the `.usertrust` vault (default: cwd)
 */
export async function loadConfig(
	overrides?: Partial<TrustConfig>,
	vaultBase?: string,
): Promise<TrustConfig> {
	const base = vaultBase ?? process.cwd();
	const configPath = join(base, VAULT_DIR, "usertrust.config.json");
	let raw: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		raw = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
	}
	const merged = { ...raw };
	if (overrides) {
		for (const [key, val] of Object.entries(overrides)) {
			if (val !== undefined) {
				(merged as Record<string, unknown>)[key] = val;
			}
		}
	}
	return TrustConfigSchema.parse(merged);
}

/** Identity function for TypeScript config intellisense. */
export function defineConfig(config: TrustConfig): TrustConfig {
	return TrustConfigSchema.parse(config);
}
