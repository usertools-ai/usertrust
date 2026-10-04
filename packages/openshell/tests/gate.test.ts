// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { costFromRates, getModelRates } from "usertrust";
import { describe, expect, it } from "vitest";
import {
	BodyTooLargeError,
	DEFAULT_GATE_CONFIG,
	evaluateRequest,
	type GateResult,
	MAX_BODY_BYTES,
} from "../src/gate.js";

const ANTHROPIC = "api.anthropic.com";
const OPENAI = "api.openai.com";
const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));

function gate(host: string, path: string, body: unknown, config = DEFAULT_GATE_CONFIG): GateResult {
	return evaluateRequest({ method: "POST", host, path, body: enc(body) }, config);
}
const anthropic = (extra: Record<string, unknown> = {}) =>
	gate(ANTHROPIC, "/v1/messages", {
		model: "claude-sonnet-4-6",
		max_tokens: 1024,
		messages: [{ role: "user", content: "hi" }],
		...extra,
	});
const chat = (extra: Record<string, unknown> = {}) =>
	gate(OPENAI, "/v1/chat/completions", {
		model: "gpt-4o",
		max_completion_tokens: 512,
		messages: [{ role: "user", content: "hi" }],
		...extra,
	});
const responses = (extra: Record<string, unknown> = {}) =>
	gate(OPENAI, "/v1/responses", { model: "gpt-4o", max_output_tokens: 512, input: "hi", ...extra });

const denied = (r: GateResult) => (r.decision === "deny" ? r.reason : `not denied: ${r.decision}`);

describe("the request gate: what is metered is ALLOWED with a priced hold", () => {
	it("an Anthropic call is allowed; the hold is priced on the byte bound and the request's max_tokens", () => {
		const body = {
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [{ role: "user", content: "hi" }],
		};
		const r = gate(ANTHROPIC, "/v1/messages", body);
		expect(r.decision).toBe("allow");
		if (r.decision !== "allow") return;
		const bytes = enc(body).byteLength;
		const rates = getModelRates("claude-sonnet-4-6");
		expect(r.hold).toMatchObject({
			route: "anthropic.messages",
			inputTokenBound: bytes,
			maxOutputTokens: 1024,
		});
		expect(r.hold.amount).toBe(
			Math.max(costFromRates(rates, bytes, 1024), costFromRates(rates, 0, 1024, 0, bytes)),
		);
		expect(r.mutations).toEqual({ removeHeaders: ["accept-encoding"] });
	});

	it("the hold is priced at the DEARER of the input and cache-write tiers", () => {
		const r = anthropic();
		if (r.decision !== "allow") throw new Error("expected allow");
		const rates = getModelRates("claude-sonnet-4-6");
		const asInput = costFromRates(rates, r.hold.inputTokenBound, 1024);
		const asCacheWrite = costFromRates(rates, 0, 1024, 0, r.hold.inputTokenBound);
		expect(asCacheWrite, "sonnet's cache write is dearer than input").toBeGreaterThan(asInput);
		expect(r.hold.amount).toBe(asCacheWrite);
	});

	it("an inline image's data bytes are replaced by the per-image maximum", () => {
		const data = "A".repeat(10_000);
		const body = {
			model: "claude-sonnet-4-6",
			max_tokens: 10,
			messages: [
				{
					role: "user",
					content: [
						{ type: "image", source: { type: "base64", media_type: "image/png", data } },
						{ type: "text", text: "what is it" },
					],
				},
			],
		};
		const r = gate(ANTHROPIC, "/v1/messages", body);
		if (r.decision !== "allow") throw new Error(`expected allow, got ${denied(r)}`);
		expect(r.hold.inputTokenBound).toBe(enc(body).byteLength - data.length + 2_000);
	});

	it("an OpenAI data-URI image and a URL image each add the per-image maximum", () => {
		const uri = `data:image/png;base64,${"B".repeat(5_000)}`;
		const body = {
			model: "gpt-4o",
			max_tokens: 10,
			messages: [
				{
					role: "user",
					content: [
						{ type: "image_url", image_url: { url: uri } },
						{ type: "image_url", image_url: { url: "https://x.example/a.png" } },
					],
				},
			],
		};
		const r = gate(OPENAI, "/v1/chat/completions", body);
		if (r.decision !== "allow") throw new Error(`expected allow, got ${denied(r)}`);
		expect(r.hold.inputTokenBound).toBe(enc(body).byteLength - uri.length + 2 * 4_000);
	});

	it("the chat output limit is the LARGER of max_completion_tokens and max_tokens", () => {
		const r = chat({ max_completion_tokens: 100, max_tokens: 300 });
		if (r.decision !== "allow") throw new Error("expected allow");
		expect(r.hold.maxOutputTokens).toBe(300);
	});

	it("client function tools are allowed on every route", () => {
		expect(
			anthropic({
				tools: [
					{ name: "f", input_schema: { type: "object" } },
					{ type: "custom", name: "g", input_schema: {} },
				],
			}).decision,
		).toBe("allow");
		expect(chat({ tools: [{ type: "function", function: { name: "f" } }] }).decision).toBe("allow");
		expect(responses({ tools: [{ type: "function", name: "f" }] }).decision).toBe("allow");
	});

	it("a full Responses conversation of messages, function calls and reasoning is allowed", () => {
		const r = responses({
			input: [
				{ role: "user", content: [{ type: "input_text", text: "hi" }] },
				{ type: "reasoning", summary: [] },
				{ type: "function_call", name: "f", arguments: "{}", call_id: "c" },
				{ type: "function_call_output", call_id: "c", output: "1" },
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
			],
		});
		expect(r.decision).toBe("allow");
	});
});

describe("the request gate: mutations", () => {
	it("a streaming chat call gets stream_options.include_usage, keeping its other options", () => {
		const r = chat({ stream: true, stream_options: { foo: 1 } });
		if (r.decision !== "allow") throw new Error("expected allow");
		const sent = JSON.parse(new TextDecoder().decode(r.mutations.body));
		expect(sent.stream_options).toEqual({ foo: 1, include_usage: true });
		expect(sent.messages).toEqual([{ role: "user", content: "hi" }]);
		expect(r.hold.streaming).toBe(true);
	});
	it("a non-streaming chat call and a streaming Responses call are never body-mutated", () => {
		const c = chat();
		const s = responses({ stream: true });
		if (c.decision !== "allow" || s.decision !== "allow") throw new Error("expected allow");
		expect(c.mutations.body).toBeUndefined();
		expect(s.mutations.body).toBeUndefined();
		expect(s.mutations.removeHeaders).toEqual(["accept-encoding"]);
	});
});

describe("the request gate: every unmetered shape is DENIED before any hold", () => {
	it("route_unsupported for an unlisted route, before the body is even read", () => {
		expect(denied(gate(OPENAI, "/v1/embeddings", "not json at all"))).toBe("route_unsupported");
	});
	it("an allowlisted route passes through unmetered", () => {
		const config = {
			...DEFAULT_GATE_CONFIG,
			routes: {
				...DEFAULT_GATE_CONFIG.routes,
				passthrough: [{ method: "GET", path: "/v1/models" }],
			},
		};
		const r = evaluateRequest(
			{ method: "GET", host: OPENAI, path: "/v1/models", body: new Uint8Array() },
			config,
		);
		expect(r).toEqual({ decision: "passthrough", mutations: { removeHeaders: [] } });
	});
	it("a body over the payload maximum fails the middleware (fail-closed)", () => {
		const body = new Uint8Array(MAX_BODY_BYTES + 1);
		expect(() =>
			evaluateRequest({ method: "POST", host: OPENAI, path: "/v1/responses", body }),
		).toThrow(BodyTooLargeError);
	});
	it("request_unparseable: not JSON, not UTF-8, not an object, no model, malformed messages/tools/input", () => {
		expect(denied(gate(OPENAI, "/v1/responses", "{nope"))).toBe("request_unparseable");
		expect(
			denied(
				evaluateRequest({
					method: "POST",
					host: OPENAI,
					path: "/v1/responses",
					body: new Uint8Array([0xff, 0xfe]),
				}),
			),
		).toBe("request_unparseable");
		expect(denied(gate(OPENAI, "/v1/responses", [1]))).toBe("request_unparseable");
		expect(denied(gate(OPENAI, "/v1/responses", { input: "x" }))).toBe("request_unparseable");
		expect(denied(anthropic({ messages: "x" }))).toBe("request_unparseable");
		expect(denied(anthropic({ tools: {} }))).toBe("request_unparseable");
		expect(denied(chat({ messages: [{ role: "user", content: 7 }] }))).toBe("request_unparseable");
		expect(denied(responses({ input: 7 }))).toBe("request_unparseable");
	});
	it("background_unsupported", () => {
		expect(denied(responses({ background: true }))).toBe("background_unsupported");
	});
	it("hosted_tool_unsupported: every tool that is not a client function — including types that do not exist yet", () => {
		for (const t of [
			"web_search",
			"file_search",
			"code_interpreter",
			"computer_use_preview",
			"image_generation",
			"mcp",
			"a_type_invented_next_year",
		]) {
			expect(denied(responses({ tools: [{ type: "function", name: "ok" }, { type: t }] })), t).toBe(
				"hosted_tool_unsupported",
			);
			expect(denied(chat({ tools: [{ type: t }] })), t).toBe("hosted_tool_unsupported");
		}
		for (const t of [
			"web_search_20250305",
			"web_fetch_20250910",
			"code_execution_20250825",
			"bash_20250124",
			"an_invented_server_tool",
		]) {
			expect(denied(anthropic({ tools: [{ type: t, name: "x" }] })), t).toBe(
				"hosted_tool_unsupported",
			);
		}
		expect(denied(anthropic({ mcp_servers: [] }))).toBe("hosted_tool_unsupported");
		expect(denied(chat({ web_search_options: {} }))).toBe("hosted_tool_unsupported");
	});
	it("provider_context_unsupported: context the provider expands and bills but the body does not contain", () => {
		expect(denied(responses({ previous_response_id: "resp_1" }))).toBe(
			"provider_context_unsupported",
		);
		expect(denied(responses({ conversation: "conv_1" }))).toBe("provider_context_unsupported");
		expect(denied(responses({ prompt: { id: "pmpt_1" } }))).toBe("provider_context_unsupported");
		expect(
			denied(
				responses({ input: [{ role: "user", content: [{ type: "input_file", file_id: "f" }] }] }),
			),
		).toBe("provider_context_unsupported");
		expect(
			denied(
				responses({ input: [{ role: "user", content: [{ type: "input_image", file_id: "f" }] }] }),
			),
		).toBe("provider_context_unsupported");
		expect(denied(responses({ input: [{ type: "item_reference", id: "x" }] }))).toBe(
			"provider_context_unsupported",
		);
		expect(
			denied(
				chat({ messages: [{ role: "user", content: [{ type: "file", file: { file_id: "f" } }] }] }),
			),
		).toBe("provider_context_unsupported");
		expect(
			denied(
				anthropic({
					messages: [
						{
							role: "user",
							content: [{ type: "document", source: { type: "file", file_id: "f" } }],
						},
					],
				}),
			),
		).toBe("provider_context_unsupported");
		expect(
			denied(
				anthropic({
					messages: [
						{
							role: "user",
							content: [{ type: "document", source: { type: "url", url: "https://x" } }],
						},
					],
				}),
			),
		).toBe("provider_context_unsupported");
		expect(
			denied(
				anthropic({
					messages: [
						{ role: "user", content: [{ type: "image", source: { type: "file", file_id: "f" } }] },
					],
				}),
			),
		).toBe("provider_context_unsupported");
		expect(denied(anthropic({ container: "c" }))).toBe("provider_context_unsupported");
	});
	it("multiple_choices_unsupported for n > 1; n = 1 is fine", () => {
		expect(denied(chat({ n: 2 }))).toBe("multiple_choices_unsupported");
		expect(chat({ n: 1 }).decision).toBe("allow");
	});
	it("content_unsupported: a part or item of a type v1 does not bound", () => {
		expect(
			denied(
				chat({ messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }] }),
			),
		).toBe("content_unsupported");
		expect(
			denied(
				chat({
					messages: [{ role: "user", content: [{ type: "file", file: { file_data: "x" } }] }],
				}),
			),
		).toBe("content_unsupported");
		expect(denied(chat({ modalities: ["text", "audio"] }))).toBe("content_unsupported");
		expect(
			denied(
				anthropic({
					messages: [
						{
							role: "user",
							content: [{ type: "document", source: { type: "base64", data: "x" } }],
						},
					],
				}),
			),
		).toBe("content_unsupported");
		expect(
			denied(anthropic({ messages: [{ role: "user", content: [{ type: "an_invented_block" }] }] })),
		).toBe("content_unsupported");
		expect(
			denied(
				anthropic({
					messages: [
						{
							role: "user",
							content: [
								{ type: "tool_result", tool_use_id: "t", content: [{ type: "search_result" }] },
							],
						},
					],
				}),
			),
		).toBe("content_unsupported");
		expect(denied(responses({ input: [{ type: "web_search_call", id: "x" }] }))).toBe(
			"content_unsupported",
		);
		expect(
			denied(responses({ input: [{ role: "user", content: [{ type: "input_audio" }] }] })),
		).toBe("content_unsupported");
	});
	it("max_output_unbounded when the request sets no valid output limit (interim — see README)", () => {
		expect(denied(gate(OPENAI, "/v1/chat/completions", { model: "gpt-4o", messages: [] }))).toBe(
			"max_output_unbounded",
		);
		expect(denied(gate(OPENAI, "/v1/responses", { model: "gpt-4o", input: "x" }))).toBe(
			"max_output_unbounded",
		);
		for (const bad of [0, -1, 1.5, "10", null]) {
			expect(denied(anthropic({ max_tokens: bad })), String(bad)).toBe("max_output_unbounded");
		}
	});
	it("model_unpriced is DENIED — an unpriced model is never billed at a fallback rate", () => {
		expect(denied(chat({ model: "totally-unknown-model" }))).toBe("model_unpriced");
		const config = {
			...DEFAULT_GATE_CONFIG,
			customRates: { "totally-unknown-model": { inputPer1k: 1, outputPer1k: 2 } },
		};
		const r = gate(
			OPENAI,
			"/v1/chat/completions",
			{ model: "totally-unknown-model", max_tokens: 5, messages: [] },
			config,
		);
		expect(r.decision, "an operator rate makes it priced").toBe("allow");
	});
});
