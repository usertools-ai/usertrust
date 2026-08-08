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

// ── a client WITHOUT `messages` (OpenAI/Google) passes through unchanged ──
// chat.completions.create stays RAW (no top-level `messages` → no rewrite), and
// responses.stream stays RAW/sync (ungoverned per F7): not a Promise, no receipt.

export type _OpenAICreateUnchanged = Assert<
	IsExact<ReturnType<GovOpenAI["chat"]["completions"]["create"]>, Promise<{ id: string }>>
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
