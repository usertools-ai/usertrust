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
 */

import type { TrustedClient } from "../../src/govern.js";
import type { TrustReceipt } from "../../src/shared/types.js";

type Assert<T extends true> = T;
type IsExact<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Extends<A, B> = A extends B ? true : false;

// ── Fake client shapes (no SDK import — usertrust is provider-agnostic) ──

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

// ── create + non-governed members unchanged (no receipt grafted onto the type) ──

export type _CreateUnchanged = Assert<
	IsExact<ReturnType<GovAnthropic["messages"]["create"]>, Promise<{ id: string }>>
>;
export type _CreateHasNoReceipt = Assert<
	Extends<
		Awaited<ReturnType<GovAnthropic["messages"]["create"]>>,
		{ receipt: unknown }
	> extends true
		? false
		: true
>;
export type _CountTokensPreserved = Assert<
	IsExact<ReturnType<GovAnthropic["messages"]["countTokens"]>, Promise<{ input_tokens: number }>>
>;

// ── governance methods grafted on ──

export type _HasDestroy = Assert<Extends<GovAnthropic, { destroy(): Promise<void> }>>;

// ── a client WITHOUT `messages` (OpenAI/Google) passes through unchanged ──
// responses.stream stays RAW/sync (ungoverned per F7): not a Promise, no receipt.

export type _OpenAIResponsesStreamRaw = Assert<
	IsExact<ReturnType<GovOpenAI["responses"]["stream"]>, { on(): void }>
>;
export type _OpenAIResponsesStreamNotAsync = Assert<
	Extends<ReturnType<GovOpenAI["responses"]["stream"]>, Promise<unknown>> extends true
		? false
		: true
>;
export type _OpenAIHasDestroy = Assert<Extends<GovOpenAI, { destroy(): Promise<void> }>>;
