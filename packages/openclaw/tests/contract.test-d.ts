// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Contract test — `src/types.ts` mirrors vs. the PINNED `@mariozechner/pi-ai`,
 * plus every assertion that reads only our own mirror.
 *
 * These are compile-time assertions. `tsc -b` never compiles this file (the
 * package tsconfig's `rootDir: "src"` excludes `tests/`), so the real gate is
 *
 *   npx tsc -p packages/openclaw/tsconfig.type-tests.json
 *
 * which `npm run typecheck` runs — meaning this file compiles on EVERY push.
 *
 * Pin: `@mariozechner/pi-ai` 0.73.1 — the surface programmatic pi-ai callers
 * hand the wrapper. An exact devDependency, imported type-only: nothing here
 * reaches runtime and the package is not required to build or ship the plugin.
 *
 * The **openclaw** half of the same contract lives in
 * `contract-openclaw.test-d.ts`, compiled by the `openclaw-contract` CI job
 * after an out-of-tree install of the pinned host. openclaw is not a
 * devDependency (see `../openclaw-contract.env`), and `tsc` cannot conditionally
 * include a file, so the split is two projects rather than one. Every assertion
 * runs in CI; they just run in two different jobs.
 *
 * Variance, and why each direction is asserted:
 *   - Events flow host → us, so the host's event union must be assignable to
 *     ours (`Extends<Host, Ours>`).
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
	AssistantMessage,
	AssistantMessageEventStreamLike,
	Context,
	Message,
	Model,
	OpenClawPluginApi,
	StreamEvent,
	StreamFn,
	ToolResultMessage,
	Usage,
} from "../src/types.js";

type Assert<T extends true> = T;
type IsExact<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Extends<A, B> = A extends B ? true : false;

// ── (2) tool-RESULT message: role, name field, correlation id, error flag ──

export type _ToolResultRoleIsToolResult = Assert<IsExact<ToolResultMessage["role"], "toolResult">>;
export type _PiToolResultRole = Assert<IsExact<PiToolResult["role"], "toolResult">>;

// The tool NAME lives on `toolName`, at the top level of the message.
export type _ToolNameIsString = Assert<IsExact<ToolResultMessage["toolName"], string>>;
export type _PiToolName = Assert<IsExact<PiToolResult["toolName"], string>>;

// Correlation back to the preceding assistant turn's `ToolCall.id`.
export type _ToolCallIdIsString = Assert<IsExact<ToolResultMessage["toolCallId"], string>>;
export type _PiToolCallId = Assert<IsExact<PiToolResult["toolCallId"], string>>;

// `isError` is REQUIRED (not optional) on both hosts — excluded results are
// distinguishable without inspecting any text.
export type _IsErrorRequiredBoolean = Assert<IsExact<ToolResultMessage["isError"], boolean>>;
export type _PiIsErrorRequired = Assert<IsExact<PiToolResult["isError"], boolean>>;

// pi-ai's tool results are accepted by the mirror.
export type _PiToolResultAssignable = Assert<Extends<PiToolResult, ToolResultMessage>>;

// The message union has exactly three roles — there is no system-role message.
export type _MessageRoles = Assert<IsExact<Message["role"], "user" | "assistant" | "toolResult">>;
export type _PiMessageRoles = Assert<
	IsExact<PiMessage["role"], "user" | "assistant" | "toolResult">
>;
export type _PiMessagesAssignable = Assert<Extends<PiMessage, Message>>;

// ── (3) done / error terminal events and where usage lives ──

export type _PiEventTypes = Assert<IsExact<StreamEvent["type"], PiEvent["type"]>>;

// The terminal discriminant is `reason`, not `stopReason`.
export type _DoneReason = Assert<
	IsExact<Extract<StreamEvent, { type: "done" }>["reason"], "stop" | "length" | "toolUse">
>;
export type _PiDoneReason = Assert<
	IsExact<Extract<PiEvent, { type: "done" }>["reason"], "stop" | "length" | "toolUse">
>;
export type _ErrorReason = Assert<
	IsExact<Extract<StreamEvent, { type: "error" }>["reason"], "aborted" | "error">
>;

// Usage is nested on the terminal assistant message, NOT on the event.
export type _PiDoneCarriesMessage = Assert<
	IsExact<Extract<PiEvent, { type: "done" }>["message"], PiAssistantMessage>
>;
export type _PiUsageOnMessage = Assert<IsExact<PiAssistantMessage["usage"], PiUsage>>;

// Token counts are `input`/`output`, not `inputTokens`/`outputTokens`.
export type _UsageInput = Assert<IsExact<Usage["input"], number>>;
export type _UsageOutput = Assert<IsExact<Usage["output"], number>>;
export type _PiUsageFields = Assert<Extends<PiUsage, Usage>>;

// Whole-union acceptance: pi-ai's events flow through the mirror.
export type _PiEventsAssignable = Assert<Extends<PiEvent, StreamEvent>>;

// ── (4) system-prompt surface ──

// `Context.systemPrompt` is the delivery surface; injection has nowhere else
// to go because `Message` carries no system role (asserted above).
export type _SystemPromptIsOptionalString = Assert<
	IsExact<Context["systemPrompt"], string | undefined>
>;
export type _PiSystemPrompt = Assert<IsExact<PiContext["systemPrompt"], string | undefined>>;
export type _PiContextAccepted = Assert<Extends<PiContext, Context>>;

// ── (5) `model` is an OBJECT at the wrapper boundary, not a string ──

export type _ModelIdIsString = Assert<IsExact<Model["id"], string>>;
export type _PiModelIdIsString = Assert<IsExact<PiModel<"anthropic-messages">["id"], string>>;

// ── stream surface: richer than AsyncIterable ──

// A bare async iterable is NOT a valid return at this boundary — `result()`
// has to be forwarded too, which is why the wrapper is a proxy.
export type _BareIterableIsInsufficient = Assert<
	IsExact<Extends<AsyncIterable<StreamEvent>, AssistantMessageEventStreamLike>, false>
>;
export type _StreamResultIsFinalMessage = Assert<
	IsExact<ReturnType<AssistantMessageEventStreamLike["result"]>, Promise<AssistantMessage>>
>;

// pi-ai's `StreamFunction` is the synchronous-return variant of the same shape.
export type _PiStreamFunctionAccepted = Assert<Extends<PiStreamFunction, StreamFn>>;

// ── plugin registration + config delivery ──

// Config arrives on the api object, not as a hook argument.
export type _PluginConfigOnApi = Assert<
	IsExact<OpenClawPluginApi["pluginConfig"], Record<string, unknown> | undefined>
>;
