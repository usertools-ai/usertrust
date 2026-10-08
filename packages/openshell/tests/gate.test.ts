// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { costFromRates, getModelRates } from "usertrust";
import { describe, expect, it } from "vitest";
import {
	BodyTooLargeError,
	DEFAULT_GATE_CONFIG,
	evaluateRequest,
	GateConfigError,
	type GateResult,
	MAX_BODY_BYTES,
} from "../src/gate.js";
import { settleHold } from "../src/settlement.js";

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

/** The forwarded body's length; ALLOW always carries one. */
function sentBytes(r: GateResult): number {
	if (r.decision !== "allow" || r.mutations.body === undefined)
		throw new Error("no forwarded body");
	return r.mutations.body.byteLength;
}

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
		expect(r.mutations).toEqual({ removeHeaders: ["accept-encoding"], body: enc(body) });
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
		// #166 P2: the documented maximum for Claude 4.7+ (4,784), not the older 1,568.
		expect(r.hold.inputTokenBound).toBe(sentBytes(r) - data.length + 4_784);
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
		// gpt-4o's tile maximum: 85 + 8 × 170.
		expect(r.hold.inputTokenBound).toBe(sentBytes(r) - uri.length + 2 * 1_445);
	});

	it("#166 P2: a model with no documented image maximum takes the provider's highest", () => {
		const img = (model: string) =>
			gate(OPENAI, "/v1/chat/completions", {
				model,
				max_tokens: 10,
				messages: [
					{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/a.png" } }] },
				],
			});
		// gpt-4o-mini's tile images reach 48,169 tokens — 33× gpt-4o's.
		const r = img("gpt-4o-mini");
		if (r.decision !== "allow") throw new Error(`expected allow, got ${denied(r)}`);
		expect(r.hold.inputTokenBound - sentBytes(r)).toBe(73_800);
		expect(r.hold.inputTokenBound - sentBytes(r)).toBeGreaterThanOrEqual(2833 + 8 * 5667);
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
				{ type: "reasoning", summary: [], encrypted_content: "gAAAA" },
				{ type: "function_call", name: "f", arguments: "{}", call_id: "c" },
				{ type: "function_call_output", call_id: "c", output: "1" },
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
			],
		});
		expect(r.decision).toBe("allow");
	});
});

describe("the request gate: mutations", () => {
	it("a streaming chat call gets stream_options.include_usage — the gate's own value, whatever the client sent", () => {
		const r = chat({ stream: true, stream_options: { include_usage: false } });
		if (r.decision !== "allow") throw new Error("expected allow");
		const sent = JSON.parse(new TextDecoder().decode(r.mutations.body));
		expect(sent.stream_options).toEqual({ include_usage: true });
		expect(sent.messages).toEqual([{ role: "user", content: "hi" }]);
		expect(r.hold.streaming).toBe(true);
	});
	it("a non-streaming chat call and a streaming Responses call forward their own document, unchanged", () => {
		const c = chat();
		const s = responses({ stream: true });
		if (c.decision !== "allow" || s.decision !== "allow") throw new Error("expected allow");
		const sent = (b?: Uint8Array) => JSON.parse(new TextDecoder().decode(b));
		// The only change: the service tier pinned to "default" (#166 P1-3).
		expect(sent(c.mutations.body)).toEqual({
			model: "gpt-4o",
			max_completion_tokens: 512,
			messages: [{ role: "user", content: "hi" }],
			service_tier: "default",
		});
		expect(sent(s.mutations.body)).toEqual({
			model: "gpt-4o",
			max_output_tokens: 512,
			input: "hi",
			stream: true,
			service_tier: "default",
		});
		expect(s.mutations.removeHeaders).toEqual(["accept-encoding"]);
	});
	it("#166 P2: duplicate keys — the provider receives the value the GATE checked", () => {
		// The gate's parser keeps the LAST "model"; a provider keeping the first would
		// otherwise bill a model the gate never priced.
		const raw = `{"model":"gpt-4o-unpriced-dear","model":"gpt-4o","max_completion_tokens":5,"messages":[]}`;
		const r = evaluateRequest({
			method: "POST",
			host: OPENAI,
			path: "/v1/chat/completions",
			body: enc(raw),
		});
		if (r.decision !== "allow") throw new Error(`expected allow: ${JSON.stringify(r)}`);
		const sent = new TextDecoder().decode(r.mutations.body);
		expect(sent).not.toContain("gpt-4o-unpriced-dear");
		expect(JSON.parse(sent).model).toBe("gpt-4o");
	});
	it("#166 P2: the input bound counts the FORWARDED bytes, even when they are longer", () => {
		// 1e5 re-serializes as 100000: the provider receives more bytes than were sent.
		const raw = `{"model":"gpt-4o","max_completion_tokens":5,"messages":[],"seed":1e5}`;
		const r = evaluateRequest({
			method: "POST",
			host: OPENAI,
			path: "/v1/chat/completions",
			body: enc(raw),
		});
		if (r.decision !== "allow") throw new Error(`expected allow: ${JSON.stringify(r)}`);
		expect(r.mutations.body?.byteLength).toBeGreaterThan(enc(raw).byteLength);
		expect(r.hold.inputTokenBound).toBe(r.mutations.body?.byteLength);
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
				passthrough: [{ host: OPENAI, method: "GET", path: "/v1/models" }],
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
	it("an operator rate that is not a finite, non-negative number makes the model UNPRICED — DENIED, never held at it", () => {
		const call = (model: string, rates: Record<string, unknown>) =>
			gate(
				OPENAI,
				"/v1/chat/completions",
				{ model, max_tokens: 5, messages: [] },
				{ ...DEFAULT_GATE_CONFIG, customRates: { [model]: rates as never } },
			);
		const bad = [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", null];
		for (const field of ["inputPer1k", "outputPer1k", "cacheReadPer1k", "cacheWritePer1k"]) {
			for (const v of bad) {
				const rates = { inputPer1k: 1, outputPer1k: 2, [field]: v };
				expect(denied(call("op-model", rates)), `${field}=${String(v)}`).toBe("model_unpriced");
				// A broken override of a TABLE model is not silently replaced by the table's rate.
				expect(denied(call("gpt-4o", rates)), `gpt-4o ${field}=${String(v)}`).toBe(
					"model_unpriced",
				);
			}
		}
		expect(denied(call("op-model", {})), "missing required rates").toBe("model_unpriced");
		// Zero is a price (free), and the optional cache rates may be absent.
		expect(call("op-model", { inputPer1k: 0, outputPer1k: 0 }).decision).toBe("allow");
		expect(
			call("op-model", { inputPer1k: 1, outputPer1k: 2, cacheReadPer1k: undefined }).decision,
		).toBe("allow");
	});
});

describe("#166 P1: a tool's output is walked like any other content", () => {
	const fco = (output: unknown) =>
		responses({
			input: [
				{ type: "function_call", name: "f", arguments: "{}", call_id: "c" },
				{ type: "function_call_output", call_id: "c", output },
			],
		});
	it("an image in a function_call_output is COUNTED in the bound", () => {
		const text = fco([{ type: "input_text", text: "ok" }]);
		const img = fco([{ type: "input_image", image_url: "https://example.com/a.png" }]);
		if (text.decision !== "allow" || img.decision !== "allow") throw new Error("expected allow");
		expect(img.hold.inputTokenBound - sentBytes(img)).toBe(1_445);
		expect(text.hold.inputTokenBound).toBe(sentBytes(text));
	});
	it("a file, a stored image, or an unknown part in a function_call_output is DENIED", () => {
		expect(denied(fco([{ type: "input_file", file_id: "f" }]))).toBe(
			"provider_context_unsupported",
		);
		expect(denied(fco([{ type: "input_image", file_id: "f" }]))).toBe(
			"provider_context_unsupported",
		);
		expect(denied(fco([{ type: "input_audio", data: "x" }]))).toBe("content_unsupported");
		expect(denied(fco({ not: "an array" }))).toBe("request_unparseable");
	});
});

describe("#166 P2: provider-expanded references are refused", () => {
	it("a Responses reasoning item without encrypted_content (a stored reference)", () => {
		expect(denied(responses({ input: [{ type: "reasoning", id: "rs_1", summary: [] }] }))).toBe(
			"provider_context_unsupported",
		);
	});
	it("a chat assistant message carrying an earlier audio response by id", () => {
		expect(
			denied(
				chat({
					messages: [
						{ role: "user", content: "hi" },
						{ role: "assistant", audio: { id: "audio_1" } },
					],
				}),
			),
		).toBe("provider_context_unsupported");
	});
});

describe("#166 P1-3: top-level fields are allowlisted; tiers priced above standard are denied", () => {
	it("Anthropic fast mode, a US-only region, and an unknown service tier", () => {
		expect(denied(anthropic({ speed: "fast" }))).toBe("pricing_tier_unsupported");
		expect(denied(anthropic({ inference_geo: "us" }))).toBe("pricing_tier_unsupported");
		expect(denied(anthropic({ service_tier: "priority" }))).toBe("pricing_tier_unsupported");
		// Standard values pass.
		for (const extra of [
			{ speed: "standard" },
			{ inference_geo: "global" },
			{ service_tier: "auto" },
			{ service_tier: "standard_only" },
		]) {
			expect(anthropic(extra).decision, JSON.stringify(extra)).toBe("allow");
		}
	});
	it("OpenAI priority / fast / ultrafast / scale are denied on both routes", () => {
		for (const tier of ["priority", "fast", "ultrafast", "scale", "nonsense", 1]) {
			expect(denied(chat({ service_tier: tier })), `chat ${tier}`).toBe("pricing_tier_unsupported");
			expect(denied(responses({ service_tier: tier })), `responses ${tier}`).toBe(
				"pricing_tier_unsupported",
			);
		}
	});
	it("OpenAI absent / auto is PINNED to default; default and flex forward as sent", () => {
		const tierSent = (r: GateResult) =>
			r.decision === "allow"
				? JSON.parse(new TextDecoder().decode(r.mutations.body)).service_tier
				: `denied ${denied(r)}`;
		expect(tierSent(chat())).toBe("default");
		expect(tierSent(chat({ service_tier: "auto" }))).toBe("default");
		expect(tierSent(chat({ service_tier: null }))).toBe("default");
		expect(tierSent(responses({ service_tier: "auto" }))).toBe("default");
		expect(tierSent(chat({ service_tier: "flex" }))).toBe("flex");
		expect(tierSent(responses({ service_tier: "default" }))).toBe("default");
	});
	it("a field off the route's allowlist is denied — including ones that do not exist yet", () => {
		expect(denied(anthropic({ fallbacks: [{ model: "x" }] }))).toBe("parameter_unsupported");
		expect(denied(anthropic({ compaction: {} }))).toBe("parameter_unsupported");
		expect(denied(anthropic({ context_management: {} }))).toBe("parameter_unsupported");
		expect(denied(chat({ prediction: { type: "content", content: "x" } }))).toBe(
			"parameter_unsupported",
		);
		expect(denied(chat({ audio: { voice: "alloy", format: "wav" } }))).toBe(
			"parameter_unsupported",
		);
		expect(denied(chat({ prompt_cache_retention: "24h" }))).toBe("parameter_unsupported");
		expect(denied(responses({ prompt_cache_options: { ttl: "1h" } }))).toBe(
			"parameter_unsupported",
		);
		expect(denied(responses({ context_management: {} }))).toBe("parameter_unsupported");
		expect(denied(chat({ a_field_from_next_year: true }))).toBe("parameter_unsupported");
		// A route's field is not another route's.
		expect(denied(chat({ max_output_tokens: 5 }))).toBe("parameter_unsupported");
	});
	it("control: every allowlisted ordinary field passes", () => {
		expect(
			anthropic({
				system: "s",
				metadata: { user_id: "u" },
				stop_sequences: ["x"],
				temperature: 0.5,
				top_k: 5,
				top_p: 0.9,
				thinking: { type: "enabled", budget_tokens: 512 },
				output_config: { effort: "low" },
			}).decision,
		).toBe("allow");
		expect(
			chat({
				temperature: 1,
				seed: 1,
				user: "u",
				response_format: { type: "text" },
				reasoning_effort: "low",
				store: false,
				prompt_cache_key: "k",
			}).decision,
		).toBe("allow");
		expect(
			responses({
				instructions: "be brief",
				reasoning: { effort: "low" },
				text: { format: { type: "text" } },
				truncation: "disabled",
				include: ["reasoning.encrypted_content"],
				store: false,
			}).decision,
		).toBe("allow");
	});
	it("Responses instructions must be a string", () => {
		expect(denied(responses({ instructions: [{ role: "system", content: "x" }] }))).toBe(
			"content_unsupported",
		);
	});
});

describe("#166 P2-2: a request with tools carries the provider's tool system prompt", () => {
	it("Anthropic: the bound includes the tool-use overhead; without tools it does not", () => {
		const tool = { name: "f", input_schema: { type: "object" } };
		const r = anthropic({ tools: [tool] });
		const none = anthropic();
		if (r.decision !== "allow" || none.decision !== "allow") throw new Error("expected allow");
		expect(r.hold.inputTokenBound - sentBytes(r)).toBe(1_024);
		expect(none.hold.inputTokenBound - sentBytes(none)).toBe(0);
		// At or above the largest documented overhead (804).
		expect(DEFAULT_GATE_CONFIG.toolOverheadTokens.anthropic).toBeGreaterThanOrEqual(804);
	});
});

// gpt-4o-2024-05-13 is no longer the example: it has its OWN exact row now (priced above
// its alias), so the gate rightly prices it. -08-06 has none, meters at gpt-4o's row
// in the governor, and stays unpriced here because isModelPriced is exact by design.
describe("#166 P1-1: a model priced only by PREFIX is unpriced at the gate", () => {
	it("o3-pro, a dated gpt-4o snapshot, a -pro tier and a -fast variant are denied model_unpriced", () => {
		for (const model of ["o3-pro", "gpt-4o-2024-08-06", "gpt-5.4-pro", "claude-opus-4-6-fast"]) {
			const r = model.startsWith("claude")
				? gate(ANTHROPIC, "/v1/messages", { model, max_tokens: 5, messages: [] })
				: gate(OPENAI, "/v1/chat/completions", { model, max_tokens: 5, messages: [] });
			expect(denied(r), model).toBe("model_unpriced");
		}
	});
	it("control: the exact table model, and an operator's exact rate for the variant, are allowed", () => {
		expect(chat().decision).toBe("allow");
		const config = {
			...DEFAULT_GATE_CONFIG,
			customRates: { "o3-pro": { inputPer1k: 200, outputPer1k: 800 } },
		};
		expect(
			gate(OPENAI, "/v1/chat/completions", { model: "o3-pro", max_tokens: 5, messages: [] }, config)
				.decision,
		).toBe("allow");
	});
});

describe("#166 MEDIUM: the gate refuses running usage counts", () => {
	it("P1: stream_options.continuous_usage_stats is refused on both OpenAI routes", () => {
		expect(denied(chat({ stream: true, stream_options: { continuous_usage_stats: true } }))).toBe(
			"parameter_unsupported",
		);
		expect(
			denied(responses({ stream: true, stream_options: { continuous_usage_stats: false } })),
		).toBe("parameter_unsupported");
	});
	it("control: an ordinary stream_options still passes", () => {
		expect(chat({ stream: true, stream_options: { include_usage: true } }).decision).toBe("allow");
		expect(chat({ stream: true }).decision, "absent").toBe("allow");
	});
	it("#175: include_usage, when present, must be a boolean — null, a string or an object is DENIED on every OpenAI route, streaming or not", () => {
		for (const r of [chat, responses]) {
			for (const stream of [true, false]) {
				for (const v of [null, "x", {}, 1]) {
					const out = r({ stream, stream_options: { include_usage: v } });
					expect(denied(out), `${JSON.stringify(v)} stream=${stream}`).toBe(
						"parameter_unsupported",
					);
					if (out.decision === "deny") expect(out.detail).toBe("stream_options.include_usage");
				}
			}
		}
		expect(chat({ stream: false, stream_options: { include_usage: false } }).decision).toBe(
			"allow",
		);
	});
	it("#168: only allowlisted stream_options keys are forwarded — any other key, or a non-object, is DENIED", () => {
		for (const r of [chat, responses]) {
			for (const so of [{ foo: 1 }, { include_usage: true, include_obfuscation: false }]) {
				const out = r({ stream: true, stream_options: so });
				expect(denied(out), JSON.stringify(so)).toBe("parameter_unsupported");
				if (out.decision === "deny") expect(out.detail).toMatch(/^stream_options\./);
			}
			// null too: a key that is present is checked; when not streaming it would be forwarded.
			for (const so of [null, "x", 1, [], true]) {
				// Not streaming, so nothing replaces it: it would have been forwarded as sent.
				expect(denied(r({ stream_options: so })), JSON.stringify(so)).toBe("parameter_unsupported");
			}
		}
	});
	it("P1: the hold carries the rates it was priced with", () => {
		const r = chat();
		if (r.decision !== "allow") throw new Error("expected allow");
		expect(r.hold.rates).toEqual(getModelRates("gpt-4o"));
	});
});

describe("#169: the hold's worst case includes the cache-read tier", () => {
	it("an operator rate whose cache read is dearer than input and cache write: a call read entirely from cache settles within its hold", () => {
		const config = {
			...DEFAULT_GATE_CONFIG,
			customRates: {
				"op-model": { inputPer1k: 1, outputPer1k: 2, cacheReadPer1k: 9, cacheWritePer1k: 3 },
			},
		};
		const r = gate(
			OPENAI,
			"/v1/chat/completions",
			{ model: "op-model", max_completion_tokens: 50, messages: [{ role: "user", content: "hi" }] },
			config,
		);
		if (r.decision !== "allow") throw new Error("expected allow");
		const s = settleHold(r.hold, {
			inputTokens: 0,
			outputTokens: r.hold.maxOutputTokens,
			cacheReadTokens: r.hold.inputTokenBound,
			cacheWriteTokens: 0,
			source: "provider",
		});
		expect(s.overage).toBe(0);
		expect(r.hold.amount).toBe(
			costFromRates(config.customRates["op-model"], 0, 50, r.hold.inputTokenBound, 0),
		);
	});
});

describe("#170: the returned Hold is frozen", () => {
	it("a mutation of the hold or its rates throws (ESM is strict) and changes nothing", () => {
		const r = chat();
		if (r.decision !== "allow") throw new Error("expected allow");
		const amount = r.hold.amount;
		expect(Object.isFrozen(r.hold)).toBe(true);
		expect(Object.isFrozen(r.hold.rates)).toBe(true);
		expect(() => {
			(r.hold as { amount: number }).amount = 1;
		}).toThrow(TypeError);
		expect(() => {
			(r.hold.rates as { inputPer1k: number }).inputPer1k = 0;
		}).toThrow(TypeError);
		expect(r.hold.amount).toBe(amount);
	});
});

describe("#171: the image and tool token config is validated — a bad value refuses, never lowers the bound", () => {
	const image = { type: "image_url", image_url: { url: "https://example.com/a.png" } };
	const withImage = { messages: [{ role: "user", content: [image] }] };
	// Anthropic's tool shape: the tool-overhead bound is Anthropic's (OpenAI documents none).
	const tools = { tools: [{ name: "f", input_schema: { type: "object" } }] };
	const bad = [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "10", undefined];
	const run = (
		config: typeof DEFAULT_GATE_CONFIG,
		extra: Record<string, unknown>,
		host = OPENAI,
	) =>
		host === OPENAI
			? gate(
					OPENAI,
					"/v1/chat/completions",
					{ model: "gpt-4o", max_completion_tokens: 5, messages: [], ...extra },
					config,
				)
			: gate(
					ANTHROPIC,
					"/v1/messages",
					{ model: "claude-sonnet-4-6", max_tokens: 5, messages: [], ...extra },
					config,
				);
	it("imageTokenMax, imageTokenMaxByModel and toolOverheadTokens: negative, NaN, Infinity, fractional, non-number or missing throw GateConfigError", () => {
		for (const v of bad) {
			const configs = [
				{
					...DEFAULT_GATE_CONFIG,
					imageTokenMax: { ...DEFAULT_GATE_CONFIG.imageTokenMax, openai: v },
				},
				{
					...DEFAULT_GATE_CONFIG,
					imageTokenMaxByModel: { ...DEFAULT_GATE_CONFIG.imageTokenMaxByModel, "gpt-4o": v },
				},
				{
					...DEFAULT_GATE_CONFIG,
					toolOverheadTokens: { ...DEFAULT_GATE_CONFIG.toolOverheadTokens, anthropic: v },
				},
			] as unknown as (typeof DEFAULT_GATE_CONFIG)[];
			// Refused whatever the request carries: a bad config is refused, not just a bad bound.
			for (const config of configs) {
				expect(() => run(config, {}), String(v)).toThrow(GateConfigError);
				expect(() => run(config, {}, ANTHROPIC), String(v)).toThrow(GateConfigError);
			}
		}
	});
	it("a missing provider entry is refused", () => {
		const config = {
			...DEFAULT_GATE_CONFIG,
			toolOverheadTokens: { openai: 0 },
		} as unknown as typeof DEFAULT_GATE_CONFIG;
		expect(() => run(config, tools, ANTHROPIC)).toThrow(GateConfigError);
	});
	it("control: zero is a valid bound, and the defaults pass", () => {
		const zero = { ...DEFAULT_GATE_CONFIG, toolOverheadTokens: { anthropic: 0, openai: 0 } };
		expect(run(zero, tools, ANTHROPIC).decision).toBe("allow");
		expect(run(DEFAULT_GATE_CONFIG, withImage).decision).toBe("allow");
	});
});
