// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Host-level smoke check of `register()` / config delivery against the PINNED
 * openclaw contract.
 *
 * The fake host below is TYPED as openclaw's own `OpenClawPluginApi`, so the
 * shape it hands the plugin — including where the config lives — is checked
 * against the pinned package at compile time and exercised at runtime here.
 * Field-level type equality lives in `contract-openclaw.test-d.ts`.
 *
 * openclaw is NOT a devDependency (see `../openclaw-contract.env`), so this
 * file has two modes and no third:
 *
 *   - `USERTRUST_OPENCLAW_CONTRACT=1` — the `openclaw-contract` CI job, after
 *     an out-of-tree install of the pinned version. A MISSING or MISMATCHED
 *     openclaw throws here, before a single test runs: a job whose whole
 *     purpose is proving the pin must never pass by proving nothing.
 *   - unset — every other run, local or CI. If openclaw is absent the suite
 *     SKIPS, loudly, naming the job that does prove it. The type-only imports
 *     below are erased by the transform, so nothing here fails to load; what
 *     would be missing is the claim, not the runtime.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it, vi } from "vitest";
import register, { createUsertrustPlugin } from "../src/index.js";
import {
	doneEvent,
	makeContext,
	makeModel,
	makeUsage,
	startEvent,
	streamOf,
} from "./host-fixtures.js";

// ── the pin, and whether this process can actually prove it ──

const CONTRACT_JOB = "the `openclaw-contract` CI job (.github/workflows/ci.yml)";

/** The one place the pin lives. Parsed, never duplicated. */
function pinnedVersion(): string {
	const env = readFileSync(new URL("../openclaw-contract.env", import.meta.url), "utf8");
	const match = env.match(/^OPENCLAW_CONTRACT_VERSION=(.+)$/m);
	if (match?.[1] == null) {
		throw new Error(
			"usertrust: packages/openclaw/openclaw-contract.env has no OPENCLAW_CONTRACT_VERSION — " +
				"that file is the single source of the openclaw pin and cannot be empty.",
		);
	}
	return match[1].trim();
}

/**
 * The installed openclaw's version, or `null` when the package is absent.
 *
 * Resolved through an entry point rather than `openclaw/package.json`: the
 * manifest is not in openclaw's `exports` map, so requiring it directly throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED even when the package is perfectly present.
 */
function installedVersion(): string | null {
	const require = createRequire(import.meta.url);
	let dir: string;
	try {
		dir = dirname(require.resolve("openclaw/plugin-sdk/core"));
	} catch {
		return null;
	}
	// Walk up to the package root — `dist/plugin-sdk/core.js` is several levels
	// below the manifest, and the layout is openclaw's to change.
	for (let cursor = dir; ; ) {
		try {
			const manifest = JSON.parse(readFileSync(join(cursor, "package.json"), "utf8")) as {
				name?: string;
				version?: string;
			};
			if (manifest.name === "openclaw" && typeof manifest.version === "string") {
				return manifest.version;
			}
		} catch {
			// no manifest at this level; keep walking
		}
		const parent = dirname(cursor);
		if (parent === cursor) return null;
		cursor = parent;
	}
}

const PINNED = pinnedVersion();
const INSTALLED = installedVersion();
const CONTRACT_MODE = process.env.USERTRUST_OPENCLAW_CONTRACT === "1";

if (CONTRACT_MODE && INSTALLED == null) {
	throw new Error(
		`usertrust: USERTRUST_OPENCLAW_CONTRACT=1 but openclaw is NOT INSTALLED. This mode exists ` +
			`to prove the host contract against openclaw@${PINNED}; skipping would make the proof ` +
			`vacuous. Install it out-of-tree first:\n` +
			`  npm install --no-save --package-lock=false --ignore-scripts openclaw@${PINNED}`,
	);
}
if (CONTRACT_MODE && INSTALLED !== PINNED) {
	throw new Error(
		`usertrust: openclaw VERSION MISMATCH — installed ${INSTALLED}, pinned ${PINNED} ` +
			`(packages/openclaw/openclaw-contract.env). The contract is a claim about one exact ` +
			`release; proving it against a different one proves nothing about the pin.`,
	);
}
if (!CONTRACT_MODE && INSTALLED !== PINNED) {
	// `process.stderr`, NOT `console.warn`: vitest intercepts console output and
	// attributes it to the running task, and its default reporter drops what it
	// collects during module load of a file that then runs no tests — which is
	// exactly this case, so a `console.warn` here is invisible in `npx vitest run`
	// and the skip is silent instead of loud. Writing to the stream directly
	// bypasses the interception and always reaches the terminal.
	process.stderr.write(
		`\n[contract.test.ts] SKIPPING the openclaw host-smoke suite — openclaw@${PINNED} is ` +
			`${INSTALLED == null ? "not installed" : `not what is installed (found ${INSTALLED})`}.\n` +
			`  openclaw is deliberately not a dependency of this repo (it is an OPTIONAL PEER, and\n` +
			`  \`npm ci\` does not install those). ${CONTRACT_JOB}\n` +
			`  installs the pinned version out-of-tree and runs this file with\n` +
			`  USERTRUST_OPENCLAW_CONTRACT=1, where an absent or mismatched openclaw is a HARD\n` +
			`  FAILURE. Nothing is being waved through; the proof just happens there. To run it here:\n` +
			`    source packages/openclaw/openclaw-contract.env\n` +
			`    npm install --no-save --package-lock=false --ignore-scripts openclaw@"$OPENCLAW_CONTRACT_VERSION"\n` +
			`    USERTRUST_OPENCLAW_CONTRACT=1 npx vitest run packages/openclaw/tests/contract.test.ts\n\n`,
	);
}

/** The suite runs only where the pinned host is actually present. */
const describeHostContract = INSTALLED === PINNED ? describe : describe.skip;

// Mock tigerbeetle-node — the smoke check is about registration, not the ledger.
vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(() => ({
		createAccounts: vi.fn(async () => []),
		createTransfers: vi.fn(async () => []),
		lookupAccounts: vi.fn(async () => []),
		lookupTransfers: vi.fn(async () => []),
		destroy: vi.fn(),
	})),
	AccountFlags: { linked: 1, debits_must_not_exceed_credits: 2, history: 4 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateTransferError: { exists: 1, exceeds_credits: 34 },
	CreateAccountError: { exists: 1 },
	amount_max: 0xffffffffffffffffffffffffffffffffn,
}));

/**
 * A minimal stand-in for openclaw's plugin host. Only the members the plugin
 * touches are real; the rest are absent, and the cast is what pins the claim
 * "this is the surface openclaw hands us" to the pinned package.
 */
function fakeHost(pluginConfig?: Record<string, unknown>): {
	api: OpenClawPluginApi;
	registered: ProviderPlugin[];
} {
	const registered: ProviderPlugin[] = [];
	const api = {
		id: "usertrust",
		name: "usertrust",
		...(pluginConfig != null ? { pluginConfig } : {}),
		registerProvider: (provider: ProviderPlugin) => {
			registered.push(provider);
		},
	} as unknown as OpenClawPluginApi;
	return { api, registered };
}

describeHostContract(`openclaw host contract (openclaw@${PINNED})`, () => {
	it("register() reads config from api.pluginConfig and registers a provider", () => {
		const { api, registered } = fakeHost({ budget: 100_000, dryRun: true });

		register(api);

		expect(registered).toHaveLength(1);
		const plugin = registered[0];
		expect(plugin?.id).toBe("usertrust");
		expect(plugin?.label).toBe("usertrust Governance");
		// `auth` is required by the pinned ProviderPlugin contract.
		expect(Array.isArray(plugin?.auth)).toBe(true);
		expect(typeof plugin?.wrapStreamFn).toBe("function");
	});

	it("register() fails loudly when the host delivers no plugin config", () => {
		const { api, registered } = fakeHost();

		expect(() => register(api)).toThrow(/plugin config missing/);
		expect(registered).toHaveLength(0);
	});

	it("wrapStreamFn takes one context argument and reads the inner fn off it", async () => {
		const plugin = createUsertrustPlugin({ budget: 100_000, dryRun: true });

		expect(plugin.wrapStreamFn?.length).toBe(1);

		const inner = streamOf([startEvent(), doneEvent(makeUsage(50, 20))]);
		const wrapped = plugin.wrapStreamFn?.({
			provider: "anthropic",
			modelId: "claude-sonnet-4-6",
			streamFn: inner,
		});

		expect(wrapped).toBeTypeOf("function");
		if (wrapped == null) return;

		const collected: string[] = [];
		for await (const event of await wrapped(makeModel(), makeContext())) {
			collected.push(event.type);
		}
		expect(collected).toEqual(["start", "done"]);
	});

	it("wrapStreamFn declines when the host supplies no inner stream fn", () => {
		const plugin = createUsertrustPlugin({ budget: 100_000, dryRun: true });

		expect(plugin.wrapStreamFn?.({ provider: "anthropic", modelId: "x" })).toBeUndefined();
	});

	it("the governed stream preserves the host surface — result(), not just iteration", async () => {
		const plugin = createUsertrustPlugin({ budget: 100_000, dryRun: true });
		const wrapped = plugin.wrapStreamFn?.({
			provider: "anthropic",
			modelId: "claude-sonnet-4-6",
			streamFn: streamOf([startEvent(), doneEvent(makeUsage(50, 20))]),
		});

		const stream = await wrapped?.(makeModel(), makeContext());
		expect(typeof stream?.result).toBe("function");

		const final = await stream?.result();
		expect(final?.role).toBe("assistant");
	});
});
