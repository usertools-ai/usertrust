// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Which parts of an LLM request the PII scan reads, and the only parts `pii: "redact"` rewrites.
 *
 * A request carries two kinds of string. CONTENT is text the model reads: the prompt, tool
 * results, the arguments of earlier tool calls. CONTROL is everything else the provider or a
 * transport acts on: credentials for a remote MCP server, headers, cache keys, safety identifiers,
 * metadata, the ids that pair a tool call with its result, signatures, media bytes. Rewriting a
 * control string breaks the call (a remote server refuses a rewritten token) or quietly changes
 * what it does (a different cache key), so it is sent exactly as the caller wrote it.
 *
 * Each provider's request is described by a CLOSED schema below, derived from the request types
 * of the provider SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`). The scan reads the
 * content sites the schema names, and redaction replaces only those, in a copy: every other value
 * of the request, at any depth, is the caller's own value, by reference. A field the schema does
 * not name (a newer SDK's field, a block type it does not know) is neither read nor rewritten;
 * it is reported by its path, never its value, so a gap in the schema is seen instead of guessed.
 *
 * The fields read are those the scan read before (the prompt): Anthropic `messages` and a string
 * `system`, OpenAI chat `messages`, OpenAI Responses `input` and `instructions`, Google `contents`.
 * Inside them, only content is read.
 */

import type { LLMClientKind } from "../shared/types.js";
import { detectPII, type PIIDetection, redactPII } from "./pii.js";

// ---------------------------------------------------------------------------
// The schema language
// ---------------------------------------------------------------------------

/**
 * - `text`: a string the model reads.
 * - `json`: a JSON value (a tool call's input); the strings inside it are content, its keys never.
 * - `jsonText`: a string that holds JSON (a tool call's `arguments`): the string values inside it
 *   are content, its keys never. Redaction replaces only those string literals in the text, so
 *   every other byte (numbers, keys, whitespace) is sent as written. A string that is not JSON is
 *   read, and replaced, as text.
 * - `control`: sent as written, never read.
 */
export type Leaf = "text" | "json" | "jsonText" | "control";

export interface ObjectNode<F extends Record<string, Node> = Record<string, Node>> {
	readonly kind: "object";
	/** Every key the object can carry. A key not here is unlisted. */
	readonly fields: F;
}
export interface ArrayNode<O extends Node = Node> {
	readonly kind: "array";
	readonly of: O;
}
/** A value that is one of several shapes (a string or an array of blocks, say). */
export interface EitherNode {
	readonly kind: "either";
	readonly string?: Node;
	readonly array?: Node;
	readonly object?: Node;
}
/** An object told apart by the value of one key (`type`, `role`); an unknown value is unlisted. */
export interface ByKeyNode<V extends Record<string, Node> = Record<string, Node>> {
	readonly kind: "byKey";
	readonly key: string;
	readonly values: V;
	/** The object when the key is absent or null. Without it, such an object is unlisted. */
	readonly absent?: Node;
}
/** An object whose node depends on more than one key; `choose` reads own data properties only. */
export interface ChooseNode {
	readonly kind: "choose";
	readonly choose: (value: Readonly<Record<string, unknown>>) => Node;
}
export type Node = Leaf | ObjectNode | ArrayNode | EitherNode | ByKeyNode | ChooseNode;

const T = "text" as const;
const C = "control" as const;
const J = "json" as const;
const JT = "jsonText" as const;

/** A null-prototype copy, so a key such as `constructor` is never found on a prototype. */
function own<R extends Record<string, unknown>>(record: R): R {
	return Object.freeze(Object.assign(Object.create(null) as R, record));
}
const obj = <F extends Record<string, Node>>(fields: F): ObjectNode<F> =>
	Object.freeze({ kind: "object", fields: own(fields) });
const arr = <O extends Node>(of: O): ArrayNode<O> => Object.freeze({ kind: "array", of });
const either = <S extends Omit<EitherNode, "kind">>(shapes: S): { readonly kind: "either" } & S =>
	Object.freeze({ kind: "either" as const, ...shapes });
const byKey = <V extends Record<string, Node>>(
	key: string,
	values: V,
	absent?: Node,
): ByKeyNode<V> =>
	Object.freeze({
		kind: "byKey",
		key,
		values: own(values),
		...(absent !== undefined ? { absent } : {}),
	});
const byType = <V extends Record<string, Node>>(values: V, absent?: Node): ByKeyNode<V> =>
	byKey("type", values, absent);

// ---------------------------------------------------------------------------
// Anthropic: messages.create / stream, beta included (@anthropic-ai/sdk messages.d.ts)
// ---------------------------------------------------------------------------

export const ANTHROPIC_TEXT_BLOCK = obj({ type: C, text: T, cache_control: C, citations: C });
const ANTHROPIC_IMAGE_BLOCK = obj({ type: C, source: C, cache_control: C });
export const ANTHROPIC_DOCUMENT_SOURCE = byType({
	base64: C,
	text: obj({ type: C, data: T, media_type: C }),
	content: obj({
		type: C,
		content: either({
			string: T,
			array: arr(byType({ text: ANTHROPIC_TEXT_BLOCK, image: ANTHROPIC_IMAGE_BLOCK })),
		}),
	}),
	url: C,
	file: C,
});
export const ANTHROPIC_DOCUMENT_BLOCK = obj({
	type: C,
	source: ANTHROPIC_DOCUMENT_SOURCE,
	title: T,
	context: T,
	cache_control: C,
	citations: C,
});
export const ANTHROPIC_SEARCH_RESULT_BLOCK = obj({
	type: C,
	content: arr(byType({ text: ANTHROPIC_TEXT_BLOCK })),
	title: T,
	source: C,
	cache_control: C,
	citations: C,
});
export const ANTHROPIC_TOOL_USE_BLOCK = obj({
	type: C,
	id: C,
	name: C,
	input: J,
	cache_control: C,
	caller: C,
});
export const ANTHROPIC_TOOL_RESULT_BLOCK = obj({
	type: C,
	tool_use_id: C,
	is_error: C,
	cache_control: C,
	content: either({
		string: T,
		array: arr(
			byType({
				text: ANTHROPIC_TEXT_BLOCK,
				image: ANTHROPIC_IMAGE_BLOCK,
				search_result: ANTHROPIC_SEARCH_RESULT_BLOCK,
				document: ANTHROPIC_DOCUMENT_BLOCK,
				tool_reference: C,
			}),
		),
	}),
});
export const ANTHROPIC_WEB_FETCH_RESULT_BLOCK = obj({
	type: C,
	tool_use_id: C,
	cache_control: C,
	caller: C,
	content: byType({
		web_fetch_tool_result_error: C,
		web_fetch_result: obj({ type: C, url: C, retrieved_at: C, content: ANTHROPIC_DOCUMENT_BLOCK }),
	}),
});
const executionResult = obj({ type: C, content: C, return_code: C, stdout: T, stderr: T });
export const ANTHROPIC_CODE_EXECUTION_RESULT_BLOCK = obj({
	type: C,
	tool_use_id: C,
	cache_control: C,
	content: byType({
		code_execution_tool_result_error: C,
		code_execution_result: executionResult,
		encrypted_code_execution_result: obj({
			type: C,
			content: C,
			encrypted_stdout: C,
			return_code: C,
			stderr: T,
		}),
	}),
});
export const ANTHROPIC_BASH_EXECUTION_RESULT_BLOCK = obj({
	type: C,
	tool_use_id: C,
	cache_control: C,
	content: byType({
		bash_code_execution_tool_result_error: C,
		bash_code_execution_result: executionResult,
	}),
});
export const ANTHROPIC_TEXT_EDITOR_RESULT_BLOCK = obj({
	type: C,
	tool_use_id: C,
	cache_control: C,
	content: byType({
		text_editor_code_execution_tool_result_error: obj({
			type: C,
			error_code: C,
			error_message: T,
		}),
		text_editor_code_execution_view_result: obj({
			type: C,
			content: T,
			file_type: C,
			num_lines: C,
			start_line: C,
			total_lines: C,
		}),
		text_editor_code_execution_create_result: C,
		text_editor_code_execution_str_replace_result: obj({
			type: C,
			lines: arr(T),
			new_lines: C,
			new_start: C,
			old_lines: C,
			old_start: C,
		}),
	}),
});
export const ANTHROPIC_ADVISOR_RESULT_BLOCK = obj({
	type: C,
	tool_use_id: C,
	cache_control: C,
	content: byType({
		advisor_tool_result_error: C,
		advisor_result: obj({ type: C, text: T, stop_reason: C }),
		advisor_redacted_result: C,
	}),
});
export const ANTHROPIC_MCP_TOOL_USE_BLOCK = obj({
	type: C,
	id: C,
	name: C,
	server_name: C,
	input: J,
	cache_control: C,
});
export const ANTHROPIC_MCP_TOOL_RESULT_BLOCK = obj({
	type: C,
	tool_use_id: C,
	is_error: C,
	cache_control: C,
	content: either({ string: T, array: arr(byType({ text: ANTHROPIC_TEXT_BLOCK })) }),
});
export const ANTHROPIC_MID_CONVERSATION_SYSTEM_BLOCK = obj({
	type: C,
	cache_control: C,
	content: arr(byType({ text: ANTHROPIC_TEXT_BLOCK, tool_addition: C, tool_removal: C })),
});

/**
 * Every content block, by `type`. Replayed reasoning (`thinking`, `redacted_thinking`, and a
 * `compaction` summary sent back with its `encrypted_content`) is the provider's own earlier output
 * and is sent as written: a thinking block that is changed in any way is refused with a 400.
 */
export const ANTHROPIC_BLOCKS = byType({
	text: ANTHROPIC_TEXT_BLOCK,
	image: ANTHROPIC_IMAGE_BLOCK,
	document: ANTHROPIC_DOCUMENT_BLOCK,
	search_result: ANTHROPIC_SEARCH_RESULT_BLOCK,
	thinking: C,
	redacted_thinking: C,
	tool_use: ANTHROPIC_TOOL_USE_BLOCK,
	server_tool_use: ANTHROPIC_TOOL_USE_BLOCK,
	tool_result: ANTHROPIC_TOOL_RESULT_BLOCK,
	web_search_tool_result: C,
	web_fetch_tool_result: ANTHROPIC_WEB_FETCH_RESULT_BLOCK,
	code_execution_tool_result: ANTHROPIC_CODE_EXECUTION_RESULT_BLOCK,
	bash_code_execution_tool_result: ANTHROPIC_BASH_EXECUTION_RESULT_BLOCK,
	text_editor_code_execution_tool_result: ANTHROPIC_TEXT_EDITOR_RESULT_BLOCK,
	tool_search_tool_result: C,
	container_upload: C,
	mid_conv_system: ANTHROPIC_MID_CONVERSATION_SYSTEM_BLOCK,
	advisor_tool_result: ANTHROPIC_ADVISOR_RESULT_BLOCK,
	mcp_tool_use: ANTHROPIC_MCP_TOOL_USE_BLOCK,
	mcp_tool_result: ANTHROPIC_MCP_TOOL_RESULT_BLOCK,
	compaction: C,
	tool_addition: C,
	tool_removal: C,
	fallback: C,
});

export const ANTHROPIC_MESSAGE = obj({
	role: C,
	content: either({ string: T, array: arr(ANTHROPIC_BLOCKS) }),
});

export const ANTHROPIC_REQUEST = obj({
	messages: arr(ANTHROPIC_MESSAGE),
	// A string system prompt is read, as before; an array of system blocks is not (yet).
	system: either({ string: T, array: C }),
	model: C,
	max_tokens: C,
	cache_control: C,
	container: C,
	context_management: C,
	diagnostics: C,
	fallback_credit_token: C,
	fallbacks: C,
	inference_geo: C,
	mcp_servers: C,
	metadata: C,
	output_config: C,
	output_format: C,
	service_tier: C,
	speed: C,
	stop_sequences: C,
	stream: C,
	temperature: C,
	thinking: C,
	tool_choice: C,
	tools: C,
	top_k: C,
	top_p: C,
	betas: C,
	user_profile_id: C,
});

// ---------------------------------------------------------------------------
// OpenAI chat.completions.create (openai chat/completions/completions.d.ts)
// ---------------------------------------------------------------------------

export const OPENAI_CHAT_TEXT_PART = obj({ type: C, text: T, prompt_cache_breakpoint: C });
const chatTextContent = either({ string: T, array: arr(byType({ text: OPENAI_CHAT_TEXT_PART })) });
export const OPENAI_CHAT_USER_PARTS = byType({
	text: OPENAI_CHAT_TEXT_PART,
	image_url: C,
	input_audio: C,
	file: C,
});
export const OPENAI_CHAT_ASSISTANT_PARTS = byType({
	text: OPENAI_CHAT_TEXT_PART,
	refusal: obj({ type: C, refusal: T }),
});
export const OPENAI_CHAT_TOOL_CALLS = byType({
	function: obj({ type: C, id: C, function: obj({ name: C, arguments: JT }) }),
	custom: obj({ type: C, id: C, custom: obj({ name: C, input: T }) }),
});
export const OPENAI_CHAT_MESSAGES = byKey("role", {
	developer: obj({ role: C, name: C, content: chatTextContent }),
	system: obj({ role: C, name: C, content: chatTextContent }),
	user: obj({
		role: C,
		name: C,
		content: either({ string: T, array: arr(OPENAI_CHAT_USER_PARTS) }),
	}),
	assistant: obj({
		role: C,
		name: C,
		audio: C,
		refusal: T,
		content: either({ string: T, array: arr(OPENAI_CHAT_ASSISTANT_PARTS) }),
		function_call: obj({ name: C, arguments: JT }),
		tool_calls: arr(OPENAI_CHAT_TOOL_CALLS),
	}),
	tool: obj({ role: C, tool_call_id: C, content: chatTextContent }),
	function: obj({ role: C, name: C, content: T }),
});

export const OPENAI_CHAT_REQUEST = obj({
	messages: arr(OPENAI_CHAT_MESSAGES),
	model: C,
	audio: C,
	frequency_penalty: C,
	function_call: C,
	functions: C,
	logit_bias: C,
	logprobs: C,
	max_completion_tokens: C,
	max_tokens: C,
	metadata: C,
	modalities: C,
	moderation: C,
	n: C,
	parallel_tool_calls: C,
	prediction: C,
	presence_penalty: C,
	prompt_cache_key: C,
	prompt_cache_options: C,
	prompt_cache_retention: C,
	reasoning_effort: C,
	response_format: C,
	safety_identifier: C,
	seed: C,
	service_tier: C,
	stop: C,
	store: C,
	stream: C,
	stream_options: C,
	temperature: C,
	tool_choice: C,
	tools: C,
	top_logprobs: C,
	top_p: C,
	user: C,
	verbosity: C,
	web_search_options: C,
});

// ---------------------------------------------------------------------------
// OpenAI responses.create (openai responses/responses.d.ts)
// ---------------------------------------------------------------------------

export const OPENAI_RESPONSES_INPUT_TEXT = obj({ type: C, text: T, prompt_cache_breakpoint: C });
/** The parts of a message, input or output, and of a tool call's output. */
export const OPENAI_RESPONSES_PARTS = byType({
	input_text: OPENAI_RESPONSES_INPUT_TEXT,
	input_image: C,
	input_file: C,
	output_text: obj({ type: C, text: T, annotations: C, logprobs: C }),
	refusal: obj({ type: C, refusal: T }),
});
const responsesContent = either({ string: T, array: arr(OPENAI_RESPONSES_PARTS) });
export const OPENAI_RESPONSES_MESSAGE = obj({
	type: C,
	id: C,
	role: C,
	status: C,
	phase: C,
	content: responsesContent,
});
/**
 * Every input item, by `type`. Items the provider produced and the caller sends back as they
 * were (reasoning, compaction, and the calls and results of the provider's own hosted tools) are
 * sent as written.
 */
/** An item reference given without its `type`. */
const OPENAI_RESPONSES_ITEM_REFERENCE = obj({ id: C, type: C });
export const OPENAI_RESPONSES_ITEMS = byType(
	{
		message: OPENAI_RESPONSES_MESSAGE,
		function_call: obj({
			type: C,
			id: C,
			call_id: C,
			name: C,
			arguments: JT,
			caller: C,
			namespace: C,
			status: C,
		}),
		function_call_output: obj({
			type: C,
			id: C,
			call_id: C,
			output: responsesContent,
			caller: C,
			name: C,
			namespace: C,
			status: C,
		}),
		custom_tool_call: obj({
			type: C,
			id: C,
			call_id: C,
			name: C,
			input: T,
			caller: C,
			namespace: C,
		}),
		custom_tool_call_output: obj({
			type: C,
			id: C,
			call_id: C,
			output: responsesContent,
			caller: C,
		}),
		mcp_call: obj({
			type: C,
			id: C,
			name: C,
			server_label: C,
			approval_request_id: C,
			arguments: JT,
			output: T,
			error: T,
			status: C,
		}),
		mcp_approval_request: obj({ type: C, id: C, name: C, server_label: C, arguments: JT }),
		mcp_approval_response: obj({ type: C, id: C, approval_request_id: C, approve: C, reason: T }),
		local_shell_call_output: obj({ type: C, id: C, output: T, status: C }),
		shell_call_output: obj({
			type: C,
			id: C,
			call_id: C,
			caller: C,
			max_output_length: C,
			status: C,
			output: arr(obj({ stdout: T, stderr: T, outcome: C })),
		}),
		apply_patch_call_output: obj({ type: C, id: C, call_id: C, caller: C, status: C, output: T }),
		program: obj({ type: C, id: C, call_id: C, fingerprint: C, code: T }),
		program_output: obj({ type: C, id: C, call_id: C, status: C, result: T }),
		tool_search_call: obj({ type: C, id: C, call_id: C, execution: C, status: C, arguments: J }),
		reasoning: C,
		compaction: C,
		compaction_trigger: C,
		item_reference: C,
		file_search_call: C,
		web_search_call: C,
		computer_call: C,
		computer_call_output: C,
		image_generation_call: C,
		code_interpreter_call: C,
		local_shell_call: C,
		shell_call: C,
		apply_patch_call: C,
		mcp_list_tools: C,
		tool_search_output: C,
		additional_tools: C,
	},
	// No `type`: a message (EasyInputMessage) when it has a role, else an item reference, whose
	// only fields are its id and type: any other key is reported, never passed over unscanned.
	{
		kind: "choose",
		choose: (item) =>
			Object.hasOwn(item, "role") ? OPENAI_RESPONSES_MESSAGE : OPENAI_RESPONSES_ITEM_REFERENCE,
	},
);

export const OPENAI_RESPONSES_REQUEST = obj({
	input: either({ string: T, array: arr(OPENAI_RESPONSES_ITEMS) }),
	instructions: T,
	model: C,
	background: C,
	context_management: C,
	conversation: C,
	include: C,
	max_output_tokens: C,
	metadata: C,
	moderation: C,
	parallel_tool_calls: C,
	previous_response_id: C,
	prompt: C,
	prompt_cache_key: C,
	prompt_cache_options: C,
	prompt_cache_retention: C,
	reasoning: C,
	safety_identifier: C,
	service_tier: C,
	store: C,
	stream: C,
	stream_options: C,
	temperature: C,
	text: C,
	tool_choice: C,
	tools: C,
	top_logprobs: C,
	top_p: C,
	truncation: C,
	user: C,
});

// ---------------------------------------------------------------------------
// Google models.generateContent / generateContentStream (@google/genai genai.d.ts)
// ---------------------------------------------------------------------------

export const GOOGLE_PART = obj({
	text: T,
	thought: C,
	thoughtSignature: C,
	mediaResolution: C,
	inlineData: C,
	fileData: C,
	videoMetadata: C,
	partMetadata: C,
	functionCall: obj({ id: C, name: C, args: J, partialArgs: C, willContinue: C }),
	functionResponse: obj({
		id: C,
		name: C,
		response: J,
		parts: C,
		willContinue: C,
		scheduling: C,
	}),
	executableCode: obj({ id: C, code: T, language: C }),
	codeExecutionResult: obj({ id: C, output: T, outcome: C }),
	toolCall: obj({ id: C, toolType: C, args: J }),
	toolResponse: obj({ id: C, toolType: C, response: J }),
});
/**
 * A part the model produced (a thought, or a part carrying its thought signature) is its own earlier
 * output: sent as written. The signature must be a non-empty string: the SDK drops an `undefined`
 * one from the wire, so a key that is merely present would exempt ordinary content.
 */
const googlePart: ChooseNode = {
	kind: "choose",
	choose: (part) =>
		(typeof part.thoughtSignature === "string" && part.thoughtSignature !== "") ||
		part.thought === true
			? C
			: GOOGLE_PART,
};
export const GOOGLE_CONTENT = obj({ role: C, parts: arr(googlePart) });
/** An element of `contents`: a string, a Content (`parts` / `role`), or a bare Part. */
const googleContentsElement = either({
	string: T,
	object: {
		kind: "choose",
		choose: (value) =>
			value.parts !== undefined || value.role !== undefined ? GOOGLE_CONTENT : googlePart,
	},
});
export const GOOGLE_REQUEST = obj({
	model: C,
	config: C,
	contents: either({
		string: T,
		array: arr(googleContentsElement),
		object: googleContentsElement,
	}),
});

/** The schema of one request: OpenAI's two shapes are told apart as the governor does (`messages`). */
export function requestSchema(
	params: Readonly<Record<string, unknown>>,
	kind: LLMClientKind,
): Node {
	if (kind === "anthropic") return ANTHROPIC_REQUEST;
	if (kind === "google") return GOOGLE_REQUEST;
	return params.messages === undefined ? OPENAI_RESPONSES_REQUEST : OPENAI_CHAT_REQUEST;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

type Segment = string | number;

/** One content value: where it is, how it is read, and the value. */
interface ContentSite {
	readonly path: readonly Segment[];
	readonly leaf: "text" | "json" | "jsonText";
	readonly value: unknown;
}

/** The content sites of a request, and the fields it carries that its schema does not name. */
export interface ContentScan {
	readonly sites: readonly ContentSite[];
	/** Each unlisted field as a pattern (`messages[].content[type=x]`), never with a value. */
	readonly unlisted: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Walk `root` against `schema`. Values the schema does not describe are never descended into, and
 * the schema is not recursive, so the walk is as deep as the schema at most, a cycle in the request
 * included. A `json` site's own value is walked by `detectPII` / `redactPII`, which guard their own.
 */
export function scanContent(root: unknown, schema: Node): ContentScan {
	const sites: ContentSite[] = [];
	const unlisted = new Set<string>();
	const describe = (value: unknown): string =>
		value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
	const visit = (value: unknown, node: Node, path: Segment[], pattern: string): void => {
		// An absent or null value carries nothing, whatever the schema expects there.
		if (value === undefined || value === null || node === "control") return;
		if (node === "text") {
			if (typeof value === "string") sites.push({ path, leaf: "text", value });
			else unlisted.add(`${pattern} (${describe(value)})`);
			return;
		}
		if (node === "jsonText") {
			if (typeof value === "string") sites.push({ path, leaf: "jsonText", value });
			else unlisted.add(`${pattern} (${describe(value)})`);
			return;
		}
		if (node === "json") {
			sites.push({ path, leaf: "json", value });
			return;
		}
		switch (node.kind) {
			case "either": {
				const branch =
					typeof value === "string"
						? node.string
						: Array.isArray(value)
							? node.array
							: isRecord(value)
								? node.object
								: undefined;
				if (branch === undefined) unlisted.add(`${pattern} (${describe(value)})`);
				else visit(value, branch, path, pattern);
				return;
			}
			case "array": {
				if (!Array.isArray(value)) {
					unlisted.add(`${pattern} (${describe(value)})`);
					return;
				}
				for (let i = 0; i < value.length; i++) {
					visit(value[i], node.of, [...path, i], `${pattern}[]`);
				}
				return;
			}
			case "object": {
				if (!isRecord(value)) {
					unlisted.add(`${pattern} (${describe(value)})`);
					return;
				}
				// Own names, not only enumerable keys: a field the SDK reads by name (Google's request
				// mirror keeps one the caller hid as a non-enumerable own property) is sent all the same.
				for (const key of Object.getOwnPropertyNames(value)) {
					// A key holding undefined is not serialized: nothing of it reaches the provider.
					if (value[key] === undefined) continue;
					const child = Object.hasOwn(node.fields, key) ? node.fields[key] : undefined;
					if (child !== undefined) {
						visit(value[key], child, [...path, key], pattern === "" ? key : `${pattern}.${key}`);
					} else if (Object.prototype.propertyIsEnumerable.call(value, key)) {
						// A hidden key no schema names is read by no SDK and serialized by none: not sent.
						unlisted.add(
							pattern === "" ? nameForWarning(key) : `${pattern}.${nameForWarning(key)}`,
						);
					}
				}
				return;
			}
			case "byKey": {
				if (!isRecord(value)) {
					unlisted.add(`${pattern} (${describe(value)})`);
					return;
				}
				const tag = Object.hasOwn(value, node.key) ? value[node.key] : undefined;
				if (tag === undefined || tag === null) {
					if (node.absent === undefined) unlisted.add(`${pattern}[${node.key}=]`);
					else visit(value, node.absent, path, pattern);
					return;
				}
				const known =
					typeof tag === "string" && Object.hasOwn(node.values, tag) ? node.values[tag] : undefined;
				if (known === undefined) {
					const shown = typeof tag === "string" ? nameForWarning(tag) : describe(tag);
					unlisted.add(`${pattern}[${node.key}=${shown}]`);
				} else visit(value, known, path, `${pattern}[${node.key}=${tag as string}]`);
				return;
			}
			case "choose": {
				if (!isRecord(value)) {
					unlisted.add(`${pattern} (${describe(value)})`);
					return;
				}
				visit(value, node.choose(value), path, pattern);
				return;
			}
		}
	};
	visit(root, schema, [], "");
	return { sites, unlisted: [...unlisted] };
}

/** A string VALUE literal in a JSON text: its span `[start, end)` and the string it decodes to. */
interface JsonString {
	readonly start: number;
	readonly end: number;
	readonly value: string;
}

/**
 * Every string VALUE literal in a `jsonText` site, keys skipped, in order; undefined when the text
 * is not JSON (it is then read and replaced as text). The scan and the redaction both read this
 * list, so their scopes are equal: a member repeated under one key is listed each time, as it is
 * sent, where a parse would keep only the last. One pass over the text with a stack of open
 * containers, so any nesting the parse accepts is read without recursion.
 */
function jsonStringValues(text: string): JsonString[] | undefined {
	try {
		JSON.parse(text);
	} catch {
		return undefined;
	}
	const strings: JsonString[] = [];
	const inObject: boolean[] = [];
	let keyNext = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "{" || ch === "[") {
			inObject.push(ch === "{");
			keyNext = ch === "{";
		} else if (ch === "}" || ch === "]") {
			inObject.pop();
			keyNext = false;
		} else if (ch === ",") {
			keyNext = inObject.at(-1) === true;
		} else if (ch === '"') {
			let end = i + 1;
			while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
			end += 1;
			if (keyNext) keyNext = false;
			else strings.push({ start: i, end, value: JSON.parse(text.slice(i, end)) as string });
			i = end - 1;
		}
	}
	return strings;
}

/** `a.b[2].c` for a site path and a path inside the site's value (`detectPII`'s own form). */
function joinPath(path: readonly Segment[], inner: string): string {
	let out = "";
	for (const segment of path) {
		out += typeof segment === "number" ? `[${segment}]` : out === "" ? segment : `.${segment}`;
	}
	if (inner === "") return out;
	if (out === "") return inner;
	return inner.startsWith("[") || inner.startsWith("(") ? `${out}${inner}` : `${out}.${inner}`;
}

/** The PII the content sites hold, as `detectPII` reports it, with each path from the request root. */
export function detectContentPII(scan: ContentScan): PIIDetection {
	const types = new Set<string>();
	const paths: string[] = [];
	const add = (site: ContentSite, value: unknown): void => {
		const found = detectPII(value);
		for (const type of found.types) types.add(type);
		for (const inner of found.paths) paths.push(joinPath(site.path, inner));
	};
	for (const site of scan.sites) {
		const strings = site.leaf === "jsonText" ? jsonStringValues(site.value as string) : undefined;
		if (strings === undefined) add(site, site.value);
		else for (const string of strings) add(site, string.value);
	}
	return { found: types.size > 0, types: [...types], paths };
}

/**
 * `text` with each of its string values (`strings`) that holds PII replaced by its redaction, or
 * undefined when none does. Every other byte is kept as written: keys, whitespace, and numbers,
 * which a parse and re-serialization would change (one past 2^53 rounds, one past the double range
 * becomes `null`).
 */
function redactJsonStrings(text: string, strings: readonly JsonString[]): string | undefined {
	let out = "";
	let from = 0;
	for (const string of strings) {
		const redacted = redactPII(string.value);
		if (!redacted.detection.found) continue;
		out += `${text.slice(from, string.start)}${JSON.stringify(redacted.data)}`;
		from = string.end;
	}
	return from === 0 ? undefined : out + text.slice(from);
}

/**
 * A shallow copy with the same prototype and own properties, each as enumerable as before. Every
 * property of the copy is configurable (and, holding a value, writable): the copy is ours to
 * change, even where the caller froze its own object.
 */
function shallowCopy<V extends object>(value: V): V {
	if (Array.isArray(value)) return value.slice() as V;
	const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(value);
	for (const key of Reflect.ownKeys(descriptors)) {
		const descriptor = descriptors[key as string] as PropertyDescriptor;
		descriptor.configurable = true;
		if ("value" in descriptor) descriptor.writable = true;
	}
	return Object.defineProperties(
		Object.create(Object.getPrototypeOf(value) as object | null) as V,
		descriptors,
	);
}

function define(target: object, key: Segment, value: unknown): void {
	// A hidden (non-enumerable) field stays hidden: a serializer that skips it must still skip it.
	const enumerable = Object.getOwnPropertyDescriptor(target, key)?.enumerable ?? true;
	Object.defineProperty(target, key, { value, writable: true, enumerable, configurable: true });
}

/**
 * `root` with each content site that holds PII replaced by its redaction. Only the containers on
 * the way to a changed site are copied; every other value is the caller's own, by reference, and
 * `root` itself is never changed. A `jsonText` site keeps its text, with only the string values
 * that hold PII replaced (see {@link redactJsonStrings}).
 */
export function redactContent(root: unknown, scan: ContentScan): unknown {
	const copies = new Map<object, object>();
	const copyOf = (value: object): object => {
		let copy = copies.get(value);
		if (copy === undefined) {
			copy = shallowCopy(value);
			copies.set(value, copy);
		}
		return copy;
	};
	let out = root;
	for (const site of scan.sites) {
		let replacement: unknown;
		const strings = site.leaf === "jsonText" ? jsonStringValues(site.value as string) : undefined;
		if (strings !== undefined) {
			replacement = redactJsonStrings(site.value as string, strings);
			if (replacement === undefined) continue;
		} else {
			const redacted = redactPII(site.value);
			if (!redacted.detection.found) continue;
			replacement = redacted.data;
		}
		if (site.path.length === 0) {
			out = replacement;
			continue;
		}
		let source = root as Record<Segment, unknown>;
		let target = copyOf(root as object) as Record<Segment, unknown>;
		out = target;
		for (let i = 0; i < site.path.length - 1; i++) {
			const segment = site.path[i] as Segment;
			const next = source[segment] as object;
			const nextCopy = copyOf(next) as Record<Segment, unknown>;
			define(target, segment, nextCopy);
			source = next as Record<Segment, unknown>;
			target = nextCopy;
		}
		define(target, site.path[site.path.length - 1] as Segment, replacement);
	}
	return out;
}

// ---------------------------------------------------------------------------
// The unlisted-field warning
// ---------------------------------------------------------------------------

/** The `process.emitWarning` code under which a field the content schema does not name is reported. */
export const PII_UNLISTED_FIELD_WARNING = "USERTRUST_PII_UNLISTED_FIELD";

/** How many distinct fields one governor reports; past it, one last warning says so and no more. */
export const PII_UNLISTED_FIELD_REPORT_LIMIT = 256;

/** A field name in a terminal warning: C0, DEL and C1 become `?`, as the audit warnings do. */
/**
 * An unlisted key or an unknown type tag as a warning may name it. A malformed request can put any
 * value where a field name or a tag belongs, so it is shown only when it is shaped like an
 * identifier and holds no PII; anything else is reported under a fixed marker.
 */
function nameForWarning(text: string): string {
	return /^[A-Za-z_$][\w$-]{0,63}$/.test(text) && !detectPII(text).found ? text : UNSHOWN_NAME;
}

/** What {@link nameForWarning} reports in place of a name it will not show. */
const UNSHOWN_NAME = "<not shown>";

function scrubForWarning(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? "?" : ch;
	}
	return out;
}

const PROVIDER_NAMES: Readonly<Record<LLMClientKind, string>> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	google: "Google",
};

/**
 * Report each field in `unlisted` that `reported` has not seen: once per field per governor, as a
 * process warning with the stable code {@link PII_UNLISTED_FIELD_WARNING} and on `console.warn`.
 * The warning names the provider and the field's path, never its value.
 */
export function reportUnlistedFields(
	kind: LLMClientKind,
	unlisted: readonly string[],
	reported: Set<string>,
): void {
	for (const path of unlisted) {
		if (reported.has(path)) continue;
		if (reported.size >= PII_UNLISTED_FIELD_REPORT_LIMIT) {
			if (!reported.has("")) {
				reported.add("");
				warn(
					`PII scan: more than ${PII_UNLISTED_FIELD_REPORT_LIMIT} request fields were not in the content schema; no more are reported`,
				);
			}
			return;
		}
		reported.add(path);
		warn(
			`PII scan: ${PROVIDER_NAMES[kind]} request field ${scrubForWarning(path)} is not in the content schema; it is neither scanned nor redacted, and is sent as written`,
		);
	}
}

function warn(message: string): void {
	console.warn(`[PII] ${message}`);
	process.emitWarning(message, { code: PII_UNLISTED_FIELD_WARNING });
}
