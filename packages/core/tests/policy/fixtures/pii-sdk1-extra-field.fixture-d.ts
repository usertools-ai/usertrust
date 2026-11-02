// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The positive control for `pii-sdk1-pin.test.ts`. It is the same assertion the real type test makes
 * for the OpenAI chat request, with one more request field the SDK "has" and the PII content schema
 * does not name. It does not compile, on purpose. Its name does not end in `.test-d.ts`, so no real
 * type-test project picks it up: only the pin test compiles it, beside the real file, and expects
 * the pin to turn red because of it.
 */

import type * as C from "openai/resources/chat/completions/completions";
import type { ObjectNode, OPENAI_CHAT_REQUEST } from "../../../src/policy/pii-content.js";

type Assert<T extends true> = T;
type IsExact<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Fields<N> = N extends ObjectNode<infer F> ? keyof F : never;

export type UnlistedRequestField = Assert<
	IsExact<
		Fields<typeof OPENAI_CHAT_REQUEST>,
		keyof C.ChatCompletionCreateParamsBase | "a_request_field_the_schema_does_not_name"
	>
>;
