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

import type { Governor, TrustOpts } from "usertrust";
import { createGovernor, parentUserIdRefusal, withCostCenter } from "usertrust";
import { fingerprintConfig } from "./fingerprint.js";
import type { GovernanceOptions } from "./stream-governor.js";
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
export { deriveAttribution } from "./attribution.js";
export type { GovernanceOptions } from "./stream-governor.js";
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
	CacheRetention,
	Context,
	CostCentersConfig,
	EnvelopeConfig,
	FrozenCostCenters,
	GovernedStreamMeta,
	Message,
	Model,
	ProviderPlugin,
	ProviderResponse,
	// The OPEN options bag. `package.json` publishes exactly ONE export subpath
	// (`.` → `dist/index.js`), so a name missing from this list is unreachable
	// for every consumer — `src/types.js` is not importable from outside. That
	// made the documented escape hatch for provider-specific knobs
	// (`reasoning` / `thinkingBudgets`, which cannot be named on `StreamOptions`
	// because the two hosts' thinking enums disagree) a dead reference.
	ProviderStreamOptions,
	ProviderWrapStreamFnContext,
	StreamContext,
	StreamEvent,
	StreamFn,
	StreamOptions,
	StreamUsage,
	ToolResultMessage,
	Transport,
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
 * An empty string-keyed map with NO prototype — the only kind safe to build by
 * assignment from operator-supplied keys. See `normalizeCostCenters`'s doc for
 * why (`__proto__` is a legal key on both maps, and a plain object silently
 * eats it). Membership is still read with `Object.hasOwn`, which works
 * identically on a null-prototype object.
 */
function emptyMap<T>(): Record<string, T> {
	return Object.create(null) as Record<string, T>;
}

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
 * And every map this builds is NULL-PROTOTYPE ({@link emptyMap}), which is the
 * WRITE-side half of that same rule. `__proto__` is a legal cost-center string
 * (core's `COST_CENTER_PATTERN` is `/^[a-zA-Z0-9._-]{1,64}$/`), a legal tool
 * name, and a genuine own property when it arrives via `JSON.parse`. Assigning
 * it into an ordinary object invokes `Object.prototype`'s `__proto__` SETTER
 * instead of creating the key: a string value is silently discarded, and an
 * object value silently re-points the map's prototype. Either way the entry
 * disappears with no error, attribution falls through to `default`, and a
 * correlated call debits the wrong envelope. A null-prototype map has no such
 * setter to inherit, so the assignment creates the own key it looks like it
 * creates.
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

	const envelopes = emptyMap<EnvelopeConfig>();
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
	// Built by assignment into a null-prototype map, NOT `Object.fromEntries`:
	// the result is read back with `Object.hasOwn` and indexed by operator-
	// supplied keys, so it has to stay free of an inherited `__proto__` accessor
	// for exactly the reason the source map does.
	const envelopeCopies = emptyMap<Readonly<EnvelopeConfig>>();
	for (const [k, v] of Object.entries(envelopes)) {
		envelopeCopies[k] = Object.freeze({ ...v });
	}
	const frozenEnvelopes = Object.freeze(envelopeCopies) as Readonly<
		Record<string, Readonly<EnvelopeConfig>>
	>;

	if (raw.tools === null || typeof raw.tools !== "object" || Array.isArray(raw.tools)) {
		throw new Error("usertrust: costCenters.tools must be an object");
	}
	const rawTools = raw.tools as Record<string, unknown>;
	const tools = emptyMap<string>();
	for (const toolName of Object.keys(rawTools)) {
		const target = rawTools[toolName];
		if (typeof target !== "string" || !Object.hasOwn(frozenEnvelopes, target)) {
			throw new Error(
				`usertrust: costCenters.tools["${toolName}"] must name an envelopes key, got ${JSON.stringify(target)}`,
			);
		}
		tools[toolName] = target;
	}
	// `Object.freeze(tools)`, never `Object.freeze({ ...tools })`: spreading into
	// an object LITERAL would hand the frozen map back an `Object.prototype`, and
	// with it the `__proto__` accessor this whole map was built to avoid. Nothing
	// mutates `tools` after this point, so there is no copy to make.
	const frozenTools = Object.freeze(tools);

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
				governedStreamLazy(getGovernor, next, model, context, options, {
					costCenters: frozenCostCenters,
				});
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
	options?: GovernedStreamFnOptions,
): Promise<{ governedStreamFn: StreamFn; governor: Governor }> {
	const frozenCostCenters =
		config.costCenters !== undefined ? normalizeCostCenters(config.costCenters) : undefined;
	const gov = await initGovernor(config, frozenCostCenters, options?.engine);
	// This path builds its OWN wrapper rather than going through
	// `createUsertrustPlugin`, so it needs the same opts bag explicitly —
	// otherwise the programmatic entry point would silently ignore a
	// `costCenters` config it just finished validating.
	const governedStreamFn = wrapStreamWithGovernance(streamFn, gov, {
		costCenters: frozenCostCenters,
		...(options?.onReceipt !== undefined ? { onReceipt: options.onReceipt } : {}),
	});
	return { governedStreamFn, governor: gov };
}

/**
 * Non-JSON options for {@link createGovernedStreamFn} — everything a programmatic
 * caller can hand the wrapper that could never come from `openclaw.json`.
 *
 * They are a SEPARATE argument rather than fields on `UsertrustPluginConfig` for
 * three reasons: `openclaw.plugin.json` declares the config
 * `additionalProperties: false`, so a function-valued key there would be refused
 * by the manifest the plugin path is validated against; the config is
 * canonical-JSON fingerprinted to decide governor identity, and `JSON.stringify`
 * flattens every function to nothing (two distinct engines would fingerprint
 * identically); and the plugin path — the one an operator configures — must keep
 * exactly the surface the manifest describes.
 */
export interface GovernedStreamFnOptions {
	/**
	 * Fires with the `TrustReceipt` after each successful `settle()`. Forwarded
	 * verbatim to {@link GovernanceOptions.onReceipt}, including its isolation
	 * and fire-and-forget guarantees.
	 */
	onReceipt?: GovernanceOptions["onReceipt"];
	/**
	 * TEST/ADVANCED: the `TrustEngine` the governor spends through, instead of a
	 * TigerBeetle client — core's own `GovernorOpts._engine`, forwarded. This is
	 * how a test drives the real attribution path (envelope holds, receipt budget
	 * snapshots, `budgetContext` reads) with no cluster, the same seam core's
	 * headless tests use.
	 *
	 * NOT a governance bypass: core accepts an injected engine only under
	 * `USERTRUST_TEST=1` / `NODE_ENV=test` (AUD-470) and ignores it in production,
	 * so passing one from shipped code buys nothing.
	 *
	 * It deliberately does NOT participate in the governor fingerprint — the
	 * governor is a module singleton, so the FIRST caller's engine is the one the
	 * process uses; a later call with the same config reuses that governor, engine
	 * included. Call `shutdown()` between engines.
	 */
	engine?: TrustOpts["_engine"];
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
 * {@link fingerprintConfig} digest of whichever config CLAIMED the singleton
 * governor — set the moment an init starts, cleared on `shutdown()` and on a
 * failed init. See `initGovernor` for the three lifecycle legs.
 *
 * A DIGEST, not the config JSON, because this variable outlives the call that
 * set it by the whole process lifetime and the JSON contains `proxyKey`. See
 * `fingerprint.ts`.
 */
let governorFingerprint: string | null = null;

function initGovernor(
	config: UsertrustPluginConfig,
	frozenCostCenters?: FrozenCostCenters,
	engine?: TrustOpts["_engine"],
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
		// TEST/ADVANCED seam (`GovernedStreamFnOptions.engine`). Core honours it
		// only in a test environment; everywhere else it is ignored, so this
		// spread cannot weaken a shipped governor. `null` is a MEANINGFUL value
		// there ("no engine"), so the key is forwarded whenever it was given.
		...(engine !== undefined ? { _engine: engine } : {}),
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
	options: StreamOptions | undefined,
	opts: GovernanceOptions,
): AssistantMessageEventStreamLike {
	const inner = getGovernor().then((gov) =>
		wrapStreamWithGovernance(streamFn, gov, opts)(model, context, options),
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
