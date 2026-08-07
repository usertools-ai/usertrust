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
import { createGovernor, parentUserIdRefusal, withCostCenter } from "usertrust";
import { wrapCompleteWithGovernance, wrapStreamWithGovernance } from "./stream-governor.js";
import type {
	AssistantMessageEventStreamLike,
	Context,
	EnvelopeConfig,
	FrozenCostCenters,
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
	CostCentersConfig,
	EnvelopeConfig,
	FrozenCostCenters,
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

/**
 * Config-time cap on `costCenters.envelopes`, mirroring core's `MAX_ENVELOPES`
 * (`packages/core/src/budget/context.ts`). Not imported — core's public entry
 * points (`.`, `./headless`, `./pricing`) don't export it, and Task 4 is
 * scoped to `packages/openclaw` — so the value is duplicated here, the same
 * mirror pattern `shared/ids.ts` documents for `cli/budget.ts`'s
 * `COST_CENTER_PATTERN` copy. If core's constant changes, this one must too.
 */
const MAX_ENVELOPES = 128;

/** Mirrors `openclaw.plugin.json`'s `configSchema.properties.costCenters` (`additionalProperties: false`). */
const KNOWN_COST_CENTERS_FIELDS = new Set([
	"parentUserId",
	"tools",
	"default",
	"envelopes",
	"scarcityContext",
]);

/** Mirrors the manifest's per-envelope schema node (`additionalProperties: false`). */
const KNOWN_ENVELOPE_FIELDS = new Set(["allocated", "periodStartMs", "periodEndMs"]);

/**
 * Validates AND normalizes `UsertrustPluginConfig.costCenters` into a
 * deep-frozen {@link FrozenCostCenters} — the ONLY shape any wrapper reads
 * downstream. Called at plugin CONSTRUCTION time (`createUsertrustPlugin`,
 * `register`, `createGovernedStreamFn`), never lazily: a malformed config
 * fails loudly before the plugin is handed to the host, not on the first
 * governed call.
 *
 * Reuses core's own validation doors rather than re-implementing them:
 * {@link parentUserIdRefusal} (the canonical parent-id rule) and
 * `withCostCenter`'s charset + envelope-metadata checks (the canonical
 * cost-center doors — see `packages/core/src/budget/attribution.ts`).
 * `withCostCenter(key, () => {}, metadata)` is called purely for its
 * validation side effect; the no-op callback runs no governed work and opens
 * no ALS scope any caller can observe.
 *
 * Every `tools`/`default` membership check against `envelopes` uses
 * `Object.hasOwn`, never the `in` operator: `in` also matches properties
 * inherited from `Object.prototype` (`toString`, `constructor`, …), which
 * would let an operator config accidentally — or an attacker deliberately —
 * route spend to a phantom "envelope" that was never declared.
 *
 * @throws Error — config-shaped, naming the offending field — on any
 * malformed shape.
 */
export function normalizeCostCenters(cc: unknown): FrozenCostCenters {
	if (cc === null || typeof cc !== "object" || Array.isArray(cc)) {
		throw new Error(
			`usertrust: costCenters must be an object, got ${cc === null ? "null" : typeof cc}`,
		);
	}
	const raw = cc as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (!KNOWN_COST_CENTERS_FIELDS.has(key)) {
			throw new Error(`usertrust: costCenters has an unknown field "${key}"`);
		}
	}

	if (typeof raw.parentUserId !== "string") {
		throw new Error("usertrust: costCenters.parentUserId is required and must be a string");
	}
	const parentRefusal = parentUserIdRefusal(raw.parentUserId);
	if (parentRefusal !== null) {
		throw new Error(`usertrust: costCenters.parentUserId ${parentRefusal}`);
	}

	if (raw.envelopes === null || typeof raw.envelopes !== "object" || Array.isArray(raw.envelopes)) {
		throw new Error("usertrust: costCenters.envelopes must be an object");
	}
	const rawEnvelopes = raw.envelopes as Record<string, unknown>;
	const envelopeKeys = Object.keys(rawEnvelopes);
	if (envelopeKeys.length > MAX_ENVELOPES) {
		throw new Error(
			`usertrust: costCenters.envelopes has ${envelopeKeys.length} entries, exceeds the ${MAX_ENVELOPES} cap`,
		);
	}

	const envelopes: Record<string, EnvelopeConfig> = {};
	for (const key of envelopeKeys) {
		const entry = rawEnvelopes[key];
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`usertrust: costCenters.envelopes["${key}"] must be an object`);
		}
		const e = entry as Record<string, unknown>;
		for (const field of Object.keys(e)) {
			if (!KNOWN_ENVELOPE_FIELDS.has(field)) {
				throw new Error(
					`usertrust: costCenters.envelopes["${key}"] has an unknown field "${field}"`,
				);
			}
		}
		const metadata = {
			allocated: e.allocated as number,
			periodStartMs: e.periodStartMs as number,
			...(e.periodEndMs !== undefined ? { periodEndMs: e.periodEndMs as number } : {}),
		};
		// Core's own charset + metadata validation door — reused, never
		// re-implemented (money-math/validation single-source). The no-op
		// callback means nothing governed actually runs; only the doors fire.
		withCostCenter(key, () => {}, metadata);
		envelopes[key] = metadata;
	}
	const frozenEnvelopes = Object.freeze(
		Object.fromEntries(Object.entries(envelopes).map(([k, v]) => [k, Object.freeze({ ...v })])),
	) as Readonly<Record<string, Readonly<EnvelopeConfig>>>;

	if (raw.tools === null || typeof raw.tools !== "object" || Array.isArray(raw.tools)) {
		throw new Error("usertrust: costCenters.tools must be an object");
	}
	const rawTools = raw.tools as Record<string, unknown>;
	const tools: Record<string, string> = {};
	for (const toolName of Object.keys(rawTools)) {
		const target = rawTools[toolName];
		if (typeof target !== "string" || !Object.hasOwn(frozenEnvelopes, target)) {
			throw new Error(
				`usertrust: costCenters.tools["${toolName}"] must name an envelopes key, got ${JSON.stringify(target)}`,
			);
		}
		tools[toolName] = target;
	}
	const frozenTools = Object.freeze({ ...tools });

	if (raw.default !== undefined) {
		if (typeof raw.default !== "string" || !Object.hasOwn(frozenEnvelopes, raw.default)) {
			throw new Error(
				`usertrust: costCenters.default must name an envelopes key, got ${JSON.stringify(raw.default)}`,
			);
		}
	}

	if (raw.scarcityContext !== undefined && typeof raw.scarcityContext !== "boolean") {
		throw new Error("usertrust: costCenters.scarcityContext must be a boolean");
	}

	return Object.freeze({
		parentUserId: raw.parentUserId,
		tools: frozenTools,
		...(raw.default !== undefined ? { default: raw.default as string } : {}),
		envelopes: frozenEnvelopes,
		scarcityContext: raw.scarcityContext === undefined ? true : (raw.scarcityContext as boolean),
	});
}

/**
 * Canonical-JSON fingerprint of the config that determines the module-
 * singleton governor's identity — key order never matters, so two
 * semantically identical configs written with different key orders
 * fingerprint the same.
 */
function fingerprintConfig(
	config: UsertrustPluginConfig,
	frozenCostCenters?: FrozenCostCenters,
): string {
	return JSON.stringify(sortKeysDeep({ ...config, costCenters: frozenCostCenters }));
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

function configMismatchError(): Error {
	return new Error(
		"usertrust: plugin already initialized with a DIFFERENT config — the governor is a " +
			"module-wide singleton (one process, one governor), so a second config would either " +
			"silently take over the first plugin instance's budget/parentUserId or be silently " +
			"ignored. Construct every plugin instance with the SAME config, or call shutdown() " +
			"before switching to a different one.",
	);
}

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
 *
 * `config.costCenters`, when present, is validated and normalized HERE — at
 * construction time, synchronously — via `normalizeCostCenters`, even though
 * governor init itself stays lazy. A malformed `costCenters` config throws
 * before this function returns, not on the plugin's first governed call.
 */
export function createUsertrustPlugin(config: UsertrustPluginConfig): ProviderPlugin {
	const frozenCostCenters =
		config.costCenters !== undefined ? normalizeCostCenters(config.costCenters) : undefined;
	const getGovernor = lazyGovernor(config, frozenCostCenters);

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
 *
 * `config.costCenters`, when present, is validated at call time via
 * `normalizeCostCenters` — the same construction-time door `createUsertrustPlugin`
 * uses, since this function is this API's entire "construction" step.
 */
export async function createGovernedStreamFn(
	streamFn: StreamFn,
	config: UsertrustPluginConfig,
): Promise<{ governedStreamFn: StreamFn; governor: Governor }> {
	const frozenCostCenters =
		config.costCenters !== undefined ? normalizeCostCenters(config.costCenters) : undefined;
	const gov = await initGovernor(config, frozenCostCenters);
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
		governorFingerprint = null;
	}
}

// ── Internal ──

/** Module-level promise to prevent concurrent initialization race. */
let initPromise: Promise<Governor> | null = null;

/**
 * Canonical-JSON fingerprint of whichever config CLAIMED the singleton
 * governor — set the moment an init starts, cleared on `shutdown()` and on a
 * failed init. See `initGovernor` for the three lifecycle legs.
 */
let governorFingerprint: string | null = null;

function initGovernor(
	config: UsertrustPluginConfig,
	frozenCostCenters?: FrozenCostCenters,
): Promise<Governor> {
	const fingerprint = fingerprintConfig(config, frozenCostCenters);

	if (governor != null) {
		// A governor already exists. Reuse it ONLY for the config that built
		// it — a second, DIFFERENT config must never silently take over an
		// already-governed budget/parentUserId (module-singleton governor).
		if (fingerprint !== governorFingerprint) {
			return Promise.reject(configMismatchError());
		}
		return Promise.resolve(governor);
	}

	if (initPromise != null) {
		// An init is already in flight. Same rule as above, but pre-resolution:
		// a DIFFERENT config racing against an in-flight init must not silently
		// piggyback on whichever governor happens to land first.
		if (fingerprint !== governorFingerprint) {
			return Promise.reject(configMismatchError());
		}
		return initPromise;
	}

	// CLAIM SYNCHRONOUSLY, before any await/microtask gap — this is what makes
	// two different configs racing in the same tick race-safe: the second call
	// sees `initPromise != null` (set below) and the fingerprint already
	// claimed, rather than both proceeding to build competing governors
	// (classic TOCTOU: two concurrent callers both observe `governor == null`).
	governorFingerprint = fingerprint;
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
						...(config.endpoint.baseURL !== undefined ? { baseURL: config.endpoint.baseURL } : {}),
					},
				}
			: {}),
		// Ship 2: the envelope account identity — validated + frozen by
		// `normalizeCostCenters` at construction time, never re-read off the
		// caller's raw (possibly since-mutated) `config.costCenters`.
		...(frozenCostCenters != null ? { parentUserId: frozenCostCenters.parentUserId } : {}),
	})
		.then((gov) => {
			governor = gov;
			return gov;
		})
		.catch((err: unknown) => {
			// Clear the claim so a retry — same config OR a different one — after
			// a failed init is accepted rather than permanently wedged on a
			// fingerprint no governor ever actually landed for.
			initPromise = null;
			governorFingerprint = null;
			throw err;
		});

	return initPromise;
}

function lazyGovernor(
	config: UsertrustPluginConfig,
	frozenCostCenters?: FrozenCostCenters,
): () => Promise<Governor> {
	let promise: Promise<Governor> | null = null;

	return () => {
		if (promise == null) {
			promise = initGovernor(config, frozenCostCenters);
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
