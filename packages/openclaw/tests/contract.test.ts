// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Host-level smoke check of `register()` / config delivery against the PINNED
 * openclaw contract (2026.7.1-2).
 *
 * The fake host below is TYPED as openclaw's own `OpenClawPluginApi`, so the
 * shape it hands the plugin — including where the config lives — is checked
 * against the pinned package at compile time and exercised at runtime here.
 * Field-level type equality lives in `contract.test-d.ts`.
 */

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

describe("openclaw host contract", () => {
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
