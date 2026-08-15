// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * types.ts — pinned OpenClaw / pi-ai contract mirrors
 *
 * The plugin must compile and ship without either host package installed at
 * runtime, so every host shape it touches is mirrored here. The mirrors are
 * NOT freehand: they are type-asserted against the pinned host packages, in
 * two halves, because only one of the two is ever installed.
 *
 *   - @mariozechner/pi-ai (exact devDependency; programmatic pi-ai callers)
 *     `tests/contract.test-d.ts`, compiled on EVERY push by
 *       npx tsc -p packages/openclaw/tsconfig.type-tests.json
 *     which `npm run typecheck` runs.
 *
 *   - openclaw (optional peer, NOT installed by `npm ci`; plugin registration
 *     plus the llm-core stream contract). Version pinned in exactly one place,
 *     `openclaw-contract.env`. `tests/contract-openclaw.test-d.ts`, compiled by
 *     the `openclaw-contract` CI job after an out-of-tree install:
 *       npx tsc -p packages/openclaw/tsconfig.contract-openclaw.json
 *
 * Never hand-edit a mirror without re-running BOTH.
 *
 * Where the two hosts differ, the mirror carries the shape that is assignable
 * in BOTH directions at the wrap seam (openclaw hands us a stream fn and takes
 * ours back), and widens optionality so either host's events are accepted.
 */

import type { EndpointClass, LocalRuntime } from "usertrust";

// ── llm-core content blocks ──

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
	executionMode?: "sequential" | "parallel";
}

// ── llm-core messages ──

/** Normalized per-response token + cost accounting reported by the host. */
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
	runtimeContextCarrier?: boolean;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: string;
	provider: string;
	model: string;
	responseModel?: string;
	responseId?: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

/**
 * Host-inserted result of a previously executed tool call.
 *
 * This is the ONLY structured evidence the plugin has that a tool actually
 * ran: `toolName` carries the name, `toolCallId` correlates back to the
 * `ToolCall.id` on the preceding assistant message, and `isError` marks
 * results the host produced without a real execution.
 */
export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/**
 * TypeBox `TSchema` at the pinned boundary.
 *
 * The plugin never inspects tool parameter schemas, and mirroring TypeBox's
 * symbol-keyed `TSchema` would drag a typebox dependency into a package that
 * has to compile without one — so the schema stays deliberately opaque, and
 * `any` keeps it assignable in both directions at the wrap seam.
 */
// biome-ignore lint/suspicious/noExplicitAny: opaque passthrough of TypeBox TSchema — see above.
export type ToolParameterSchema = any;

export interface Tool {
	name: string;
	description: string;
	parameters: ToolParameterSchema;
}

/**
 * The request context the host hands to a stream function.
 *
 * `systemPrompt` is the host's system-prompt surface — there is NO system-role
 * message in the pinned contract (`Message` has exactly three roles).
 */
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

/** Legacy alias kept for the package's published type surface. */
export type StreamContext = Context;

// ── llm-core stream events ──

export interface StartEvent {
	type: "start";
	partial: AssistantMessage;
}

export interface TextStartEvent {
	type: "text_start";
	contentIndex: number;
	partial: AssistantMessage;
}

/**
 * `partial` is REQUIRED by pi-ai and OPTIONAL by openclaw (which drops it on
 * plain text deltas to avoid retaining a full assistant snapshot per token),
 * so the mirror takes the optional form and accepts both.
 */
export interface TextDeltaEvent {
	type: "text_delta";
	contentIndex: number;
	delta: string;
	partial?: AssistantMessage;
}

export interface TextEndEvent {
	type: "text_end";
	contentIndex: number;
	content: string;
	partial: AssistantMessage;
}

export interface ThinkingStartEvent {
	type: "thinking_start";
	contentIndex: number;
	partial: AssistantMessage;
}

export interface ThinkingDeltaEvent {
	type: "thinking_delta";
	contentIndex: number;
	delta: string;
	partial: AssistantMessage;
}

export interface ThinkingEndEvent {
	type: "thinking_end";
	contentIndex: number;
	content: string;
	partial: AssistantMessage;
}

export interface ToolCallStartEvent {
	type: "toolcall_start";
	contentIndex: number;
	partial: AssistantMessage;
}

export interface ToolCallDeltaEvent {
	type: "toolcall_delta";
	contentIndex: number;
	delta: string;
	partial: AssistantMessage;
}

export interface ToolCallEndEvent {
	type: "toolcall_end";
	contentIndex: number;
	toolCall: ToolCall;
	partial: AssistantMessage;
}

/** Terminal success event. Token usage lives on `message.usage`. */
export interface DoneEvent {
	type: "done";
	reason: Extract<StopReason, "stop" | "length" | "toolUse">;
	message: AssistantMessage;
}

/** Terminal failure event. Token usage lives on `error.usage`. */
export interface ErrorEvent {
	type: "error";
	reason: Extract<StopReason, "aborted" | "error">;
	error: AssistantMessage;
}

export type StreamEvent =
	| StartEvent
	| TextStartEvent
	| TextDeltaEvent
	| TextEndEvent
	| ThinkingStartEvent
	| ThinkingDeltaEvent
	| ThinkingEndEvent
	| ToolCallStartEvent
	| ToolCallDeltaEvent
	| ToolCallEndEvent
	| DoneEvent
	| ErrorEvent;

/**
 * The stream surface returned at the plugin boundary.
 *
 * NOT a bare `AsyncIterable` — the host also calls `result()` for the final
 * assistant message, so any wrapper has to forward that too.
 */
export interface AssistantMessageEventStreamLike extends AsyncIterable<StreamEvent> {
	result(): Promise<AssistantMessage>;
}

// ── llm-core model + options ──

export interface Model {
	id: string;
	name: string;
	api: string;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
}

/** Preferred wire transport for providers that support more than one. */
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

/** Prompt-cache retention preference; providers map it to their own values. */
export type CacheRetention = "none" | "short" | "long";

/** The HTTP response summary `StreamOptions.onResponse` is handed. */
export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

/**
 * Per-call knobs. `maxTokens` and `temperature` live HERE, not on `Context` —
 * they are what the pre-call hold estimates against.
 *
 * This mirrors the pinned host's `StreamOptions` FIELD FOR FIELD
 * (`openclaw/dist/types-CFIUY_La.d.ts:50-119`,
 * `pi-ai/dist/types.d.ts:24-85`), and that completeness is load-bearing rather
 * than tidiness. A field the host declares and the mirror drops is not an
 * assignability failure — extra optional properties never break assignability
 * in either direction — so nothing about the wrap seam complains. What breaks
 * is the EXCESS-PROPERTY check on a caller's object literal: with `headers`
 * missing here, `governed(model, ctx, { headers })` stops compiling for a
 * caller passing something the host has always supported, and their only way
 * out is a cast. The contract tests therefore assert this surface with VALUES,
 * not just `Extends`, because a type-level assertion cannot see it.
 *
 * `signal` is the one field with governance meaning: when it fires, the pinned
 * providers end the stream with `{ type: "error", reason: "aborted" }` carrying
 * the partial usage, which `stream-governor.ts` SETTLES rather than voids.
 */
export interface StreamOptions {
	temperature?: number;
	maxTokens?: number;
	/** Stop sequences, mapped to each provider's native field. openclaw only. */
	stop?: string[];
	signal?: AbortSignal;
	apiKey?: string;
	transport?: Transport;
	cacheRetention?: CacheRetention;
	sessionId?: string;
	/** Cache-affinity key distinct from session identity. openclaw only. */
	promptCacheKey?: string;
	/** Inspect or replace the provider payload before it is sent. */
	onPayload?: (payload: unknown, model: Model) => unknown | Promise<unknown>;
	/** Fires after the HTTP response arrives, before its body is consumed. */
	onResponse?: (response: ProviderResponse, model: Model) => void | Promise<void>;
	/** Extra HTTP headers, merged with (and able to override) provider defaults. */
	headers?: Record<string, string>;
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	/** Provider-extracted request metadata (Anthropic reads `user_id`, …). */
	metadata?: Record<string, unknown>;
}

/**
 * The OPEN options bag, mirroring the host's own alias
 * (`openclaw/dist/types-CFIUY_La.d.ts:123`, `pi-ai/dist/types.d.ts:86`):
 *
 *     type ProviderStreamOptions = StreamOptions & Record<string, unknown>;
 *
 * Not decoration. The pinned agent loop spreads its WHOLE config into the bag
 * it hands a stream fn — `streamFunction(config.model, llmContext, { ...config,
 * apiKey, signal })` (`openclaw/dist/proxy-BzhBz8iM.js:356-360`) — so the value
 * that actually arrives at runtime always carries keys no interface declares.
 * Callers with provider-specific knobs (including `reasoning` /
 * `thinkingBudgets`, whose enums differ between the two hosts and so are not
 * mirrored — contract-notes §7) type their literal as this.
 */
export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

/**
 * The stream function shape on both sides of the wrap seam: the host hands one
 * in and takes one back, so the mirror has to be assignable in both directions.
 */
export type StreamFn = (
	model: Model,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStreamLike | Promise<AssistantMessageEventStreamLike>;

// ── usertrust-owned types ──

/**
 * usertrust's normalized usage shape — NOT a host mirror.
 *
 * `token-extractor.ts` duck-types raw provider chunks (Anthropic, OpenAI,
 * Gemini, Ollama) as well as host `StreamEvent`s into this one shape.
 */
export interface StreamUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

/** Receipt attached to governed stream events. */
export interface GovernedStreamMeta {
	transferId: string;
	estimatedCost: number;
	model: string;
}

/**
 * One operator-declared spending envelope within `costCenters.envelopes`.
 * Mirrors core's `EnvelopeDescriptor` minus `costCenter` (the envelope's key
 * in the map already carries that).
 */
export interface EnvelopeConfig {
	allocated: number;
	periodStartMs: number;
	periodEndMs?: number;
}

/**
 * Operator-declared tool→cost-center attribution config (spec shape, as
 * written in openclaw.json — unvalidated). Lives on
 * `UsertrustPluginConfig.costCenters`; `normalizeCostCenters` (index.ts)
 * validates it against core's canonical doors and returns the deep-frozen
 * {@link FrozenCostCenters} every wrapper actually reads.
 *
 * SECURITY: `tools` values and `default` are the ONLY strings that ever reach
 * `withCostCenter` (see the design's attribution security model) — both are
 * OPERATOR config, never request content, so no agent-controlled text can
 * author or relabel a cost center.
 */
export interface CostCentersConfig {
	/** → `GovernorOpts.parentUserId`. Required — the envelope account identity. */
	parentUserId: string;
	/** toolName → costCenter. Every value must be an `envelopes` key. */
	tools: Record<string, string>;
	/** Fallback cost center for unmapped/no tool-result runs. Must be an `envelopes` key. */
	default?: string;
	envelopes: Record<string, EnvelopeConfig>;
	/** Inject the per-turn scarcity block. Default `true` when `costCenters` is present. */
	scarcityContext?: boolean;
}

/**
 * The validated, normalized, deep-frozen form of {@link CostCentersConfig} —
 * the ONLY shape any wrapper may read. Producing it is `normalizeCostCenters`'s
 * entire job: a caller's later mutation of the raw object it built config from
 * can never change routing, because nothing downstream holds a reference to
 * that raw object. `scarcityContext` is normalized to its default (`true`) so
 * no reader re-derives the default-when-absent rule.
 */
export type FrozenCostCenters = Readonly<{
	parentUserId: string;
	tools: Readonly<Record<string, string>>;
	default?: string;
	envelopes: Readonly<Record<string, Readonly<EnvelopeConfig>>>;
	scarcityContext: boolean;
}>;

/** Configuration passed to the plugin from openclaw.json. */
export interface UsertrustPluginConfig {
	budget: number;
	tier?: "free" | "mini" | "pro" | "mega" | "ultra";
	dryRun?: boolean;
	configPath?: string;
	/**
	 * @deprecated AUD-456: Remote proxy mode is not implemented. Forwarded to
	 * `createGovernor({ proxy })`, which throws. Use a local TigerBeetle or
	 * `dryRun` for enforcement.
	 */
	proxy?: string;
	/**
	 * @deprecated AUD-456: Proxy API key. Unused — `proxy` throws first.
	 */
	proxyKey?: string;
	/** Vault directory (audit chain, spend ledger). Defaults to cwd. */
	vaultBase?: string;
	/**
	 * Explicit endpoint scope for this OpenClaw runtime (M2). TRUSTED-OPERATOR
	 * declaration: the headless/OpenClaw path has no client baseURL to sniff, so
	 * core's config.endpoints[] URL matchers do NOT apply here (design decision 6)
	 * — declare `{ class: "local" }` yourself or every call meters as cloud
	 * (frontier fallback pricing for local models + strict cloud anomaly thresholds).
	 */
	endpoint?: {
		class: EndpointClass;
		runtime?: LocalRuntime;
		baseURL?: string;
	};
	/**
	 * Operator-declared tool→cost-center attribution + per-turn scarcity
	 * injection (Ship 2). Absent → no attribution, no scarcity block, byte-
	 * identical behavior to before this config existed. Validated + normalized
	 * by `normalizeCostCenters` at plugin CONSTRUCTION time, never lazily.
	 */
	costCenters?: CostCentersConfig;
	/**
	 * ProviderPlugin.id. Defaults to `"usertrust"` so existing registrations
	 * keep matching. Override only if you need the plugin itself to BE a
	 * different provider id; attaching the wrapper to live providers is
	 * `aliases`, not this.
	 */
	id?: string;
	/**
	 * Provider ids whose `wrapStreamFn` this plugin should attach to.
	 *
	 * OpenClaw resolves the hook by matching the call's provider id against
	 * this plugin's `id`/`aliases` — there is no host-wide wrap. Absent → the
	 * default list (`anthropic`, `openai`, `google`): those are the
	 * `Model.provider` values live OpenClaw/pi-ai calls actually use.
	 * `openai-completions` / `openai-responses` are API transports
	 * (`model.api`), not provider ids; aliasing them still wraps nothing.
	 * Pass `[]` to wrap only calls routed to `id`.
	 */
	aliases?: string[];
}

// ── OpenClaw plugin registration ──

/**
 * The subset of openclaw's `OpenClawPluginApi` this plugin uses.
 *
 * Config is delivered on the api object as `pluginConfig` at register() time —
 * it is NOT a second argument to any hook.
 */
export interface OpenClawPluginApi {
	id: string;
	name: string;
	pluginConfig?: Record<string, unknown>;
	registerProvider(provider: ProviderPlugin): void;
}

/**
 * Context handed to `ProviderPlugin.wrapStreamFn`.
 *
 * The hook takes ONE argument and reads the inner stream fn off it; it does
 * not receive `(next, config)`.
 */
export interface ProviderWrapStreamFnContext {
	provider: string;
	modelId: string;
	streamFn?: StreamFn;
}

/**
 * The text-inference provider capability openclaw's loader expects.
 *
 * `auth` is REQUIRED upstream, and the hook is provider-scoped: openclaw
 * resolves it by matching the call's provider id against this plugin's `id`
 * and aliases, so it fires only for calls routed to this provider.
 */
/**
 * An entry in openclaw's `ProviderPlugin.auth` array.
 *
 * usertrust governs someone else's provider credentials and declares none of
 * its own, so the mirror keeps the shape opaque rather than reproducing
 * openclaw's wizard/auth-method surface.
 */
// biome-ignore lint/suspicious/noExplicitAny: opaque passthrough of openclaw's ProviderAuthMethod.
export type ProviderAuthMethod = any;

export interface ProviderPlugin {
	id: string;
	label: string;
	auth: ProviderAuthMethod[];
	aliases?: string[];
	/** Middleware: reads `ctx.streamFn` and returns a wrapped one. */
	wrapStreamFn?: (ctx: ProviderWrapStreamFnContext) => StreamFn | null | undefined;
	/** Optional: provide a fully custom stream fn. We do not use this. */
	createStreamFn?: (ctx: unknown) => StreamFn | null | undefined;
}
