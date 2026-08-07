// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Contract test — `src/types.ts` mirrors vs. the PINNED host packages.
 *
 * These are compile-time assertions. `tsc -b` never compiles this file (the
 * package tsconfig's `rootDir: "src"` excludes `tests/`), so the real gate is
 *
 *   npx tsc -p packages/openclaw/tsconfig.type-tests.json
 *
 * Pins:
 *   - openclaw 2026.7.1-2         — the host the plugin actually loads into
 *   - @mariozechner/pi-ai 0.73.1  — programmatic pi-ai callers
 *
 * Both are devDependencies, imported type-only: nothing here reaches runtime
 * and neither package is required to build or ship the plugin.
 *
 * Variance, and why each direction is asserted:
 *   - Events flow host → us, so the host's event union must be assignable to
 *     ours (`Extends<Host, Ours>`).
 *   - The wrap seam is bidirectional: openclaw hands us `ctx.streamFn` and
 *     takes our wrapped fn back, so `StreamFn` must be assignable BOTH ways.
 *   - Fields the money/attribution paths read by name are pinned with exact
 *     equality — a rename upstream has to fail this compile, not production.
 */

import type {
	AssistantMessage as PiAssistantMessage,
	Context as PiContext,
	AssistantMessageEvent as PiEvent,
	Message as PiMessage,
	Model as PiModel,
	StreamFunction as PiStreamFunction,
	ToolResultMessage as PiToolResult,
	Usage as PiUsage,
} from "@mariozechner/pi-ai";
import type {
	OpenClawPluginApi as OcPluginApi,
	OpenClawPluginDefinition as OcPluginDefinition,
	ProviderWrapStreamFnContext as OcWrapCtx,
} from "openclaw/plugin-sdk/core";
import type {
	AssistantMessage as OcAssistantMessage,
	Context as OcContext,
	AssistantMessageEvent as OcEvent,
	Message as OcMessage,
	Model as OcModel,
	StreamFunction as OcStreamFunction,
	ToolCall as OcToolCall,
	ToolResultMessage as OcToolResult,
	Usage as OcUsage,
} from "openclaw/plugin-sdk/llm";
import type { ProviderPlugin as OcProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import type {
	AssistantMessage,
	AssistantMessageEventStreamLike,
	Context,
	Message,
	Model,
	OpenClawPluginApi,
	ProviderPlugin,
	ProviderWrapStreamFnContext,
	StreamEvent,
	StreamFn,
	ToolResultMessage,
	Usage,
} from "../src/types.js";

type Assert<T extends true> = T;
type IsExact<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Extends<A, B> = A extends B ? true : false;

/** The stream fn openclaw hands in on `ctx.streamFn` and expects back. */
type OcStreamFn = NonNullable<OcWrapCtx["streamFn"]>;

// ── (2) tool-RESULT message: role, name field, correlation id, error flag ──

export type _ToolResultRoleIsToolResult = Assert<IsExact<ToolResultMessage["role"], "toolResult">>;
export type _OcToolResultRole = Assert<IsExact<OcToolResult["role"], "toolResult">>;
export type _PiToolResultRole = Assert<IsExact<PiToolResult["role"], "toolResult">>;

// The tool NAME lives on `toolName`, at the top level of the message.
export type _ToolNameIsString = Assert<IsExact<ToolResultMessage["toolName"], string>>;
export type _OcToolName = Assert<IsExact<OcToolResult["toolName"], string>>;
export type _PiToolName = Assert<IsExact<PiToolResult["toolName"], string>>;

// Correlation back to the preceding assistant turn's `ToolCall.id`.
export type _ToolCallIdIsString = Assert<IsExact<ToolResultMessage["toolCallId"], string>>;
export type _OcToolCallId = Assert<IsExact<OcToolResult["toolCallId"], string>>;
export type _PiToolCallId = Assert<IsExact<PiToolResult["toolCallId"], string>>;
export type _OcToolCallIdMatchesCallId = Assert<
	IsExact<OcToolCall["id"], OcToolResult["toolCallId"]>
>;

// `isError` is REQUIRED (not optional) on both hosts — excluded results are
// distinguishable without inspecting any text.
export type _IsErrorRequiredBoolean = Assert<IsExact<ToolResultMessage["isError"], boolean>>;
export type _OcIsErrorRequired = Assert<IsExact<OcToolResult["isError"], boolean>>;
export type _PiIsErrorRequired = Assert<IsExact<PiToolResult["isError"], boolean>>;

// Both hosts' tool results are accepted by the mirror.
export type _OcToolResultAssignable = Assert<Extends<OcToolResult, ToolResultMessage>>;
export type _PiToolResultAssignable = Assert<Extends<PiToolResult, ToolResultMessage>>;

// The message union has exactly three roles — there is no system-role message.
export type _MessageRoles = Assert<IsExact<Message["role"], "user" | "assistant" | "toolResult">>;
export type _OcMessageRoles = Assert<
	IsExact<OcMessage["role"], "user" | "assistant" | "toolResult">
>;
export type _PiMessageRoles = Assert<
	IsExact<PiMessage["role"], "user" | "assistant" | "toolResult">
>;
export type _OcMessagesAssignable = Assert<Extends<OcMessage, Message>>;
export type _PiMessagesAssignable = Assert<Extends<PiMessage, Message>>;

// ── (3) done / error terminal events and where usage lives ──

export type _EventTypes = Assert<IsExact<StreamEvent["type"], OcEvent["type"]>>;
export type _PiEventTypes = Assert<IsExact<StreamEvent["type"], PiEvent["type"]>>;

// The terminal discriminant is `reason`, not `stopReason`.
export type _DoneReason = Assert<
	IsExact<Extract<StreamEvent, { type: "done" }>["reason"], "stop" | "length" | "toolUse">
>;
export type _OcDoneReason = Assert<
	IsExact<Extract<OcEvent, { type: "done" }>["reason"], "stop" | "length" | "toolUse">
>;
export type _PiDoneReason = Assert<
	IsExact<Extract<PiEvent, { type: "done" }>["reason"], "stop" | "length" | "toolUse">
>;
export type _ErrorReason = Assert<
	IsExact<Extract<StreamEvent, { type: "error" }>["reason"], "aborted" | "error">
>;
export type _OcErrorReason = Assert<
	IsExact<Extract<OcEvent, { type: "error" }>["reason"], "aborted" | "error">
>;

// Usage is nested on the terminal assistant message, NOT on the event.
export type _DoneCarriesMessage = Assert<
	IsExact<Extract<OcEvent, { type: "done" }>["message"], OcAssistantMessage>
>;
export type _PiDoneCarriesMessage = Assert<
	IsExact<Extract<PiEvent, { type: "done" }>["message"], PiAssistantMessage>
>;
export type _ErrorCarriesMessage = Assert<
	IsExact<Extract<OcEvent, { type: "error" }>["error"], OcAssistantMessage>
>;
export type _OcUsageOnMessage = Assert<IsExact<OcAssistantMessage["usage"], OcUsage>>;
export type _PiUsageOnMessage = Assert<IsExact<PiAssistantMessage["usage"], PiUsage>>;

// Token counts are `input`/`output`, not `inputTokens`/`outputTokens`.
export type _UsageInput = Assert<IsExact<Usage["input"], number>>;
export type _UsageOutput = Assert<IsExact<Usage["output"], number>>;
export type _OcUsageFields = Assert<Extends<OcUsage, Usage>>;
export type _PiUsageFields = Assert<Extends<PiUsage, Usage>>;

// Whole-union acceptance: either host's events flow through the mirror.
export type _OcEventsAssignable = Assert<Extends<OcEvent, StreamEvent>>;
export type _PiEventsAssignable = Assert<Extends<PiEvent, StreamEvent>>;

// ── (4) system-prompt surface ──

// `Context.systemPrompt` is the delivery surface; injection has nowhere else
// to go because `Message` carries no system role (asserted above).
export type _SystemPromptIsOptionalString = Assert<
	IsExact<Context["systemPrompt"], string | undefined>
>;
export type _OcSystemPrompt = Assert<IsExact<OcContext["systemPrompt"], string | undefined>>;
export type _PiSystemPrompt = Assert<IsExact<PiContext["systemPrompt"], string | undefined>>;
export type _OcContextAccepted = Assert<Extends<OcContext, Context>>;
export type _PiContextAccepted = Assert<Extends<PiContext, Context>>;
export type _ContextForwardable = Assert<Extends<Context, OcContext>>;

// ── (5) `model` is an OBJECT at the wrapper boundary, not a string ──

export type _ModelIsNotString = Assert<IsExact<Extends<OcStreamFn, (m: string) => unknown>, false>>;
export type _ModelIdIsString = Assert<IsExact<Model["id"], string>>;
export type _OcModelIdIsString = Assert<IsExact<OcModel["id"], string>>;
export type _PiModelIdIsString = Assert<IsExact<PiModel<"anthropic-messages">["id"], string>>;
export type _OcModelAccepted = Assert<Extends<OcModel, Model>>;
export type _ModelForwardable = Assert<Extends<Model, OcModel>>;

// ── stream surface: richer than AsyncIterable ──

// A bare async iterable is NOT a valid return at this boundary — `result()`
// has to be forwarded too, which is why the wrapper is a proxy.
export type _BareIterableIsInsufficient = Assert<
	IsExact<Extends<AsyncIterable<StreamEvent>, AssistantMessageEventStreamLike>, false>
>;
export type _StreamResultIsFinalMessage = Assert<
	IsExact<ReturnType<AssistantMessageEventStreamLike["result"]>, Promise<AssistantMessage>>
>;

// The wrap seam is bidirectional: we accept openclaw's `ctx.streamFn` and
// openclaw accepts what we hand back.
export type _HostStreamFnAccepted = Assert<Extends<OcStreamFn, StreamFn>>;
export type _OurStreamFnReturnable = Assert<Extends<StreamFn, OcStreamFn>>;

// pi-ai's `StreamFunction` is the synchronous-return variant of the same shape.
export type _PiStreamFunctionAccepted = Assert<Extends<PiStreamFunction, StreamFn>>;
export type _OcStreamFunctionAccepted = Assert<Extends<OcStreamFunction, StreamFn>>;

// ── plugin registration + config delivery ──

// `register(api)` — the bare-function plugin module form is still supported.
export type _RegisterIsPluginModule = Assert<
	Extends<(api: OcPluginApi) => void, NonNullable<OcPluginDefinition["register"]>>
>;

// Config arrives on the api object, not as a hook argument.
export type _PluginConfigOnApi = Assert<
	IsExact<OpenClawPluginApi["pluginConfig"], Record<string, unknown> | undefined>
>;
export type _OcPluginConfigOnApi = Assert<
	IsExact<OcPluginApi["pluginConfig"], Record<string, unknown> | undefined>
>;
export type _OcApiAccepted = Assert<Extends<OcPluginApi, OpenClawPluginApi>>;

// `wrapStreamFn` takes ONE context argument carrying the inner stream fn.
export type _WrapCtxCarriesStreamFn = Assert<Extends<OcWrapCtx, ProviderWrapStreamFnContext>>;
export type _WrapHookArity = Assert<
	IsExact<Parameters<NonNullable<OcProviderPlugin["wrapStreamFn"]>>["length"], 1>
>;

// Our ProviderPlugin is a valid openclaw provider registration.
export type _ProviderPluginRegistrable = Assert<Extends<ProviderPlugin, OcProviderPlugin>>;
