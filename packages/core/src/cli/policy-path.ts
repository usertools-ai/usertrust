// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Where the policy file IS, decided once for every diagnostic that reports on it.
 *
 * `cli/policy.ts` and `cli/health.ts` both need this and both had their own copy.
 * The copies diverged the moment one was fixed: a review found that an unreadable
 * config made `policy validate` check `./policies/default.yml` instead of failing,
 * that was repaired, and the identical bug sat in `health.ts` until the next round
 * found it there. Two copies of a rule is two places to fix it and one place to
 * forget.
 *
 * The rule itself: a diagnostic must resolve its target exactly as the governor
 * does, and refuse when it cannot. A diagnostic that answers confidently about a
 * file the governor would never load is worse than one that declines — it reports
 * `[ok]` for a deployment that cannot start.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Default from `TrustConfigSchema.policies`, relative to the vault dir. */
export const DEFAULT_POLICIES_PATH = "./policies/default.yml";

export type PolicyPathResolution = { path: string } | { error: string };

/**
 * Read the `policies` key out of `usertrust.config.json`.
 *
 * Tolerates a config that is unusable in OTHER respects — a broken budget must
 * not stop an operator diagnosing their policy — but not one that cannot be read,
 * parsed, or whose `policies` is not a string. The value is taken VERBATIM,
 * including `""`: `TrustConfigSchema` accepts an empty string and both governors
 * resolve it to the vault directory, where the load fails, so substituting the
 * default would report on a different file than the one that runs.
 */
export function resolvePolicyPath(vaultDir: string): PolicyPathResolution {
	const configPath = join(vaultDir, "usertrust.config.json");
	if (!existsSync(configPath)) return { path: DEFAULT_POLICIES_PATH };

	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch (err) {
		return { error: `config cannot be read: ${(err as Error).message}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { error: `config is not valid JSON: ${(err as Error).message}` };
	}

	// `JSON.parse("null")` SUCCEEDS and returns null, so a property read here threw
	// a raw TypeError outside every catch — the command emitted no diagnostic at
	// all, in either output mode, for a config that a bad generation step can
	// easily produce. A valid JSON document is not necessarily a usable one.
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {
			error: `config must be a JSON object, got ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed}`,
		};
	}

	const policies = (parsed as { policies?: unknown }).policies;
	if (policies !== undefined && typeof policies !== "string") {
		return { error: `config "policies" must be a string, got ${typeof policies}` };
	}
	return { path: typeof policies === "string" ? policies : DEFAULT_POLICIES_PATH };
}
