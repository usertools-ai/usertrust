// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The PII content schema (src/policy/pii-content.ts) names EVERY field of the provider request
 * types it describes, and no other: each object's keys, and each union's discriminants, are
 * asserted equal to the installed SDKs' own request types. A field an SDK adds (or removes) fails
 * this compile, so the schema is reviewed with each SDK upgrade, instead of the new field being
 * found later by its runtime warning.
 *
 * Compiled by `tsc -p packages/core/tsconfig.type-tests.json` (part of `npm run typecheck`, which
 * CI runs). `Assert<false>` violates the `extends true` constraint and fails the compile.
 */

import type * as AB from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type * as A from "@anthropic-ai/sdk/resources/messages/messages";
import type * as G from "@google/genai";
import type * as C from "openai/resources/chat/completions/completions";
import type * as R from "openai/resources/responses/responses";
import type {
	ANTHROPIC_ADVISOR_RESULT_BLOCK,
	ANTHROPIC_BASH_EXECUTION_RESULT_BLOCK,
	ANTHROPIC_BLOCKS,
	ANTHROPIC_CODE_EXECUTION_RESULT_BLOCK,
	ANTHROPIC_DOCUMENT_BLOCK,
	ANTHROPIC_DOCUMENT_SOURCE,
	ANTHROPIC_MCP_TOOL_RESULT_BLOCK,
	ANTHROPIC_MCP_TOOL_USE_BLOCK,
	ANTHROPIC_MESSAGE,
	ANTHROPIC_MID_CONVERSATION_SYSTEM_BLOCK,
	ANTHROPIC_REQUEST,
	ANTHROPIC_SEARCH_RESULT_BLOCK,
	ANTHROPIC_TEXT_BLOCK,
	ANTHROPIC_TEXT_EDITOR_RESULT_BLOCK,
	ANTHROPIC_TOOL_RESULT_BLOCK,
	ANTHROPIC_TOOL_USE_BLOCK,
	ANTHROPIC_WEB_FETCH_RESULT_BLOCK,
	ArrayNode,
	ByKeyNode,
	GOOGLE_CONTENT,
	GOOGLE_PART,
	GOOGLE_REQUEST,
	ObjectNode,
	OPENAI_CHAT_ASSISTANT_PARTS,
	OPENAI_CHAT_MESSAGES,
	OPENAI_CHAT_REQUEST,
	OPENAI_CHAT_TEXT_PART,
	OPENAI_CHAT_TOOL_CALLS,
	OPENAI_CHAT_USER_PARTS,
	OPENAI_RESPONSES_ITEMS,
	OPENAI_RESPONSES_MESSAGE,
	OPENAI_RESPONSES_PARTS,
	OPENAI_RESPONSES_REQUEST,
} from "../../src/policy/pii-content.js";

type Assert<T extends true> = T;
type IsExact<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Every key of every member of a union (`keyof` of a union is only the keys all members share). */
type AllKeys<T> = T extends unknown ? keyof T : never;
/** The keys an object node names. */
type Fields<N> = N extends ObjectNode<infer F> ? keyof F : never;
/** The discriminants a by-key node names. */
type Tags<N> = N extends ByKeyNode<infer V> ? keyof V : never;
/** The node a by-key node gives one discriminant. */
type Branch<N, K extends string> = N extends ByKeyNode<infer V> ? V[K] : never;
/** The members of a union whose `type` is `K`. */
type Typed<U, K> = Extract<U, { type: K }>;
type Field<N, K extends string> = N extends ObjectNode<infer F> ? F[K] : never;
/** One arm of an either node, and the element node of an array node. */
type Arm<N, K extends "string" | "array" | "object"> = N extends { readonly kind: "either" } & {
	readonly [P in K]: infer X;
}
	? X
	: never;
type Of<N> = N extends ArrayNode<infer O> ? O : never;
type Element<T> = Exclude<NonNullable<T>, string> extends ReadonlyArray<infer E> ? E : never;

// ---------------------------------------------------------------------------
// Anthropic: base and beta together (a beta request is the superset)
// ---------------------------------------------------------------------------

type ABlock = A.ContentBlockParam | AB.BetaContentBlockParam;

export type AnthropicRequest = Assert<
	IsExact<
		Fields<typeof ANTHROPIC_REQUEST>,
		keyof A.MessageCreateParamsBase | keyof AB.MessageCreateParamsBase
	>
>;
export type AnthropicMessage = Assert<
	IsExact<Fields<typeof ANTHROPIC_MESSAGE>, keyof A.MessageParam | keyof AB.BetaMessageParam>
>;
export type AnthropicBlockTypes = Assert<IsExact<Tags<typeof ANTHROPIC_BLOCKS>, ABlock["type"]>>;
export type AnthropicText = Assert<
	IsExact<Fields<typeof ANTHROPIC_TEXT_BLOCK>, AllKeys<Typed<ABlock, "text">>>
>;
export type AnthropicDocument = Assert<
	IsExact<Fields<typeof ANTHROPIC_DOCUMENT_BLOCK>, AllKeys<Typed<ABlock, "document">>>
>;
export type AnthropicDocumentSources = Assert<
	IsExact<Tags<typeof ANTHROPIC_DOCUMENT_SOURCE>, Typed<ABlock, "document">["source"]["type"]>
>;
export type AnthropicSearchResult = Assert<
	IsExact<Fields<typeof ANTHROPIC_SEARCH_RESULT_BLOCK>, AllKeys<Typed<ABlock, "search_result">>>
>;
export type AnthropicToolUse = Assert<
	IsExact<
		Fields<typeof ANTHROPIC_TOOL_USE_BLOCK>,
		AllKeys<Typed<ABlock, "tool_use" | "server_tool_use">>
	>
>;
export type AnthropicToolResult = Assert<
	IsExact<Fields<typeof ANTHROPIC_TOOL_RESULT_BLOCK>, AllKeys<Typed<ABlock, "tool_result">>>
>;
export type AnthropicToolResultContent = Assert<
	IsExact<
		Tags<Of<Arm<Field<typeof ANTHROPIC_TOOL_RESULT_BLOCK, "content">, "array">>>,
		Element<Typed<ABlock, "tool_result">["content"]>["type"]
	>
>;
export type AnthropicMcpToolResultContent = Assert<
	IsExact<
		Tags<Of<Arm<Field<typeof ANTHROPIC_MCP_TOOL_RESULT_BLOCK, "content">, "array">>>,
		Element<Typed<ABlock, "mcp_tool_result">["content"]>["type"]
	>
>;
export type AnthropicSearchResultContent = Assert<
	IsExact<
		Tags<Of<Field<typeof ANTHROPIC_SEARCH_RESULT_BLOCK, "content">>>,
		Typed<ABlock, "search_result">["content"][number]["type"]
	>
>;
export type AnthropicContentSourceContent = Assert<
	IsExact<
		Tags<Of<Arm<Field<Branch<typeof ANTHROPIC_DOCUMENT_SOURCE, "content">, "content">, "array">>>,
		Element<Typed<Typed<ABlock, "document">["source"], "content">["content"]>["type"]
	>
>;
export type AnthropicWebFetch = Assert<
	IsExact<
		Fields<typeof ANTHROPIC_WEB_FETCH_RESULT_BLOCK>,
		AllKeys<Typed<ABlock, "web_fetch_tool_result">>
	>
>;
export type AnthropicWebFetchContent = Assert<
	IsExact<
		Tags<Field<typeof ANTHROPIC_WEB_FETCH_RESULT_BLOCK, "content">>,
		Typed<ABlock, "web_fetch_tool_result">["content"]["type"]
	>
>;
export type AnthropicCodeExecution = Assert<
	IsExact<
		Fields<typeof ANTHROPIC_CODE_EXECUTION_RESULT_BLOCK>,
		AllKeys<Typed<ABlock, "code_execution_tool_result">>
	>
>;
export type AnthropicCodeExecutionContent = Assert<
	IsExact<
		Tags<Field<typeof ANTHROPIC_CODE_EXECUTION_RESULT_BLOCK, "content">>,
		Typed<ABlock, "code_execution_tool_result">["content"]["type"]
	>
>;
export type AnthropicCodeExecutionResult = Assert<
	IsExact<
		Fields<
			Branch<
				Field<typeof ANTHROPIC_CODE_EXECUTION_RESULT_BLOCK, "content">,
				"code_execution_result"
			>
		>,
		AllKeys<Typed<Typed<ABlock, "code_execution_tool_result">["content"], "code_execution_result">>
	>
>;
export type AnthropicEncryptedCodeExecutionResult = Assert<
	IsExact<
		Fields<
			Branch<
				Field<typeof ANTHROPIC_CODE_EXECUTION_RESULT_BLOCK, "content">,
				"encrypted_code_execution_result"
			>
		>,
		AllKeys<
			Typed<
				Typed<ABlock, "code_execution_tool_result">["content"],
				"encrypted_code_execution_result"
			>
		>
	>
>;
export type AnthropicBash = Assert<
	IsExact<
		Fields<typeof ANTHROPIC_BASH_EXECUTION_RESULT_BLOCK>,
		AllKeys<Typed<ABlock, "bash_code_execution_tool_result">>
	>
>;
export type AnthropicBashContent = Assert<
	IsExact<
		Tags<Field<typeof ANTHROPIC_BASH_EXECUTION_RESULT_BLOCK, "content">>,
		Typed<ABlock, "bash_code_execution_tool_result">["content"]["type"]
	>
>;
export type AnthropicBashResult = Assert<
	IsExact<
		Fields<
			Branch<
				Field<typeof ANTHROPIC_BASH_EXECUTION_RESULT_BLOCK, "content">,
				"bash_code_execution_result"
			>
		>,
		AllKeys<
			Typed<
				Typed<ABlock, "bash_code_execution_tool_result">["content"],
				"bash_code_execution_result"
			>
		>
	>
>;
type TextEditorContent = Typed<ABlock, "text_editor_code_execution_tool_result">["content"];
type TextEditorNode = Field<typeof ANTHROPIC_TEXT_EDITOR_RESULT_BLOCK, "content">;
export type AnthropicTextEditor = Assert<
	IsExact<
		Fields<typeof ANTHROPIC_TEXT_EDITOR_RESULT_BLOCK>,
		AllKeys<Typed<ABlock, "text_editor_code_execution_tool_result">>
	>
>;
export type AnthropicTextEditorContent = Assert<
	IsExact<Tags<TextEditorNode>, TextEditorContent["type"]>
>;
export type AnthropicTextEditorError = Assert<
	IsExact<
		Fields<Branch<TextEditorNode, "text_editor_code_execution_tool_result_error">>,
		AllKeys<Typed<TextEditorContent, "text_editor_code_execution_tool_result_error">>
	>
>;
export type AnthropicTextEditorView = Assert<
	IsExact<
		Fields<Branch<TextEditorNode, "text_editor_code_execution_view_result">>,
		AllKeys<Typed<TextEditorContent, "text_editor_code_execution_view_result">>
	>
>;
export type AnthropicTextEditorReplace = Assert<
	IsExact<
		Fields<Branch<TextEditorNode, "text_editor_code_execution_str_replace_result">>,
		AllKeys<Typed<TextEditorContent, "text_editor_code_execution_str_replace_result">>
	>
>;
export type AnthropicAdvisor = Assert<
	IsExact<
		Fields<typeof ANTHROPIC_ADVISOR_RESULT_BLOCK>,
		AllKeys<Typed<ABlock, "advisor_tool_result">>
	>
>;
export type AnthropicAdvisorContent = Assert<
	IsExact<
		Tags<Field<typeof ANTHROPIC_ADVISOR_RESULT_BLOCK, "content">>,
		Typed<ABlock, "advisor_tool_result">["content"]["type"]
	>
>;
export type AnthropicAdvisorResult = Assert<
	IsExact<
		Fields<Branch<Field<typeof ANTHROPIC_ADVISOR_RESULT_BLOCK, "content">, "advisor_result">>,
		AllKeys<Typed<Typed<ABlock, "advisor_tool_result">["content"], "advisor_result">>
	>
>;
export type AnthropicMcpToolUse = Assert<
	IsExact<Fields<typeof ANTHROPIC_MCP_TOOL_USE_BLOCK>, AllKeys<Typed<ABlock, "mcp_tool_use">>>
>;
export type AnthropicMcpToolResult = Assert<
	IsExact<Fields<typeof ANTHROPIC_MCP_TOOL_RESULT_BLOCK>, AllKeys<Typed<ABlock, "mcp_tool_result">>>
>;
export type AnthropicMidConversationSystem = Assert<
	IsExact<
		Fields<typeof ANTHROPIC_MID_CONVERSATION_SYSTEM_BLOCK>,
		AllKeys<Typed<ABlock, "mid_conv_system">>
	>
>;
export type AnthropicMidConversationSystemContent = Assert<
	IsExact<
		Tags<Of<Field<typeof ANTHROPIC_MID_CONVERSATION_SYSTEM_BLOCK, "content">>>,
		Element<Typed<ABlock, "mid_conv_system">["content"]>["type"]
	>
>;

// ---------------------------------------------------------------------------
// OpenAI chat.completions
// ---------------------------------------------------------------------------

type ChatMessage = C.ChatCompletionMessageParam;
type ChatRole<K> = Extract<ChatMessage, { role: K }>;
type ChatNode<K extends string> = Branch<typeof OPENAI_CHAT_MESSAGES, K>;

export type ChatRequest = Assert<
	IsExact<Fields<typeof OPENAI_CHAT_REQUEST>, keyof C.ChatCompletionCreateParamsBase>
>;
export type ChatRoles = Assert<IsExact<Tags<typeof OPENAI_CHAT_MESSAGES>, ChatMessage["role"]>>;
export type ChatDeveloper = Assert<
	IsExact<Fields<ChatNode<"developer">>, keyof ChatRole<"developer">>
>;
export type ChatSystem = Assert<IsExact<Fields<ChatNode<"system">>, keyof ChatRole<"system">>>;
export type ChatUser = Assert<IsExact<Fields<ChatNode<"user">>, keyof ChatRole<"user">>>;
export type ChatAssistant = Assert<
	IsExact<Fields<ChatNode<"assistant">>, keyof ChatRole<"assistant">>
>;
export type ChatTool = Assert<IsExact<Fields<ChatNode<"tool">>, keyof ChatRole<"tool">>>;
export type ChatFunction = Assert<
	IsExact<Fields<ChatNode<"function">>, keyof ChatRole<"function">>
>;
export type ChatTextPart = Assert<
	IsExact<Fields<typeof OPENAI_CHAT_TEXT_PART>, keyof C.ChatCompletionContentPartText>
>;
export type ChatUserParts = Assert<
	IsExact<Tags<typeof OPENAI_CHAT_USER_PARTS>, C.ChatCompletionContentPart["type"]>
>;
export type ChatAssistantParts = Assert<
	IsExact<
		Tags<typeof OPENAI_CHAT_ASSISTANT_PARTS>,
		Element<ChatRole<"assistant">["content"]>["type"]
	>
>;
export type ChatToolCalls = Assert<
	IsExact<Tags<typeof OPENAI_CHAT_TOOL_CALLS>, C.ChatCompletionMessageToolCall["type"]>
>;
export type ChatFunctionToolCall = Assert<
	IsExact<
		Fields<Branch<typeof OPENAI_CHAT_TOOL_CALLS, "function">>,
		keyof C.ChatCompletionMessageFunctionToolCall
	>
>;
export type ChatCustomToolCall = Assert<
	IsExact<
		Fields<Branch<typeof OPENAI_CHAT_TOOL_CALLS, "custom">>,
		keyof C.ChatCompletionMessageCustomToolCall
	>
>;

// ---------------------------------------------------------------------------
// OpenAI responses
// ---------------------------------------------------------------------------

type Item = R.ResponseInputItem;
type ItemOf<K> = Extract<Item, { type?: K | null }>;
type ItemNode<K extends string> = Branch<typeof OPENAI_RESPONSES_ITEMS, K>;

export type ResponsesRequest = Assert<
	IsExact<Fields<typeof OPENAI_RESPONSES_REQUEST>, keyof R.ResponseCreateParamsBase>
>;
export type ResponsesItemTypes = Assert<
	IsExact<Tags<typeof OPENAI_RESPONSES_ITEMS>, NonNullable<Item["type"]>>
>;
export type ResponsesMessage = Assert<
	IsExact<Fields<typeof OPENAI_RESPONSES_MESSAGE>, AllKeys<ItemOf<"message">>>
>;
export type ResponsesParts = Assert<
	IsExact<
		Tags<typeof OPENAI_RESPONSES_PARTS>,
		R.ResponseInputContent["type"] | R.ResponseOutputMessage["content"][number]["type"]
	>
>;
type ListedItem =
	| "function_call"
	| "function_call_output"
	| "custom_tool_call"
	| "custom_tool_call_output"
	| "mcp_call"
	| "mcp_approval_request"
	| "mcp_approval_response"
	| "local_shell_call_output"
	| "shell_call_output"
	| "apply_patch_call_output"
	| "program"
	| "program_output"
	| "tool_search_call";
type ItemFieldsMatch<K extends ListedItem> = IsExact<Fields<ItemNode<K>>, AllKeys<ItemOf<K>>>;
export type ResponsesItems = Assert<
	IsExact<{ [K in ListedItem]: ItemFieldsMatch<K> }, { [K in ListedItem]: true }>
>;
export type ResponsesShellOutput = Assert<
	IsExact<
		Fields<Of<Field<ItemNode<"shell_call_output">, "output">>>,
		keyof ItemOf<"shell_call_output">["output"][number]
	>
>;

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

type PartNode<K extends string> = Field<typeof GOOGLE_PART, K>;

export type GoogleRequest = Assert<
	IsExact<Fields<typeof GOOGLE_REQUEST>, keyof G.GenerateContentParameters>
>;
export type GoogleContent = Assert<IsExact<Fields<typeof GOOGLE_CONTENT>, keyof G.Content>>;
export type GooglePart = Assert<IsExact<Fields<typeof GOOGLE_PART>, keyof G.Part>>;
export type GoogleFunctionCall = Assert<
	IsExact<Fields<PartNode<"functionCall">>, keyof G.FunctionCall>
>;
export type GoogleFunctionResponse = Assert<
	IsExact<Fields<PartNode<"functionResponse">>, keyof G.FunctionResponse>
>;
export type GoogleExecutableCode = Assert<
	IsExact<Fields<PartNode<"executableCode">>, keyof G.ExecutableCode>
>;
export type GoogleCodeExecutionResult = Assert<
	IsExact<Fields<PartNode<"codeExecutionResult">>, keyof G.CodeExecutionResult>
>;
export type GoogleToolCall = Assert<
	IsExact<Fields<PartNode<"toolCall">>, keyof NonNullable<G.Part["toolCall"]>>
>;
export type GoogleToolResponse = Assert<
	IsExact<Fields<PartNode<"toolResponse">>, keyof NonNullable<G.Part["toolResponse"]>>
>;
