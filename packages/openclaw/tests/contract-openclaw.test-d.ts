// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Contract test — `src/types.ts` mirrors vs. the PINNED **openclaw** host.
 *
 * The openclaw HALF of the contract. Its sibling `contract.test-d.ts` holds the
 * `@mariozechner/pi-ai` half and the assertions that read only our own mirror;
 * that file compiles on every push. This one cannot, because openclaw is not a
 * devDependency — see `../openclaw-contract.env` for why — so it lives in its
 * own project and is compiled by exactly one thing:
 *
 *   .github/workflows/ci.yml, job `openclaw-contract`
 *     source packages/openclaw/openclaw-contract.env
 *     npm install --no-save --ignore-scripts openclaw@"$OPENCLAW_CONTRACT_VERSION"
 *     USERTRUST_OPENCLAW_CONTRACT=1 npx tsc -p packages/openclaw/tsconfig.contract-openclaw.json
 *
 * `tsc` has no notion of "skip this file if a package is missing", which is the
 * whole reason the split is a second tsconfig rather than a conditional include.
 * Run it locally the same way, after the same ad-hoc install.
 *
 * The pinned host is the one the plugin actually loads into. Its version lives
 * in `../openclaw-contract.env` and NOWHERE else — not here, deliberately: a
 * version restated in a doc comment is a version that goes stale on the next
 * bump. Imported type-only, so nothing here reaches runtime and the package is
 * not required to build or ship the plugin.
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
	ProviderStreamOptions as OcProviderStreamOptions,
	StreamFunction as OcStreamFunction,
	ToolCall as OcToolCall,
	ToolResultMessage as OcToolResult,
	Usage as OcUsage,
} from "openclaw/plugin-sdk/llm";
import type { ProviderPlugin as OcProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import type {
	Context,
	Message,
	Model,
	OpenClawPluginApi,
	ProviderPlugin,
	ProviderStreamOptions,
	ProviderWrapStreamFnContext,
	StreamEvent,
	StreamFn,
	StreamOptions,
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

export type _OcToolResultRole = Assert<IsExact<OcToolResult["role"], "toolResult">>;

// The tool NAME lives on `toolName`, at the top level of the message.
export type _OcToolName = Assert<IsExact<OcToolResult["toolName"], string>>;

// Correlation back to the preceding assistant turn's `ToolCall.id`.
export type _OcToolCallId = Assert<IsExact<OcToolResult["toolCallId"], string>>;
export type _OcToolCallIdMatchesCallId = Assert<
	IsExact<OcToolCall["id"], OcToolResult["toolCallId"]>
>;

// `isError` is REQUIRED (not optional) — excluded results are distinguishable
// without inspecting any text.
export type _OcIsErrorRequired = Assert<IsExact<OcToolResult["isError"], boolean>>;

// The host's tool results are accepted by the mirror.
export type _OcToolResultAssignable = Assert<Extends<OcToolResult, ToolResultMessage>>;

// The message union has exactly three roles — there is no system-role message.
export type _OcMessageRoles = Assert<
	IsExact<OcMessage["role"], "user" | "assistant" | "toolResult">
>;
export type _OcMessagesAssignable = Assert<Extends<OcMessage, Message>>;

// ── (3) done / error terminal events and where usage lives ──

export type _EventTypes = Assert<IsExact<StreamEvent["type"], OcEvent["type"]>>;

// The terminal discriminant is `reason`, not `stopReason`.
export type _OcDoneReason = Assert<
	IsExact<Extract<OcEvent, { type: "done" }>["reason"], "stop" | "length" | "toolUse">
>;
export type _OcErrorReason = Assert<
	IsExact<Extract<OcEvent, { type: "error" }>["reason"], "aborted" | "error">
>;

// Usage is nested on the terminal assistant message, NOT on the event.
export type _DoneCarriesMessage = Assert<
	IsExact<Extract<OcEvent, { type: "done" }>["message"], OcAssistantMessage>
>;
export type _ErrorCarriesMessage = Assert<
	IsExact<Extract<OcEvent, { type: "error" }>["error"], OcAssistantMessage>
>;
export type _OcUsageOnMessage = Assert<IsExact<OcAssistantMessage["usage"], OcUsage>>;

// Token counts are `input`/`output`, not `inputTokens`/`outputTokens`.
export type _OcUsageFields = Assert<Extends<OcUsage, Usage>>;

// Whole-union acceptance: the host's events flow through the mirror.
export type _OcEventsAssignable = Assert<Extends<OcEvent, StreamEvent>>;

// ── (4) system-prompt surface ──

// `Context.systemPrompt` is the delivery surface; injection has nowhere else
// to go because `Message` carries no system role (asserted above).
export type _OcSystemPrompt = Assert<IsExact<OcContext["systemPrompt"], string | undefined>>;
export type _OcContextAccepted = Assert<Extends<OcContext, Context>>;
export type _ContextForwardable = Assert<Extends<Context, OcContext>>;

// ── (5) `model` is an OBJECT at the wrapper boundary, not a string ──

export type _ModelIsNotString = Assert<IsExact<Extends<OcStreamFn, (m: string) => unknown>, false>>;
export type _OcModelIdIsString = Assert<IsExact<OcModel["id"], string>>;
export type _OcModelAccepted = Assert<Extends<OcModel, Model>>;
export type _ModelForwardable = Assert<Extends<Model, OcModel>>;

// ── stream surface ──

// The wrap seam is bidirectional: we accept openclaw's `ctx.streamFn` and
// openclaw accepts what we hand back.
export type _HostStreamFnAccepted = Assert<Extends<OcStreamFn, StreamFn>>;
export type _OurStreamFnReturnable = Assert<Extends<StreamFn, OcStreamFn>>;
export type _OcStreamFunctionAccepted = Assert<Extends<OcStreamFunction, StreamFn>>;

// ── per-call options: the host's surface, and it is OPEN ──

/** The options bag openclaw's own stream fn takes, read off the seam itself. */
type OcStreamOptions = NonNullable<Parameters<OcStreamFn>[2]>;

export type _OcOptionsAccepted = Assert<Extends<OcStreamOptions, StreamOptions>>;
export type _OptionsForwardableToOc = Assert<Extends<StreamOptions, OcStreamOptions>>;

/**
 * The mirror's named fields must be fields the HOST actually declares — not
 * invented ones — and a caller must be able to write them as a fresh object
 * literal. Asserted with a VALUE, because excess-property checking fires only
 * on a fresh literal and is therefore invisible to the `Extends` assertions
 * above: a field the mirror drops breaks callers without breaking either
 * direction of assignability.
 */
export const _mirrorFieldsExistOnHost: OcStreamOptions = {
	temperature: 0.2,
	maxTokens: 1024,
	stop: ["\n\n"],
	apiKey: "sk-test",
	transport: "sse",
	cacheRetention: "long",
	sessionId: "session-1",
	promptCacheKey: "cache-1",
	headers: { "x-usertrust-trace": "1" },
	timeoutMs: 30_000,
	maxRetries: 2,
	maxRetryDelayMs: 60_000,
	metadata: { user_id: "u-1" },
};

/** …and the same literal has to be writable against the mirror. */
export const _hostOptionFieldsAreWritable: StreamOptions = _mirrorFieldsExistOnHost;

/**
 * The OPEN half. `ProviderStreamOptions` is the host's own escape hatch, and
 * the pinned agent loop depends on it: it spreads its WHOLE config into the bag
 * (`dist/proxy-BzhBz8iM.js:356-360`), so the value that reaches a stream fn at
 * runtime always carries keys no interface declares.
 */
export const _providerOptionsAreOpen: ProviderStreamOptions = {
	maxTokens: 64,
	reasoning: "high",
	someProviderSpecificKnob: true,
};
export type _OcProviderOptionsAccepted = Assert<Extends<OcProviderStreamOptions, StreamOptions>>;

// ── plugin registration + config delivery ──

// `register(api)` — the bare-function plugin module form is still supported.
export type _RegisterIsPluginModule = Assert<
	Extends<(api: OcPluginApi) => void, NonNullable<OcPluginDefinition["register"]>>
>;

// Config arrives on the api object, not as a hook argument.
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
