// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * types.ts — pinned OpenClaw / pi-ai contract mirrors
 *
 * The plugin must compile and ship without either host package installed at
 * runtime, so every host shape it touches is mirrored here. The mirrors are
 * NOT freehand: they are pinned to
 *
 *   - openclaw 2026.7.1-2         (plugin registration + the llm-core stream contract)
 *   - @mariozechner/pi-ai 0.73.1  (programmatic pi-ai callers)
 *
 * and `tests/contract.test-d.ts` type-asserts each one against the pinned
 * packages. Never hand-edit a mirror without re-running the gate:
 *
 *   npx tsc -p packages/openclaw/tsconfig.type-tests.json
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

/**
 * Per-call knobs. `maxTokens` and `temperature` live HERE, not on `Context` —
 * they are what the pre-call hold estimates against.
 */
export interface StreamOptions {
	temperature?: number;
	maxTokens?: number;
	stop?: string[];
	signal?: AbortSignal;
	apiKey?: string;
}

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

/** Configuration passed to the plugin from openclaw.json. */
export interface UsertrustPluginConfig {
	budget: number;
	tier?: "free" | "mini" | "pro" | "mega" | "ultra";
	dryRun?: boolean;
	configPath?: string;
	proxy?: string;
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
