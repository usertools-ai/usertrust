// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The PII content schema, path by path. Each row places an e-mail address at ONE field of a
 * provider request, beside a prompt:
 * - a CONTENT row: the field is what the model reads, so the scan finds it and redaction replaces
 *   it (and only it);
 * - a CONTROL row: the field is something the provider or a transport acts on, so the scan never
 *   reads it and redaction sends it as written, even when the prompt beside it is redacted.
 * Every row's request is fully described by the schema (no field reported as unlisted), and the
 * caller's request is never changed.
 */

import { describe, expect, it, vi } from "vitest";
import {
	detectContentPII,
	PII_UNLISTED_FIELD_REPORT_LIMIT,
	PII_UNLISTED_FIELD_WARNING,
	redactContent,
	reportUnlistedFields,
	requestSchema,
	scanContent,
} from "../../src/policy/pii-content.js";
import type { LLMClientKind } from "../../src/shared/types.js";

type Loose = Record<string, unknown>;

const EMAIL = "alice@example.com";
const R = "[REDACTED:email]";

type Row = [label: string, build: (prompt: string, value: string) => Loose];

const scan = (kind: LLMClientKind, request: Loose) =>
	scanContent(request, requestSchema(request, kind));

function conforms(kind: LLMClientKind, content: Row[], control: Row[]): void {
	for (const [rows, isContent] of [
		[content, true],
		[control, false],
	] as const) {
		for (const [label, build] of rows) {
			it(`${isContent ? "content" : "control"}: ${label}`, () => {
				// The field alone: the scan finds it exactly when it is content.
				const alone = build("hi", EMAIL);
				const aloneScan = scan(kind, alone);
				expect(aloneScan.unlisted).toEqual([]);
				expect(detectContentPII(aloneScan).found).toBe(isContent);

				// Beside a prompt that holds PII: the prompt is redacted, and the field is redacted
				// exactly when it is content. The caller's request is never changed.
				const request = build(EMAIL, EMAIL);
				const before = JSON.stringify(request);
				const requestScan = scan(kind, request);
				expect(requestScan.unlisted).toEqual([]);
				expect(redactContent(request, requestScan)).toEqual(build(R, isContent ? R : EMAIL));
				expect(JSON.stringify(request)).toBe(before);
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

const anthropic = (prompt: string, ...blocks: Loose[]): Loose => ({
	model: "claude-sonnet-4-5",
	max_tokens: 64,
	messages: [
		{ role: "user", content: prompt },
		{ role: "assistant", content: blocks },
	],
});
const block = (make: (v: string) => Loose) => (p: string, v: string) => anthropic(p, make(v));
const top = (make: (v: string) => Loose) => (p: string, v: string) => ({
	...anthropic(p),
	...make(v),
});
const textDoc = (data: string): Loose => ({
	type: "document",
	source: { type: "text", media_type: "text/plain", data },
});

describe("Anthropic messages", () => {
	conforms(
		"anthropic",
		[
			[
				"a string message",
				(p, v) => ({
					...anthropic(p),
					messages: [
						{ role: "user", content: p },
						{ role: "user", content: v },
					],
				}),
			],
			["a string system prompt", top((v) => ({ system: v }))],
			["a text block", block((v) => ({ type: "text", text: v }))],
			[
				"a document's title",
				block((v) => ({
					type: "document",
					source: { type: "url", url: "https://x.test/a.pdf" },
					title: v,
				})),
			],
			[
				"a document's context",
				block((v) => ({
					type: "document",
					source: { type: "url", url: "https://x.test/a.pdf" },
					context: v,
				})),
			],
			["a plain-text document", block((v) => textDoc(v))],
			[
				"a content document as a string",
				block((v) => ({ type: "document", source: { type: "content", content: v } })),
			],
			[
				"a content document's text block",
				block((v) => ({
					type: "document",
					source: { type: "content", content: [{ type: "text", text: v }] },
				})),
			],
			[
				"a search result's title",
				block((v) => ({
					type: "search_result",
					source: "https://x.test",
					title: v,
					content: [{ type: "text", text: "ok" }],
				})),
			],
			[
				"a search result's text",
				block((v) => ({
					type: "search_result",
					source: "https://x.test",
					title: "t",
					content: [{ type: "text", text: v }],
				})),
			],
			[
				"a tool_use input's strings",
				block((v) => ({
					type: "tool_use",
					id: "toolu_1",
					name: "send",
					input: { to: v, cc: [{ address: v }], n: 1 },
				})),
			],
			[
				"a server_tool_use input",
				block((v) => ({
					type: "server_tool_use",
					id: "srvtoolu_1",
					name: "web_search",
					input: { query: v },
				})),
			],
			[
				"a tool_result as a string",
				block((v) => ({ type: "tool_result", tool_use_id: "toolu_1", content: v })),
			],
			[
				"a tool_result's text block",
				block((v) => ({
					type: "tool_result",
					tool_use_id: "toolu_1",
					content: [{ type: "text", text: v }],
				})),
			],
			[
				"a tool_result's search result",
				block((v) => ({
					type: "tool_result",
					tool_use_id: "toolu_1",
					content: [
						{
							type: "search_result",
							source: "s",
							title: "t",
							content: [{ type: "text", text: v }],
						},
					],
				})),
			],
			[
				"a tool_result's document",
				block((v) => ({ type: "tool_result", tool_use_id: "toolu_1", content: [textDoc(v)] })),
			],
			[
				"a fetched page",
				block((v) => ({
					type: "web_fetch_tool_result",
					tool_use_id: "srvtoolu_1",
					content: { type: "web_fetch_result", url: "https://x.test", content: textDoc(v) },
				})),
			],
			[
				"code execution stdout",
				block((v) => ({
					type: "code_execution_tool_result",
					tool_use_id: "s",
					content: {
						type: "code_execution_result",
						stdout: v,
						stderr: "",
						return_code: 0,
						content: [],
					},
				})),
			],
			[
				"code execution stderr",
				block((v) => ({
					type: "code_execution_tool_result",
					tool_use_id: "s",
					content: {
						type: "code_execution_result",
						stdout: "",
						stderr: v,
						return_code: 1,
						content: [],
					},
				})),
			],
			[
				"encrypted code execution stderr",
				block((v) => ({
					type: "code_execution_tool_result",
					tool_use_id: "s",
					content: {
						type: "encrypted_code_execution_result",
						encrypted_stdout: "enc",
						stderr: v,
						return_code: 1,
						content: [],
					},
				})),
			],
			[
				"bash stdout",
				block((v) => ({
					type: "bash_code_execution_tool_result",
					tool_use_id: "s",
					content: {
						type: "bash_code_execution_result",
						stdout: v,
						stderr: "",
						return_code: 0,
						content: [],
					},
				})),
			],
			[
				"bash stderr",
				block((v) => ({
					type: "bash_code_execution_tool_result",
					tool_use_id: "s",
					content: {
						type: "bash_code_execution_result",
						stdout: "",
						stderr: v,
						return_code: 1,
						content: [],
					},
				})),
			],
			[
				"a text editor view",
				block((v) => ({
					type: "text_editor_code_execution_tool_result",
					tool_use_id: "s",
					content: {
						type: "text_editor_code_execution_view_result",
						content: v,
						file_type: "text",
					},
				})),
			],
			[
				"a text editor error message",
				block((v) => ({
					type: "text_editor_code_execution_tool_result",
					tool_use_id: "s",
					content: {
						type: "text_editor_code_execution_tool_result_error",
						error_code: "unavailable",
						error_message: v,
					},
				})),
			],
			[
				"a text editor replacement's lines",
				block((v) => ({
					type: "text_editor_code_execution_tool_result",
					tool_use_id: "s",
					content: { type: "text_editor_code_execution_str_replace_result", lines: ["a", v] },
				})),
			],
			[
				"an advisor's text",
				block((v) => ({
					type: "advisor_tool_result",
					tool_use_id: "s",
					content: { type: "advisor_result", text: v },
				})),
			],
			[
				"an mcp_tool_use input",
				block((v) => ({
					type: "mcp_tool_use",
					id: "mcptoolu_1",
					name: "send",
					server_name: "orders",
					input: { to: v },
				})),
			],
			[
				"an mcp_tool_result as a string",
				block((v) => ({ type: "mcp_tool_result", tool_use_id: "mcptoolu_1", content: v })),
			],
			[
				"an mcp_tool_result's text block",
				block((v) => ({
					type: "mcp_tool_result",
					tool_use_id: "mcptoolu_1",
					content: [{ type: "text", text: v }],
				})),
			],
			[
				"a mid-conversation system text block",
				block((v) => ({ type: "mid_conv_system", content: [{ type: "text", text: v }] })),
			],
		],
		[
			["a thinking block", block((v) => ({ type: "thinking", thinking: v, signature: "sig" }))],
			["a redacted_thinking block", block((v) => ({ type: "redacted_thinking", data: v }))],
			[
				"a compaction block",
				block((v) => ({ type: "compaction", content: v, encrypted_content: "enc" })),
			],
			[
				"a text block's citations",
				block((v) => ({
					type: "text",
					text: "ok",
					citations: [
						{
							type: "char_location",
							cited_text: v,
							document_index: 0,
							document_title: v,
							start_char_index: 0,
							end_char_index: 1,
						},
					],
				})),
			],
			[
				"an image",
				block((v) => ({
					type: "image",
					source: { type: "base64", media_type: "image/png", data: v },
				})),
			],
			[
				"a document's URL",
				block((v) => ({ type: "document", source: { type: "url", url: `https://x.test/${v}` } })),
			],
			[
				"a base64 document",
				block((v) => ({
					type: "document",
					source: { type: "base64", media_type: "application/pdf", data: v },
				})),
			],
			[
				"a file document",
				block((v) => ({ type: "document", source: { type: "file", file_id: v } })),
			],
			[
				"a search result's source",
				block((v) => ({
					type: "search_result",
					source: v,
					title: "t",
					content: [{ type: "text", text: "ok" }],
				})),
			],
			["a tool_use id and name", block((v) => ({ type: "tool_use", id: v, name: v, input: {} }))],
			[
				"a tool_result's tool_use_id",
				block((v) => ({ type: "tool_result", tool_use_id: v, content: "ok" })),
			],
			[
				"a tool reference",
				block((v) => ({
					type: "tool_result",
					tool_use_id: "toolu_1",
					content: [{ type: "tool_reference", tool_name: v }],
				})),
			],
			[
				"a web search result",
				block((v) => ({
					type: "web_search_tool_result",
					tool_use_id: "s",
					content: [{ type: "web_search_result", url: "u", title: v, encrypted_content: "e" }],
				})),
			],
			[
				"a fetched page's URL",
				block((v) => ({
					type: "web_fetch_tool_result",
					tool_use_id: "s",
					content: { type: "web_fetch_result", url: v, content: textDoc("ok") },
				})),
			],
			[
				"encrypted stdout",
				block((v) => ({
					type: "code_execution_tool_result",
					tool_use_id: "s",
					content: {
						type: "encrypted_code_execution_result",
						encrypted_stdout: v,
						stderr: "",
						return_code: 0,
						content: [],
					},
				})),
			],
			["a container upload", block((v) => ({ type: "container_upload", file_id: v }))],
			[
				"an advisor's redacted result",
				block((v) => ({
					type: "advisor_tool_result",
					tool_use_id: "s",
					content: { type: "advisor_redacted_result", encrypted_content: v },
				})),
			],
			[
				"an mcp_tool_use's server name",
				block((v) => ({ type: "mcp_tool_use", id: "m", name: "send", server_name: v, input: {} })),
			],
			["a system prompt as blocks", top((v) => ({ system: [{ type: "text", text: v }] }))],
			["metadata", top((v) => ({ metadata: { user_id: v } }))],
			[
				"an MCP server's authorization token",
				top((v) => ({
					mcp_servers: [
						{ type: "url", url: "https://mcp.test", name: "orders", authorization_token: v },
					],
				})),
			],
			[
				"tool definitions",
				top((v) => ({
					tools: [{ name: "send", description: v, input_schema: { type: "object" } }],
				})),
			],
			["stop sequences and the container", top((v) => ({ stop_sequences: [v], container: v }))],
		],
	);
});

// ---------------------------------------------------------------------------
// OpenAI chat
// ---------------------------------------------------------------------------

const chat = (prompt: string, ...messages: Loose[]): Loose => ({
	model: "gpt-4o",
	messages: [{ role: "user", content: prompt }, ...messages],
});
const msg = (make: (v: string) => Loose) => (p: string, v: string) => chat(p, make(v));
const chatTop = (make: (v: string) => Loose) => (p: string, v: string) => ({
	...chat(p),
	...make(v),
});
const args = (v: string) => JSON.stringify({ to: v, n: 1 });

describe("OpenAI chat.completions", () => {
	conforms(
		"openai",
		[
			["a user message", msg((v) => ({ role: "user", content: v }))],
			["a user text part", msg((v) => ({ role: "user", content: [{ type: "text", text: v }] }))],
			["a developer message", msg((v) => ({ role: "developer", content: v }))],
			[
				"a developer text part",
				msg((v) => ({ role: "developer", content: [{ type: "text", text: v }] })),
			],
			["a system message", msg((v) => ({ role: "system", content: v }))],
			[
				"a system text part",
				msg((v) => ({ role: "system", content: [{ type: "text", text: v }] })),
			],
			["an assistant message", msg((v) => ({ role: "assistant", content: v }))],
			[
				"an assistant text part",
				msg((v) => ({ role: "assistant", content: [{ type: "text", text: v }] })),
			],
			[
				"an assistant refusal part",
				msg((v) => ({ role: "assistant", content: [{ type: "refusal", refusal: v }] })),
			],
			["an assistant refusal", msg((v) => ({ role: "assistant", content: null, refusal: v }))],
			[
				"a function tool call's arguments",
				msg((v) => ({
					role: "assistant",
					content: null,
					tool_calls: [
						{ id: "call_1", type: "function", function: { name: "send", arguments: args(v) } },
					],
				})),
			],
			[
				"a custom tool call's input",
				msg((v) => ({
					role: "assistant",
					content: null,
					tool_calls: [{ id: "call_1", type: "custom", custom: { name: "send", input: v } }],
				})),
			],
			[
				"a function_call's arguments",
				msg((v) => ({
					role: "assistant",
					content: null,
					function_call: { name: "send", arguments: args(v) },
				})),
			],
			["a tool message", msg((v) => ({ role: "tool", tool_call_id: "call_1", content: v }))],
			[
				"a tool text part",
				msg((v) => ({
					role: "tool",
					tool_call_id: "call_1",
					content: [{ type: "text", text: v }],
				})),
			],
			["a function message", msg((v) => ({ role: "function", name: "send", content: v }))],
		],
		[
			["a message's name", msg((v) => ({ role: "user", name: v, content: "ok" }))],
			[
				"an image part",
				msg((v) => ({ role: "user", content: [{ type: "image_url", image_url: { url: v } }] })),
			],
			[
				"an audio part",
				msg((v) => ({
					role: "user",
					content: [{ type: "input_audio", input_audio: { data: v, format: "wav" } }],
				})),
			],
			[
				"a file part",
				msg((v) => ({
					role: "user",
					content: [{ type: "file", file: { filename: v, file_data: "d" } }],
				})),
			],
			[
				"a tool call's id and name",
				msg((v) => ({
					role: "assistant",
					content: null,
					tool_calls: [{ id: v, type: "function", function: { name: v, arguments: "{}" } }],
				})),
			],
			[
				"a tool message's tool_call_id",
				msg((v) => ({ role: "tool", tool_call_id: v, content: "ok" })),
			],
			[
				"an assistant's audio",
				msg((v) => ({ role: "assistant", content: null, audio: { id: v } })),
			],
			["metadata", chatTop((v) => ({ metadata: { order_id: v } }))],
			[
				"prompt_cache_key, safety_identifier and user",
				chatTop((v) => ({ prompt_cache_key: v, safety_identifier: v, user: v })),
			],
			["a prediction", chatTop((v) => ({ prediction: { type: "content", content: v } }))],
			[
				"tool and function definitions",
				chatTop((v) => ({
					tools: [{ type: "function", function: { name: "send", description: v } }],
					functions: [{ name: "f", description: v }],
				})),
			],
			["stop sequences", chatTop((v) => ({ stop: [v] }))],
		],
	);
});

// ---------------------------------------------------------------------------
// OpenAI responses
// ---------------------------------------------------------------------------

const responses = (prompt: string, ...items: Loose[]): Loose => ({
	model: "gpt-4o",
	input: [{ role: "user", content: prompt }, ...items],
});
const item = (make: (v: string) => Loose) => (p: string, v: string) => responses(p, make(v));
const respTop = (make: (v: string) => Loose) => (p: string, v: string) => ({
	...responses(p),
	...make(v),
});

describe("OpenAI responses", () => {
	conforms(
		"openai",
		[
			["the input as a string", (p, v) => ({ model: "gpt-4o", input: v, instructions: p })],
			["the instructions", (p, v) => ({ model: "gpt-4o", input: p, instructions: v })],
			["a message without a type", item((v) => ({ role: "user", content: v }))],
			[
				"an input_text part",
				item((v) => ({
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: v }],
				})),
			],
			[
				"an earlier output_text",
				item((v) => ({
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: v, annotations: [] }],
				})),
			],
			[
				"an earlier refusal",
				item((v) => ({
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "refusal", refusal: v }],
				})),
			],
			[
				"a function call's arguments",
				item((v) => ({ type: "function_call", call_id: "c1", name: "send", arguments: args(v) })),
			],
			[
				"a function call's output",
				item((v) => ({ type: "function_call_output", call_id: "c1", output: v })),
			],
			[
				"a function call's output parts",
				item((v) => ({
					type: "function_call_output",
					call_id: "c1",
					output: [{ type: "input_text", text: v }],
				})),
			],
			[
				"a custom tool call's input",
				item((v) => ({ type: "custom_tool_call", call_id: "c1", name: "send", input: v })),
			],
			[
				"a custom tool call's output",
				item((v) => ({ type: "custom_tool_call_output", call_id: "c1", output: v })),
			],
			[
				"an MCP call's arguments",
				item((v) => ({
					type: "mcp_call",
					id: "m1",
					name: "send",
					server_label: "orders",
					arguments: args(v),
				})),
			],
			[
				"an MCP call's output",
				item((v) => ({
					type: "mcp_call",
					id: "m1",
					name: "send",
					server_label: "orders",
					arguments: "{}",
					output: v,
				})),
			],
			[
				"an MCP call's error",
				item((v) => ({
					type: "mcp_call",
					id: "m1",
					name: "send",
					server_label: "orders",
					arguments: "{}",
					error: v,
				})),
			],
			[
				"an MCP approval request's arguments",
				item((v) => ({
					type: "mcp_approval_request",
					id: "a1",
					name: "send",
					server_label: "orders",
					arguments: args(v),
				})),
			],
			[
				"an MCP approval response's reason",
				item((v) => ({
					type: "mcp_approval_response",
					approval_request_id: "a1",
					approve: false,
					reason: v,
				})),
			],
			[
				"a local shell call's output",
				item((v) => ({ type: "local_shell_call_output", id: "l1", output: v })),
			],
			[
				"a shell call's stdout and stderr",
				item((v) => ({
					type: "shell_call_output",
					call_id: "s1",
					output: [{ stdout: v, stderr: v, outcome: { type: "exit", exit_code: 0 } }],
				})),
			],
			[
				"an apply_patch call's output",
				item((v) => ({
					type: "apply_patch_call_output",
					call_id: "p1",
					status: "completed",
					output: v,
				})),
			],
			[
				"a program's code",
				item((v) => ({ type: "program", id: "pr1", call_id: "c1", code: v, fingerprint: "f" })),
			],
			[
				"a program's result",
				item((v) => ({
					type: "program_output",
					id: "po1",
					call_id: "c1",
					result: v,
					status: "completed",
				})),
			],
			[
				"a tool search call's arguments",
				item((v) => ({ type: "tool_search_call", call_id: "t1", arguments: { query: v } })),
			],
		],
		[
			[
				"a reasoning item",
				item((v) => ({
					type: "reasoning",
					id: "rs_1",
					summary: [{ type: "summary_text", text: v }],
					encrypted_content: "e",
				})),
			],
			["a compaction item", item((v) => ({ type: "compaction", encrypted_content: v }))],
			["an item reference", item((v) => ({ type: "item_reference", id: v }))],
			["an item reference without a type", item((v) => ({ id: v }))],
			[
				"a local shell call",
				item((v) => ({
					type: "local_shell_call",
					id: "l1",
					call_id: "c1",
					status: "completed",
					action: { type: "exec", command: ["echo", v], env: { K: v } },
				})),
			],
			[
				"an apply_patch call",
				item((v) => ({
					type: "apply_patch_call",
					call_id: "p1",
					status: "completed",
					operation: { type: "create_file", path: "a", diff: v },
				})),
			],
			[
				"an image part",
				item((v) => ({
					type: "message",
					role: "user",
					content: [{ type: "input_image", image_url: v, detail: "auto" }],
				})),
			],
			[
				"a file part",
				item((v) => ({
					type: "message",
					role: "user",
					content: [{ type: "input_file", filename: v, file_data: "d" }],
				})),
			],
			[
				"a function call's call_id and name",
				item((v) => ({ type: "function_call", call_id: v, name: v, arguments: "{}" })),
			],
			[
				"an output_text's annotations",
				item((v) => ({
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [
						{
							type: "output_text",
							text: "ok",
							annotations: [
								{ type: "url_citation", url: v, title: v, start_index: 0, end_index: 1 },
							],
						},
					],
				})),
			],
			["metadata", respTop((v) => ({ metadata: { order_id: v } }))],
			[
				"a stored prompt's variables",
				respTop((v) => ({ prompt: { id: "pmpt_1", variables: { who: v } } })),
			],
			[
				"an MCP tool's headers",
				respTop((v) => ({
					tools: [
						{
							type: "mcp",
							server_label: "orders",
							server_url: "https://mcp.test",
							headers: { Authorization: v },
						},
					],
				})),
			],
			[
				"prompt_cache_key, safety_identifier, user and previous_response_id",
				respTop((v) => ({
					prompt_cache_key: v,
					safety_identifier: v,
					user: v,
					previous_response_id: v,
				})),
			],
		],
	);
});

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

const google = (prompt: string, ...contents: unknown[]): Loose => ({
	model: "gemini-2.5-flash",
	contents: [{ role: "user", parts: [{ text: prompt }] }, ...contents],
});
const part = (make: (v: string) => Loose) => (p: string, v: string) =>
	google(p, { role: "model", parts: [make(v)] });
const config = (make: (v: string) => Loose) => (p: string, v: string) => ({
	...google(p),
	config: make(v),
});

describe("Google generateContent", () => {
	conforms(
		"google",
		[
			["the contents as a string", (_p, v) => ({ model: "gemini-2.5-flash", contents: v })],
			["a string in the contents", (p, v) => ({ model: "gemini-2.5-flash", contents: [p, v] })],
			[
				"a single Content",
				(_p, v) => ({
					model: "gemini-2.5-flash",
					contents: { role: "user", parts: [{ text: v }] },
				}),
			],
			["a bare Part in the contents", (p, v) => google(p, { text: v })],
			[
				"a bare Part whose role key holds undefined",
				(p, v) => google(p, { role: undefined, text: v }),
			],
			["a text part", part((v) => ({ text: v }))],
			[
				"a text part whose thoughtSignature key holds undefined",
				part((v) => ({ text: v, thoughtSignature: undefined })),
			],
			[
				"a text part with an empty thoughtSignature",
				part((v) => ({ text: v, thoughtSignature: "" })),
			],
			["a text part with thought: false", part((v) => ({ text: v, thought: false }))],
			[
				"a function call's args",
				part((v) => ({ functionCall: { id: "f1", name: "send", args: { to: v, n: 1 } } })),
			],
			[
				"a function response",
				part((v) => ({ functionResponse: { id: "f1", name: "send", response: { output: v } } })),
			],
			["executable code", part((v) => ({ executableCode: { code: v, language: "PYTHON" } }))],
			[
				"a code execution result",
				part((v) => ({ codeExecutionResult: { outcome: "OUTCOME_OK", output: v } })),
			],
			[
				"a tool call's args",
				part((v) => ({ toolCall: { id: "t1", toolType: "x", args: { q: v } } })),
			],
			[
				"a tool response",
				part((v) => ({ toolResponse: { id: "t1", toolType: "x", response: { out: v } } })),
			],
		],
		[
			["a thought", part((v) => ({ text: v, thought: true }))],
			["a part with a thought signature", part((v) => ({ text: v, thoughtSignature: "sig" }))],
			[
				"a function call with a thought signature",
				part((v) => ({ functionCall: { name: "send", args: { to: v } }, thoughtSignature: "sig" })),
			],
			["inline data", part((v) => ({ inlineData: { mimeType: "text/plain", data: v } }))],
			["file data", part((v) => ({ fileData: { fileUri: v, mimeType: "text/plain" } }))],
			[
				"a function call's id and name",
				part((v) => ({ functionCall: { id: v, name: v, args: {} } })),
			],
			["the system instruction", config((v) => ({ systemInstruction: v }))],
			[
				"a header sent through httpOptions",
				config((v) => ({ httpOptions: { headers: { "x-gateway-authorization": v } } })),
			],
			[
				"an MCP server's transport headers",
				config((v) => ({
					tools: [
						{
							mcpServers: [
								{
									name: "orders",
									streamableHttpTransport: {
										url: "https://mcp.test",
										headers: { Authorization: v },
									},
								},
							],
						},
					],
				})),
			],
			[
				"labels and tool declarations",
				config((v) => ({
					labels: { who: v },
					tools: [{ functionDeclarations: [{ name: "send", description: v }] }],
				})),
			],
		],
	);
});

// ---------------------------------------------------------------------------
// Behaviour beyond the table
// ---------------------------------------------------------------------------

describe("fields the schema does not name", () => {
	it("an unlisted top-level field and an unlisted block type are left alone and reported by path, never by value", () => {
		const request: Loose = {
			...anthropic(EMAIL, { type: "future_block", text: EMAIL }),
			future_field: { note: EMAIL },
		};
		const s = scan("anthropic", request);
		expect([...s.unlisted].sort()).toEqual([
			"future_field",
			"messages[].content[][type=future_block]",
		]);
		expect(JSON.stringify(s.unlisted)).not.toContain(EMAIL);
		const sent = redactContent(request, s) as Loose;
		expect(sent["future_field"]).toBe(request["future_field"]);
		expect((sent["messages"] as Loose[])[1]).toBe((request["messages"] as Loose[])[1]);
		expect(((sent["messages"] as Loose[])[0] as Loose)["content"]).toBe(R);
	});

	it("an unlisted key inside a listed object, a block without a type and a value of the wrong shape are reported", () => {
		const s = scan("openai", {
			model: "gpt-4o",
			messages: [
				{ role: "user", content: "hi", future: 1 },
				{ role: "user", content: [{ text: "no type" }] },
				{ role: "user", content: 42 },
				{ role: "robot", content: "x" },
			],
		});
		expect([...s.unlisted].sort()).toEqual([
			"messages[][role=robot]",
			"messages[][role=user].content (number)",
			"messages[][role=user].content[][type=]",
			"messages[][role=user].future",
		]);
	});

	it("an unknown tag or key is named only when it is a plain identifier holding no PII", () => {
		const s = scan("openai", {
			model: "gpt-4o",
			messages: [
				{ role: EMAIL, content: "x" },
				{ role: "user", content: "x", [EMAIL]: 1, "a\u001b[2Jb": 2, future_key: 3 },
				{ role: "user", content: [{ type: "+1 415 555 0100", text: "x" }] },
			],
			[EMAIL]: true,
		});
		expect([...s.unlisted].sort()).toEqual([
			"<not shown>",
			"messages[][role=<not shown>]",
			"messages[][role=user].<not shown>",
			"messages[][role=user].content[][type=<not shown>]",
			"messages[][role=user].future_key",
		]);
		expect(JSON.stringify(s.unlisted)).not.toContain(EMAIL);
	});

	it("an item without a type or a role is an item reference: any key beside its id is reported", () => {
		const ref = { model: "gpt-4o", input: [{ id: "msg_1" }] };
		expect(scan("openai", ref).unlisted).toEqual([]);
		const s = scan("openai", { model: "gpt-4o", input: [{ id: "msg_1", content: EMAIL }] });
		expect(s.unlisted).toEqual(["input[].content"]);
	});

	it("a key such as constructor or __proto__ is unlisted, never found on a prototype", () => {
		const request = JSON.parse(
			'{"model":"m","max_tokens":1,"messages":[],"constructor":"x","__proto__":{"a":1}}',
		) as Loose;
		expect([...scan("anthropic", request).unlisted].sort()).toEqual(["__proto__", "constructor"]);
	});

	it("each field is reported once per governor, as a process warning with a stable code and on console.warn", () => {
		const warnings: Array<{ message: string; code: unknown }> = [];
		const emit = vi.spyOn(process, "emitWarning").mockImplementation(((
			message: string,
			options?: { code?: string },
		) => {
			warnings.push({ message, code: options?.code });
		}) as typeof process.emitWarning);
		const log = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const reported = new Set<string>();
			reportUnlistedFields("openai", ["future_field", "messages[][role=robot]"], reported);
			reportUnlistedFields("openai", ["future_field"], reported);
			expect(warnings.map((w) => w.code)).toEqual([
				PII_UNLISTED_FIELD_WARNING,
				PII_UNLISTED_FIELD_WARNING,
			]);
			expect(warnings[0]?.message).toContain("OpenAI request field future_field");
			expect(log).toHaveBeenCalledTimes(2);
			// another governor reports it again
			reportUnlistedFields("openai", ["future_field"], new Set());
			expect(warnings).toHaveLength(3);
		} finally {
			emit.mockRestore();
			log.mockRestore();
		}
	});

	it("a field name is scrubbed for the terminal, and past the limit one last warning says so", () => {
		const messages: string[] = [];
		const emit = vi.spyOn(process, "emitWarning").mockImplementation(((message: string) => {
			messages.push(message);
		}) as typeof process.emitWarning);
		const log = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const reported = new Set<string>();
			reportUnlistedFields("google", ["a\u001b[2Jb"], reported);
			expect(messages[0]).toContain("a?[2Jb");
			const many = Array.from({ length: PII_UNLISTED_FIELD_REPORT_LIMIT + 10 }, (_, i) => `f${i}`);
			reportUnlistedFields("google", many, reported);
			reportUnlistedFields("google", ["later"], reported);
			expect(messages).toHaveLength(PII_UNLISTED_FIELD_REPORT_LIMIT + 1);
			expect(messages.at(-1)).toContain("no more are reported");
		} finally {
			emit.mockRestore();
			log.mockRestore();
		}
	});
});

describe("JSON-string arguments", () => {
	it("have their string values redacted and are sent as valid JSON, with keys, numbers and clean strings kept", () => {
		const request = chat("hi", {
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: {
						name: "send",
						arguments: JSON.stringify({ [EMAIL]: EMAIL, n: 1, ok: "fine" }),
					},
				},
			],
		});
		const sent = redactContent(request, scan("openai", request)) as Loose;
		const call = ((sent["messages"] as Loose[])[1] as { tool_calls: Array<{ function: Loose }> })
			.tool_calls[0]?.function;
		expect(JSON.parse(call?.["arguments"] as string)).toEqual({ [EMAIL]: R, n: 1, ok: "fine" });
	});

	it("are sent byte-for-byte when nothing in them is PII, even beside a redacted prompt", () => {
		const text = '{ "to" :  "bob",\n "n": 1.50 }';
		const request = chat(EMAIL, {
			role: "assistant",
			content: null,
			function_call: { name: "send", arguments: text },
		});
		const sent = redactContent(request, scan("openai", request)) as Loose;
		expect(
			((sent["messages"] as Loose[])[1] as { function_call: Loose }).function_call["arguments"],
		).toBe(text);
	});

	it("keep every byte but the replaced string values: big numbers, escapes, whitespace and keys", () => {
		const text =
			'{"id":9007199254740993, "big":1e400,\n "to" : "alice\\u0040example.com",' +
			` "${EMAIL}": ["say \\"hi\\"", 1.50, "${EMAIL}"]}`;
		const expected =
			'{"id":9007199254740993, "big":1e400,\n "to" : "[REDACTED:email]",' +
			` "${EMAIL}": ["say \\"hi\\"", 1.50, "[REDACTED:email]"]}`;
		const request = chat("hi", {
			role: "assistant",
			content: null,
			function_call: { name: "send", arguments: text },
		});
		const s = scan("openai", request);
		expect(detectContentPII(s).found).toBe(true);
		const sent = redactContent(request, s) as Loose;
		expect(
			((sent["messages"] as Loose[])[1] as { function_call: Loose }).function_call["arguments"],
		).toBe(expected);
	});

	it("nested deeper than a recursive serializer reaches are redacted, not thrown on", () => {
		const depth = 10_000;
		const text = `${"[".repeat(depth)}"${EMAIL}"${"]".repeat(depth)}`;
		const request = chat("hi", {
			role: "assistant",
			content: null,
			function_call: { name: "send", arguments: text },
		});
		const sent = redactContent(request, scan("openai", request)) as Loose;
		expect(
			((sent["messages"] as Loose[])[1] as { function_call: Loose }).function_call["arguments"],
		).toBe(`${"[".repeat(depth)}"${R}"${"]".repeat(depth)}`);
	});

	it("that are not JSON are redacted as text, whole", () => {
		const request = responses("hi", {
			type: "function_call",
			call_id: "c1",
			name: "send",
			arguments: `to: ${EMAIL}`,
		});
		const sent = redactContent(request, scan("openai", request)) as Loose;
		expect(((sent["input"] as Loose[])[1] as Loose)["arguments"]).toBe(R);
	});
});

describe("copy on write", () => {
	it("copies only the containers on the way to a redacted value; everything else is the caller's, by reference", () => {
		const signal = new AbortController().signal;
		const tool = { tool: async () => ({}), callTool: async () => [] };
		const request: Loose = {
			model: "gemini-2.5-flash",
			contents: [
				{ role: "user", parts: [{ text: EMAIL }] },
				{ role: "model", parts: [{ text: "ok" }] },
			],
			config: { abortSignal: signal, tools: [tool] },
		};
		const sent = redactContent(request, scan("google", request)) as Loose;
		expect(sent).not.toBe(request);
		expect(sent["config"]).toBe(request["config"]);
		const [first, second] = sent["contents"] as Loose[];
		expect(second).toBe((request["contents"] as Loose[])[1]);
		expect(((first as Loose)["parts"] as Loose[])[0]).toEqual({ text: R });
		const original = (request["contents"] as Loose[])[0] as Loose;
		expect((original["parts"] as Loose[])[0]).toEqual({ text: EMAIL });
	});

	it("hands the request back as it is when nothing is redacted", () => {
		const request = anthropic("hi", { type: "thinking", thinking: EMAIL, signature: "s" });
		expect(redactContent(request, scan("anthropic", request))).toBe(request);
	});

	it("keeps a copied container's prototype, and two redactions under one parent share one copy", () => {
		class Message {
			role = "user";
			content: unknown;
			constructor(content: unknown) {
				this.content = content;
			}
		}
		const request: Loose = {
			model: "m",
			max_tokens: 1,
			messages: [
				new Message([
					{ type: "text", text: EMAIL },
					{ type: "text", text: EMAIL },
				]),
			],
		};
		const sent = redactContent(request, scan("anthropic", request)) as Loose;
		const message = (sent["messages"] as unknown[])[0];
		expect(message).toBeInstanceOf(Message);
		expect((message as Message).content).toEqual([
			{ type: "text", text: R },
			{ type: "text", text: R },
		]);
	});

	it("a thinking block is sent as the same object, byte for byte, while the text beside it is redacted", () => {
		const thinking = { type: "thinking", thinking: `I should email ${EMAIL}`, signature: "EqQBCg" };
		const request = anthropic("hi", thinking, { type: "text", text: EMAIL });
		const sent = redactContent(request, scan("anthropic", request)) as Loose;
		const blocks = ((sent["messages"] as Loose[])[1] as { content: unknown[] }).content;
		expect(blocks[0]).toBe(thinking);
		expect(blocks[1]).toEqual({ type: "text", text: R });
	});
});

describe("detection paths", () => {
	it("are given from the request root, in detectPII's own form", () => {
		const request = anthropic(EMAIL, {
			type: "tool_use",
			id: "t",
			name: "n",
			input: { to: [EMAIL] },
		});
		expect(detectContentPII(scan("anthropic", request)).paths).toEqual([
			"messages[0].content(email)",
			"messages[1].content[0].input.to[0](email)",
		]);
	});
});
