// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * F5 — the exported `TrustedClient<T>` type must mirror the runtime governed
 * surface. These are compile-time assertions enforced by `npm run typecheck` (which
 * runs `tsc -b` AND `tsc -p packages/core/tsconfig.type-tests.json` — the step CI
 * runs). Plain `tsc -b` does NOT compile this file (it's outside the src tsconfig's
 * include), and this repo's `vitest --typecheck` runner does not actually enforce
 * type assertions — so the tsconfig.type-tests.json project is the real gate.
 *
 * `Assert<false>` violates the `extends true` constraint and fails the compile;
 * `IsExact` is the standard invariant-position exact-equality test.
 *
 * Two kinds of client shapes are asserted against:
 * - Fake mocks (provider-agnostic, no SDK import) pin the rewrite semantics.
 * - The REAL `@anthropic-ai/sdk` types (root devDependency) pin the published
 *   surface — the drift alarm if upstream changes its `create` overloads.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type {
	BetaMessage,
	BetaRawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Message, RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages/messages";
import type { Stream } from "@anthropic-ai/sdk/streaming";
import type OpenAI from "openai";
import type { Stream as OpenAIStream } from "openai/core/streaming";
import type {
	ChatCompletion,
	ChatCompletionChunk,
} from "openai/resources/chat/completions/completions";
import type {
	Response as OpenAIResponse,
	ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { TrustedClient } from "../../src/govern.js";
import type { TrustReceipt } from "../../src/shared/types.js";
import type { GovernedStream } from "../../src/streaming.js";

type Assert<T extends true> = T;
type IsExact<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Extends<A, B> = A extends B ? true : false;

// ── Fake client shapes (provider-agnostic mocks) ──

interface FakeMessageStreamHandle {
	on(event: string, cb: (...a: unknown[]) => void): FakeMessageStreamHandle;
	finalMessage(): Promise<{ id: string }>;
	abort(): void;
}

interface FakeAnthropic {
	messages: {
		create(body: { model: string }): Promise<{ id: string }>;
		stream(body: { model: string }): FakeMessageStreamHandle;
		parse(body: { model: string }): Promise<{ id: string; parsed_output: unknown }>;
		countTokens(body: { model: string }): Promise<{ input_tokens: number }>;
	};
	beta: {
		messages: {
			create(body: { model: string }): Promise<{ id: string }>;
			stream(body: { model: string }): FakeMessageStreamHandle;
		};
	};
}

interface FakeOpenAI {
	chat: { completions: { create(body: { model: string }): Promise<{ id: string }> } };
	responses: {
		create(body: { model: string }): Promise<{ id: string }>;
		stream(body: { model: string }): { on(): void };
	};
}

type GovAnthropic = TrustedClient<FakeAnthropic>;
type GovOpenAI = TrustedClient<FakeOpenAI>;

// ── messages.stream / beta.messages.stream: async, resolving to handle + receipt ──

export type _StreamIsAsyncWithReceipt = Assert<
	IsExact<
		ReturnType<GovAnthropic["messages"]["stream"]>,
		Promise<FakeMessageStreamHandle & { receipt: Promise<TrustReceipt> }>
	>
>;
export type _BetaStreamIsAsyncWithReceipt = Assert<
	IsExact<
		ReturnType<GovAnthropic["beta"]["messages"]["stream"]>,
		Promise<FakeMessageStreamHandle & { receipt: Promise<TrustReceipt> }>
	>
>;

// ── messages.parse: parsed message + SETTLED (non-promise) receipt ──

export type _ParseReturnsParsedWithReceipt = Assert<
	IsExact<
		Awaited<ReturnType<GovAnthropic["messages"]["parse"]>>,
		{ id: string; parsed_output: unknown } & { receipt: TrustReceipt }
	>
>;

// ── create IS governed: resolves to the { response, receipt } envelope ──
// Non-governed members (countTokens) stay unchanged.

export type _CreateEnvelope = Assert<
	IsExact<
		ReturnType<GovAnthropic["messages"]["create"]>,
		Promise<{ response: { id: string }; receipt: TrustReceipt }>
	>
>;
export type _BetaCreateEnvelope = Assert<
	IsExact<
		ReturnType<GovAnthropic["beta"]["messages"]["create"]>,
		Promise<{ response: { id: string }; receipt: TrustReceipt }>
	>
>;
export type _CountTokensPreserved = Assert<
	IsExact<ReturnType<GovAnthropic["messages"]["countTokens"]>, Promise<{ input_tokens: number }>>
>;

// ── overloaded create: each overload rewrites per call site ──
// Mirrors the real SDK's 3-overload shape (non-streaming / streaming / base).
// The streaming overload's response is AsyncIterable-shaped so it exercises the
// GovernedResponseOf branch: the runtime wraps an iterable provider response in
// createGovernedStream's wrapper (AsyncIterable + `.receipt` promise) — the raw
// SDK stream members (`tee()` etc.) do NOT exist on the governed response.
// Acceptance criterion is per-CALL-SITE resolved result correctness, so every
// assertion below is over `typeof` of an actual call expression — never over the
// whole overloaded function type (ReturnType/IsExact only see the last overload).

interface FakeSdkEventStream {
	[Symbol.asyncIterator](): AsyncIterator<{ delta: string }>;
	tee(): [FakeSdkEventStream, FakeSdkEventStream];
}

interface OverloadedAnthropicMock {
	messages: {
		create(params: { model: string; stream?: false }): Promise<{ kind: "msg" }>;
		create(params: { model: string; stream: true }): Promise<FakeSdkEventStream>;
		create(params: {
			model: string;
			stream?: boolean;
		}): Promise<{ kind: "msg" } | FakeSdkEventStream>;
		stream(params: { model: string }): FakeMessageStreamHandle;
	};
}

type GovOverloaded = TrustedClient<OverloadedAnthropicMock>;
declare const govOverloaded: GovOverloaded;
declare const widenedFlag: boolean;

const overloadNonStreamingCall = () => govOverloaded.messages.create({ model: "m" });
export type _OverloadNonStreaming = Assert<
	IsExact<
		Awaited<ReturnType<typeof overloadNonStreamingCall>>,
		{ response: { kind: "msg" }; receipt: TrustReceipt }
	>
>;

const overloadStreamingCall = () => govOverloaded.messages.create({ model: "m", stream: true });
export type _OverloadStreaming = Assert<
	IsExact<
		Awaited<ReturnType<typeof overloadStreamingCall>>,
		{ response: GovernedStream<{ delta: string }>; receipt: TrustReceipt }
	>
>;
export type _OverloadStreamingHasNoRawMembers = Assert<
	Extends<
		Awaited<ReturnType<typeof overloadStreamingCall>>["response"],
		{ tee: unknown }
	> extends true
		? false
		: true
>;

const overloadWidenedCall = () =>
	govOverloaded.messages.create({ model: "m", stream: widenedFlag });
export type _OverloadWidened = Assert<
	IsExact<
		Awaited<ReturnType<typeof overloadWidenedCall>>,
		{ response: { kind: "msg" } | GovernedStream<{ delta: string }>; receipt: TrustReceipt }
	>
>;

// ── REAL SDK: the published surface, per call site ──
// Non-streaming: the governed `response` must be EXACTLY what the same call on
// the raw SDK would have resolved to (`Awaited<APIPromise<T>>` carries the
// SDK's `_request_id` graft — the runtime awaits that promise, so the graft is
// the honest type); parity is asserted against the raw client, then the
// concrete SDK shape is pinned with `Extends`.
// Streaming: the governed `response` is NOT the SDK's raw `Stream` — the
// runtime wraps it in createGovernedStream's wrapper, so the type is
// `GovernedStream<RawMessageStreamEvent>` (AsyncIterable + settled-`.receipt`
// promise; the envelope's own `receipt` is the estimate).
// If upstream adds a fourth `create` overload or reshapes these types, this
// block breaks loudly.

type GovRealAnthropic = TrustedClient<Anthropic>;
declare const rawAnthropic: Anthropic;
declare const govRealAnthropic: GovRealAnthropic;

const realRawNonStreaming = () =>
	rawAnthropic.messages.create({ model: "m", max_tokens: 1, messages: [] });
const realGovNonStreaming = () =>
	govRealAnthropic.messages.create({ model: "m", max_tokens: 1, messages: [] });
export type _RealNonStreamingEnvelope = Assert<
	IsExact<
		Awaited<ReturnType<typeof realGovNonStreaming>>,
		{ response: Awaited<ReturnType<typeof realRawNonStreaming>>; receipt: TrustReceipt }
	>
>;
export type _RealNonStreamingIsMessage = Assert<
	Extends<Awaited<ReturnType<typeof realGovNonStreaming>>["response"], Message>
>;

// The second RequestOptions argument must survive the rewrite. The response is
// the governed wrapper, never the raw SDK Stream (no tee()/controller).
const realGovStreaming = () =>
	govRealAnthropic.messages.create(
		{ model: "m", max_tokens: 1, messages: [], stream: true },
		{ maxRetries: 0 },
	);
export type _RealStreamingEnvelope = Assert<
	IsExact<
		Awaited<ReturnType<typeof realGovStreaming>>,
		{ response: GovernedStream<RawMessageStreamEvent>; receipt: TrustReceipt }
	>
>;
export type _RealStreamingIsNotRawStream = Assert<
	Extends<
		Awaited<ReturnType<typeof realGovStreaming>>["response"],
		Stream<RawMessageStreamEvent>
	> extends true
		? false
		: true
>;
export type _RealStreamingIsNotMessage = Assert<
	Extends<Awaited<ReturnType<typeof realGovStreaming>>["response"], Message> extends true
		? false
		: true
>;

// Widened `stream: boolean` resolves the base overload: the union envelope,
// with the streaming half mapped to the governed wrapper and the message half
// kept at raw-SDK parity.
const realGovWidened = () =>
	govRealAnthropic.messages.create({
		model: "m",
		max_tokens: 1,
		messages: [],
		stream: widenedFlag,
	});
export type _RealWidenedEnvelope = Assert<
	IsExact<
		Awaited<ReturnType<typeof realGovWidened>>,
		{
			response:
				| GovernedStream<RawMessageStreamEvent>
				| Awaited<ReturnType<typeof realRawNonStreaming>>;
			receipt: TrustReceipt;
		}
	>
>;

// beta.messages.create mirrors messages.create (GovernedBeta reuses GovernedMessages).
const realRawBeta = () =>
	rawAnthropic.beta.messages.create({ model: "m", max_tokens: 1, messages: [] });
const realGovBeta = () =>
	govRealAnthropic.beta.messages.create({ model: "m", max_tokens: 1, messages: [] });
export type _RealBetaEnvelope = Assert<
	IsExact<
		Awaited<ReturnType<typeof realGovBeta>>,
		{ response: Awaited<ReturnType<typeof realRawBeta>>; receipt: TrustReceipt }
	>
>;
export type _RealBetaIsBetaMessage = Assert<
	Extends<Awaited<ReturnType<typeof realGovBeta>>["response"], BetaMessage>
>;
const realGovBetaStreaming = () =>
	govRealAnthropic.beta.messages.create({ model: "m", max_tokens: 1, messages: [], stream: true });
export type _RealBetaStreamingEnvelope = Assert<
	IsExact<
		Awaited<ReturnType<typeof realGovBetaStreaming>>,
		{ response: GovernedStream<BetaRawMessageStreamEvent>; receipt: TrustReceipt }
	>
>;

// ── governance methods grafted on ──

export type _HasDestroy = Assert<Extends<GovAnthropic, { destroy(): Promise<void> }>>;

// ── OpenAI mocks: BOTH governed `create` surfaces carry the envelope ──
// buildOpenAIProxy routes `chat.completions.create` and (feature-detected)
// `responses.create` through interceptCall, so both resolve to
// `{ response, receipt }`. `responses.stream()` stays RAW and SYNC: it drives the
// SDK's own client internally and never reaches the governed `create` (F7).

export type _OpenAIChatCreateEnvelope = Assert<
	IsExact<
		ReturnType<GovOpenAI["chat"]["completions"]["create"]>,
		Promise<{ response: { id: string }; receipt: TrustReceipt }>
	>
>;
export type _OpenAIResponsesCreateEnvelope = Assert<
	IsExact<
		ReturnType<GovOpenAI["responses"]["create"]>,
		Promise<{ response: { id: string }; receipt: TrustReceipt }>
	>
>;
export type _OpenAIResponsesStreamRaw = Assert<
	IsExact<ReturnType<GovOpenAI["responses"]["stream"]>, { on(): void }>
>;
export type _OpenAIResponsesStreamNotAsync = Assert<
	Extends<ReturnType<GovOpenAI["responses"]["stream"]>, Promise<unknown>> extends true
		? false
		: true
>;
export type _OpenAIHasDestroy = Assert<Extends<GovOpenAI, { destroy(): Promise<void> }>>;

// ── REAL OpenAI SDK: the published surface, per call site ──
// Same acceptance criterion as the Anthropic block above: every assertion is over
// `typeof` an actual call expression, and the non-streaming `response` is compared
// against the RAW client's own resolution so the SDK's `WithRequestID` graft
// (`Awaited<APIPromise<T>>`) survives the rewrite rather than being replaced by a
// bare nominal type. Streaming resolves to createGovernedStream's wrapper — the
// generic AsyncIterable branch in interceptCall, NOT the `stream-helper` path —
// so the raw `Stream` members (`tee()`, `controller`) are gone.
// openai@7.3.0 declares exactly three `create` overloads on BOTH resources
// (completions.d.ts:56-58, responses.d.ts:51-53). If upstream adds a fourth, or
// reshapes either type, this block breaks loudly.

type GovRealOpenAI = TrustedClient<OpenAI>;
declare const rawOpenAI: OpenAI;
declare const govRealOpenAI: GovRealOpenAI;

const rawChatNonStreaming = () => rawOpenAI.chat.completions.create({ model: "m", messages: [] });
const govChatNonStreaming = () =>
	govRealOpenAI.chat.completions.create({ model: "m", messages: [] });
export type _RealChatNonStreamingEnvelope = Assert<
	IsExact<
		Awaited<ReturnType<typeof govChatNonStreaming>>,
		{ response: Awaited<ReturnType<typeof rawChatNonStreaming>>; receipt: TrustReceipt }
	>
>;
export type _RealChatNonStreamingIsChatCompletion = Assert<
	Extends<Awaited<ReturnType<typeof govChatNonStreaming>>["response"], ChatCompletion>
>;

// The second RequestOptions argument must survive the rewrite.
const govChatStreaming = () =>
	govRealOpenAI.chat.completions.create(
		{ model: "m", messages: [], stream: true },
		{ maxRetries: 0 },
	);
export type _RealChatStreamingEnvelope = Assert<
	IsExact<
		Awaited<ReturnType<typeof govChatStreaming>>,
		{ response: GovernedStream<ChatCompletionChunk>; receipt: TrustReceipt }
	>
>;
export type _RealChatStreamingIsNotRawStream = Assert<
	Extends<
		Awaited<ReturnType<typeof govChatStreaming>>["response"],
		OpenAIStream<ChatCompletionChunk>
	> extends true
		? false
		: true
>;
export type _RealChatStreamingIsNotChatCompletion = Assert<
	Extends<Awaited<ReturnType<typeof govChatStreaming>>["response"], ChatCompletion> extends true
		? false
		: true
>;

const govChatWidened = () =>
	govRealOpenAI.chat.completions.create({ model: "m", messages: [], stream: widenedFlag });
export type _RealChatWidenedEnvelope = Assert<
	IsExact<
		Awaited<ReturnType<typeof govChatWidened>>,
		{
			response:
				| GovernedStream<ChatCompletionChunk>
				| Awaited<ReturnType<typeof rawChatNonStreaming>>;
			receipt: TrustReceipt;
		}
	>
>;

// responses.create — the highest-risk overloaded path: `retrieve` is overloaded
// three ways too and must stay raw, and the streaming overload sits between two
// non-streaming ones.
const rawResponsesNonStreaming = () => rawOpenAI.responses.create({ model: "m", input: "hi" });
const govResponsesNonStreaming = () => govRealOpenAI.responses.create({ model: "m", input: "hi" });
export type _RealResponsesNonStreamingEnvelope = Assert<
	IsExact<
		Awaited<ReturnType<typeof govResponsesNonStreaming>>,
		{ response: Awaited<ReturnType<typeof rawResponsesNonStreaming>>; receipt: TrustReceipt }
	>
>;
export type _RealResponsesNonStreamingIsResponse = Assert<
	Extends<Awaited<ReturnType<typeof govResponsesNonStreaming>>["response"], OpenAIResponse>
>;

const govResponsesStreaming = () =>
	govRealOpenAI.responses.create({ model: "m", input: "hi", stream: true });
export type _RealResponsesStreamingEnvelope = Assert<
	IsExact<
		Awaited<ReturnType<typeof govResponsesStreaming>>,
		{ response: GovernedStream<ResponseStreamEvent>; receipt: TrustReceipt }
	>
>;
export type _RealResponsesStreamingIsNotRawStream = Assert<
	Extends<
		Awaited<ReturnType<typeof govResponsesStreaming>>["response"],
		OpenAIStream<ResponseStreamEvent>
	> extends true
		? false
		: true
>;

const govResponsesStreamingWithOptions = () =>
	govRealOpenAI.responses.create({ model: "m", input: "hi", stream: true }, { maxRetries: 0 });
export type _RealResponsesStreamingWithOptionsEnvelope = Assert<
	IsExact<
		Awaited<ReturnType<typeof govResponsesStreamingWithOptions>>,
		{ response: GovernedStream<ResponseStreamEvent>; receipt: TrustReceipt }
	>
>;

const govResponsesWidened = () =>
	govRealOpenAI.responses.create({ model: "m", input: "hi", stream: widenedFlag });
export type _RealResponsesWidenedEnvelope = Assert<
	IsExact<
		Awaited<ReturnType<typeof govResponsesWidened>>,
		{
			response:
				| GovernedStream<ResponseStreamEvent>
				| Awaited<ReturnType<typeof rawResponsesNonStreaming>>;
			receipt: TrustReceipt;
		}
	>
>;

// ── UNGOVERNED OpenAI inventory: raw parity, per call site ──
// These bypass governance, audit and budget enforcement (detect.ts's boundary
// doc block). If any of them ever gained a receipt-bearing type, TrustedClient
// would advertise a proof that the runtime never produces — and these are exactly
// the streaming shortcuts users reach for.

export type _RawChatParse = Assert<
	IsExact<
		ReturnType<GovRealOpenAI["chat"]["completions"]["parse"]>,
		ReturnType<OpenAI["chat"]["completions"]["parse"]>
	>
>;
export type _RawChatStreamHelper = Assert<
	IsExact<
		ReturnType<GovRealOpenAI["chat"]["completions"]["stream"]>,
		ReturnType<OpenAI["chat"]["completions"]["stream"]>
	>
>;
export type _RawChatRunTools = Assert<
	IsExact<
		ReturnType<GovRealOpenAI["chat"]["completions"]["runTools"]>,
		ReturnType<OpenAI["chat"]["completions"]["runTools"]>
	>
>;
export type _RawChatRetrieve = Assert<
	IsExact<
		ReturnType<GovRealOpenAI["chat"]["completions"]["retrieve"]>,
		ReturnType<OpenAI["chat"]["completions"]["retrieve"]>
	>
>;
export type _RawResponsesStreamHelper = Assert<
	IsExact<
		ReturnType<GovRealOpenAI["responses"]["stream"]>,
		ReturnType<OpenAI["responses"]["stream"]>
	>
>;
export type _RawResponsesParse = Assert<
	IsExact<ReturnType<GovRealOpenAI["responses"]["parse"]>, ReturnType<OpenAI["responses"]["parse"]>>
>;
export type _RawResponsesRetrieve = Assert<
	IsExact<
		ReturnType<GovRealOpenAI["responses"]["retrieve"]>,
		ReturnType<OpenAI["responses"]["retrieve"]>
	>
>;
export type _RawResponsesCancel = Assert<
	IsExact<
		ReturnType<GovRealOpenAI["responses"]["cancel"]>,
		ReturnType<OpenAI["responses"]["cancel"]>
	>
>;
export type _RawResponsesDelete = Assert<
	IsExact<
		ReturnType<GovRealOpenAI["responses"]["delete"]>,
		ReturnType<OpenAI["responses"]["delete"]>
	>
>;
export type _RawResponsesCompact = Assert<
	IsExact<
		ReturnType<GovRealOpenAI["responses"]["compact"]>,
		ReturnType<OpenAI["responses"]["compact"]>
	>
>;
export type _RawLegacyCompletionsCreate = Assert<
	IsExact<
		ReturnType<GovRealOpenAI["completions"]["create"]>,
		ReturnType<OpenAI["completions"]["create"]>
	>
>;
export type _RawOpenAIBeta = Assert<IsExact<GovRealOpenAI["beta"], OpenAI["beta"]>>;
export type _RawOpenAIModels = Assert<IsExact<GovRealOpenAI["models"], OpenAI["models"]>>;

// ── detectClientKind's ORDER and GUARDS, mirrored exactly (detect.ts:61) ──
// The runtime picks ONE provider proxy: Anthropic (callable `messages.create`),
// else OpenAI (callable `chat.completions.create`), else Google (callable
// `models.generateContent`). A hybrid client must resolve the same way in the
// type, or TrustedClient advertises receipts on a surface no proxy wraps.

interface FakeGoogleModels {
	generateContent(params: { model: string; contents: string }): Promise<{ text: string }>;
	generateContentStream(params: {
		model: string;
		contents: string;
	}): Promise<AsyncGenerator<{ text: string }>>;
	countTokens(params: { model: string }): Promise<{ totalTokens: number }>;
}

interface FakeGoogle {
	models: FakeGoogleModels;
}

type GovGoogle = TrustedClient<FakeGoogle>;

export type _GoogleGenerateContentEnvelope = Assert<
	IsExact<
		ReturnType<GovGoogle["models"]["generateContent"]>,
		Promise<{ response: { text: string }; receipt: TrustReceipt }>
	>
>;
// generateContentStream is UNGOVERNED: buildGoogleProxy traps `generateContent`
// only, everything else falls through Reflect.get. Its raw return is a promise of
// an AsyncGenerator, so a rewrite here would be invisible at the call site until
// a consumer reached for a `.receipt` that never arrives.
export type _GoogleGenerateContentStreamRaw = Assert<
	IsExact<
		ReturnType<GovGoogle["models"]["generateContentStream"]>,
		Promise<AsyncGenerator<{ text: string }>>
	>
>;
export type _GoogleCountTokensRaw = Assert<
	IsExact<ReturnType<GovGoogle["models"]["countTokens"]>, Promise<{ totalTokens: number }>>
>;
export type _GoogleHasDestroy = Assert<Extends<GovGoogle, { destroy(): Promise<void> }>>;

// Anthropic + OpenAI on one client → Anthropic wins; the OpenAI surfaces stay raw.
interface HybridAnthropicOpenAI extends FakeOpenAI {
	messages: { create(body: { model: string }): Promise<{ id: string }> };
}
type GovHybridAnthropicOpenAI = TrustedClient<HybridAnthropicOpenAI>;

export type _HybridAnthropicWins = Assert<
	IsExact<
		ReturnType<GovHybridAnthropicOpenAI["messages"]["create"]>,
		Promise<{ response: { id: string }; receipt: TrustReceipt }>
	>
>;
export type _HybridOpenAIChatStaysRaw = Assert<
	IsExact<
		ReturnType<GovHybridAnthropicOpenAI["chat"]["completions"]["create"]>,
		Promise<{ id: string }>
	>
>;
export type _HybridOpenAIResponsesStaysRaw = Assert<
	IsExact<ReturnType<GovHybridAnthropicOpenAI["responses"]["create"]>, Promise<{ id: string }>>
>;

// OpenAI + Google on one client → OpenAI wins; `models` stays raw.
interface HybridOpenAIGoogle extends FakeOpenAI {
	models: FakeGoogleModels;
}
type GovHybridOpenAIGoogle = TrustedClient<HybridOpenAIGoogle>;

export type _HybridOpenAIWins = Assert<
	IsExact<
		ReturnType<GovHybridOpenAIGoogle["chat"]["completions"]["create"]>,
		Promise<{ response: { id: string }; receipt: TrustReceipt }>
	>
>;
export type _HybridGoogleStaysRaw = Assert<
	IsExact<ReturnType<GovHybridOpenAIGoogle["models"]["generateContent"]>, Promise<{ text: string }>>
>;

// `responses` WITHOUT `chat.completions.create` is NOT an OpenAI client:
// detectClientKind keys on chat.completions.create alone, so nothing is rewritten
// and `responses.create` must stay raw.
interface ResponsesOnly {
	responses: { create(body: { model: string }): Promise<{ id: string }> };
}
export type _ResponsesOnlyNotRewritten = Assert<
	IsExact<ReturnType<TrustedClient<ResponsesOnly>["responses"]["create"]>, Promise<{ id: string }>>
>;

// A top-level `messages` whose `create` is NOT callable does not preempt:
// detect.ts requires `typeof client.messages.create === "function"`, so this
// client is detected as OpenAI and only the OpenAI surfaces are rewritten.
interface NonCallableMessages extends FakeOpenAI {
	messages: { create: string };
}
type GovNonCallableMessages = TrustedClient<NonCallableMessages>;
export type _NonCallableMessagesStayRaw = Assert<
	IsExact<GovNonCallableMessages["messages"], { create: string }>
>;
export type _NonCallableMessagesFallsToOpenAI = Assert<
	IsExact<
		ReturnType<GovNonCallableMessages["chat"]["completions"]["create"]>,
		Promise<{ response: { id: string }; receipt: TrustReceipt }>
	>
>;

// …and with no other governed shape present, nothing is rewritten at all
// (detectClientKind would throw on this client at runtime).
export type _NonCallableMessagesAloneUnchanged = Assert<
	IsExact<TrustedClient<{ messages: { create: string } }>["messages"], { create: string }>
>;

// An older OpenAI client predating the Responses API: no `responses` key at all.
// The rewrite must not grow a phantom one — buildOpenAIResponsesProxy returns
// undefined for that client and `responses` stays a raw Reflect.get miss.
interface ChatOnlyOpenAI {
	chat: { completions: { create(body: { model: string }): Promise<{ id: string }> } };
}
type GovChatOnlyOpenAI = TrustedClient<ChatOnlyOpenAI>;
export type _ChatOnlyHasNoPhantomResponses = Assert<
	"responses" extends keyof GovChatOnlyOpenAI ? false : true
>;
export type _ChatOnlyChatIsGoverned = Assert<
	IsExact<
		ReturnType<GovChatOnlyOpenAI["chat"]["completions"]["create"]>,
		Promise<{ response: { id: string }; receipt: TrustReceipt }>
	>
>;

// An OPTIONAL `responses` must stay optional. Under exactOptionalPropertyTypes a
// rewrite that dropped the `?` (or that widened it with `| undefined`) breaks
// assignability across the package boundary for every consumer holding the
// original client type.
interface OptionalResponsesOpenAI {
	chat: { completions: { create(body: { model: string }): Promise<{ id: string }> } };
	responses?: { create(body: { model: string }): Promise<{ id: string }> };
}
type GovOptionalResponses = TrustedClient<OptionalResponsesOpenAI>;
export type _OptionalResponsesIsStillOptional = Assert<
	Pick<GovOptionalResponses, "responses"> extends Required<Pick<GovOptionalResponses, "responses">>
		? false
		: true
>;
// …and the `?` was not paid for by widening the value with `| undefined`, which
// under exactOptionalPropertyTypes is a DIFFERENT type that accepts an explicit
// `responses: undefined` the original rejects.
export type _OptionalResponsesNotWidenedWithUndefined = Assert<
	{ responses: undefined } extends Pick<GovOptionalResponses, "responses"> ? false : true
>;
export type _OptionalResponsesCreateGoverned = Assert<
	IsExact<
		ReturnType<NonNullable<GovOptionalResponses["responses"]>["create"]>,
		Promise<{ response: { id: string }; receipt: TrustReceipt }>
	>
>;

// A `responses` whose `create` is NOT callable stays raw in full — this mirrors
// buildOpenAIResponsesProxy's `typeof responsesObj.create !== "function"` bail-out,
// which leaves the whole resource a pass-through.
interface NonCallableResponsesCreate {
	chat: { completions: { create(body: { model: string }): Promise<{ id: string }> } };
	responses: { create: string; retrieve(id: string): Promise<{ id: string }> };
}
export type _NonCallableResponsesCreateStaysRaw = Assert<
	IsExact<
		TrustedClient<NonCallableResponsesCreate>["responses"],
		{ create: string; retrieve(id: string): Promise<{ id: string }> }
	>
>;
