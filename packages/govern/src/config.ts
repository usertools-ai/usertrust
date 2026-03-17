import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { VAULT_DIR } from "./shared/constants.js";
import { GovernConfigSchema } from "./shared/types.js";
import type { GovernConfig } from "./shared/types.js";

/**
 * Load govern config from `.usertools/govern.config.json`, merged with
 * optional runtime overrides. Returns a validated GovernConfig.
 *
 * @param overrides - Optional partial config to merge on top of file values
 * @param vaultBase - Base directory containing the `.usertools` vault (default: cwd)
 */
export async function loadConfig(
	overrides?: Partial<GovernConfig>,
	vaultBase?: string,
): Promise<GovernConfig> {
	const base = vaultBase ?? process.cwd();
	const configPath = join(base, VAULT_DIR, "govern.config.json");
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
	return GovernConfigSchema.parse(merged);
}

/** Identity function for TypeScript config intellisense. */
export function defineConfig(config: GovernConfig): GovernConfig {
	return GovernConfigSchema.parse(config);
}
