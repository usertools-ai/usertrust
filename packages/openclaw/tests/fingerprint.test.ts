// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * fingerprint.test.ts — the governor-identity fingerprint.
 *
 * `index.ts` keeps the winning config's fingerprint at MODULE scope for the
 * whole process lifetime (`governorFingerprint`), because that string is what
 * decides whether a second `createUsertrustPlugin` reuses the singleton
 * governor or is refused. The canonical JSON of a plugin config contains
 * `proxyKey` — an operator's API key — so retaining the JSON itself would keep
 * that key resident, in the clear, in a module-level variable for as long as
 * the process runs, reachable from any heap dump or `--inspect` session.
 *
 * A digest decides identity exactly as well as the JSON does (equality is the
 * only operation ever performed on it) and retains nothing. These tests pin
 * both halves: the semantics are unchanged, and the plaintext is gone.
 */

import { describe, expect, it } from "vitest";
import { fingerprintConfig } from "../src/fingerprint.js";
import { normalizeCostCenters } from "../src/index.js";
import type { UsertrustPluginConfig } from "../src/types.js";

const SECRET = "sk-ut-super-secret-operator-key-2026";

const BASE: UsertrustPluginConfig = {
	budget: 100_000,
	dryRun: true,
	proxy: "https://proxy.usertrust.ai",
	proxyKey: SECRET,
	vaultBase: "/tmp/vault",
};

const CC = normalizeCostCenters({
	parentUserId: "acme",
	tools: { web_search: "research" },
	default: "general",
	envelopes: {
		research: { allocated: 10_000, periodStartMs: 0 },
		general: { allocated: 1_000, periodStartMs: 0 },
	},
});

describe("fingerprintConfig", () => {
	it("is a sha-256 hex digest, not the config JSON", () => {
		expect(fingerprintConfig(BASE)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("never retains the proxyKey plaintext — the whole point of hashing it", () => {
		const fp = fingerprintConfig(BASE, CC);
		expect(fp).not.toContain(SECRET);
		// Not even a prefix of it: a digest shares no substring with its input
		// beyond coincidence, and `sk-ut-` would be a coincidence worth failing on.
		expect(fp).not.toContain("sk-ut-");
		// Nor any other config value that a heap dump would otherwise hand over.
		expect(fp).not.toContain("proxy.usertrust.ai");
		expect(fp).not.toContain("acme");
	});

	it("is key-order independent — the canonical-JSON guarantee survives hashing", () => {
		const a: UsertrustPluginConfig = { budget: 100_000, dryRun: true, proxyKey: SECRET };
		const b: UsertrustPluginConfig = { proxyKey: SECRET, dryRun: true, budget: 100_000 };

		expect(fingerprintConfig(a)).toBe(fingerprintConfig(b));
	});

	it("is key-order independent through NESTED objects too", () => {
		const a: UsertrustPluginConfig = {
			budget: 1,
			endpoint: { class: "local", runtime: "ollama", baseURL: "http://x" },
		};
		const b: UsertrustPluginConfig = {
			endpoint: { baseURL: "http://x", runtime: "ollama", class: "local" },
			budget: 1,
		};

		expect(fingerprintConfig(a)).toBe(fingerprintConfig(b));
	});

	it("separates configs that differ anywhere — budget, secret, or cost centers", () => {
		const base = fingerprintConfig(BASE);

		expect(fingerprintConfig({ ...BASE, budget: 200_000 })).not.toBe(base);
		expect(fingerprintConfig({ ...BASE, proxyKey: `${SECRET}-rotated` })).not.toBe(base);
		expect(fingerprintConfig(BASE, CC)).not.toBe(base);
	});

	it("is stable across calls for the same config (identity, not a nonce)", () => {
		expect(fingerprintConfig(BASE, CC)).toBe(fingerprintConfig(BASE, CC));
	});

	it("separates configs that differ only DEEP inside a nested object", () => {
		expect(
			fingerprintConfig({ budget: 1, endpoint: { class: "local", runtime: "unknown" } }),
		).not.toBe(fingerprintConfig({ budget: 1, endpoint: { class: "cloud", runtime: "unknown" } }));
	});

	it("omits routing-only id/aliases — they never reach createGovernor()", () => {
		const base = fingerprintConfig({ budget: 1 });

		expect(fingerprintConfig({ budget: 1, aliases: ["anthropic"] })).toBe(base);
		expect(fingerprintConfig({ budget: 1, aliases: [] })).toBe(base);
		expect(fingerprintConfig({ budget: 1, id: "other" })).toBe(base);
		expect(fingerprintConfig({ budget: 2 })).not.toBe(base);
	});
});
