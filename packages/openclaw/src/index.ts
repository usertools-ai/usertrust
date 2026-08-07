// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * @usertrust/openclaw — usertrust governance plugin for OpenClaw
 *
 * Adds budget enforcement, policy gates, and hash-chained audit trails
 * to every LLM call in OpenClaw. Zero code changes required — install
 * the plugin and every call is governed.
 *
 * Installation:
 *   openclaw plugins install @usertrust/openclaw
 *
 * Or manual setup in openclaw.json:
 *   {
 *     "plugins": {
 *       "entries": {
 *         "usertrust": {
 *           "enabled": true,
 *           "config": { "budget": 100000, "dryRun": true }
 *         }
 *       }
 *     }
 *   }
 *
 * How it works:
 *   User's LLM call → OpenClaw → wrapStreamFn (usertrust) →
 *     1. Check budget (PENDING hold)
 *     2. Forward to real stream
 *     3. Accumulate token usage from stream
 *     4. POST settle with actual cost
 *     5. Return governed stream to OpenClaw
 */

import type { Governor } from "usertrust";
import { createGovernor } from "usertrust";
import { wrapCompleteWithGovernance, wrapStreamWithGovernance } from "./stream-governor.js";
import type {
	AssistantMessageEventStreamLike,
	Context,
	Model,
	OpenClawPluginApi,
	ProviderPlugin,
	StreamFn,
	StreamOptions,
	UsertrustPluginConfig,
} from "./types.js";

// Re-export for consumers
export { wrapCompleteWithGovernance, wrapStreamWithGovernance } from "./stream-governor.js";
export {
	createAccumulator,
	extractTextDeltaLength,
	extractUsageFromEvent,
	extractUsageFromProviderChunk,
} from "./token-extractor.js";
export type {
	AssistantMessage,
	AssistantMessageEventStreamLike,
	Context,
	GovernedStreamMeta,
	Message,
	Model,
	ProviderPlugin,
	ProviderWrapStreamFnContext,
	StreamContext,
	StreamEvent,
	StreamFn,
	StreamOptions,
	StreamUsage,
	ToolResultMessage,
	Usage,
	UsertrustPluginConfig,
} from "./types.js";

/** Active governor instance — singleton per plugin lifecycle. */
let governor: Governor | null = null;

/**
 * OpenClaw plugin entry point.
 *
 * Called by OpenClaw's plugin loader. Initializes the usertrust
 * governance engine and registers the stream wrapper.
 */
export default function register(api: OpenClawPluginApi): void {
	// OpenClaw delivers openclaw.json → plugins.entries.usertrust.config on the
	// api object as `pluginConfig`, at register() time. It is NOT a second
	// argument to any hook.
	const config = api.pluginConfig as UsertrustPluginConfig | undefined;
	if (config == null) {
		throw new Error(
			"usertrust: plugin config missing — set plugins.entries.usertrust.config.budget in openclaw.json",
		);
	}

	api.registerProvider(createUsertrustPlugin(config));
}

/**
 * Factory: build an OpenClaw `ProviderPlugin` bound to a usertrust config.
 *
 * Use this when programmatically wiring usertrust into an OpenClaw runtime
 * (rather than going through the auto-discovery `register()` default).
 * The returned plugin's `wrapStreamFn` follows OpenClaw's provider-hook shape:
 * one context argument carrying the inner `streamFn`.
 *
 * Init is lazy — the governor is created on the first wrapped call, not
 * at plugin construction time. This matches OpenClaw's lifecycle (plugins
 * register synchronously; governance needs async init).
 *
 * ```ts
 * import { createUsertrustPlugin } from "usertrust-openclaw";
 *
 * const plugin = createUsertrustPlugin({ budget: 100_000, dryRun: true });
 * const wrapped = plugin.wrapStreamFn!({ provider, modelId, streamFn: rawStreamFn });
 * for await (const event of wrapped!(model, context)) { ... }
 * ```
 */
export function createUsertrustPlugin(config: UsertrustPluginConfig): ProviderPlugin {
	const getGovernor = lazyGovernor(config);

	return {
		id: "usertrust",
		label: "usertrust Governance",
		// `auth` is required by OpenClaw's ProviderPlugin contract. usertrust
		// governs someone else's provider credentials and holds none of its own.
		auth: [],
		wrapStreamFn(ctx): StreamFn | undefined {
			const next = ctx.streamFn;
			if (next == null) return undefined;
			return (model, context, options) =>
				governedStreamLazy(getGovernor, next, model, context, options);
		},
	};
}

/**
 * Programmatic API for non-OpenClaw usage.
 *
 * Use this when integrating usertrust governance into a custom
 * pi-ai setup without the full OpenClaw plugin system.
 *
 * ```ts
 * import { createGovernedStreamFn } from "usertrust-openclaw";
 *
 * const governed = await createGovernedStreamFn(myStreamFn, {
 *   budget: 100_000,
 *   dryRun: true,
 * });
 *
 * for await (const event of governed("claude-sonnet-4-6", context)) {
 *   // events flow through with governance applied
 * }
 * ```
 */
export async function createGovernedStreamFn(
	streamFn: StreamFn,
	config: UsertrustPluginConfig,
): Promise<{ governedStreamFn: StreamFn; governor: Governor }> {
	const gov = await initGovernor(config);
	const governedStreamFn = wrapStreamWithGovernance(streamFn, gov);
	return { governedStreamFn, governor: gov };
}

/**
 * Get the active governor instance.
 * Returns null if the plugin hasn't been initialized yet.
 */
export function getGovernor(): Governor | null {
	return governor;
}

/**
 * Graceful shutdown — call this when OpenClaw exits.
 * Voids all pending holds and flushes the audit chain.
 */
export async function shutdown(): Promise<void> {
	if (governor != null) {
		await governor.destroy();
		governor = null;
		initPromise = null;
	}
}

// ── Internal ──

/** Module-level promise to prevent concurrent initialization race. */
let initPromise: Promise<Governor> | null = null;

function initGovernor(config: UsertrustPluginConfig): Promise<Governor> {
	if (governor != null) {
		return Promise.resolve(governor);
	}

	// Memoize the init promise to prevent TOCTOU race — two concurrent
	// callers both see governor == null but only one createGovernor runs.
	if (initPromise == null) {
		initPromise = createGovernor({
			budget: config.budget,
			...(config.dryRun != null ? { dryRun: config.dryRun } : {}),
			...(config.configPath != null ? { configPath: config.configPath } : {}),
			...(config.proxy != null ? { proxy: config.proxy } : {}),
			...(config.proxyKey != null ? { key: config.proxyKey } : {}),
			...(config.vaultBase != null ? { vaultBase: config.vaultBase } : {}),
			// M2: forward the operator's endpoint declaration into the headless
			// governor (GovernorOpts.endpoint). Without this, every OpenClaw call
			// defaults to cloud scope — local models would meter at frontier
			// fallback and inherit strict cloud anomaly thresholds. runtime defaults
			// to "unknown"; baseURL is omitted (never undefined) when absent.
			...(config.endpoint != null
				? {
						endpoint: {
							class: config.endpoint.class,
							runtime: config.endpoint.runtime ?? "unknown",
							...(config.endpoint.baseURL !== undefined
								? { baseURL: config.endpoint.baseURL }
								: {}),
						},
					}
				: {}),
		}).then((gov) => {
			governor = gov;
			return gov;
		});
	}

	return initPromise;
}

function lazyGovernor(config: UsertrustPluginConfig): () => Promise<Governor> {
	let promise: Promise<Governor> | null = null;

	return () => {
		if (promise == null) {
			promise = initGovernor(config);
		}
		return promise;
	};
}

/**
 * Governor init is async but the wrap seam is synchronous, so both halves of
 * the stream surface (iteration and `result()`) read from the same lazily
 * created inner stream.
 */
function governedStreamLazy(
	getGovernor: () => Promise<Governor>,
	streamFn: StreamFn,
	model: Model,
	context: Context,
	options?: StreamOptions,
): AssistantMessageEventStreamLike {
	const inner = getGovernor().then((gov) =>
		wrapStreamWithGovernance(streamFn, gov)(model, context, options),
	);
	// Consumers still see the rejection through their own await; this only
	// stops an init failure from surfacing as an unhandled rejection.
	inner.catch(() => {});

	return {
		async *[Symbol.asyncIterator]() {
			yield* await inner;
		},
		async result() {
			return (await inner).result();
		},
	};
}
