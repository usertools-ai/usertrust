// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The second positive control for `pii-sdk1-pin.test.ts`: a new key INSIDE an assertion the pin
 * already lists. It is `pii-sdk1-exact-gaps.sdk1-d.ts`'s Anthropic request assertion with `thread`
 * left out of the expected set, which is what the file would say if the SDK had just added `thread`
 * and nobody had accounted for it. The pin alone would not notice: that assertion already fails, with the
 * same line and column. This one must turn the leg red. It does not compile, on purpose.
 */

import type * as AB from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type * as A from "@anthropic-ai/sdk/resources/messages/messages";
import type { ANTHROPIC_REQUEST, ObjectNode } from "../../../src/policy/pii-content.js";

type Assert<T extends true> = T;
type IsExact<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Fields<N> = N extends ObjectNode<infer F> ? keyof F : never;

export type UnaccountedKeyInsidePinnedAssertion = Assert<
	IsExact<
		Exclude<
			keyof A.MessageCreateParamsBase | keyof AB.MessageCreateParamsBase,
			Fields<typeof ANTHROPIC_REQUEST>
		>,
		"workspace_id" | "compaction"
	>
>;
