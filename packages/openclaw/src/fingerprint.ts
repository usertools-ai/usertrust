// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * fingerprint.ts — the identity of the config that CLAIMED the singleton governor.
 *
 * `index.ts` holds one governor per module, so a second plugin instance either
 * reuses it (same config) or is refused (different config). "Same config" is
 * decided here, and the deciding value is held at module scope in `index.ts`
 * for the whole process lifetime — which is why it must not be the config
 * itself: a plugin config carries `proxyKey`, an operator's API key, and the
 * canonical JSON of it would keep that key resident in the clear in a
 * module-level variable, reachable from any heap dump or `--inspect` session,
 * long after the value was needed.
 *
 * Equality is the ONLY operation ever performed on a fingerprint, and a digest
 * supports equality exactly as well as the JSON does — so the JSON is hashed
 * and discarded. Semantics are unchanged; the retained secret is gone.
 *
 * `id` and `aliases` are omitted: they only control OpenClaw routing of
 * `wrapStreamFn` and are never forwarded to `createGovernor()`. Hashing them
 * would refuse a second wrapper with the same governance settings but a
 * different alias list (or default aliases vs explicit vs `[]`).
 */

import { createHash } from "node:crypto";
import type { FrozenCostCenters, UsertrustPluginConfig } from "./types.js";

/**
 * Canonical-JSON-then-sha-256 fingerprint of the config that determines the
 * module-singleton governor's identity. Key order never matters — the JSON is
 * canonicalized before hashing — so two semantically identical configs written
 * with different key orders fingerprint the same.
 *
 * @returns a 64-character lowercase hex digest. Never the config text.
 */
export function fingerprintConfig(
	config: UsertrustPluginConfig,
	frozenCostCenters?: FrozenCostCenters,
): string {
	// Routing-only: `id`/`aliases` never reach createGovernor(). See file header.
	const { id: _id, aliases: _aliases, ...governance } = config;
	const canonical = JSON.stringify(sortKeysDeep({ ...governance, costCenters: frozenCostCenters }));
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function sortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeysDeep);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}
