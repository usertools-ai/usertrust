// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Compiled ONLY by the 1.x leg (`tsconfig.type-tests.sdk1.json`), never on the SDK floor, and kept
 * out of `tsconfig.tests.json`: on the floor these sets differ, so it would not compile there.
 *
 * `pii-content-sdk-types.test-d.ts` has seven assertions that fail on @anthropic-ai/sdk 1.3.0, and
 * `pii-sdk1-pin.test.ts` pins each failure by its assertion, line and column. That pin cannot tell
 * WHICH keys make an assertion fail: a new key an SDK adds inside one of the seven leaves the same
 * `false`, the same diagnostic and the same location, so it would pass unseen. This file closes
 * that. For each failing assertion it states the exact keys the SDK has and the schema does not
 * ("unlisted"), and the exact keys the schema names and the SDK no longer has ("extra"). A key the
 * SDK adds changes the first set and fails this compile; classifying a key in the schema shrinks
 * it, and the line here is then edited. (`AnthropicMidConversationSystemContent` compares against
 * `unknown` on 1.3.0 and has no key set to state.)
 */

import type * as AB from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type * as A from "@anthropic-ai/sdk/resources/messages/messages";
import type {
	ANTHROPIC_BLOCKS,
	ANTHROPIC_MID_CONVERSATION_SYSTEM_BLOCK,
	ANTHROPIC_REQUEST,
	ANTHROPIC_TOOL_RESULT_BLOCK,
	ANTHROPIC_TOOL_USE_BLOCK,
	ArrayNode,
	ByKeyNode,
	ObjectNode,
} from "../../src/policy/pii-content.js";

type Assert<T extends true> = T;
type IsExact<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type AllKeys<T> = T extends unknown ? keyof T : never;
type Fields<N> = N extends ObjectNode<infer F> ? keyof F : never;
type Tags<N> = N extends ByKeyNode<infer V> ? keyof V : never;
type Typed<U, K> = Extract<U, { type: K }>;
type Field<N, K extends string> = N extends ObjectNode<infer F> ? F[K] : never;
type Arm<N, K extends "string" | "array" | "object"> = N extends { readonly kind: "either" } & {
	readonly [P in K]: infer X;
}
	? X
	: never;
type Of<N> = N extends ArrayNode<infer O> ? O : never;
type Element<T> = Exclude<NonNullable<T>, string> extends ReadonlyArray<infer E> ? E : never;

type ABlock = A.ContentBlockParam | AB.BetaContentBlockParam;

/** What `have` names that `named` does not, and the reverse. */
type Unlisted<Have, Named> = Exclude<Have, Named>;
type Extra<Have, Named> = Exclude<Named, Have>;

type RequestKeys = keyof A.MessageCreateParamsBase | keyof AB.MessageCreateParamsBase;
type RequestNamed = Fields<typeof ANTHROPIC_REQUEST>;
export type Sdk1AnthropicRequestUnlisted = Assert<
	IsExact<Unlisted<RequestKeys, RequestNamed>, "workspace_id" | "compaction" | "thread">
>;
export type Sdk1AnthropicRequestExtra = Assert<
	IsExact<Extra<RequestKeys, RequestNamed>, "temperature" | "top_k" | "top_p">
>;

export type Sdk1AnthropicBlockTypesUnlisted = Assert<
	IsExact<Unlisted<ABlock["type"], Tags<typeof ANTHROPIC_BLOCKS>>, "mcp_tool_listing">
>;
export type Sdk1AnthropicBlockTypesExtra = Assert<
	IsExact<Extra<ABlock["type"], Tags<typeof ANTHROPIC_BLOCKS>>, "mid_conv_system">
>;

type ToolUseKeys = AllKeys<Typed<ABlock, "tool_use" | "server_tool_use">>;
export type Sdk1AnthropicToolUseUnlisted = Assert<
	IsExact<Unlisted<ToolUseKeys, Fields<typeof ANTHROPIC_TOOL_USE_BLOCK>>, "toolset_name">
>;
export type Sdk1AnthropicToolUseExtra = Assert<
	IsExact<Extra<ToolUseKeys, Fields<typeof ANTHROPIC_TOOL_USE_BLOCK>>, never>
>;

type ToolResultKeys = AllKeys<Typed<ABlock, "tool_result">>;
export type Sdk1AnthropicToolResultUnlisted = Assert<
	IsExact<Unlisted<ToolResultKeys, Fields<typeof ANTHROPIC_TOOL_RESULT_BLOCK>>, "toolset_name">
>;
export type Sdk1AnthropicToolResultExtra = Assert<
	IsExact<Extra<ToolResultKeys, Fields<typeof ANTHROPIC_TOOL_RESULT_BLOCK>>, never>
>;

type ToolResultContentTags = Element<Typed<ABlock, "tool_result">["content"]>["type"];
type ToolResultContentNamed = Tags<
	Of<Arm<Field<typeof ANTHROPIC_TOOL_RESULT_BLOCK, "content">, "array">>
>;
export type Sdk1AnthropicToolResultContentUnlisted = Assert<
	IsExact<Unlisted<ToolResultContentTags, ToolResultContentNamed>, "browser_state">
>;
export type Sdk1AnthropicToolResultContentExtra = Assert<
	IsExact<Extra<ToolResultContentTags, ToolResultContentNamed>, never>
>;

type MidConvKeys = AllKeys<Typed<ABlock, "mid_conv_system">>;
export type Sdk1AnthropicMidConversationSystemUnlisted = Assert<
	IsExact<Unlisted<MidConvKeys, Fields<typeof ANTHROPIC_MID_CONVERSATION_SYSTEM_BLOCK>>, never>
>;
export type Sdk1AnthropicMidConversationSystemExtra = Assert<
	IsExact<
		Extra<MidConvKeys, Fields<typeof ANTHROPIC_MID_CONVERSATION_SYSTEM_BLOCK>>,
		"cache_control" | "content" | "type"
	>
>;
